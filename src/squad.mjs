import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { WorkspaceState, declaredPath } from './workspace-state.mjs';
import { assembleAgentContext, renderAgentContext } from './context.mjs';
import { observeFiles } from './file-observer.mjs';
import { OpenCodeClient, safeRuntimeError } from './opencode.mjs';
import { startOpenCode } from './process.mjs';

const msgID = () => `msg_${randomUUID().replaceAll('-', '')}`;
const terminalEvents = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function shortIntention(role, task) {
  let summary = `Assigned focus (squad coordinator), ${role}: `;
  for (const point of task) { if (Buffer.byteLength(summary + point) > 1_000) break; summary += point; }
  return summary;
}

const stepTypes = new Set(['session.step.started', 'session.step.streamed', 'session.step.ended', 'session.step.failed']);
const finishes = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown']);
const finiteCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const safeLabel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
const delta = (end, start) => end !== null && start !== null && end >= start ? end - start : null;

/** Native request/body/settlement observations; none measures pure model compute. */
export class ModelSteps {
  constructor() {
    this.steps = [];
    this.omissions = { stepStarts: 0, events: 0, uncorrelatedEvents: 0, duplicatePhaseEvents: 0 };
  }
  observe(event, { gap = false } = {}) {
    const isStep = stepTypes.has(event.type), isInput = event.type === 'session.tool.input.started';
    if (!isStep && !isInput) return false;
    const assistantMessageID = safeLabel(event.data?.assistantMessageID);
    if (!assistantMessageID) { this.omissions.uncorrelatedEvents++; return false; }
    let step = this.steps.find(value => value.assistantMessageID === assistantMessageID);
    if (!step && !isStep) { this.omissions.uncorrelatedEvents++; return false; }
    if (!step) {
      if (this.steps.length >= 32) { this.omissions.events++; if (event.type === 'session.step.started') this.omissions.stepStarts++; return false; }
      step = { assistantMessageID, events: {}, started: null, model: null, tokens: { input: null, output: null, reasoning: null, cache: { read: null, write: null } }, cost: null, finish: null, sourceGap: gap, firstInput: null, requestToBodyMs: null, postBodySettlementMs: null };
      this.steps.push(step);
    }
    step.sourceGap ||= gap;
    const metadata = { id: safeLabel(event.id), type: event.type, time: finiteCount(event.time) };
    if (isInput) step.firstInput ??= metadata;
    else {
      const phase = event.type.slice('session.step.'.length);
      if (step.events[phase]) { this.omissions.duplicatePhaseEvents++; return false; }
      step.events[phase] = metadata;
      if (phase === 'started') {
        step.started = finiteCount(event.data.started);
        const providerID = safeLabel(event.data.model?.providerID), id = safeLabel(event.data.model?.id);
        if (providerID && id) step.model = { providerID, id, ...(safeLabel(event.data.model.variant) ? { variant: safeLabel(event.data.model.variant) } : {}) };
      }
      if (phase === 'ended' || phase === 'failed') {
        for (const key of ['input', 'output', 'reasoning']) step.tokens[key] = finiteCount(event.data.tokens?.[key]);
        for (const key of ['read', 'write']) step.tokens.cache[key] = finiteCount(event.data.tokens?.cache?.[key]);
        step.cost = finiteCount(event.data.cost);
        step.finish = finishes.has(event.data.finish) ? event.data.finish : null;
      }
    }
    const bodyTime = step.events.streamed?.time ?? null;
    const terminalTime = step.events.ended?.time ?? step.events.failed?.time ?? null;
    const unknownBasis = step.sourceGap || step.started === null || !step.events.started;
    step.requestToBodyMs = unknownBasis ? null : delta(bodyTime, step.started);
    step.postBodySettlementMs = unknownBasis ? null : delta(terminalTime, bodyTime);
    return true;
  }
  gap() { for (const step of this.steps) if (!step.events.ended && !step.events.failed) { step.sourceGap = true; step.requestToBodyMs = null; step.postBodySettlementMs = null; } }
}

/** One queued observation awaiting native delivery; this grants no editing ownership. */
export class NotificationPolicy {
  constructor({ cut, active, deliver, onSuppression = () => {}, quietMs = 2_000, maxNotices = 3 }) {
    Object.assign(this, { cut, active, deliver, onSuppression, quietMs, maxNotices });
    this.dirty = new Set(); this.seen = new Map();
    this.count = 0; this.pendingID = null; this.sending = false; this.closed = false; this.lastChange = 0; this.lastSent = 0;
  }
  observe(path) {
    if (this.closed || !this.active()) return;
    const cut = this.cut(), file = cut.files.find(value => value.path === path), read = cut.reads.find(value => value.path === path);
    let reason = null;
    if (!file) reason = 'outside_relevant_evidence';
    else if (this.seen.get(path) === file.revision) reason = 'duplicate_observed_revision';
    else if (!cut.dependencies.some(edge => edge.producerPath === path) && !(read?.revision != null && read.revision < file.revision)) reason = 'no_declared_dependency_or_stale_read';
    if (reason) { this.onSuppression({ path, reason, attribution: 'unknown' }); return; }
    this.seen.set(path, file.revision);
    if (this.count >= this.maxNotices) { this.onSuppression({ path, reason: 'task_notification_budget', attribution: 'unknown' }); return; }
    this.dirty.add(path); this.lastChange = Date.now();
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (this.closed || !this.active() || this.pendingID || this.sending || !this.dirty.size || this.count >= this.maxNotices) return;
    this.timer = setTimeout(() => { this.timer = null; void this.send(); }, Math.max(0, this.quietMs - (Date.now() - this.lastChange), this.quietMs - (Date.now() - this.lastSent)));
  }
  async send() {
    if (this.closed || !this.active() || this.pendingID || this.count >= this.maxNotices) return;
    const paths = [...this.dirty]; this.dirty.clear();
    const id = msgID(); this.pendingID = id; this.sending = true; this.count++; this.lastSent = Date.now();
    try { await this.deliver({ id, paths }); }
    catch { this.onSuppression({ reason: 'notification_admission_unknown', attribution: 'unknown' }); }
    finally { this.sending = false; this.schedule(); }
  }
  delivered(id) {
    if (id !== this.pendingID) return false;
    this.pendingID = null; this.schedule(); return true;
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; }
}
function pathWithin(root, value) {
  if (typeof value !== 'string') return null;
  const path = isAbsolute(value) ? relative(root, value) : value;
  return !path || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.') || path.includes('\\') ? null : path;
}
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}

export function validateSquadFixture(value) {
  if (!value || !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 128 || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 64) throw new TypeError('invalid_squad_roster');
  const paths = [...new Set(value.paths.map(declaredPath))], declared = new Set(paths), identities = new Set();
  function task(record) {
    if (!record || typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record.id) || identities.has(record.id) || typeof record.task !== 'string' || !record.task.trim() || Buffer.byteLength(record.task) > 4096 || !Array.isArray(record.files ?? []) || (record.files?.length ?? 0) > 64 || !Array.isArray(record.dependencies ?? []) || (record.dependencies?.length ?? 0) > 64) throw new TypeError('invalid_squad_task');
    identities.add(record.id);
    const files = [...new Set((record.files ?? []).map(declaredPath))];
    const dependencies = (record.dependencies ?? []).map(edge => typeof edge === 'string' ? { producerPath: declaredPath(edge), consumerPath: null } : { producerPath: declaredPath(edge.producerPath), consumerPath: edge.consumerPath ? declaredPath(edge.consumerPath) : null });
    if (files.some(path => !declared.has(path)) || dependencies.some(edge => !declared.has(edge.producerPath) || edge.consumerPath && !declared.has(edge.consumerPath))) throw new TypeError('undeclared_squad_path');
    return { id: record.id, task: record.task, files, dependencies };
  }
  const tasks = value.tasks.map(task);
  const integrationTask = value.integrationTask == null ? null : task(typeof value.integrationTask === 'string' ? { id: 'integration', task: value.integrationTask, files: paths.slice(0, 64), dependencies: [] } : value.integrationTask);
  const sharedFile = declaredPath(value.sharedFile ?? (declared.has('data/history.json') ? 'data/history.json' : paths[0]));
  if (!declared.has(sharedFile)) throw new TypeError('undeclared_shared_file');
  const participants = tasks.length + (integrationTask ? 1 : 0);
  const sourceStreams = 1 + participants * 2;
  if (participants > 64 || sourceStreams > 128) throw Object.assign(new RangeError('squad_capacity_exceeded'), { code: 'squad_capacity_exceeded', requested: { participants, sourceStreams }, capacity: { participants: 64, sourceStreams: 128, observedFiles: 128 } });
  return { paths, tasks, integrationTask, sharedFile };
}

/** Explicitly assigned native roster build. Observer awareness does not fence native writes. */
export async function runRealSquad({ profile, fixture: providedFixture, preserveExisting = false, buildRoot, maxConcurrentNative, seed: providedSeed, verify: providedVerify, onUpdate = () => {}, signal, deadlineMs = 720_000, actorDeadlineMs = 360_000, fixtureRoot, runtime = {} }) {
  if (!profile?.model || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 720_000 || !Number.isFinite(actorDeadlineMs) || actorDeadlineMs <= 0 || actorDeadlineMs > 360_000) throw new TypeError('Invalid squad profile/deadline');
  if ((maxConcurrentNative !== undefined && (!Number.isSafeInteger(maxConcurrentNative) || maxConcurrentNative < 1)) || typeof preserveExisting !== 'boolean') throw new TypeError('invalid_squad_concurrency');
  if (preserveExisting && (!providedFixture || !(buildRoot ?? fixtureRoot))) throw new TypeError('preserve_existing_requires_fixture_and_root');
  if (buildRoot && fixtureRoot && resolve(buildRoot) !== resolve(fixtureRoot)) throw new TypeError('ambiguous_squad_root');
  const validatedFixture = providedFixture ? validateSquadFixture(providedFixture) : null;
  if (validatedFixture && maxConcurrentNative !== undefined && maxConcurrentNative > validatedFixture.tasks.length) throw Object.assign(new RangeError('squad_concurrency_exceeds_roster'), { code: 'squad_concurrency_exceeds_roster' });
  const seed = preserveExisting ? null : providedSeed ?? runtime.seedGangCode ?? (!providedFixture ? (await import('../fixtures/gangcode.mjs')).seedGangCode : null);
  const verify = providedVerify ?? runtime.verifyGangCode ?? (await import('../fixtures/gangcode-verifier.mjs')).verifyGangCode;
  if (typeof verify !== 'function' || seed && typeof seed !== 'function') throw new TypeError('invalid_squad_callback');
  const start = runtime.startOpenCode ?? startOpenCode;
  const Client = runtime.OpenCodeClient ?? OpenCodeClient;
  const observe = runtime.observeFiles ?? observeFiles;
  const assemble = runtime.assembleAgentContext ?? assembleAgentContext;
  const controller = new AbortController();
  const stopSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
  const state = new WorkspaceState({ epoch: randomUUID() });
  const started = Date.now(), actors = [], pending = new Set(), events = [];
  let observer, phase = 'Preparing Canada: Crossroads squad', fixture, localState, concurrency;
  const executionConcurrency = { currentAdmitted: 0, peakAdmitted: 0, currentRunning: 0, peakRunning: 0, basis: 'successful_native_prompt_admission_to_wait_settlement_or_confirmed_process_stop', nativeRunningBasis: 'session.execution.started_to_terminal_or_confirmed_process_stop' };
  const initialPlan = validatedFixture ? [...validatedFixture.tasks.map(task => task.id), ...(validatedFixture.integrationTask ? [validatedFixture.integrationTask.id] : [])] : [];
  const result = { kind: 'real-native-squad-build', condition: 'Canada: Crossroads / shared workspace', model: { ...profile.model }, planned: initialPlan, assigned: [], actors: [], notices: [], errors: [], batches: [], executionConcurrency, preservedExisting: preserveExisting, preVerification: null, verification: { correct: false, checks: [] }, buildRoot: null };
  function publish() { try { onUpdate({ phase, state: state.snapshot(), events: [...events], result }); } catch { /* Progress delivery cannot affect the agents. */ } }
  function record(value) { events.push({ elapsedMs: Date.now() - started, ...value }); if (events.length > 256) events.shift(); publish(); }
  function error(actor, code) { const issue = { actor: actor?.id ?? null, code }; result.errors.push(issue); actor?.evidence.errors.push(code); record({ actor: actor?.id, type: 'runtime.error', status: code }); }
  function control(actor, type, data) { return state.ingest({ id: randomUUID(), epoch: state.epoch, source: 'control', sourceSeq: ++actor.controlSeq, participantID: actor.id, sessionID: actor.sessionID, generation: 1, type, data }); }
  function track(promise) { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }

  function running(actor, value) {
    if (actor.nativeRunning === value) return;
    actor.nativeRunning = value;
    executionConcurrency.currentRunning += value ? 1 : -1;
    executionConcurrency.peakRunning = Math.max(executionConcurrency.peakRunning, executionConcurrency.currentRunning);
  }
  function settledAdmission(actor) {
    if (actor.admissionOpen) { actor.admissionOpen = false; executionConcurrency.currentAdmitted--; }
  }

  async function contextProof(actor, id, text) {
    try {
      const response = await bounded(actor.client.context(actor.sessionID, AbortSignal.any([stopSignal, AbortSignal.timeout(5_000)])), 5_100, 'context_deadline');
      return { projected: Array.isArray(response?.data) && response.data.some(message => message.id === id && message.type === 'user' && message.text === text) ? true : null, providerConsumption: 'unverified' };
    } catch { return { projected: null, providerConsumption: 'unverified', reason: 'native_context_unavailable' }; }
  }

  function queueNotice(actor, path) {
    actor.notificationPolicy?.observe(path);
  }

  async function sendNotice(actor, { id, paths }) {
    if (!actor.active || stopSignal.aborted) return;
    const notice = { id, actor: actor.id, causePaths: paths, elapsedMs: Date.now() - started, status: 'sending', delivery: 'queue', attribution: 'unknown' };
    result.notices.push(notice); actor.evidence.notices++;
    try {
      const context = assemble({ state, participantID: actor.id, join: actor.join, cause: { id, type: 'workspace.changed', path: paths[0], paths, revision: state.files.get(paths[0])?.revision ?? null } });
      notice.contextID = context.contextID;
      const text = renderAgentContext(context);
      actor.projections.push({ id, text, notice });
      const admitted = await actor.client.prompt(actor.sessionID, text, { id, delivery: 'queue', resume: false, signal: AbortSignal.any([stopSignal, actor.noticeController.signal, AbortSignal.timeout(10_000)]) });
      notice.status = 'accepted'; notice.admittedAt = admitted.created;
      actor.instructionRevision++;
      actor.noticeRevisions.set(id, actor.instructionRevision);
      control(actor, 'control.accepted', { commandID: id, instructionRevision: actor.instructionRevision });
      if (actor.delivered.has(id)) { notice.status = 'delivered'; control(actor, 'control.delivered', { commandID: id, instructionRevision: actor.instructionRevision }); }
    } catch { notice.status = 'unknown'; }
    finally {
      record({ actor: actor.id, type: 'awareness.notification', path: paths[0], status: notice.status });
    }
  }

  async function closeActor(actor) {
    actor.closing = true;
    actor.active = false;
    actor.noticeController?.abort();
    actor.notificationPolicy?.close();
    actor.client?.close();
    try {
      if (!actor.server && actor.setupStopUnconfirmed) throw new Error('native_stop_unconfirmed');
      if (actor.server) await bounded(actor.server.close(), 10_000, 'native_stop_unconfirmed');
      actor.evidence.processStopped = true;
      running(actor, false); settledAdmission(actor);
      actor.evidence.processStoppedAt = Date.now();
      if (actor.evidence.executionStartedAt === undefined) { actor.evidence.settledAt = actor.evidence.processStoppedAt; actor.evidence.settleMs = actor.evidence.processStoppedAt - (actor.evidence.setupFinishedAt ?? actor.evidence.setupStartedAt); }
    }
    catch { actor.evidence.processStopped = false; error(actor, 'native_stop_unconfirmed'); }
    if (actor.stream) try { await bounded(actor.stream, 2_000, 'stream_close_unconfirmed'); } catch { error(actor, 'native_stream_close_unconfirmed'); }
  }

  async function setup(task) {
    const evidence = { id: task.id, assigned: true, setupStartedAt: Date.now(), affinityFiles: [...(task.files ?? [])], admitted: false, outcome: 'setup', notices: 0, errors: [], processStopped: null, firstJoinBeforeTools: null, initialContextProof: null };
    result.assigned.push(task.id); result.actors.push(evidence); publish();
    const actor = { id: task.id, task, evidence, controlSeq: 0, instructionRevision: 0, active: false, delivered: new Set(), noticeRevisions: new Map(), synced: deferred(), projections: [], nativeCursor: null, gap: false, nativeRunning: false, noticeController: new AbortController() };
    actor.modelSteps = new ModelSteps();
    evidence.modelSteps = actor.modelSteps.steps; evidence.modelStepOmissions = actor.modelSteps.omissions;
    evidence.modelStepTimingBasis = { requestToBody: 'request_preparation_transport_provider_network_response_parse_combined', postBodySettlement: 'local_tools_snapshot_and_step_settlement', pureModelCompute: 'unknown', retention: 'first_32_assistant_message_ids', omissionStepStarts: 'discarded_started_events_not_unique_ids' };
    actors.push(actor);
    try {
      actor.server = await start({ ...profile, stateDir: join(localState, task.id), directory: result.buildRoot, signal: stopSignal });
      actor.client = new Client({ endpoint: actor.server.endpoint, password: actor.server.password, model: profile.model, directory: result.buildRoot });
      actor.sessionID = await actor.client.createSession(`Canada: Crossroads / ${task.id}`, stopSignal);
      state.register({ id: task.id, task: { id: `${task.id}-canada-crossroads`, revision: 1, text: task.task }, sessionID: actor.sessionID, generation: 1, dependencies: task.dependencies ?? [] });
      state.setIntention(task.id, shortIntention(task.id, task.task));
      actor.join = state.joinFile(task.id, fixture.sharedFile);
      for (const path of task.files ?? []) if (path !== fixture.sharedFile) state.joinFile(task.id, path);
      actor.notificationPolicy = new NotificationPolicy({ cut: () => state.decisionCut(actor.id), active: () => actor.active && !actor.closing,
        deliver: value => { actor.noticeWork = track(sendNotice(actor, value)); return actor.noticeWork; },
        onSuppression: data => record({ actor: actor.id, type: 'notification.suppressed', ...data }) });
      actor.stream = (async () => {
        try {
          for await (const event of actor.client.events(actor.sessionID, { transport: 'live', signal: stopSignal })) {
            if (event.type === 'server.connected') { actor.synced.resolve(true); continue; }
            if (actor.nativeCursor !== null && event.seq <= actor.nativeCursor) { record({ actor: task.id, type: 'native.event.ignored', status: 'duplicate_or_reordered', seq: event.seq }); continue; }
            if (actor.nativeCursor !== null && event.seq !== actor.nativeCursor + 1) { actor.gap = true; actor.modelSteps.gap(); }
            actor.nativeCursor = event.seq;
            const modelStep = actor.modelSteps.observe(event, { gap: actor.gap });
            const path = pathWithin(result.buildRoot, event.data.input?.path);
            const success = event.type === 'session.tool.success';
            const data = success && path ? { path, kind: event.data.toolName === 'read' ? 'read' : ['write', 'edit'].includes(event.data.toolName) ? 'edit' : 'unknown', location: event.data.input.offset == null ? null : { offset: event.data.input.offset, limit: event.data.input.limit ?? null } } : { complete: !actor.gap, reason: actor.gap ? 'native stream sequence gap' : null, historicalComplete: false };
            state.ingest({ id: event.id, epoch: state.epoch, source: 'opencode', sourceSeq: event.seq, participantID: task.id, sessionID: actor.sessionID, generation: 1, type: success && path ? 'activity.observed' : 'coverage.changed', time: event.time, data });
            const inboxID = event.data.inboxID ?? event.data.id;
            if (event.type === 'session.tool.input.started' && actor.firstToolSeq === undefined) actor.firstToolSeq = event.seq;
            if (event.type === 'session.inbox.delivered' && inboxID) {
              actor.delivered.add(inboxID);
              actor.notificationPolicy?.delivered(inboxID);
              if (inboxID === actor.initialMessageID) actor.initialDeliveredSeq = event.seq;
              const notice = result.notices.find(item => item.actor === actor.id && item.id === inboxID);
              if (notice) {
                const revision = actor.noticeRevisions.get(inboxID);
                notice.status = 'delivered';
                if (revision) control(actor, 'control.delivered', { commandID: inboxID, instructionRevision: revision });
              }
            }
            if (terminalEvents.has(event.type)) { actor.active = false; actor.evidence.nativeLastTerminalAt = Date.now(); running(actor, false); }
            if (event.type === 'session.execution.started') { actor.evidence.nativeFirstStartedAt ??= Date.now(); if (!actor.closing && !Number.isFinite(actor.evidence.idleAt)) running(actor, true); }
            if (event.type === 'session.execution.started' && actor.evidence.outcome === 'running' && !actor.closing) actor.active = true;
            if (modelStep || success || event.type.includes('inbox') || event.type.includes('execution')) record({ actor: task.id, type: event.type, path, tool: event.data.toolName, seq: event.seq });
          }
          if (!stopSignal.aborted && actor.active) throw new Error('native_stream_ended');
        } catch {
          actor.synced.resolve(false);
          if (!stopSignal.aborted && !actor.closing && !actor.evidence.processStopped) { actor.modelSteps.gap(); error(actor, 'native_stream_unavailable'); control(actor, 'coverage.changed', { complete: false, reason: 'native source unavailable' }); }
        }
      })();
      if (!await bounded(actor.synced.promise, 5_000, 'native_stream_ready_deadline')) throw new Error('native_stream_unavailable');
      evidence.outcome = 'ready'; evidence.setupFinishedAt = Date.now(); evidence.setupMs = evidence.setupFinishedAt - evidence.setupStartedAt;
      return actor;
    } catch (caught) { evidence.failure = safeRuntimeError(caught); evidence.setupFinishedAt = Date.now(); evidence.setupMs = evidence.setupFinishedAt - evidence.setupStartedAt; actor.setupStopUnconfirmed = caught?.stopUnconfirmed === true; evidence.outcome = 'setup_failed'; error(actor, 'actor_setup_failed'); await closeActor(actor); return null; }
  }

  async function execute(actor, extraEvidence = '') {
    const actorSignal = AbortSignal.any([stopSignal, AbortSignal.timeout(actorDeadlineMs)]);
    actor.evidence.executionStartedAt = Date.now();
    try {
      actor.active = true;
      control(actor, 'agent.status', { status: 'running' });
      actor.join = state.joinFile(actor.id, fixture.sharedFile);
      const context = assemble({ state, participantID: actor.id, join: actor.join });
      const text = `${actor.task.task}\nYou are one member of an explicitly assigned squad building Canada: Crossroads. Files listed for your role are affinities, not exclusive ownership. Inspect existing peer work; preserve useful changes. Use file tools, not processes or nested agents. Prefer compact modules under 250 lines and UI under 350 lines while satisfying the mission; avoid oversized scaffolding. Work within the mission and existing task authority.\n${extraEvidence}\n${renderAgentContext(context)}`;
      actor.initialMessageID = msgID(); actor.evidence.initialContextID = context.contextID;
      actor.projections.push({ id: actor.initialMessageID, text, initial: true });
      const admitted = await actor.client.prompt(actor.sessionID, text, { id: actor.initialMessageID, delivery: 'steer', signal: actorSignal });
      actor.evidence.admitted = true; actor.evidence.admittedAt = admitted.created; actor.admissionOpen = true; executionConcurrency.currentAdmitted++; executionConcurrency.peakAdmitted = Math.max(executionConcurrency.peakAdmitted, executionConcurrency.currentAdmitted); actor.evidence.outcome = 'running'; record({ actor: actor.id, type: 'task.admitted' });
      const terminal = await actor.client.wait(actor.sessionID, actorSignal);
      actor.evidence.outcome = terminal.outcome; actor.evidence.idleAt = terminal.idle;
      if (Number.isFinite(terminal.idle)) { settledAdmission(actor); running(actor, false); }
      if (terminal.outcome !== 'succeeded') error(actor, 'task_not_succeeded');
    } catch (caught) { actor.evidence.failure = safeRuntimeError(caught); actor.evidence.outcome = actorSignal.aborted ? 'deadline_or_cancelled' : 'runtime_failed'; error(actor, actorSignal.aborted ? 'actor_deadline_or_cancel' : 'actor_runtime_failed'); }
    finally {
      actor.evidence.executionFinishedAt = Date.now(); actor.evidence.executionMs = actor.evidence.executionFinishedAt - actor.evidence.executionStartedAt;
      actor.evidence.settleStartedAt = Date.now();
      actor.active = false;
      actor.notificationPolicy?.close();
      // A timed-out writer must stop before spending time on optional projection proofs.
      const executionUnconfirmed = !Number.isFinite(actor.evidence.idleAt);
      if (actorSignal.aborted || executionUnconfirmed) await closeActor(actor);
      if (!actorSignal.aborted && !executionUnconfirmed && actor.noticeWork) {
        try { await bounded(actor.noticeWork, 5_000, 'notice_settlement_deadline'); }
        catch { actor.noticeController.abort(); await bounded(actor.noticeWork, 1_000, 'notice_cancel_deadline').catch(() => error(actor, 'notification_settlement_unconfirmed')); }
      }
      if (state.agents.has(actor.id)) control(actor, 'agent.status', { status: actor.evidence.outcome === 'succeeded' ? 'completed' : 'failed' });
      for (const projection of actor.projections) {
        const proof = actorSignal.aborted || executionUnconfirmed ? { projected: null, providerConsumption: 'unverified', reason: 'execution_settlement_unconfirmed' } : await contextProof(actor, projection.id, projection.text);
        if (projection.initial) actor.evidence.initialContextProof = proof;
        else projection.notice.contextProof = proof;
      }
      actor.projections = [];
      actor.evidence.firstJoinBeforeTools = actor.firstToolSeq !== undefined && actor.initialDeliveredSeq !== undefined ? actor.initialDeliveredSeq < actor.firstToolSeq : null;
      if (actor.evidence.processStopped !== true) await closeActor(actor);
      actor.evidence.settledAt = Date.now(); actor.evidence.settleMs = actor.evidence.settledAt - actor.evidence.settleStartedAt;
      record({ actor: actor.id, type: 'task.settled', status: actor.evidence.outcome });
    }
  }

  publish();
  try {
    const requestedRoot = buildRoot ?? fixtureRoot;
    result.buildRoot = requestedRoot ? resolve(requestedRoot) : await mkdtemp(join(tmpdir(), 'canada-crossroads-squad-'));
    if (preserveExisting) {
      if (!(await stat(result.buildRoot)).isDirectory()) throw new Error('existing_squad_root_not_directory');
      result.buildRoot = await realpath(result.buildRoot);
    } else await mkdir(result.buildRoot, { recursive: true });
    localState = await mkdtemp(join(tmpdir(), 'canada-crossroads-native-'));
    const seeded = seed ? await seed(result.buildRoot) : null;
    fixture = validatedFixture ?? validateSquadFixture(seeded);
    result.planned = [...fixture.tasks.map(task => task.id), ...(fixture.integrationTask ? [fixture.integrationTask.id] : [])];
    concurrency = maxConcurrentNative ?? fixture.tasks.length;
    if (concurrency > fixture.tasks.length) throw Object.assign(new RangeError('squad_concurrency_exceeds_roster'), { code: 'squad_concurrency_exceeds_roster' });
    publish();
    observer = await observe({ root: result.buildRoot, paths: fixture.paths, epoch: state.epoch, signal: stopSignal, intervalMs: 200, onObservation(event) {
      state.ingest(event);
      if (event.type === 'file.observed') { record({ source: 'file-observer', type: event.type, path: event.data.path, revision: event.data.revision }); if (event.data.revision > 1) for (const actor of actors) queueNotice(actor, event.data.path); }
    } });
    for (let offset = 0; offset < fixture.tasks.length; offset += concurrency) {
      if (stopSignal.aborted || actors.some(actor => actor.evidence.processStopped === false)) break;
      const group = fixture.tasks.slice(offset, offset + concurrency), ready = [];
      const batch = { index: result.batches.length + 1, planned: group.map(task => task.id), startedAt: Date.now(), admitted: [] };
      result.batches.push(batch);
      phase = `Connecting squad batch ${batch.index} (${group.length} planned members)`; publish();
      const setupResults = await Promise.allSettled(group.map(task => setup(task)));
      for (const settled of setupResults) { if (settled.status === 'fulfilled' && settled.value) ready.push(settled.value); else if (settled.status === 'rejected') error(null, 'actor_setup_unhandled'); }
      phase = `${ready.length} native agents building Canada: Crossroads together`; publish();
      await Promise.allSettled(ready.map(actor => execute(actor)));
      batch.admitted = ready.filter(actor => actor.evidence.admitted).map(actor => actor.id);
      batch.processesStopped = actors.every(actor => actor.evidence.processStopped === true); batch.settledAt = Date.now();
      await observer.reconcile();
      record({ type: 'batch.settled', status: batch.processesStopped ? 'quiescent' : 'stop_unconfirmed' });
    }
    await observer.reconcile();
    result.preVerification = actors.every(actor => actor.evidence.processStopped === true) ? await verify(result.buildRoot) : { correct: false, checks: [{ name: 'runtime_settled', passed: false }] };
    record({ type: 'preintegration.checked', status: result.preVerification.correct ? 'passed' : 'incomplete' });
    if (fixture.integrationTask && !stopSignal.aborted && actors.every(actor => actor.evidence.processStopped === true) && result.assigned.length === fixture.tasks.length) {
      phase = 'Independent prechecks recorded; assigning integration agent'; publish();
      const integrator = await setup(fixture.integrationTask);
      if (integrator) {
        const failed = result.preVerification.checks.filter(check => !check.passed).map(check => check.name).slice(0, 40);
        await execute(integrator, `Independent preintegration evidence: ${JSON.stringify({ correct: result.preVerification.correct, failingCheckNames: failed })}. These are check labels, not repair instructions.`);
      }
    } else { result.integrationSkipped = !fixture.integrationTask ? 'not_planned' : stopSignal.aborted ? 'squad_deadline_or_cancel' : 'previous_process_stop_unconfirmed'; }
    await observer.reconcile();
    result.verification = actors.every(actor => actor.evidence.processStopped === true) ? await verify(result.buildRoot) : { correct: false, checks: [{ name: 'runtime_settled', passed: false }] };
  } catch { error(null, stopSignal.aborted ? 'squad_deadline_or_cancel' : 'squad_setup_or_verification_failure'); }
  finally {
    observer?.close(); controller.abort();
    await Promise.allSettled(actors.filter(actor => actor.evidence.processStopped !== true).map(closeActor));
    await bounded(Promise.allSettled([...pending]), 2_000, 'notice_cleanup_deadline').catch(() => error(null, 'notification_cleanup_unconfirmed'));
    result.elapsedMs = Date.now() - started; result.events = events; result.state = state.snapshot();
    result.limits = { observerOnly: true, nativeWritesFenced: false, readBasis: 'temporal-or-unknown', nativeTransport: 'volatile-live-no-replay', maxConcurrentNative: concurrency ?? null, concurrencyExplicit: maxConcurrentNative !== undefined, capacity: { participants: 64, sourceStreams: 128, maxAssignedForSquadSources: 63, observedFiles: 128 }, maxNoticesPerActor: 3, notificationQuietMs: 2_000, noticeDelivery: 'queue', pendingNoticeUntilNativeDelivery: true, actorDeadlineMs, deadlineMs, providerConsumption: 'unverified', jevEvaluated: false };
    phase = result.verification.correct ? 'Canada: Crossroads independent checks passed' : 'Squad complete with failed/incomplete checks'; publish();
  }
  return result;
}
