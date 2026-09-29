import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { WorkspaceState } from './workspace-state.mjs';
import { assembleAgentContext, renderAgentContext } from './context.mjs';
import { observeFiles } from './file-observer.mjs';
import { DecisionLane } from './decisions.mjs';
import { OpenCodeClient } from './opencode.mjs';
import { startOpenCode } from './process.mjs';
import { seedFixture, verifyFixture } from '../fixtures/money.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function safeReason(error) {
  const message = error?.message ?? '';
  return /^(Requires OpenCode|OpenCode |Native |Invalid |Model catalog|Provider baseURL|native_stream_|invalid |observation |file |participant |task |source |declared |settled )/.test(message) ? message.slice(0,160) : (error?.code ?? error?.name ?? 'unknown');
}
const messageID = () => 'msg_' + randomUUID().replaceAll('-', '');
function observedPath(root, value) {
  if (typeof value !== 'string') return null;
  const path = isAbsolute(value) ? relative(root, value) : value;
  return !path || path.startsWith('../') || path.includes('\\') || path.startsWith('/') ? null : path;
}

/** One assigned native trial; every outcome remains evidence, including no opportunity. */
export async function runRealTrial({ profile, awareness, onUpdate = () => {}, signal, deadlineMs = 180_000 }) {
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(deadlineMs);
  const trialSignal = signal ? AbortSignal.any([signal, deadline, controller.signal]) : AbortSignal.any([deadline, controller.signal]);
  let root, localState, fixture;
  const state = new WorkspaceState({ epoch: randomUUID() });
  const lane = new DecisionLane();
  const actors = [], resources = [], events = [], notices = [], shadow = [], pending = new Set();
  const barrier = deferred();
  const started = Date.now();
  let phase = 'Starting isolated native sessions', observer, setupFailed = false;
  const result = { kind: 'real-native-diagnostic', condition: awareness ? 'awareness-enabled' : 'awareness-disabled',
    assigned: true, model: profile.model, readBarrier: false, notificationOpportunity: false,
    notices, shadow, actors: [], verification: { correct: false, checks: [] }, errors: [] };
  const publish = () => onUpdate({ phase: `${result.condition}: ${phase}`, state: state.snapshot(), events: [...events], result });
  const record = event => { events.push({ elapsedMs: Date.now() - started, ...event }); if (events.length > 256) events.shift(); publish(); };
  const control = (actor, type, data) => state.ingest({ id: randomUUID(), epoch: state.epoch, source: 'control', sourceSeq: ++actor.controlSeq,
    participantID: actor.id, sessionID: actor.sessionID, generation: 1, type, time: new Date().toISOString(), data });
  function shadowCut(actor) {
    if (!actor || !state.agents.has(actor.id)) return;
    const promise = lane.evaluate(state.decisionCut(actor.id), { currentCut: () => state.decisionCut(actor.id), mode: 'shadow' });
    pending.add(promise); void promise.then(receipt => { shadow.push(receipt); if (shadow.length > 100) shadow.shift(); }).finally(() => pending.delete(promise));
  }
  async function verifyContextProjection(actor, id, text) {
    try {
      const response = await actor.client.context(actor.sessionID, trialSignal);
      if (!Array.isArray(response?.data)) return { projected: null, reason: 'context_schema_unknown', providerConsumption: 'unverified' };
      return { projected: response.data.some(message => message.id === id && message.type === 'user' && message.text === text) ? true : null, reason: 'native_context_checked', providerConsumption: 'unverified' };
    } catch { return { projected: null, reason: 'context_unavailable', providerConsumption: 'unverified' }; }
  }
  async function notifyChangedDependency(actor, path) {
    if (!actor?.active || !result.readBarrier || path !== 'producer.mjs') return;
    result.notificationOpportunity = true;
    shadowCut(actor);
    if (!awareness || notices.length >= 1) return;
    const notice = { id: messageID(), causePath: path, status: 'sending', elapsedMs: Date.now() - started };
    notices.push(notice);
    // Observation, not a repair instruction. resume:false forbids reopening an idle task.
    const context = assembleAgentContext({ state, participantID: actor.id, join: actor.join, cause: { id: notice.id, type: 'dependency.changed', path, revision: state.files.get(path)?.revision ?? null } });
    notice.contextID = context.contextID;
    const text = renderAgentContext(context);
    try {
      actor.noticeText = text;
      const admitted = await actor.client.prompt(actor.sessionID, text, { id: notice.id, delivery: 'steer', resume: false, signal: trialSignal });
      notice.status = 'accepted'; notice.created = admitted.created;
      actor.instructionRevision++;
      control(actor, 'control.accepted', { commandID: notice.id, instructionRevision: actor.instructionRevision });
      if (actor.delivered.has(notice.id)) { notice.status = 'delivered'; control(actor, 'control.delivered', { commandID: notice.id, instructionRevision: actor.instructionRevision }); }
      record({ actor: actor.id, type: 'notification', path, status: notice.status });
    } catch { notice.status = 'unknown'; record({ actor: actor.id, type: 'notification', path, status: 'unknown' }); }
  }
  try {
    root = await mkdtemp(join(tmpdir(), 'agent-collaboration-trial-'));
    localState = await mkdtemp(join(tmpdir(), 'agent-collaboration-native-'));
    fixture = await seedFixture(root);
    observer = await observeFiles({ root, paths: fixture.paths, epoch: state.epoch, signal: trialSignal, intervalMs: 100,
      onObservation(event) {
        state.ingest(event);
        if (event.type === 'file.observed') {
          record({ source: 'file-observer', type: event.type, path: event.data.path, revision: event.data.revision });
          if (event.data.path === 'producer.mjs' && event.data.revision > 1) {
            const promise = notifyChangedDependency(actors.find(actor => actor.id === 'consumer'), event.data.path);
            pending.add(promise); void promise.finally(() => pending.delete(promise));
          }
        }
      } });
    for (const id of ['producer', 'consumer']) {
      const server = await startOpenCode({ ...profile, directory: root, stateDir: join(localState, id), signal: trialSignal });
      resources.push(server);
      const client = new OpenCodeClient({ endpoint: server.endpoint, password: server.password, directory: root, model: profile.model });
      const sessionID = await client.createSession(`Agent Collaboration / ${id}`, trialSignal);
      const actor = { id, client, server, sessionID, controlSeq: 0, instructionRevision: 0, active: false, synced: deferred(), delivered: new Set(), nativeCursor: null, gap: false, observerSeq: 0, executions: [] };
      actors.push(actor);
      state.register({ id, sessionID, generation: 1, task: { id: `${id}-money`, revision: 1, text: id === 'producer' ? fixture.producerTask : fixture.consumerTask }, dependencies: id === 'consumer' ? fixture.dependencies : [] });
      actor.join = state.joinFile(id, 'producer.mjs');
      actor.stream = (async () => {
        try {
          for await (const event of client.events(sessionID, { transport: 'live', signal: trialSignal })) {
            if (event.type === 'server.connected') { actor.synced.resolve(true); continue; }
            if (actor.nativeCursor !== null && event.seq !== actor.nativeCursor + 1) actor.gap = true;
            actor.nativeCursor = event.seq;
            const path = observedPath(root, event.data.input?.path);
            const successfulTool = event.type === 'session.tool.success';
            const data = successfulTool && path ? { path, kind: event.data.toolName === 'read' ? 'read' : ['edit', 'write'].includes(event.data.toolName) ? 'edit' : 'unknown', location: event.data.input.offset == null ? null : { offset: event.data.input.offset, limit: event.data.input.limit ?? null } } : { complete: !actor.gap, reason: actor.gap ? 'native log sequence gap' : null };
            state.ingest({ id: event.id, epoch: state.epoch, source: 'opencode', sourceSeq: event.seq, participantID: id, sessionID, generation: 1, type: successfulTool && path ? 'activity.observed' : 'coverage.changed', time: event.time, data });
            const inboxID = event.data.inboxID ?? event.data.id;
            if (event.type === 'session.tool.input.started' && actor.firstToolSeq === undefined) actor.firstToolSeq = event.seq;
            if (event.type === 'session.inbox.delivered' && inboxID === actor.initialMessageID) actor.initialDeliveredSeq = event.seq;
            if (event.type === 'session.execution.started') actor.executions.push({ started: event.time });
            if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
              actor.active = false;
              const execution = actor.executions.at(-1); if (execution) execution.settled = event.time;
            }
            if (event.type === 'session.inbox.delivered' && inboxID) {
              actor.delivered.add(inboxID);
              const notice = notices.find(item => item.id === inboxID);
              if (notice && notice.status === 'accepted') { notice.status = 'delivered'; control(actor, 'control.delivered', { commandID: notice.id, instructionRevision: actor.instructionRevision }); }
            }
            if (successfulTool || event.type.includes('inbox') || event.type.includes('execution')) record({ actor: id, type: event.type, path, tool: event.data.toolName, seq: event.seq, inboxID: event.type.includes('inbox') ? inboxID : undefined });
            if (id === 'consumer' && successfulTool && event.data.toolName === 'read' && path === 'producer.mjs' && !result.readBarrier) {
              result.readBarrier = true; result.readBarrierAtMs = Date.now() - started; barrier.resolve('read'); shadowCut(actor);
            }
          }
          if (!trialSignal.aborted) throw new Error('native_stream_ended');
        } catch { if (!trialSignal.aborted) { result.errors.push({ actor: id, code: 'native_stream_unavailable' }); actor.synced.resolve(false);
            state.ingest({ id: randomUUID(), epoch: state.epoch, source: 'observer', sourceSeq: ++actor.observerSeq, participantID: id, sessionID, generation: 1, type: 'coverage.changed', data: { complete: false, reason: 'native source unavailable' } }); } }
      })();
      const ready = await Promise.race([actor.synced.promise, new Promise(resolve => { const timer = setTimeout(() => resolve(false), 5_000); timer.unref(); })]);
      if (!ready) throw new Error('native_stream_not_ready');
    }
    const consumer = actors.find(actor => actor.id === 'consumer');
    const producer = actors.find(actor => actor.id === 'producer');
    async function execute(actor, task) {
      actor.active = true;
      control(actor, 'agent.status', { status: 'running' });
      actor.join = state.joinFile(actor.id, 'producer.mjs');
      const initial = awareness ? assembleAgentContext({ state, participantID: actor.id, join: actor.join }) : null;
      actor.initialContextID = initial?.contextID ?? null;
      const prompt = `${task}\nUse file tools only; do not run processes or subagents. Keep work focused on the assigned outcome.` + (initial ? `\n${renderAgentContext(initial)}` : '');
      try {
        actor.initialPrompt = prompt;
        actor.initialMessageID = messageID();
        actor.admission = await actor.client.prompt(actor.sessionID, prompt, { id: actor.initialMessageID, signal: trialSignal });
        record({ actor: actor.id, type: 'task.admitted' });
        actor.terminal = await actor.client.wait(actor.sessionID, trialSignal); return actor.terminal; }
      finally { actor.active = false; control(actor, 'agent.status', { status: actor.terminal?.outcome === 'succeeded' ? 'completed' : 'failed' }); }
    }
    phase = 'Consumer working; waiting for observed dependency read'; publish();
    const consumerWork = execute(consumer, fixture.consumerTask);
    const consumerOutcome = consumerWork.then(() => 'completed', () => 'failed');
    const barrierOutcome = await Promise.race([barrier.promise, consumerOutcome, new Promise(resolve => { const timer = setTimeout(() => resolve('read-timeout'), 45_000); timer.unref(); })]);
    result.barrierOutcome = barrierOutcome;
    phase = 'Producer migration alongside consumer'; publish();
    const producerWork = execute(producer, fixture.producerTask);
    await Promise.allSettled([producerWork, consumerWork]);
    await observer.reconcile();
    await Promise.allSettled([...pending]);
    for (const actor of actors) {
      actor.initialContextProof = actor.initialContextID && actor.admission ? await verifyContextProjection(actor, actor.admission.id, actor.initialPrompt) : null;
      for (const notice of notices) if (actor.noticeText && actor.id === 'consumer') notice.contextProof = await verifyContextProjection(actor, notice.id, actor.noticeText);
    }
    result.actors = actors.map(actor => ({ id: actor.id, admitted: !!actor.admission, outcome: actor.terminal?.outcome ?? 'unknown', idle: actor.terminal?.idle ?? null, executions: actor.executions, initialContextID: actor.initialContextID, initialContextProof: actor.initialContextProof, initialDeliveredBeforeFirstTool: actor.initialDeliveredSeq !== undefined && actor.firstToolSeq !== undefined ? actor.initialDeliveredSeq < actor.firstToolSeq : null }));
    result.admissionOverlap = !!producer.admission && !!consumer.terminal && producer.admission.created < consumer.terminal.idle;
    result.executionOverlap = !producer.executions.some(a => Number.isFinite(a.started) && Number.isFinite(a.settled)) || !consumer.executions.some(a => Number.isFinite(a.started) && Number.isFinite(a.settled)) ? null : producer.executions.some(a => consumer.executions.some(b => Number.isFinite(a.started) && Number.isFinite(a.settled) && Number.isFinite(b.started) && Number.isFinite(b.settled) && a.started < b.settled && b.started < a.settled));
    for (const actor of actors) if (actor.terminal?.outcome !== 'succeeded') result.errors.push({ actor: actor.id, code: 'task_not_succeeded' });
  } catch (error) { setupFailed = true; result.errors.push({ code: trialSignal.aborted ? 'trial_deadline_or_cancel' : 'setup_or_runtime_failure', reason: safeReason(error) }); }
  finally {
    observer?.close(); lane.close(); controller.abort();
    for (const actor of actors) actor.client.close();
    const stopped = await Promise.allSettled(resources.map(server => server.close()));
    if (stopped.some(item => item.status === 'rejected')) { setupFailed = true; result.errors.push({ code: 'native_stop_unconfirmed' }); }
    await Promise.allSettled(actors.map(actor => actor.stream));
  }
  result.verification = setupFailed ? { correct: false, checks: [{ name: 'runtime_settled', passed: false }] } : await verifyFixture(root);
  result.elapsedMs = Date.now() - started;
  result.state = state.snapshot(); result.events = events;
  result.limits = { observerOnly: true, readBasis: 'temporal-or-unknown', nativeWritesFenced: false, decisionMode: 'deterministic-shadow', jevEvaluated: false, nativeTransport: 'volatile-live-no-replay', fixtureRoot: root };
  phase = result.verification.correct ? 'Independent checks passed' : 'Independent checks failed / incomplete'; publish();
  return result;
}
