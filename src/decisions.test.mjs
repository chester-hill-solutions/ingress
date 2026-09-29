import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLane, deterministicDecision } from './decisions.mjs';

function cut(overrides = {}) {
  return { epoch: 'room-1', participantID: 'consumer', task: { id: 'task-1', revision: 1, text: 'sum orders' },
    sessionID: 'session-1', generation: 1, instructionRevision: 1, intentionRevision: 1,
    files: [{ path: 'producer.mjs', hash: 'new', revision: 2 }],
    reads: [{ path: 'producer.mjs', hash: 'old', revision: 1, confidence: 'temporal', observedAt: 10 }],
    dependencies: [{ producerPath: 'producer.mjs', consumerPath: 'consumer.mjs' }],
    coverage: { complete: true, reason: null }, evidenceVersion: 2, digest: 'cut-2', ...overrides };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('deterministic routing requests relevant refresh without certifying temporal freshness', () => {
  assert.equal(deterministicDecision(cut()).action, 'refresh_context');
  assert.equal(deterministicDecision(cut({ coverage: { complete: false } })).action, 'ask_human');
  assert.equal(deterministicDecision(cut({ reads: [{ path: 'producer.mjs', hash: 'new', revision: 2, confidence: 'temporal' }] })).action, 'notify');
  assert.equal(deterministicDecision(cut({ reads: [{ path: 'producer.mjs', hash: 'new', revision: 2, confidence: 'verified' }] })).action, 'no_action');
  assert.equal(deterministicDecision(cut({ dependencies: [] })).action, 'no_action');
});

test('same-generation human steer invalidates delayed decision before actuation', async () => {
  const held = deferred();
  let current = cut();
  let actions = 0;
  const lane = new DecisionLane({ decide: () => held.promise, actuate: () => { actions++; return { status: 'accepted' }; } });
  const receipt = lane.evaluate(current, { currentCut: () => current, mode: 'automatic' });
  current = { ...current, instructionRevision: 2 }; // Even an unchanged external digest cannot hide a changed context.
  held.resolve({ action: 'steer_current_task', paths: ['producer.mjs'], reason: 'dependency_changed' });
  assert.equal((await receipt).status, 'superseded');
  assert.equal(actions, 0);
  lane.close();
});

test('full-context changes invalidate task, session, epoch, intention and evidence independently', async () => {
  for (const replacement of [{ task: { id: 'task-1', revision: 2 } }, { sessionID: 'session-2' }, { epoch: 'room-2' },
    { intentionRevision: 2 }, { files: [{ path: 'producer.mjs', hash: 'changed', revision: 3 }] }, { coverage: { complete: false } }]) {
    const held = deferred();
    let current = cut();
    const lane = new DecisionLane({ decide: () => held.promise });
    const pending = lane.evaluate(current, { currentCut: () => current });
    current = { ...current, ...replacement };
    held.resolve({ action: 'no_action' });
    assert.equal((await pending).status, 'superseded');
    lane.close();
  }
});

test('flood deduplicates identical cuts and retains only latest pending cut per task', async () => {
  const held = deferred();
  let current = cut();
  let calls = 0;
  const lane = new DecisionLane({ decide: () => { calls++; return calls === 1 ? held.promise : { action: 'no_action' }; } });
  const first = lane.evaluate(current, { currentCut: () => current });
  for (let i = 0; i < 100; i++) assert.equal(lane.evaluate(current, { currentCut: () => current }), first);
  const secondCut = cut({ digest: 'cut-3', evidenceVersion: 3, instructionRevision: 2 });
  const second = lane.evaluate(secondCut, { currentCut: () => current });
  current = cut({ digest: 'cut-4', evidenceVersion: 4, instructionRevision: 3 });
  const third = lane.evaluate(current, { currentCut: () => current });
  assert.equal((await second).reason, 'newer_pending_cut');
  held.resolve({ action: 'no_action' });
  assert.equal((await first).status, 'superseded');
  assert.equal((await third).status, 'shadow-only');
  assert.equal(calls, 2);
  lane.close();
});

test('workspace cap and timed-out uncooperative callbacks retain their occupied slots', async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  let calls = 0;
  const lane = new DecisionLane({ timeoutMs: 15, decide: () => { calls++; return calls === 1 ? firstGate.promise : calls === 2 ? secondGate.promise : { action: 'no_action' }; } });
  const cuts = [cut(), cut({ participantID: 'b' }), cut({ participantID: 'c' })];
  const pending = cuts.map(value => lane.evaluate(value, { currentCut: () => value }));
  assert.equal((await pending[0]).status, 'timeout');
  assert.equal((await pending[1]).status, 'timeout');
  assert.equal(calls, 2);
  assert.equal(lane.running, 2);
  firstGate.resolve({ action: 'no_action' });
  assert.equal((await pending[2]).status, 'shadow-only');
  secondGate.resolve({ action: 'no_action' });
  await tick();
  lane.close();
});

test('unrelated source/version churn neither supersedes nor reevaluates a relevant decision', async () => {
  const held = deferred();
  let calls = 0;
  let current = cut({ coverage: { complete: true, reason: null, sources: [{ source: 'native', lastSequence: 2 }] } });
  const lane = new DecisionLane({ decide: () => { calls++; return held.promise; } });
  const first = lane.evaluate(current, { currentCut: () => current });
  current = { ...current, evidenceVersion: 100, digest: 'metadata-only-new-digest', coverage: { complete: true, reason: null, sources: [{ source: 'native', lastSequence: 100 }] } };
  assert.equal(lane.evaluate(current, { currentCut: () => current }), first);
  held.resolve({ action: 'refresh_context', paths: ['producer.mjs'] });
  assert.equal((await first).status, 'shadow-only');
  assert.equal(calls, 1);
  lane.close();
});

test('an expired intention cannot admit a delayed action even without an ingestion event', async () => {
  const value = cut({ intention: { text: 'invoice', revision: 1, expiresAt: new Date(Date.now() - 100).toISOString() } });
  const lane = new DecisionLane();
  assert.equal((await lane.evaluate(value, { currentCut: () => value })).status, 'superseded');
  lane.close();
});

test('completed execution cannot receive automatic follow-up work', async () => {
  const value = cut({ status: 'completed' });
  let actions = 0;
  const lane = new DecisionLane({ actuate: () => { actions++; return { status: 'accepted' }; } });
  assert.equal((await lane.evaluate(value, { currentCut: () => value, mode: 'automatic' })).status, 'superseded');
  assert.equal(actions, 0);
  lane.close();
});

test('receipts distinguish shadow, advice, accepted delivery and unknown native outcomes', async () => {
  const value = cut();
  let actions = 0;
  const lane = new DecisionLane({ decide: () => ({ action: 'steer_current_task' }), actuate: (_, options) => {
    actions++; assert.ok(options.commandID); return { status: 'accepted', id: 'native-inbox-1' };
  } });
  assert.equal((await lane.evaluate(value, { currentCut: () => value })).status, 'shadow-only');
  assert.equal((await lane.evaluate(value, { currentCut: () => value, mode: 'advisory' })).status, 'advisory-only');
  const accepted = await lane.evaluate(value, { currentCut: () => value, mode: 'automatic' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.nativeReceiptID, 'native-inbox-1');
  assert.equal(actions, 1);
  lane.close();
  const unknown = new DecisionLane({ actuate: () => { throw new Error('lost native reply'); } });
  assert.equal((await unknown.evaluate(value, { currentCut: () => value, mode: 'automatic' })).status, 'unknown');
  unknown.close();
});

test('deadline after native submission is unknown and never retries the command', async () => {
  const gate = deferred();
  const value = cut();
  let actions = 0;
  const lane = new DecisionLane({ timeoutMs: 15, actuate: () => { actions++; return gate.promise; } });
  const pending = lane.evaluate(value, { currentCut: () => value, mode: 'automatic' });
  assert.equal((await pending).status, 'unknown');
  assert.equal(lane.evaluate(value, { currentCut: () => value, mode: 'automatic' }), pending);
  assert.equal(actions, 1);
  gate.resolve({ status: 'delivered' });
  await tick();
  lane.close();
});

test('rejects forbidden actions, oversized evidence, async admission and bounds', async () => {
  assert.throws(() => new DecisionLane({ maxConcurrent: 3 }), /invalid_lane_bounds/);
  const value = cut();
  const lane = new DecisionLane({ decide: () => ({ action: 'interrupt' }) });
  assert.equal((await lane.evaluate(value, { currentCut: () => value })).reason, 'unsupported_action');
  assert.throws(() => lane.evaluate(cut({ padding: 'x'.repeat(70_000) }), { currentCut: () => value }), /evidence_cut_limit/);
  const asyncLane = new DecisionLane();
  assert.equal((await asyncLane.evaluate(value, { currentCut: async () => value })).reason, 'currentCut_must_be_synchronous');
  lane.close(); asyncLane.close();
});

test('queue backpressure and close settle pending evaluations', async () => {
  const gate = deferred();
  const lane = new DecisionLane({ maxConcurrent: 1, maxTasks: 1, decide: () => gate.promise });
  const value = cut();
  const active = lane.evaluate(value, { currentCut: () => value });
  const pending = lane.evaluate(cut({ evidenceVersion: 3, instructionRevision: 2 }), { currentCut: () => value });
  assert.equal((await lane.evaluate(cut({ participantID: 'other' }), { currentCut: () => value })).status, 'backpressure');
  lane.close();
  assert.equal((await active).status, 'closed');
  assert.equal((await pending).status, 'closed');
  gate.resolve({ action: 'no_action' });
  await tick();
});
