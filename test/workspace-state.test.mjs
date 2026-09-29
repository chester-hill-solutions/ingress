import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkspaceState } from '../src/workspace-state.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function setup() {
  const state = new WorkspaceState({ epoch: 'epoch-1' });
  state.register({ id: 'a', task: 'sum totals', sessionID: 'session-a', generation: 1, dependencies: [{ producerPath: 'money.mjs', consumerPath: 'sum.mjs' }] });
  let count = 0;
  const event = (type, data, overrides = {}) => ({ id: `event-${++count}`, epoch: 'epoch-1', participantID: 'a', sessionID: 'session-a', generation: 1, source: 'native', sourceSeq: count, type, data, time: '2026-09-29T00:00:00Z', ...overrides });
  return { state, event };
}

test('join first snapshots prior participants and exposes honest unknown locations', () => {
  const { state, event } = setup();
  state.setIntention('a', 'format current units');
  const first = state.joinFile('a', 'money.mjs');
  assert.equal(first.type, 'file.joined');
  assert.deepEqual(first.participants, []);
  state.ingest(event('activity.observed', { path: 'money.mjs', kind: 'read' }));
  state.register({ id: 'b', task: 'change contract', sessionID: 'session-b', generation: 1 });
  const second = state.joinFile('b', 'money.mjs');
  assert.deepEqual(second.participants.map(p => p.id), ['a']);
  assert.equal(second.participants[0].intention.text, 'format current units');
  assert.equal(second.participants[0].lastLocation.location, null);
  assert.equal(second.participants[0].lastLocation.confidence, 'unknown');
  assert.equal(second.self.lastLocation, null);
  assert.equal(first.participants.length, 0);
});

test('same-generation human steer changes cut before delivery and stale delivery is refused', () => {
  const { state, event } = setup();
  const before = state.decisionCut('a');
  assert.equal(state.ingest(event('control.accepted', { commandID: 'steer-1', instructionRevision: 1 })).accepted, true);
  const accepted = state.decisionCut('a');
  assert.equal(accepted.generation, before.generation);
  assert.notEqual(accepted.digest, before.digest);
  assert.equal(accepted.instructionRevision, 1);
  assert.equal(accepted.deliveredInstructionRevision, 0);
  assert.equal(state.ingest(event('control.delivered', { commandID: 'wrong', instructionRevision: 1 })).accepted, false);
  assert.equal(state.ingest(event('control.delivered', { commandID: 'steer-1', instructionRevision: 1 })).accepted, true);
  assert.equal(state.decisionCut('a').deliveredInstructionRevision, 1);
  state.ingest(event('control.accepted', { commandID: 'steer-2', instructionRevision: 2 }));
  assert.equal(state.ingest(event('control.delivered', { commandID: 'steer-1', instructionRevision: 1 })).accepted, false);
});

test('old epoch/session/generation, duplicate and reordered events cannot regress execution', () => {
  const { state, event } = setup();
  const running = event('agent.status', { status: 'running' });
  assert.equal(state.ingest(running).accepted, true);
  assert.equal(state.ingest(running).reason, 'duplicate');
  assert.equal(state.ingest(event('agent.status', { status: 'idle' }, { sourceSeq: 0 })).reason, 'reordered');
  assert.equal(state.ingest(event('agent.status', { status: 'idle' }, { epoch: 'old' })).reason, 'stale_epoch');
  state.register({ id: 'a', task: 'next task', sessionID: 'new-session', generation: 2 });
  assert.equal(state.ingest(event('agent.status', { status: 'completed' })).reason, 'stale_execution');
  assert.equal(state.snapshot().participants[0].status, 'idle');
  assert.throws(() => state.register({ id: 'a', task: 'old task', sessionID: 'session-a', generation: 1 }), /old generation/);
});

test('coverage gap stays incomplete until explicit reconciliation and unchanged gaps do not certify safety', () => {
  const { state, event } = setup();
  state.ingest(event('agent.status', { status: 'running' }, { sourceSeq: 1 }));
  state.ingest(event('activity.observed', { path: 'money.mjs', kind: 'read' }, { sourceSeq: 3 }));
  assert.equal(state.snapshot().coverage.complete, false);
  state.ingest(event('coverage.changed', { complete: true }, { sourceSeq: 4 }));
  assert.equal(state.snapshot().coverage.complete, true);
  assert.equal(state.snapshot().coverage.historicalComplete, false);
});

test('file observation never assigns authorship and native read timing remains temporal', () => {
  const { state, event } = setup();
  state.ingest(event('file.observed', { path: 'money.mjs', hash: hash('dollars'), revision: 1 }, { participantID: undefined, sessionID: undefined, generation: undefined, source: 'file-watcher', sourceSeq: 1 }));
  state.ingest(event('activity.observed', { path: 'money.mjs', kind: 'read' }, { sourceSeq: 1 }));
  const read = state.decisionCut('a').reads[0];
  assert.equal(read.confidence, 'temporal');
  assert.equal(read.hash, hash('dollars'));
  assert.equal(state.decisionCut('a').files[0].attribution, 'unknown');
  state.ingest(event('activity.observed', { path: 'money.mjs', kind: 'read', hash: hash('dollars'), revision: 1, verified: true }, { sourceSeq: 2 }));
  assert.equal(state.decisionCut('a').reads[0].confidence, 'verified');
  state.ingest(event('activity.observed', { path: 'money.mjs', kind: 'read', location: { line: 42 }, verified: true }, { source: 'otel', sourceSeq: 1 }));
  assert.equal(state.decisionCut('a').reads[0].confidence, 'verified');
  assert.equal(state.snapshot().participants[0].lastLocation.confidence, 'verified');
  assert.equal(state.snapshot().participants[0].activityEvidence.location, null);
});

test('late telemetry cannot declare lifecycle and settled execution cannot revive its intention', () => {
  const { state, event } = setup();
  state.setIntention('a', 'work on totals');
  assert.equal(state.ingest(event('agent.status', { status: 'completed' })).accepted, true);
  assert.equal(state.ingest(event('agent.status', { status: 'running' })).accepted, false);
  assert.equal(state.ingest(event('agent.status', { status: 'idle' }, { source: 'otel' })).reason, 'non_lifecycle_source');
  assert.throws(() => state.setIntention('a', 'revive'), /settled/);
  assert.equal(state.snapshot().participants[0].intention, null);
});

test('unrelated file observations do not alter decision evidence digest', () => {
  const { state, event } = setup();
  state.ingest(event('file.observed', { path: 'money.mjs', hash: hash('dollars'), revision: 1 }, { participantID: undefined, source: 'file-watcher', sourceSeq: 1 }));
  const before = state.decisionCut('a');
  state.ingest(event('file.observed', { path: 'unrelated.md', hash: hash('hello'), revision: 1 }, { participantID: undefined, source: 'file-watcher', sourceSeq: 2 }));
  assert.equal(state.decisionCut('a').digest, before.digest);
  assert.ok(state.decisionCut('a').evidenceVersion > before.evidenceVersion);
});
