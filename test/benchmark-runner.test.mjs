import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assignBenchmarks, runBenchmarkCohort, boundedBenchmarkContext } from '../src/benchmark.mjs';
import { installBenchmarkPlugin } from '../src/benchmark-plugin.mjs';
import { configureBenchmarkFixture } from '../fixtures/benchmark-configurations.mjs';
import { benchmarkFixtures } from '../fixtures/benchmarks.mjs';
import { extractBenchmarkToolPaths } from '../src/benchmark-tool-paths.mjs';

const fixture = { id: 'runner-fault', files: { 'work.mjs': 'export const value = 0;\n' },
  editablePaths: ['work.mjs'], protectedPaths: [], tasks: [
    { id: 'a', text: 'Implement the producer business outcome.', dependencies: [] },
    { id: 'b', text: 'Implement the consumer business outcome.', dependencies: ['work.mjs'] },
  ] };
const profile = { model: { providerID: 'fake', id: 'deterministic' } };
const assignment = condition => assignBenchmarks([fixture], { repeats: 1 }).find(row => row.condition === condition);
const privateError = () => Error('PRIVATE PROVIDER PROSE MUST NOT APPEAR');

async function cohort(t, options = {}) {
  const selectedFixture = options.fixture ?? fixture;
  const selectedAssignment = { ...assignment(options.condition ?? 'awareness-off'), fixtureID: selectedFixture.id,
    ...(options.actorModels ? { actorModels: options.actorModels } : {}) };
  const calls = { prompts: [], waits: [], timeline: [], clients: [], clientCloses: 0, close: 0, observerClose: 0, verification: 0, measure: 0, directories: [] };
  t.after(async () => { await Promise.all(calls.directories.map(path => rm(path, { recursive: true, force: true }))); });
  let emit;
  const runtime = {
    async observeFiles() { return { close() { calls.observerClose++; if (options.observerCloseFailure) throw privateError(); } }; },
    async startOpenCode(input) {
      calls.directories.push(input.directory, input.stateDir);
      if (options.setupStopUnknown) throw Object.assign(privateError(), { stopUnconfirmed: true });
      return { endpoint: 'http://127.0.0.1:1', password: 'fake', async close() {
        calls.close++; if (options.closeFailure) throw privateError();
      } };
    },
    OpenCodeClient: class {
      constructor(input) { calls.permissions = input.permissions; calls.clientDirectory = input.directory; calls.clients.push(input); this.model = input.model; }
      async createSession(title) { const id = title.split('/').at(-1); if (options.sessionFailure === id) throw privateError(); return 'ses_' + id; }
      async prompt(sessionID, text, input) {
        calls.prompts.push({ sessionID, text, signal: input.signal, model: this.model }); calls.timeline.push({ type: 'prompt', sessionID });
        if (options.admissionFailure === sessionID) throw privateError();
        emit({ sessionID, type: 'session.execution.started', seq: null, time: Date.now() });
        if (options.provenReceipts) await writeFile(join(calls.directories[1], 'receipts.jsonl'), JSON.stringify({ type: 'request',
          sessionID, kind: 'primary', markerPresent: (options.condition ?? 'awareness-off') === 'awareness-on' }) + '\n', { flag: 'a' });
        if (options.sourceGap && sessionID === 'ses_a') {
          emit({ sessionID, type: 'session.step.started', seq: 1, time: Date.now() });
          emit({ sessionID, type: 'session.step.ended', seq: 3, time: Date.now() });
        }
        if (options.forbiddenTool) emit({ sessionID, type: 'session.tool.input.started', seq: null, time: Date.now(), name: 'shell' });
        if (options.nativeActivity) {
          emit({ sessionID, type: 'session.tool.input.started', seq: null, time: Date.now(), toolID: 'tool_' + sessionID, name: 'read' });
          emit({ sessionID, type: 'session.tool.called', seq: null, time: Date.now(), toolID: 'tool_' + sessionID, path: join(calls.directories[0], 'work.mjs') });
          emit({ sessionID, type: 'session.tool.success', seq: null, time: Date.now(), toolID: 'tool_' + sessionID });
        }
        if (options.patchInput && sessionID === 'ses_a') {
          const name = options.toolName ?? 'patch';
          const targets = extractBenchmarkToolPaths(options.patchInput, name);
          emit({ sessionID, type: 'session.tool.input.started', seq: null, time: Date.now(), toolID: 'patch_a', name });
          emit({ sessionID, type: 'session.tool.called', seq: null, time: Date.now(), toolID: 'patch_a', paths: targets.paths, pathsComplete: targets.complete });
          emit({ sessionID, type: options.patchFailed ? 'session.tool.failed' : 'session.tool.success', seq: null, time: Date.now(), toolID: 'patch_a' });
        }
        if (options.nativeBurst && sessionID === 'ses_a') for (let i = 0; i < options.nativeBurst; i++) {
          emit({ sessionID, type: options.deltaBurst ? 'session.message.part.delta' : 'session.step.started', seq: null, time: Date.now() });
        }
      }
      async wait(sessionID, signal) {
        calls.waits.push(sessionID);
        if (options.hang === sessionID) await new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        else await new Promise(resolve => setTimeout(resolve, 3));
        emit({ sessionID, type: 'session.execution.succeeded', seq: null, time: Date.now() });
        calls.timeline.push({ type: 'settled', sessionID });
        return { outcome: 'succeeded', idle: Date.now() };
      }
      close() { calls.clientClosed = true; calls.clientCloses++; if (options.clientCloseFailure) throw privateError(); }
    },
    nativeFeed(client, signal, callback, ready) {
      emit = callback; ready();
      return new Promise((resolve, reject) => {
        const aborted = () => options.feedRejectOnAbort ? reject(signal.reason) : resolve();
        if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
      });
    },
    async verifyBenchmark(id, root) {
      calls.verification++; calls.timeline.push({ type: 'verify' });
      assert.equal(calls.close, 1, 'verification must follow shared host stop');
      assert.equal(calls.clientClosed, true);
      if (options.evaluatorFailure) throw privateError();
      return { correct: true, checks: [{ name: 'business_outcome', passed: true }], instructionChecks: [] };
    },
    async measureWorkspace() { calls.measure++; return { classification: 'lexical-proxy' }; },
  };
  const result = await runBenchmarkCohort({ assignment: selectedAssignment, fixture: selectedFixture, profile,
    deadlineMs: options.deadlineMs ?? 1000, runtime });
  assert.equal(result.actors.length, selectedFixture.tasks.length, 'every assigned actor must remain in the denominator');
  assert.equal(JSON.stringify(result).includes('PRIVATE PROVIDER PROSE'), false, 'provider prose must not enter evidence');
  return { result, calls };
}

test('unconfirmed setup cleanup retains both assignments and skips verification', async t => {
  const { result, calls } = await cohort(t, { setupStopUnknown: true });
  assert.equal(result.outcome, 'failed'); assert.equal(result.correct, false);
  assert.equal(calls.verification, 0); assert.equal(calls.observerClose, 1);
  assert.ok(result.actors.every(actor => actor.outcome === 'setup-failed' && actor.processStopped === false));
  assert.ok(result.errors.some(error => error.code === 'verification_skipped_unconfirmed_or_missing_workspace'));
});

test('one rejected admission does not prevent its peer from running and settling', async t => {
  const { result, calls } = await cohort(t, { admissionFailure: 'ses_a' });
  assert.equal(result.actors[0].outcome, 'runtime-failed'); assert.equal(result.actors[0].admitted, false);
  assert.equal(result.actors[1].outcome, 'succeeded'); assert.equal(result.actors[1].admitted, true);
  assert.deepEqual(calls.waits, ['ses_b']); assert.equal(calls.close, 1); assert.equal(calls.verification, 1);
  assert.ok(result.actors.every(actor => actor.processStopped === true)); assert.equal(result.correct, false);
});

test('one failed session setup preserves both actors while the admitted peer runs', async t => {
  const { result, calls } = await cohort(t, { sessionFailure: 'a' });
  assert.equal(result.actors[0].outcome, 'setup-failed'); assert.equal(result.actors[1].outcome, 'succeeded');
  assert.deepEqual(calls.waits, ['ses_b']); assert.equal(calls.close, 1); assert.equal(result.correct, false);
});

test('shared stop failure prevents hidden checks even after successful native outcomes', async t => {
  const { result, calls } = await cohort(t, { closeFailure: true });
  assert.ok(result.actors.every(actor => actor.outcome === 'succeeded' && actor.processStopped === false));
  assert.equal(calls.verification, 0); assert.equal(calls.measure, 0);
  assert.equal(result.outcome, 'failed'); assert.equal(result.correct, false);
  assert.ok(result.errors.some(error => error.code === 'native_stop_unconfirmed'));
});

test('evaluator failure retains native successes but fails artifact correctness', async t => {
  const { result, calls } = await cohort(t, { evaluatorFailure: true });
  assert.ok(result.actors.every(actor => actor.outcome === 'succeeded' && actor.processStopped));
  assert.equal(result.correct, false); assert.equal(result.artifactCorrect, false);
  assert.equal(calls.measure, 1); assert.ok(result.errors.some(error => error.code === 'evaluator_failure'));
});

test('observed forbidden tool attempts fail instruction qualification despite valid artifacts', async t => {
  const { result } = await cohort(t, { forbiddenTool: true });
  assert.equal(result.artifactCorrect, true); assert.equal(result.outcome, 'completed'); assert.equal(result.correct, false);
  assert.equal(result.verification.instructionChecks.find(row => row.name === 'no_observed_forbidden_tool_attempts').passed, false);
});

test('unproven treatment exposure remains unknown and cannot qualify a comparison', async t => {
  const { result } = await cohort(t, { condition: 'awareness-on' });
  assert.equal(result.artifactCorrect, true);
  assert.equal(result.treatmentExposure.status, 'unknown'); assert.equal(result.validComparison, false);
});

test('native source gap invalidates a comparison even with matching request receipts', async t => {
  const { result } = await cohort(t, { condition: 'awareness-on', provenReceipts: true, sourceGap: true });
  assert.equal(result.treatmentExposure.status, 'verified'); assert.equal(result.sourceCoverage, 'gap');
  assert.equal(result.validComparison, false); assert.equal(result.correct, false);
  assert.equal(result.artifactCorrect, true);
});

for (const option of ['observerCloseFailure', 'clientCloseFailure']) test(`${option} cannot prevent host stop or lose assigned outcomes`, async t => {
  const { result, calls } = await cohort(t, { [option]: true });
  assert.equal(calls.close, 1); assert.ok(result.actors.every(actor => actor.processStopped === true));
  assert.ok(result.errors.length > 0);
});

test('deadline is a retained timeout outcome, not a successful duration sample', async t => {
  const { result, calls } = await cohort(t, { hang: 'ses_a', deadlineMs: 80 });
  assert.equal(result.outcome, 'deadline'); assert.equal(result.actors[0].outcome, 'deadline-or-cancel');
  assert.equal(result.actors[1].outcome, 'succeeded'); assert.equal(result.correct, false);
  assert.ok(result.workMs >= 0 && result.workMs < 1000); assert.equal(calls.close, 1);
  assert.ok(result.actors.every(actor => actor.processStopped === true));
});

test('both conditions retain identical original task prompts and tool permissions', async t => {
  const off = await cohort(t), on = await cohort(t, { condition: 'awareness-on' });
  assert.deepEqual(off.calls.prompts.map(row => row.text), on.calls.prompts.map(row => row.text));
  const normalize = rows => rows.map(row => ({ ...row, resource: row.resource.replace(/\/[^*]+\/ingress-benchmark-[^/]+/, '/WORKSPACE') }));
  assert.deepEqual(normalize(off.calls.permissions), normalize(on.calls.permissions));
  assert.equal(off.result.seedSHA256, on.result.seedSHA256);
});

test('physical harness paths and native location-relative write/edit resources match the pinned permission contract', async t => {
  const { result, calls } = await cohort(t);
  const physicalRoot = await realpath(result.workspace);
  assert.equal(calls.directories[0], physicalRoot, 'native host must receive the physical path, including macOS /private/var');
  assert.equal(calls.clientDirectory, physicalRoot, 'client and native resource resolution must use the same path spelling');
  assert.equal(result.workspace, physicalRoot, 'retained workspace and verification root must share physical identity');
  for (const action of ['write', 'edit']) {
    const allow = calls.permissions.find(row => row.action === action && row.effect === 'allow');
    assert.equal(allow.resource, '*', 'native internal resources are relative, not absolute workspace paths');
    for (const path of ['package.json', 'TEAM.md', '.opencode/**']) {
      assert.ok(calls.permissions.some(row => row.action === action && row.effect === 'deny' && row.resource === path),
        `${action} protection for ${path} must use the native location-relative resource spelling`);
    }
  }
  assert.ok(calls.permissions.some(row => row.action === 'external_directory' && row.resource === '*' && row.effect === 'deny'),
    'wildcard edit permission must retain the independent external-directory denial');
});

test('stock mode installs no Ingress plugin and observes native tools without request-body claims', async t => {
  const stock = configureBenchmarkFixture(fixture, 'stock-parallel-pair');
  const { result, calls } = await cohort(t, { fixture: stock, nativeActivity: true });
  await assert.rejects(stat(join(result.workspace, '.opencode/plugins/ingress-benchmark')), { code: 'ENOENT' });
  assert.equal(result.pluginSHA256, null); assert.equal(result.system, 'stock');
  assert.deepEqual(result.pluginReceipts, []); assert.equal(result.contextBytes, 0); assert.equal(result.cacheIntervalMs, 0);
  assert.equal(result.treatmentExposure.status, 'verified');
  assert.equal(result.treatmentExposure.basis, 'structural_ingress_plugin_absence');
  assert.equal(result.treatmentExposure.requestContentObserved, false); assert.equal(result.validComparison, true);
  assert.ok(result.actors.every(actor => actor.tools.read === 1 && actor.nativeActivities === 1));
  assert.equal(calls.clientCloses, 2);
});

test('normal teardown SSE abort retains observed live coverage instead of inventing source failure', async t => {
  const { result } = await cohort(t, { fixture: configureBenchmarkFixture(fixture, 'stock-parallel-pair'), feedRejectOnAbort: true });
  assert.equal(result.outcome, 'completed'); assert.equal(result.sourceCoverage, 'live-no-replay');
  assert.equal(result.validComparison, true); assert.equal(result.correct, true);
  assert.equal(result.errors.some(row => row.code === 'native_feed_failure'), false);
});

test('delta traffic does not consume retained metadata capacity; true metadata overflow is explicit', async t => {
  const stock = configureBenchmarkFixture(fixture, 'stock-parallel-pair');
  const deltas = await cohort(t, { fixture: stock, nativeBurst: 9000, deltaBurst: true });
  assert.equal(deltas.result.nativeEventsFiltered, 9000);
  assert.equal(deltas.result.nativeEvents.length, 4); assert.equal(deltas.result.nativeEventOmissions ?? 0, 0);
  assert.equal(deltas.result.validComparison, true);
  const overflow = await cohort(t, { fixture: stock, nativeBurst: 8300 });
  assert.equal(overflow.result.nativeEvents.length, 8192); assert.ok(overflow.result.nativeEventOmissions > 0);
  assert.equal(overflow.result.validComparison, false);
});

test('actor model overrides reach distinct clients and their own prompts on one shared host', async t => {
  const models = [{ providerID: 'fake', id: 'one' }, { providerID: 'fake', id: 'two' }];
  const { result, calls } = await cohort(t, { actorModels: models });
  assert.deepEqual(calls.clients.map(client => client.model), models);
  assert.deepEqual(calls.prompts.map(prompt => prompt.model), models);
  assert.deepEqual(result.actors.map(actor => actor.model), models);
  assert.equal(result.modelSet, 'fake/one+fake/two'); assert.equal(calls.close, 1); assert.equal(calls.clientCloses, 2);
});

test('stock multi-file patch success records all declared target activity and counts the tool once', async t => {
  const selected = { ...configureBenchmarkFixture(fixture, 'stock-parallel-pair'), files: { ...fixture.files, 'other.mjs': 'export const other=0;' } };
  const patchInput = { patchText: '*** Begin Patch\n*** Update File: work.mjs\n@@\n-old\n+new\n*** Add File: other.mjs\n+PRIVATE DIFF CONTENT\n*** End Patch' };
  const { result } = await cohort(t, { fixture: selected, patchInput });
  assert.equal(result.actors[0].tools.patch, 1); assert.equal(result.actors[0].nativeActivities, 2);
  assert.equal(result.actors[0].unknownWriteAttempts ?? 0, 0); assert.equal(result.correct, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE DIFF CONTENT'), false);
});

test('patch moves diagnose protected and external targets after normalization', async t => {
  const patchInput = { patchText: '*** Begin Patch\n*** Update File: work.mjs\n*** Move to: sub/../package.json\n@@\n-a\n+b\n*** Add File: ../outside.mjs\n+x\n*** End Patch' };
  const { result } = await cohort(t, { fixture: configureBenchmarkFixture(fixture, 'stock-parallel-pair'), patchInput, patchFailed: true });
  assert.equal(result.actors[0].protectedWriteAttempts, 1); assert.equal(result.actors[0].externalWriteAttempts, 1);
  assert.equal(result.actors[0].unknownWriteAttempts ?? 0, 0); assert.equal(result.actors[0].nativeActivities ?? 0, 0);
  assert.equal(result.validComparison, true, 'known noncompliance is retained in the eligible comparison denominator'); assert.equal(result.correct, false);
});

test('ordinary writes normalize dot paths before protected-target scoring without excluding observed misbehavior', async t => {
  for (const filePath of ['./TEAM.md', 'a/../TEAM.md']) {
    const { result } = await cohort(t, { fixture: configureBenchmarkFixture(fixture, 'stock-parallel-pair'),
      toolName: 'write', patchInput: { filePath }, patchFailed: true });
    assert.equal(result.actors[0].protectedWriteAttempts, 1, filePath);
    assert.equal(result.actors[0].unknownWriteAttempts ?? 0, 0);
    assert.equal(result.validComparison, true); assert.equal(result.correct, false);
  }
});

test('malformed patch targets fail instruction/source qualification without fabricated activity', async t => {
  const { result } = await cohort(t, { fixture: configureBenchmarkFixture(fixture, 'stock-parallel-pair'),
    patchInput: { patchText: '*** Begin Patch\n*** Update File: work.mjs\nnot a diff\n*** End Patch' }, patchFailed: true });
  assert.equal(result.writeTargetCoverage, 'incomplete'); assert.equal(result.actors[0].unknownWriteAttempts, 1);
  assert.equal(result.validComparison, false); assert.equal(result.correct, false);
  assert.equal(result.actors[0].nativeActivities ?? 0, 0);
});

test('builder/reviewer phases settle sequentially with no hidden evaluation between phases', async t => {
  const configured = configureBenchmarkFixture(fixture, 'builder-reviewer');
  const { result, calls } = await cohort(t, { fixture: configured, condition: 'awareness-on' });
  assert.equal(result.executionPeak, 1); assert.equal(calls.verification, 1);
  const builderSettled = calls.timeline.findIndex(row => row.type === 'settled' && row.sessionID === 'ses_builder');
  const reviewerPrompt = calls.timeline.findIndex(row => row.type === 'prompt' && row.sessionID === 'ses_reviewer');
  const verify = calls.timeline.findIndex(row => row.type === 'verify');
  assert.ok(builderSettled < reviewerPrompt && reviewerPrompt < verify);
  assert.equal(result.phaseEvidence.length, 2);
  assert.ok(result.phaseEvidence[0].completedAt <= result.phaseEvidence[1].startedAt);
  assert.equal(result.workGoalHash, createHash('sha256').update(configured.canonicalGoal).digest('hex'));
  assert.equal(result.seedHash, result.seedSHA256); assert.equal(result.configID, 'builder-reviewer');
  assert.ok(result.contextProjections.filter(row => row.phase === 'update').every(row => row.causePath === null));
});

for (const count of [4, 8]) test(`${count} configured roles are admitted concurrently and every client closes`, async t => {
  const configured = configureBenchmarkFixture(fixture, count === 4 ? 'ingress-four' : 'ingress-eight');
  const { result, calls } = await cohort(t, { fixture: configured, condition: 'awareness-on' });
  assert.equal(result.executionPeak, count); assert.equal(calls.prompts.length, count); assert.equal(calls.clientCloses, count);
  assert.ok(result.actors.every(actor => actor.admitted && actor.outcome === 'succeeded' && actor.processStopped));
});

test('a 4 KiB test context preserves the complete goal and exposes omitted evidence when it fits', async t => {
  const selected = { ...configureBenchmarkFixture(fixture, 'ingress-pair-small-context'), contextBytes: 4096 };
  const { result, calls } = await cohort(t, { fixture: selected, condition: 'awareness-on' });
  const cache = JSON.parse(await readFile(join(calls.directories[1], 'context.json'), 'utf8'));
  for (const [index, actor] of result.actors.entries()) {
    const entry = cache.actors[actor.sessionID], json = JSON.parse(entry.text.slice(entry.text.indexOf('{')));
    assert.equal(json.task.text, selected.tasks[index].text);
    assert.ok(Buffer.byteLength('GCCTX:' + entry.contextID + '\n' + entry.text) <= 4096);
    if (Object.values(json.omissions).some(value => value > 0)) {
      assert.equal(json.coverage.contextComplete, false); assert.ok(json.uncertainty.some(text => text.includes('omitted evidence')));
    }
  }
  assert.equal(result.cacheIntervalMs, 100); assert.equal(result.contextBytes, 4096);
});

test('an impossible budget fails explicitly instead of shortening the assigned task', () => {
  const context = { version: 1, type: 'agent.workspace-context', contextID: 'original', task: { text: 'x'.repeat(4000) },
    peers: [], files: [], readBasis: [], dependencies: [], coverage: { sources: [] }, uncertainty: ['Coverage unknown.'],
    omissions: { peers: 0, files: 0, dependencies: 0, readBasis: 0, sources: 0 } };
  assert.throws(() => boundedBenchmarkContext(context, 4096), /assigned_task_and_uncertainty/);
  assert.equal(context.task.text.length, 4000); assert.equal(context.contextID, 'original');
});

test('all six actual configured small-context fixture goals fit with explicit evidence omissions', async t => {
  for (const base of benchmarkFixtures) {
    const configured = configureBenchmarkFixture(base, 'ingress-pair-small-context');
    const { result } = await cohort(t, { fixture: configured, condition: 'awareness-on' });
    assert.equal(result.outcome, 'completed', `${base.id}: ${JSON.stringify(result.errors)}`);
    assert.equal(configured.contextBytes, 8192, 'the preflighted study budget is 8 KiB');
    assert.ok(result.actors.every(actor => actor.context.maxBytes <= configured.contextBytes), base.id);
  }
});

async function pluginHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-plugin-test-'));
  const bridge = await mkdtemp(join(tmpdir(), 'benchmark-plugin-bridge-test-'));
  let cleanup;
  t.after(async () => { cleanup?.(); await Promise.all([root, bridge].map(path => rm(path, { recursive: true, force: true }))); });
  const plugin = await installBenchmarkPlugin(root, bridge);
  await writeFile(plugin.cachePath, JSON.stringify({ revision: 1, compiledAt: Date.now(), actors: {
    off: { condition: 'awareness-off', contextID: 'off-1', text: 'peer task evidence', bytes: 18 },
    on: { condition: 'awareness-on', contextID: 'on-1', text: 'peer task evidence', bytes: 18 },
  } }));
  const sourcePath = join(bridge, 'plugin.mjs'); await writeFile(sourcePath, plugin.source);
  const module = await import(pathToFileURL(sourcePath).href);
  const hooks = {};
  cleanup = await module.default.setup({ app: { version: 'deterministic' },
    session: { async hook(name, fn) { hooks[name] = fn; } }, tool: { async hook(name, fn) { hooks['tool.' + name] = fn; } } });
  return { hooks, plugin };
}

test('generated bridge leaves baseline context untouched and proves only on-arm serialization', async t => {
  const { hooks, plugin } = await pluginHarness(t);
  const off = { sessionID: 'off', system: [{ type: 'text', text: 'original instruction' }], tools: { read: {}, patch: {}, glob: {}, custom_native_tool: {} } };
  const on = structuredClone({ ...off, sessionID: 'on' }); const original = structuredClone(off);
  await hooks.context(off); await hooks.context(on);
  assert.deepEqual(off, original); assert.deepEqual(on.tools, original.tools);
  assert.equal(on.system.length, 2); assert.equal(on.system[1].text, 'GCCTX:on-1\npeer task evidence');
  for (const event of [off, on]) await hooks['http.request']({ sessionID: event.sessionID, kind: 'primary',
    request: new Request('http://127.0.0.1:1/mock', { method: 'POST', body: JSON.stringify({ system: event.system }) }) });
  const rows = (await readFile(plugin.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const requests = rows.filter(row => row.type === 'request');
  assert.deepEqual(requests.map(row => [row.sessionID, row.markerPresent]), [['off', false], ['on', true]]);
  assert.ok(rows.filter(row => row.type === 'context' && row.sessionID === 'off').every(row => !row.injected && row.bytes === 0));
  assert.deepEqual(rows.find(row => row.type === 'context').availableToolNames, Object.keys(original.tools));
});

test('generated plugin patch receipts retain all target paths without diff or tool-output prose', async t => {
  const { hooks, plugin } = await pluginHarness(t);
  const event = { sessionID: 'on', tool: 'patch', id: 'p', messageID: 'm', input: { value: JSON.stringify({
    patchText: '*** Begin Patch\n*** Update File: source.mjs\n*** Move to: dest.mjs\n@@\n-old\n+PRIVATE DIFF CONTENT\n*** End Patch' }) }, status: 'completed' };
  await hooks['tool.execute.before'](event); await hooks['tool.execute.after'](event);
  const rows = (await readFile(plugin.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type.startsWith('tool.'));
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.pathsComplete && JSON.stringify(row.paths) === JSON.stringify(['source.mjs', 'dest.mjs'])));
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
});

test('oversized cloned request-body inspection settles without waiting for native transport', async t => {
  const { hooks, plugin } = await pluginHarness(t);
  await hooks.context({ sessionID: 'on', system: [], tools: {} });
  const request = new Request('http://127.0.0.1:1/mock', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024) });
  const pending = hooks['http.request']({ sessionID: 'on', kind: 'primary', request });
  let timer;
  const settled = await Promise.race([pending.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]);
  clearTimeout(timer);
  // Release the original tee branch so a buggy implementation cannot leave test resources pending.
  await request.arrayBuffer();
  await pending;
  assert.equal(settled, true, 'bounded inspection must not deadlock the transport that follows the hook');
  const rows = (await readFile(plugin.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(row => row.type === 'request').markerPresent, null);
});
