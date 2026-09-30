import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceState } from './workspace-state.mjs';
import { assembleAgentContext, renderAgentContext } from './context.mjs';
import { observeFiles } from './file-observer.mjs';
import { OpenCodeClient, decodeSSE, safeRuntimeError } from './opencode.mjs';
import { startOpenCode } from './process.mjs';
import { installBenchmarkPlugin } from './benchmark-plugin.mjs';
import { measureWorkspace } from './benchmark-metrics.mjs';
import { verifyBenchmark } from '../fixtures/benchmarks.mjs';
import { extractBenchmarkToolPaths } from './benchmark-tool-paths.mjs';

const messageID = () => 'msg_' + randomUUID().replaceAll('-', '');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_NATIVE_EVENTS = 8192, MAX_RECEIPTS = 4096;
const retainedNativeType = /^session\.(?:execution\.(?:started|succeeded|failed|interrupted)|step\.(?:started|streamed|ended|failed)|tool\.(?:input\.started|called|success|failed))$/;

/** Keep the assignment intact; bounded evidence loss is visible to the recipient. */
export function boundedBenchmarkContext(context, maxBytes = 32768) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32768) throw RangeError('invalid_context_budget');
  const value = structuredClone(context);
  // Reserve the plugin's marker, newline and context ID, which are also model input.
  const limit = maxBytes - 96;
  const lists = [['peers', value.peers], ['sources', value.coverage.sources], ['readBasis', value.readBasis], ['files', value.files], ['dependencies', value.dependencies]];
  let reduced = false;
  const render = () => renderAgentContext(value);
  while (Buffer.byteLength(render()) > limit) {
    const list = lists.find(([, rows]) => rows.length);
    if (!list) throw RangeError('assigned_task_and_uncertainty_exceed_context_budget');
    list[1].pop(); value.omissions[list[0]]++; value.coverage.contextComplete = false;
    if (!reduced) {
      value.uncertainty.push('Configured context budget omitted evidence; omissions do not prove absence or irrelevance.');
      reduced = true;
    }
  }
  // A changed projection must never reuse an ID for its unbounded parent context.
  value.contextID = 'context-' + digest({ ...value, contextID: null });
  const text = render();
  if (Buffer.byteLength(text) > limit) throw RangeError('context_budget_exceeded');
  return { context: value, text, bytes: Buffer.byteLength(text), maxInjectedBytes: Buffer.byteLength('GCCTX:' + value.contextID + '\n' + text) };
}
export function assignBenchmarks(fixtures, { repeats = 3, seed = 104729 } = {}) {
  if (!Array.isArray(fixtures) || !fixtures.length || fixtures.length > 12 || !Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(seed)) throw new RangeError('invalid_benchmark_assignment');
  let rng = seed >>> 0;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  const results = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const order = [...fixtures];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const fixture of order) for (const condition of random() < .5 ? ['awareness-off', 'awareness-on'] : ['awareness-on', 'awareness-off']) {
      results.push({ id: `${fixture.id}-${repeat}-${condition}`, fixtureID: fixture.id, repeat, condition, assigned: true,
        outcome: 'not-run', correct: false, actors: fixture.tasks.map(task => ({ id: task.id, admitted: false, outcome: 'not-run', processStopped: null })) });
    }
  }
  return results;
}
async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path);
}
const contained = (root, value) => {
  if (typeof value !== 'string' || value === '~' || value.startsWith('~/') || value.includes('\\')) return null;
  const path = relative(root, resolve(root, value));
  return path && path !== '..' && !path.startsWith('../') && !path.startsWith('/') ? path : null;
};
async function nativeFeed(client, signal, callback, ready) {
  const response = await client.fetchImpl(client.endpoint + '/api/event', { signal, redirect: 'error', headers: {
    accept: 'text/event-stream', authorization: 'Basic ' + Buffer.from('opencode:' + client.password).toString('base64') } });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw Error('native_feed_unavailable');
  const reader = response.body.getReader();
  try { for await (const raw of decodeSSE(reader, signal)) {
    if (raw.type === 'server.connected') { ready(); continue; }
    if (typeof raw.data?.sessionID !== 'string' || typeof raw.type !== 'string' || !/^session\.[a-z.]{1,80}$/.test(raw.type)) continue;
    const targets = raw.type === 'session.tool.called' ? extractBenchmarkToolPaths(raw.data.input, raw.data.name) : null;
    callback({ sessionID: raw.data.sessionID, type: raw.type, seq: Number.isSafeInteger(raw.durable?.seq) ? raw.durable.seq : null,
      time: Number.isFinite(raw.created) ? raw.created : null,
      toolID:typeof raw.data.id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(raw.data.id)?raw.data.id:null,
      ...(targets ? { paths: targets.paths, pathsComplete: targets.complete } : {}),
      name: typeof raw.data.name === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(raw.data.name) ? raw.data.name : null,
      inputTokens: Number.isFinite(raw.data.tokens?.input) ? raw.data.tokens.input : null,
      outputTokens: Number.isFinite(raw.data.tokens?.output) ? raw.data.tokens.output : null,
      cost: Number.isFinite(raw.data.cost) ? raw.data.cost : null });
  } } finally { await reader.cancel().catch(() => {}); }
}
async function limit(promise, ms) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('operation_deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Assigned pilot cohort. Shared awareness observes, never fences ordinary file writes. */
export async function runBenchmarkCohort({ assignment, fixture, profile, deadlineMs = 180000, signal, onUpdate = () => {}, runtime = {} }) {
  if (!['awareness-off', 'awareness-on', 'stock', 'native-stock'].includes(assignment?.condition) || fixture.id !== assignment.fixtureID || !Number.isInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 1800000) throw Error('invalid_benchmark_cohort');
  const evaluatorTimeoutMs = fixture.evaluatorTimeoutMs ?? 6000;
  if (!Number.isInteger(evaluatorTimeoutMs) || evaluatorTimeoutMs < 1000 || evaluatorTimeoutMs > 35000) throw Error('invalid_evaluator_budget');
  const usesPlugin = fixture.nativePlugin !== false && !['stock', 'native-stock'].includes(assignment.condition);
  const expectedContext = usesPlugin && (fixture.awareness ?? assignment.condition === 'awareness-on');
  const contextBytes = usesPlugin ? fixture.contextBytes ?? 32768 : 0;
  const cacheIntervalMs = usesPlugin ? fixture.cacheIntervalMs ?? 50 : 0;
  if (usesPlugin && (!Number.isInteger(cacheIntervalMs) || cacheIntervalMs < 10 || cacheIntervalMs > 10000 || !Number.isInteger(contextBytes) || contextBytes < 1024 || contextBytes > 32768)) throw RangeError('invalid_context_configuration');
  const actorModels = assignment.actorModels ?? fixture.tasks.map(() => profile.model);
  if (!Array.isArray(actorModels) || actorModels.length !== fixture.tasks.length || actorModels.some(model => !model || typeof model.providerID !== 'string' || typeof model.id !== 'string')) throw TypeError('invalid_actor_models');
  const phases = fixture.phases ?? [fixture.tasks.map(task => task.id)];
  const phaseIDs = phases.flat();
  if (!Array.isArray(phases) || !phases.length || phases.some(phase => !Array.isArray(phase) || !phase.length) || phaseIDs.length !== fixture.tasks.length || new Set(phaseIDs).size !== phaseIDs.length || phaseIDs.some(id => !fixture.tasks.some(task => task.id === id))) throw TypeError('invalid_benchmark_phases');
  const result = structuredClone(assignment), started = performance.now();
  const stop = new AbortController(), deadline = AbortSignal.timeout(deadlineMs);
  const activeSignal = AbortSignal.any([stop.signal, deadline, ...(signal ? [signal] : [])]);
  const state = new WorkspaceState({ epoch: randomUUID() });
  const actors = [], receiptRows = [], nativeEvents = [], errors = [];
  Object.assign(result, { actors: fixture.tasks.map(task => ({ id: task.id, role: task.role ?? null, assigned: true, admitted: false, outcome: 'not-run', processStopped: null,
    tools: {}, usage: { input: null, output: null, cost: null, observedSteps: 0, missingInput:0,missingOutput:0,missingCost:0 }, context: { hookCount: 0, serializedCount: 0, unknownCount: 0 } })),
    errors, verification: { correct: false, checks: [], instructionChecks: [] }, complexity: null, deadlineMs,
    deliveryProfile: usesPlugin ? 'native-primary-context-hook' : 'stock-native-no-gangcode-plugin', sourceCoverage: 'unknown', observationMode: true, writesFenced: false,
    configID: fixture.configurationID ?? assignment.configID ?? null, system: usesPlugin ? 'gangcode' : 'stock',
    modelSet: [...new Set(actorModels.map(model => model.providerID + '/' + model.id))].sort().join('+'), actorModels: structuredClone(actorModels),
    nativePlugin: usesPlugin, contextBytes, cacheIntervalMs, phases: structuredClone(phases), phaseEvidence: [], contextProjections: [],
    evidenceBounds: { nativeEvents: MAX_NATIVE_EVENTS, pluginReceipts: MAX_RECEIPTS, nativeSelection: 'execution_step_tool_metadata', receiptBytes: 8 * 1024 * 1024 } });
  result.actors.forEach((actor, index) => { actor.model = structuredClone(actorModels[index]); });
  const publish = () => { try { onUpdate(result); } catch {} };
  const issue = (code, error, actor = null) => { if(errors.length<128)errors.push({ code, actor, ...(error ? { diagnostic: safeRuntimeError(error) } : {}) });else result.errorOmissions=(result.errorOmissions??0)+1; publish(); };
  let root, bridgeDirectory, plugin, observer, host, client, feed, pollTimer, cacheTimer, cacheWriter = Promise.resolve(), dirty = true;
  const clients = [];
  let receiptBytes = 0, receiptRemainder = '', lastStateVersion = -1, workStart, workEnd, stopUnconfirmed = false;
  let feedReady = false, liveNative = 0, peakNative = 0;
  const control = (actor, status) => state.ingest({ id: randomUUID(), epoch: state.epoch, source: 'control', sourceSeq: ++actor.controlSeq,
    participantID: actor.id, sessionID: actor.sessionID, generation: 1, type: 'agent.status', data: { status } });
  const rowTargets = row => {
    if (Array.isArray(row.paths)) {
      const valid = row.paths.length <= 64 && row.paths.every(path => typeof path === 'string' && Buffer.byteLength(path) <= 1024 && !/[\u0000-\u001f\u007f]/.test(path));
      return { paths: valid ? row.paths : [], complete: valid && row.pathsComplete === true };
    }
    // Compatibility with the historical single-path diagnostic receipts.
    return { paths: typeof row.path === 'string' ? [row.path] : [], complete: typeof row.path === 'string' };
  };
  const observedActivity = (actor, path, name, source, time) => {
    state.ingest({ id: randomUUID(), epoch: state.epoch, source, sourceSeq: ++actor.activitySeq,
      participantID: actor.id, sessionID: actor.sessionID, generation: 1, type: 'activity.observed',
      ...(Number.isFinite(time) ? { time: new Date(time).toISOString() } : {}),
      data: { path, kind: name === 'read' ? 'read' : ['write', 'edit', 'patch'].includes(name) ? 'edit' : 'unknown' } });
    dirty = true;
  };
  async function cache() {
    if (!plugin || !actors.length || !dirty && state.version === lastStateVersion) return;
    dirty = false;
    const entries = {};
    for (const actor of actors) {
      if (!actor.join) continue;
      const context = assembleAgentContext({ state, participantID: actor.id, join: actor.join,
        cause: lastStateVersion < 0 ? null : { id: `cut-${state.version}`, type: 'workspace.refresh' } });
      const projection = boundedBenchmarkContext(context, contextBytes);
      entries[actor.sessionID] = { condition: expectedContext ? 'awareness-on' : 'awareness-off', contextID: projection.context.contextID, text: projection.text, bytes: projection.bytes };
      actor.evidence.context.maxBytes = Math.max(actor.evidence.context.maxBytes ?? 0, projection.maxInjectedBytes);
      actor.evidence.context.omissions = { ...projection.context.omissions };
      if (result.contextProjections.length < 32) result.contextProjections.push({ participantID: actor.id, phase: projection.context.phase,
        contextID: projection.context.contextID, causePath: projection.context.cause?.path ?? null,
        bytes: projection.maxInjectedBytes, omissions: { ...projection.context.omissions } });
    }
    lastStateVersion = state.version;
    await atomic(plugin.cachePath, { revision: state.version, compiledAt: Date.now(), actors: entries });
  }
  let cacheRunning=false,cachePending=false;
  function scheduleCache(){cachePending=true;if(cacheRunning)return cacheWriter;cacheRunning=true;
    cacheWriter=(async()=>{while(cachePending){cachePending=false;try{await cache();}catch(error){issue('context_cache_failure',error);result.sourceCoverage='unknown';}}})().finally(()=>{cacheRunning=false;});return cacheWriter;}
  async function poll() {
    if (!plugin) return;
    const size = (await stat(plugin.receiptPath)).size;
    if (size > 8 * 1024 * 1024) throw Error('receipt_limit');
    const text = await readFile(plugin.receiptPath, 'utf8');
    receiptRemainder += text.slice(receiptBytes); receiptBytes = text.length;
    const rows = receiptRemainder.split('\n'); receiptRemainder = rows.pop();
    for (const line of rows) {
      if (!line || receiptRows.length >= MAX_RECEIPTS) continue;
      const row = JSON.parse(line); receiptRows.push(row);if(receiptRows.length>=MAX_RECEIPTS){result.receiptHistoryComplete=false;result.sourceCoverage='unknown';}
      const actor = actors.find(value => value.sessionID === row.sessionID);
      if (!actor) continue;
      if (row.type === 'bridge.error') { issue('native_context_bridge_failure', undefined, actor.id); continue; }
      if (row.type === 'context') {
        actor.evidence.context.hookCount++;
        if (Array.isArray(row.availableToolNames)) actor.evidence.context.availableToolNames = row.availableToolNames.filter(name => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(name)).slice(0, 128);
      }
      if (row.type === 'request' && row.kind === 'primary') {
        if (row.markerPresent === expectedContext) actor.evidence.context.serializedCount++;
        else actor.evidence.context.unknownCount++;
      }
      if (row.type === 'tool.before') actor.evidence.tools[row.tool] = (actor.evidence.tools[row.tool] ?? 0) + 1;
      if (row.type === 'tool.after' && row.status === 'completed') for (const path of new Set(rowTargets(row).paths.map(path => contained(root, path)))) {
        if (path && Object.hasOwn(fixture.files, path)) observedActivity(actor, path, row.tool, 'plugin', row.time);
      }
    }
  }
  let pollWriter = Promise.resolve();
  let pollRunning=false,pollPending=false;
  const schedulePoll=()=>{pollPending=true;if(pollRunning)return pollWriter;pollRunning=true;pollWriter=(async()=>{while(pollPending){pollPending=false;try{await poll();}catch(error){issue('receipt_observation_failure',error);result.sourceCoverage='unknown';}}})().finally(()=>{pollRunning=false;});return pollWriter;};
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), 'gangcode-benchmark-')));
    bridgeDirectory = await realpath(await mkdtemp(join(tmpdir(), 'gangcode-benchmark-state-')));
    result.workspace = root;
    for (const [path, content] of Object.entries(fixture.files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
    await writeFile(join(root, 'TEAM.md'), fixture.tasks.map(task => `## ${task.id}\n\n${task.text}\n`).join('\n'));
    result.seedSHA256 = createHash('sha256').update(JSON.stringify(fixture.files)).digest('hex');
    result.seedHash = result.seedSHA256;
    result.workGoalHash = createHash('sha256').update(fixture.canonicalGoal ?? JSON.stringify(fixture.tasks.map(task => task.text))).digest('hex');
    result.canonicalGoalHash = result.workGoalHash;
    if (usesPlugin) {
      plugin = await installBenchmarkPlugin(root, bridgeDirectory);
      result.pluginSHA256 = createHash('sha256').update(plugin.source).digest('hex');
    } else result.pluginSHA256 = null;
    observer = await (runtime.observeFiles ?? observeFiles)({ root, paths: Object.keys(fixture.files), epoch: state.epoch, intervalMs: 100,
      onObservation(event) { state.ingest(event); dirty = true; }, signal: activeSignal });
    host = await (runtime.startOpenCode ?? startOpenCode)({ ...profile, directory: root, stateDir: bridgeDirectory, signal: activeSignal });
    const permissions = [{ action: '*', resource: '*', effect: 'deny' }, ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
      // v2.0.16 FileAccess resolves internal tool resources relative to Location.directory;
      // write and edit both request the edit action. External access is a separate gate.
      ...['write', 'edit'].map(action => ({ action, resource: '*', effect: 'allow' })),
      { action: 'external_directory', resource: '*', effect: 'deny' },
      ...['package.json', 'TEAM.md', '.opencode/**', ...fixture.protectedPaths].flatMap(path => ['write', 'edit'].map(action => ({ action, resource: path, effect: 'deny' })))];
    await Promise.all(fixture.tasks.map(async (task, index) => {
      const evidence = result.actors[index];
      try {
        const actorClient = new (runtime.OpenCodeClient ?? OpenCodeClient)({ ...host, model: actorModels[index], directory: root, permissions });
        clients.push(actorClient); client ??= actorClient;
        const sessionID = await actorClient.createSession(`Benchmark ${assignment.id}/${task.id}`, activeSignal);
        evidence.sessionID = sessionID;
        const actor = { id: task.id, task, sessionID, client: actorClient, evidence, controlSeq: 0, activitySeq: 0, nativeSeq: null, nativeRunning: false,toolNames:new Map() };
        actors.push(actor); state.register({ id: actor.id, sessionID, generation: 1, task: { id: task.id, text: task.text, revision: 1 }, dependencies: task.dependencies });
        state.setIntention(actor.id, 'Assigned benchmark focus (coordinator): ' + task.text.slice(0, 700));
      } catch (error) { evidence.outcome = 'setup-failed'; issue('actor_setup_failure', error, task.id); }
    }));
    for (const actor of actors) actor.join = state.joinFile(actor.id, fixture.editablePaths[0]);
    for (const actor of actors) actor.join = state.joinFile(actor.id, fixture.editablePaths[0]);
    await cache();
    if (!client) throw Error('no_actor_client');
    let resolveReady; const ready = new Promise(resolve => { resolveReady = resolve; });
    feed = (runtime.nativeFeed ?? nativeFeed)(client, activeSignal, event => {
      const actor = actors.find(value => value.sessionID === event.sessionID); if (!actor) return;
      if (retainedNativeType.test(event.type)) {
        if (nativeEvents.length < MAX_NATIVE_EVENTS) nativeEvents.push(event);else result.nativeEventOmissions=(result.nativeEventOmissions??0)+1;
      } else result.nativeEventsFiltered=(result.nativeEventsFiltered??0)+1;
      if (event.seq !== null) { if (actor.nativeSeq !== null && event.seq !== actor.nativeSeq + 1) result.sourceCoverage = 'gap'; actor.nativeSeq = event.seq; }
      if (event.type === 'session.execution.started') { if (!actor.nativeRunning) liveNative++; actor.nativeRunning = true; peakNative = Math.max(peakNative, liveNative); }
      if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type) && actor.nativeRunning) { liveNative--; actor.nativeRunning = false; }
      if (event.type === 'session.step.ended') {
        actor.evidence.usage.observedSteps++;
        for(const [field,value,missing]of[['input',event.inputTokens,'missingInput'],['output',event.outputTokens,'missingOutput'],['cost',event.cost,'missingCost']]){if(typeof value==='number'&&Number.isFinite(value)&&value>=0)actor.evidence.usage[field]=(actor.evidence.usage[field]??0)+value;else actor.evidence.usage[missing]++;}
      }
      if(event.type==='session.tool.input.started'&&event.toolID&&actor.toolNames.size<256) {
        actor.toolNames.set(event.toolID,{ name:event.name,paths:[],complete:false });
        if (!usesPlugin && event.name) actor.evidence.tools[event.name] = (actor.evidence.tools[event.name] ?? 0) + 1;
      }
      if(event.type==='session.tool.called'){
        const tool=actor.toolNames.get(event.toolID);const name=tool?.name;
        const targets=rowTargets(event),normalized=targets.paths.map(path=>contained(root,path));
        if(tool){tool.paths=[...new Set(normalized.filter(Boolean))];tool.complete=targets.complete;}
        if(['write','edit','patch'].includes(name)){
          if(!tool?.complete||!targets.paths.length){actor.evidence.unknownWriteAttempts=(actor.evidence.unknownWriteAttempts??0)+1;result.writeTargetCoverage='incomplete';}
          for(const path of tool?.paths??[])if(['package.json','TEAM.md',...fixture.protectedPaths].includes(path)||path==='.opencode'||path.startsWith('.opencode/'))actor.evidence.protectedWriteAttempts=(actor.evidence.protectedWriteAttempts??0)+1;
          if(normalized.some(path=>!path))actor.evidence.externalWriteAttempts=(actor.evidence.externalWriteAttempts??0)+1;
        }
      }
      if(!usesPlugin&&event.type==='session.tool.success') {
        const tool=actor.toolNames.get(event.toolID);
        for(const path of tool?.paths??[])if(Object.hasOwn(fixture.files,path)) {
          observedActivity(actor,path,tool.name,'native',event.time);
          actor.evidence.nativeActivities=(actor.evidence.nativeActivities??0)+1;
        }
      }
      if(['session.tool.success','session.tool.failed'].includes(event.type))actor.toolNames.delete(event.toolID);
      if (event.type === 'session.tool.input.started' && ['shell', 'subagent'].includes(event.name)) actor.evidence.forbiddenToolAttempts = (actor.evidence.forbiddenToolAttempts ?? 0) + 1;
    }, () => { feedReady = true; result.sourceCoverage = 'live-no-replay'; resolveReady(); }).catch(error => {
      if (!activeSignal.aborted) { issue('native_feed_failure', error); result.sourceCoverage = 'unknown'; }
    });
    await limit(ready, 5000);
    if (usesPlugin) { pollTimer = setInterval(schedulePoll, 50); cacheTimer = setInterval(scheduleCache, cacheIntervalMs); }
    result.setupMs = performance.now() - started; workStart = performance.now(); result.outcome = 'running'; publish();
    const execute = async actor => {
      actor.evidence.startedAt = Date.now(); control(actor, 'running'); dirty = true;
      try {
        await actor.client.prompt(actor.sessionID, actor.task.text, { id: messageID(), signal: activeSignal }); actor.evidence.admitted = true; publish();
        const terminal = await actor.client.wait(actor.sessionID, activeSignal, { pollIntervalMs: 250 });
        actor.evidence.outcome = terminal.outcome; actor.evidence.idle = terminal.idle;
        control(actor, terminal.outcome === 'succeeded' ? 'completed' : 'failed');
      } catch (error) { actor.evidence.outcome = activeSignal.aborted ? 'deadline-or-cancel' : 'runtime-failed'; issue('actor_runtime_failure', error, actor.id); control(actor, 'failed'); }
      finally { actor.evidence.elapsedMs = Date.now() - actor.evidence.startedAt; dirty = true; publish(); }
    };
    for (const [phaseIndex, phase] of phases.entries()) {
      const phaseEvidence = { index: phaseIndex, actorIDs: [...phase], startedAt: Date.now(), completedAt: null };
      result.phaseEvidence.push(phaseEvidence);
      if (activeSignal.aborted) {
        for (const actor of actors.filter(actor => phase.includes(actor.id))) actor.evidence.outcome = 'deadline-or-cancel';
        phaseEvidence.skipped = true; phaseEvidence.completedAt = Date.now(); continue;
      }
      // The later phase sees the settled prior stage, without an evaluator/repair oracle.
      if (phaseIndex > 0) { for (const actor of actors.filter(actor => phase.includes(actor.id))) actor.join = state.joinFile(actor.id, fixture.editablePaths[0]); await scheduleCache(); }
      await Promise.all(actors.filter(actor => phase.includes(actor.id)).map(execute));
      phaseEvidence.completedAt = Date.now();
    }
    workEnd = performance.now();
    result.outcome = signal?.aborted ? 'cancelled' : deadline.aborted ? 'deadline' : result.actors.every(actor => actor.outcome === 'succeeded') ? 'completed' : 'failed';
  } catch (error) {
    stopUnconfirmed ||= error?.stopUnconfirmed === true;
    issue('cohort_setup_or_runtime_failure', error);
    result.outcome = signal?.aborted ? 'cancelled' : deadline.aborted ? 'deadline' : 'failed';
  } finally {
    const settling = performance.now();
    clearInterval(pollTimer); clearInterval(cacheTimer); stop.abort();
    try{observer?.close();}catch(error){issue('observer_close_failure',error);}
    for (const actorClient of clients) try{await limit(Promise.resolve(actorClient.close()),2500);}catch(error){issue('client_close_failure',error);}
    try{await limit(Promise.allSettled([cacheWriter,pollWriter]),5000);}catch(error){issue('bridge_settlement_failure',error);}
    try { if(host)await limit(host.close(),7000); } catch (error) { stopUnconfirmed = true; issue('native_stop_unconfirmed', error); }
    try{if(feed)await limit(feed,2500);}catch(error){issue('native_feed_settlement_failure',error);result.sourceCoverage='unknown';}
    try { await poll(); } catch (error) { issue('final_receipts_failure', error); }
    for (const actor of result.actors) { actor.processStopped = !stopUnconfirmed; if (actor.outcome === 'not-run') actor.outcome = 'setup-failed'; }
    result.settlementMs = performance.now() - settling;
    result.executionPeak = peakNative; result.nativeEvents = nativeEvents; result.pluginReceipts = receiptRows;
    result.setupMs ??= performance.now() - started;
    result.workMs = workStart === undefined ? null : (workEnd ?? settling) - workStart;
    result.feedReady = feedReady;
    if (stopUnconfirmed) result.outcome = 'failed';
  }
  const checking = performance.now();
  if (root && !stopUnconfirmed) {
    try { result.verification = await limit((runtime.verifyBenchmark ?? verifyBenchmark)(fixture.id, root), evaluatorTimeoutMs); }
    catch (error) { issue('evaluator_failure', error); }
    try { result.complexity = await limit((runtime.measureWorkspace ?? measureWorkspace)(root, fixture.editablePaths),6000); }
    catch (error) { issue('complexity_failure', error); }
  } else issue('verification_skipped_unconfirmed_or_missing_workspace');
  result.verification.instructionChecks ??= [];
  for(const check of result.verification.checks??[])result.verification.instructionChecks.push({name:'required_behavior:'+check.name,passed:check.passed});
  result.verification.instructionChecks.push({name:'no_observed_protected_write_attempts',passed:feedReady&&result.sourceCoverage==='live-no-replay'&&result.actors.every(actor=>!actor.protectedWriteAttempts&&!actor.externalWriteAttempts&&!actor.unknownWriteAttempts)});
  result.verification.instructionChecks.push({ name: 'no_observed_forbidden_tool_attempts', passed: feedReady && result.sourceCoverage === 'live-no-replay' && result.actors.every(actor => !actor.forbiddenToolAttempts) });
  result.artifactCorrect = result.verification.correct === true;
  const primaryRequests=receiptRows.filter(row=>row.type==='request'&&row.kind==='primary');
  const expected=expectedContext;
  result.treatmentExposure=usesPlugin?{status:result.receiptHistoryComplete===false?'unknown':primaryRequests.length&&actors.length===fixture.tasks.length&&actors.every(actor=>primaryRequests.some(row=>row.sessionID===actor.sessionID))&&primaryRequests.every(row=>row.markerPresent===expected)?'verified':primaryRequests.some(row=>typeof row.markerPresent==='boolean'&&row.markerPresent!==expected)?'failed':'unknown',primaryRequestsObserved:primaryRequests.length,requestContentObserved:primaryRequests.length>0}
    :{status:root&&!plugin?'verified':'unknown',basis:'structural_gangcode_plugin_absence',primaryRequestsObserved:0,requestContentObserved:false};
  result.validComparison=result.treatmentExposure.status==='verified'&&result.writeTargetCoverage!=='incomplete'&&result.receiptHistoryComplete!==false&&!result.nativeEventOmissions&&feedReady&&result.sourceCoverage==='live-no-replay'&&!errors.some(row=>['context_cache_failure','native_context_bridge_failure','receipt_observation_failure','native_feed_failure'].includes(row.code));
  result.correct = result.artifactCorrect && result.outcome === 'completed' && result.verification.instructionChecks.every(row=>row.passed===true);
  result.verificationMs = performance.now() - checking;
  result.elapsedMs = performance.now() - started;
  result.model = { ...profile.model }; publish(); return result;
}
