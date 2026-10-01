import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, rm, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRealSquad, NotificationPolicy, ModelSteps, validateSquadFixture } from '../src/squad.mjs';
import { WorkspaceState } from '../src/workspace-state.mjs';
import { assembleAgentContext } from '../src/context.mjs';

function fakeRuntime({ failRole = null, hangingRole = null, unconfirmedRole = null, contextThrowRole = null, lostWaitRole = null } = {}) {
  const roles = ['content', 'engine', 'server', 'ui'];
  const shared = { live: 0, maximum: 0, prompts: [], verified: 0, contextCalls: new Map(), verificationLive: [], peerCounts: [] };
  class Client {
    constructor({ endpoint }) { this.role = endpoint; this.items = []; this.wake = null; this.messages = []; this.sequence = 0; }
    async createSession() { return `${this.role}_session`; }
    emit(type, data = {}) { this.items.push({ id: `evt_${this.role}_${this.sequence}`, seq: this.sequence++, type, time: Date.now(), data }); this.wake?.(); this.wake = null; }
    async *events() {
      yield { type: 'server.connected', seq: null, data: {} };
      while (!this.closed) {
        if (!this.items.length) await new Promise(resolve => { this.wake = resolve; });
        while (this.items.length) yield this.items.shift();
      }
    }
    async prompt(sessionID, text, options) {
      this.messages.push({ id: options.id, type: 'user', text });
      shared.prompts.push({ role: this.role, id: options.id, resume: options.resume, text });
      this.emit('session.execution.started');
      this.emit('session.step.started', { assistantMessageID: `msg_${this.role}`, started: Date.now(), model: { providerID: 'fake', id: 'fixture' } });
      this.emit('session.step.streamed', { assistantMessageID: `msg_${this.role}` });
      this.emit('session.inbox.delivered', { inboxID: options.id });
      this.emit('session.tool.input.started', { id: `tool_${this.role}`, assistantMessageID: `msg_${this.role}` });
      this.emit('session.tool.success', { id: `tool_${this.role}`, toolName: 'read', input: { path: 'data/history.json' } });
      return { id: options.id, sessionID, delivery: options.delivery, created: Date.now() };
    }
    async wait(_, signal) {
      if (this.role === lostWaitRole) throw new Error('lost native wait response');
      if (this.role === hangingRole) await new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }); if (signal.aborted) reject(new Error('deadline')); });
      await new Promise(resolve => setTimeout(resolve, 10)); this.emit('session.step.ended', { assistantMessageID: `msg_${this.role}`, finish: 'stop', tokens: { input: 5, output: 7 }, cost: 0 }); this.emit('session.execution.succeeded'); return { outcome: 'succeeded', idle: Date.now() };
    }
    async context() { shared.contextCalls.set(this.role, (shared.contextCalls.get(this.role) ?? 0) + 1); return { data: this.messages }; }
    close() { this.closed = true; this.wake?.(); }
  }
  return { shared, runtime: {
    OpenCodeClient: Client,
    assembleAgentContext(options) { if (options.participantID === contextThrowRole) throw new Error('context_fault'); shared.peerCounts.push({ id: options.participantID, count: options.state.agents.size }); return assembleAgentContext(options); },
    async startOpenCode({ stateDir }) {
      const role = stateDir.split('/').at(-1);
      if (role === failRole) throw new Error('DO_NOT_PERSIST_SECRET');
      shared.live++; shared.maximum = Math.max(shared.maximum, shared.live);
      let closed = false;
      return { endpoint: role, password: 'DO_NOT_PERSIST_SECRET', async close() { if (role === unconfirmedRole) throw new Error('unconfirmed'); if (!closed) { shared.live--; closed = true; } } };
    },
    async seedIngress(root) {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data/history.json'), '[]');
      return { paths: ['data/history.json'], tasks: roles.map(id => ({ id, task: `Build ${id} part of the Canadian history game`, files: ['data/history.json'], dependencies: [{ producerPath: 'data/history.json', consumerPath: 'data/history.json' }] })), integrationTask: 'Integrate and verify the Canadian history game' };
    },
    async verifyIngress() { shared.verificationLive.push(shared.live); shared.verified++; return { correct: shared.verified > 1, checks: [{ name: 'game_complete', passed: shared.verified > 1 }] }; },
    async observeFiles({ onObservation, epoch }) {
      onObservation({ id: 'baseline', epoch, source: 'file-watcher', sourceSeq: 1, type: 'file.observed', data: { path: 'data/history.json', hash: createHash('sha256').update('[]').digest('hex'), revision: 1 } });
      return { close() {}, async reconcile() {} };
    },
  } };
}

test('four native participants run before a fresh fifth integration task; proofs and cleanup retained', async () => {
  const { runtime, shared } = fakeRuntime();
  const updates = [];
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, onUpdate: value => updates.push(value.phase), deadlineMs: 2_000 });
  try {
    assert.deepEqual(result.planned, ['content', 'engine', 'server', 'ui', 'integration']);
    assert.deepEqual(result.assigned, result.planned);
    assert.equal(shared.maximum, 4);
    assert.equal(shared.live, 0);
    assert.equal(result.actors.length, 5);
    assert.ok(result.actors.every(actor => actor.modelSteps.length === 1 && actor.modelSteps[0].finish === 'stop' && actor.modelSteps[0].firstInput !== null));
    assert.ok(result.actors.every(actor => actor.modelStepTimingBasis.pureModelCompute === 'unknown'));
    assert.ok(result.actors.every(actor => actor.modelSteps[0].requestToBodyMs !== null && actor.modelSteps[0].postBodySettlementMs !== null));
    assert.ok(result.actors.every(actor => actor.outcome === 'succeeded' && actor.processStopped));
    assert.ok(result.actors.every(actor => actor.firstJoinBeforeTools === true && actor.initialContextProof.projected === true));
    assert.equal(result.preVerification.correct, false);
    assert.equal(result.verification.correct, true);
    assert.ok(shared.prompts.at(-1).text.includes('game_complete'));
    assert.ok(shared.prompts.every(prompt => prompt.text.includes('agent.workspace-context')));
    assert.ok(updates.some(phase => phase.includes('4 planned members')));
    assert.equal(JSON.stringify(result).includes('DO_NOT_PERSIST_SECRET'), false);
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('timed-out actor stops without optional context calls before verification', async () => {
  const { runtime, shared } = fakeRuntime({ hangingRole: 'engine' });
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000, actorDeadlineMs: 50 });
  try {
    const actor = result.actors.find(value => value.id === 'engine');
    assert.equal(actor.outcome, 'deadline_or_cancelled');
    assert.equal(actor.processStopped, true);
    assert.equal(actor.initialContextProof.projected, null);
    assert.equal(shared.contextCalls.has('engine'), false);
    assert.deepEqual(shared.verificationLive, [0, 0]);
    assert.equal(shared.live, 0);
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('unconfirmed stop refuses both verifier stages and integration admission', async () => {
  const { runtime, shared } = fakeRuntime({ unconfirmedRole: 'engine' });
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000 });
  try {
    assert.equal(shared.verified, 0);
    assert.equal(result.actors.some(value => value.id === 'integration'), false);
    assert.equal(result.integrationSkipped, 'previous_process_stop_unconfirmed');
    assert.deepEqual(result.preVerification.checks, [{ name: 'runtime_settled', passed: false }]);
    assert.deepEqual(result.verification.checks, [{ name: 'runtime_settled', passed: false }]);
    assert.ok(result.errors.some(value => value.code === 'native_stop_unconfirmed'));
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('lost native wait reply stops uncertain execution before context proofs or independent checks', async () => {
  const { runtime, shared } = fakeRuntime({ lostWaitRole: 'server' });
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000 });
  try {
    const actor = result.actors.find(value => value.id === 'server');
    assert.equal(actor.outcome, 'runtime_failed');
    assert.deepEqual(actor.failure, { name: 'Error' });
    assert.equal(actor.admitted, true);
    assert.equal(actor.processStopped, true);
    assert.equal(actor.initialContextProof.projected, null);
    assert.equal(actor.initialContextProof.reason, 'execution_settlement_unconfirmed');
    assert.equal(shared.contextCalls.has('server'), false);
    assert.deepEqual(shared.verificationLive, [0, 0]);
    assert.equal(shared.live, 0);
    assert.ok(result.errors.some(value => value.actor === 'server' && value.code === 'actor_runtime_failed'));
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('context compilation fault cannot bypass assigned actor cleanup', async () => {
  const { runtime, shared } = fakeRuntime({ contextThrowRole: 'ui' });
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000 });
  try {
    const actor = result.actors.find(value => value.id === 'ui');
    assert.equal(actor.outcome, 'runtime_failed');
    assert.deepEqual(actor.failure, { name: 'Error' });
    assert.equal(actor.admitted, false);
    assert.equal(actor.processStopped, true);
    assert.equal(shared.live, 0);
    assert.deepEqual(shared.verificationLive, [0, 0]);
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('unconfirmed startup cleanup without returned server handle blocks workspace verification', async () => {
  const { runtime, shared } = fakeRuntime();
  const start = runtime.startOpenCode;
  runtime.startOpenCode = options => options.stateDir.endsWith('/engine') ? Promise.reject(Object.assign(new Error('startup stop unknown'), { stopUnconfirmed: true })) : start(options);
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000 });
  try {
    assert.equal(result.actors.find(value => value.id === 'engine').processStopped, false);
    assert.equal(shared.verified, 0);
    assert.equal(result.assigned.includes('integration'), false);
    assert.equal(result.verification.checks[0].name, 'runtime_settled');
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('one setup failure remains visible without hiding other assigned outcomes', async () => {
  const { runtime, shared } = fakeRuntime({ failRole: 'engine' });
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, runtime, deadlineMs: 2_000 });
  try {
    assert.equal(result.actors.find(actor => actor.id === 'engine').outcome, 'setup_failed');
    assert.ok(result.actors.filter(actor => actor.id !== 'engine').every(actor => actor.outcome === 'succeeded'));
    assert.ok(result.errors.some(error => error.actor === 'engine' && error.code === 'actor_setup_failed'));
    assert.equal(shared.live, 0);
    assert.equal(JSON.stringify(result).includes('DO_NOT_PERSIST_SECRET'), false);
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('notification policy waits for native delivery, coalesces bursts and caps three queued observations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [], suppressed = [];
  const cut = { dependencies: [{ producerPath: 'dependency.mjs' }], files: [{ path: 'dependency.mjs', revision: 2 }, { path: 'external.mjs', revision: 2 }], reads: [{ path: 'external.mjs', revision: 1 }] };
  const policy = new NotificationPolicy({ cut: () => cut, active: () => true, affinityFiles: [], deliver: async value => sent.push(value), onSuppression: value => suppressed.push(value) });
  try {
    policy.observe('dependency.mjs');
    t.mock.timers.tick(1_999); assert.equal(sent.length, 0);
    t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve(); assert.equal(sent.length, 1);
    cut.files[0].revision = 3; policy.observe('dependency.mjs');
    policy.observe('external.mjs');
    t.mock.timers.tick(10_000); await Promise.resolve(); assert.equal(sent.length, 1);
    assert.equal(policy.delivered('unrelated-old-receipt'), false);
    assert.equal(policy.delivered(sent[0].id), true);
    t.mock.timers.tick(0); await Promise.resolve(); await Promise.resolve();
    assert.equal(sent.length, 2); assert.deepEqual(sent[1].paths, ['dependency.mjs', 'external.mjs']);
    policy.delivered(sent[1].id); cut.files[0].revision = 4; policy.observe('dependency.mjs');
    t.mock.timers.tick(2_000); await Promise.resolve(); await Promise.resolve(); assert.equal(sent.length, 3);
    policy.delivered(sent[2].id); cut.files[0].revision = 5; policy.observe('dependency.mjs');
    t.mock.timers.tick(10_000); await Promise.resolve(); assert.equal(sent.length, 3);
    assert.ok(suppressed.some(value => value.reason === 'task_notification_budget' && value.attribution === 'unknown'));
  } finally { policy.close(); }
});

test('stale reads inside role affinity and outside it both route without authorship inference', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [], suppressed = [];
  let active = true;
  const cut = { dependencies: [], files: [{ path: 'data/history.json', revision: 3 }, { path: 'engine.mjs', revision: 2 }], reads: [{ path: 'data/history.json', revision: 1 }, { path: 'engine.mjs', revision: 1 }] };
  const policy = new NotificationPolicy({ cut: () => cut, active: () => active, affinityFiles: ['data/history.json'], deliver: async value => sent.push(value), onSuppression: value => suppressed.push(value) });
  try {
    policy.observe('data/history.json');
    policy.observe('engine.mjs');
    t.mock.timers.tick(2_000); await Promise.resolve(); await Promise.resolve(); assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].paths, ['data/history.json', 'engine.mjs']);
    assert.deepEqual(suppressed, []);
    policy.delivered(sent[0].id);
    active = false; cut.files[1].revision = 3; policy.observe('engine.mjs');
    t.mock.timers.tick(5_000); assert.equal(sent.length, 1);
  } finally { policy.close(); }
});

for (const count of [8, 12, 32]) test(`${count} builders start simultaneously by default with no phantom integration role`, async () => {
  const { runtime, shared } = fakeRuntime();
  const fixture = { paths: ['data/history.json'], tasks: Array.from({ length: count }, (_, index) => ({ id: `builder-${index}`, task: `Implement assigned feature ${index}`, files: ['data/history.json'], dependencies: [] })), integrationTask: null };
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, fixture, runtime, deadlineMs: 5_000 });
  try {
    assert.equal(shared.maximum, count);
    assert.equal(result.executionConcurrency.peakAdmitted, count);
    assert.equal(result.executionConcurrency.peakRunning, count);
    assert.equal(result.executionConcurrency.currentAdmitted, 0);
    assert.equal(result.executionConcurrency.currentRunning, 0);
    assert.ok(shared.peerCounts.every(value => value.count === count));
    assert.ok(result.actors.every(actor => Number.isFinite(actor.setupMs) && Number.isFinite(actor.executionMs) && Number.isFinite(actor.settleMs)));
    assert.equal(shared.live, 0);
    assert.deepEqual(result.assigned, fixture.tasks.map(task => task.id));
    assert.deepEqual(result.planned, result.assigned);
    assert.equal(result.actors.length, count);
    assert.equal(result.integrationSkipped, 'not_planned');
    assert.equal(result.batches.length, 1);
    assert.ok(result.batches.every(batch => batch.planned.length === count && batch.processesStopped));
    assert.equal(result.limits.maxConcurrentNative, count);
    assert.equal(result.limits.concurrencyExplicit, false);
    assert.ok(shared.verificationLive.every(live => live === 0));
    assert.ok(result.actors.every(actor => actor.firstJoinBeforeTools === true));
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('preserving an existing workspace never calls seed and retains trusted fixture bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collaboration-existing-'));
  const { runtime, shared } = fakeRuntime();
  let seeded = false;
  runtime.seedIngress = async () => { seeded = true; throw new Error('seed must not run'); };
  try {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/history.json'), 'existing game data');
    const fixture = { paths: ['data/history.json', 'future-feature.mjs'], tasks: [{ id: 'feature', task: 'Add the assigned extension', files: ['future-feature.mjs'], dependencies: ['data/history.json'] }], integrationTask: null };
    const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, fixture, buildRoot: root, preserveExisting: true, runtime, deadlineMs: 2_000 });
    assert.equal(seeded, false);
    assert.equal(await readFile(join(root, 'data/history.json'), 'utf8'), 'existing game data');
    assert.equal(result.preservedExisting, true);
    assert.equal(result.actors.length, 1);
    assert.equal(shared.live, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid roster identities, scope paths, count and duplicate integration are rejected before admission', () => {
  const fixture = { paths: ['shared.mjs'], tasks: [{ id: 'a', task: 'Feature', files: ['shared.mjs'], dependencies: [] }], integrationTask: null };
  assert.equal(validateSquadFixture(fixture).sharedFile, 'shared.mjs');
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: [] }), /invalid_squad_roster/);
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: Array.from({ length: 65 }, (_, index) => ({ ...fixture.tasks[0], id: `role-${index}` })) }), /invalid_squad_roster/);
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: [{ ...fixture.tasks[0], id: '../outside' }] }), /invalid_squad_task/);
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: [{ ...fixture.tasks[0], files: ['outside.mjs'] }] }), /undeclared_squad_path/);
  assert.throws(() => validateSquadFixture({ ...fixture, paths: ['../outside'] }), /declared relative/);
  assert.throws(() => validateSquadFixture({ ...fixture, integrationTask: fixture.tasks[0] }), /invalid_squad_task/);
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: [{ ...fixture.tasks[0], task: 'x'.repeat(4097) }] }), /invalid_squad_task/);
});


test('an explicitly requested lower concurrency batches twelve builders without changing default capacity', async () => {
  const { runtime, shared } = fakeRuntime();
  const fixture = { paths: ['data/history.json'], tasks: Array.from({ length: 12 }, (_, i) => ({ id: `builder-${i}`, task: `Feature ${i}`, files: ['data/history.json'] })), integrationTask: null };
  const result = await runRealSquad({ profile: { model: { providerID: 'fake', id: 'fixture' } }, fixture, maxConcurrentNative: 3, runtime, deadlineMs: 5_000 });
  try {
    assert.equal(shared.maximum, 3); assert.equal(result.executionConcurrency.peakAdmitted, 3);
    assert.equal(result.batches.length, 4); assert.equal(result.limits.concurrencyExplicit, true);
    assert.ok(result.batches.every(batch => batch.processesStopped)); assert.ok(shared.verificationLive.every(value => value === 0));
    assert.equal(result.assigned.length, 12);
  } finally { await rm(result.buildRoot, { recursive: true, force: true }); }
});

test('actual state source capacity and requested concurrency fail explicitly before native admission', async () => {
  const fixture = { paths: ['shared.mjs'], tasks: Array.from({ length: 64 }, (_, i) => ({ id: `builder-${i}`, task: `Feature ${i}`, files: ['shared.mjs'] })), integrationTask: null };
  assert.throws(() => validateSquadFixture(fixture), error => error.code === 'squad_capacity_exceeded' && error.requested.sourceStreams === 129 && error.capacity.sourceStreams === 128);
  assert.equal(validateSquadFixture({ ...fixture, tasks: fixture.tasks.slice(0, 63) }).tasks.length, 63);
  assert.throws(() => validateSquadFixture({ ...fixture, tasks: fixture.tasks.slice(0, 63), integrationTask: 'Integrate' }), /squad_capacity_exceeded/);
  const { runtime, shared } = fakeRuntime();
  await assert.rejects(runRealSquad({ profile: { model: {} }, fixture: { ...fixture, tasks: fixture.tasks.slice(0, 12) }, maxConcurrentNative: 13, runtime }), /squad_concurrency_exceeds_roster/);
  await assert.rejects(runRealSquad({ profile: { model: {} }, fixture, runtime }), /squad_capacity_exceeded/);
  assert.equal(shared.maximum, 0); assert.equal(shared.prompts.length, 0);
});


const stepEvent = (assistantMessageID, phase, time, data = {}) => ({ id: `evt_${assistantMessageID}_${phase}`, type: `session.step.${phase}`, time, data: { assistantMessageID, ...data } });
test('model step capsule correlates interleaved assistant IDs and labels combined phase timing', () => {
  const capsule = new ModelSteps();
  capsule.observe(stepEvent('msg_a', 'started', 120, { started: 100, model: { providerID: 'provider', id: 'model' } }));
  capsule.observe(stepEvent('msg_b', 'started', 125, { started: 110 }));
  capsule.observe(stepEvent('msg_b', 'streamed', 150));
  capsule.observe(stepEvent('msg_a', 'streamed', 160));
  capsule.observe({ id: 'evt_tool', type: 'session.tool.input.started', time: 170, data: { assistantMessageID: 'msg_a' } });
  capsule.observe(stepEvent('msg_b', 'failed', 180, { finish: 'content-filter', error: { message: 'PRIVATE ERROR' }, cost: 0 }));
  capsule.observe(stepEvent('msg_a', 'ended', 200, { finish: 'tool-calls', cost: 0.01, tokens: { input: 5, output: 7, reasoning: 0 }, rawFinish: 'PRIVATE FINISH', providerState: 'PRIVATE STATE', text: 'PRIVATE PROSE' }));
  assert.deepEqual(capsule.steps.map(step => [step.requestToBodyMs, step.postBodySettlementMs]), [[60, 40], [40, 30]]);
  assert.equal(capsule.steps[0].firstInput.time, 170);
  assert.equal(capsule.steps[0].tokens.reasoning, 0);
  assert.deepEqual(capsule.steps[0].tokens.cache, { read: null, write: null });
  assert.equal(capsule.steps[1].finish, 'content-filter');
  assert.equal(JSON.stringify(capsule).includes('PRIVATE'), false);
});

test('partial, gapped, negative/nonfinite and malformed model metadata remain unknown', () => {
  const capsule = new ModelSteps();
  capsule.observe(stepEvent('msg_partial', 'streamed', 150));
  capsule.observe(stepEvent('msg_partial', 'ended', 200, { finish: 'provider-private-prose', cost: Infinity, tokens: { input: NaN, output: -1, reasoning: '7', arbitrary: 9 } }));
  capsule.observe(stepEvent('msg_bad_clock', 'started', 110, { started: 100, model: { providerID: 'HOSTILE PROSE', id: 'x' } }));
  capsule.observe(stepEvent('msg_bad_clock', 'streamed', 90));
  capsule.observe(stepEvent('msg_bad_clock', 'ended', 80));
  capsule.observe(stepEvent('msg_gap', 'started', 10, { started: 0 }));
  capsule.gap();
  capsule.observe(stepEvent('msg_gap', 'streamed', 20), { gap: true });
  capsule.observe(stepEvent('msg_gap', 'ended', 30), { gap: true });
  assert.ok(capsule.steps.every(step => step.requestToBodyMs === null && step.postBodySettlementMs === null));
  assert.equal(capsule.steps[0].finish, null); assert.equal(capsule.steps[0].cost, null);
  assert.deepEqual(capsule.steps[0].tokens, { input: null, output: null, reasoning: null, cache: { read: null, write: null } });
  assert.equal(capsule.steps[1].model, null); assert.equal(capsule.steps[2].sourceGap, true);
});

test('model step retention stays at32 with explicit event/start omissions and bounded phase metadata', () => {
  const capsule = new ModelSteps();
  for (let i = 0; i < 40; i++) {
    capsule.observe(stepEvent(`msg_${i}`, 'started', i * 10, { started: i * 10 }));
    capsule.observe(stepEvent(`msg_${i}`, 'streamed', i * 10 + 1));
    capsule.observe(stepEvent(`msg_${i}`, 'ended', i * 10 + 2));
  }
  assert.equal(capsule.steps.length, 32);
  assert.deepEqual(capsule.omissions, { stepStarts: 8, events: 24, uncorrelatedEvents: 0, duplicatePhaseEvents: 0 });
  capsule.observe(stepEvent('msg_0', 'started', 1));
  capsule.observe(stepEvent(null, 'ended', 1));
  assert.equal(capsule.omissions.duplicatePhaseEvents, 1); assert.equal(capsule.omissions.uncorrelatedEvents, 1);
  assert.equal(capsule.steps[0].events.started.time, 0);
});


test('integrator receives changed MISSION after an observed read even when every file is a role affinity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = new WorkspaceState({ epoch: 'mission-epoch' }), sent = [], suppressed = [];
  const fixture = validateSquadFixture({ paths: ['MISSION.md', 'public/index.html'], tasks: [{ id: 'ui', task: 'Build UI', files: ['public/index.html'] }], integrationTask: 'Integrate peer changes' });
  assert.deepEqual(fixture.integrationTask.files, fixture.paths);
  assert.deepEqual(fixture.integrationTask.dependencies, []);
  state.register({ id: 'integration', task: fixture.integrationTask.task, sessionID: 'integration-session', generation: 1 });
  state.joinFile('integration', 'MISSION.md');
  const file = revision => ({ id: `file-${revision}`, epoch: state.epoch, source: 'file-watcher', sourceSeq: revision, type: 'file.observed', data: { path: 'MISSION.md', revision, hash: createHash('sha256').update(`mission-${revision}`).digest('hex') } });
  state.ingest(file(1));
  const policy = new NotificationPolicy({ cut: () => state.decisionCut('integration'), affinityFiles: fixture.integrationTask.files, active: () => true, deliver: async value => sent.push(value), onSuppression: value => suppressed.push(value) });
  try {
    state.ingest(file(2)); policy.observe('MISSION.md');
    t.mock.timers.tick(3_000); assert.equal(sent.length, 0);
    assert.equal(suppressed[0].reason, 'no_declared_dependency_or_stale_read');
    state.ingest({ id: 'read-mission', epoch: state.epoch, source: 'opencode', sourceSeq: 0, participantID: 'integration', sessionID: 'integration-session', generation: 1, type: 'activity.observed', data: { path: 'MISSION.md', kind: 'read' } });
    assert.equal(state.decisionCut('integration').reads[0].confidence, 'temporal');
    state.ingest(file(3)); policy.observe('MISSION.md');
    t.mock.timers.tick(2_000); await Promise.resolve(); await Promise.resolve();
    assert.equal(sent.length, 1); assert.deepEqual(sent[0].paths, ['MISSION.md']);
    assert.equal(suppressed[0].attribution, 'unknown');
    state.ingest(file(4)); policy.observe('MISSION.md');
    t.mock.timers.tick(5_000); await Promise.resolve(); assert.equal(sent.length, 1);
    policy.delivered(sent[0].id); t.mock.timers.tick(0); await Promise.resolve(); await Promise.resolve();
    assert.equal(sent.length, 2);
  } finally { policy.close(); }
});
