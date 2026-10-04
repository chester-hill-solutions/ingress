import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLedger, FenceRefusal } from '../src/product/fence.mjs';

/**
 * The one scenario the product exists for:
 *   two participants, one dependency, one of them works from a stale read.
 *
 * Everything else in this file is a guard on that claim.
 */

function twoParticipants() {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'builder', dependencies: ['engine.mjs'] });
  ledger.register({ participantId: 'integrator', dependencies: ['engine.mjs'] });
  ledger.recordWrite({ path: 'engine.mjs', revision: 1, contentHash: 'hash-1' });
  ledger.recordRead({ participantId: 'builder', path: 'engine.mjs' });
  return ledger;
}

test('a write against a current dependency is admitted', () => {
  const ledger = twoParticipants();
  const receipt = ledger.admit({ participantId: 'builder', path: 'ui.mjs', baseRevision: null, contentHash: 'ui-1' });
  assert.equal(receipt.admitted, true);
  assert.equal(receipt.reason, 'write_admitted');
  assert.equal(receipt.nextRevision, 1, 'first write to an unseen path is revision 1');
  assert.equal(receipt.kind, 'agent');
});

test('the fence refuses a write built on a dependency that moved', () => {
  const ledger = twoParticipants();
  // Someone else changes what the builder was working from.
  ledger.recordWrite({ path: 'engine.mjs', revision: 2, contentHash: 'hash-2', actorId: 'integrator' });

  const receipt = ledger.admit({ participantId: 'builder', path: 'ui.mjs', contentHash: 'ui-1' });

  assert.equal(receipt.admitted, false);
  assert.equal(receipt.reason, 'dependency_moved');
  assert.equal(receipt.staleDependencies.length, 1);
  assert.deepEqual(receipt.staleDependencies[0], {
    path: 'engine.mjs',
    readRevision: 1,
    currentRevision: 2,
    author: 'integrator',
  });
});

test('a refusal carries evidence a third party can recompute', () => {
  const ledger = twoParticipants();
  ledger.recordWrite({ path: 'engine.mjs', revision: 2, contentHash: 'hash-2', actorId: 'integrator' });
  const refusal = ledger.admit({ participantId: 'builder', path: 'ui.mjs' });

  // The fingerprint is derived from the ledger, not asserted by the caller.
  const cut = ledger.decisionCut('builder');
  assert.equal(refusal.fingerprint, cut.fingerprint);
  assert.deepEqual(cut.reads[0].stale, true);
  assert.equal(cut.reads[0].readBasis, 'verified');
});

test('re-reading clears the staleness and the write is admitted', () => {
  const ledger = twoParticipants();
  ledger.recordWrite({ path: 'engine.mjs', revision: 2, contentHash: 'hash-2', actorId: 'integrator' });
  assert.equal(ledger.admit({ participantId: 'builder', path: 'ui.mjs' }).admitted, false);

  ledger.recordRead({ participantId: 'builder', path: 'engine.mjs' });

  const retry = ledger.admit({ participantId: 'builder', path: 'ui.mjs' });
  assert.equal(retry.admitted, true, 'the fence is recoverable, not a dead end');
});

test('a write claiming an out-of-date base is refused even with no dependencies', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'solo' });
  ledger.recordWrite({ path: 'data.json', revision: 1, contentHash: 'a', actorId: 'other' });

  const refused = ledger.admit({ participantId: 'solo', path: 'data.json', baseRevision: 99 });
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, 'write_base_stale');
  assert.equal(refused.claimedRevision, 99);
  assert.equal(refused.currentRevision, 1);

  const admitted = ledger.admit({ participantId: 'solo', path: 'data.json', baseRevision: 1 });
  assert.equal(admitted.admitted, true);
});

test('a dependency nobody read is refused as unknown, not assumed safe', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'guesser', dependencies: ['schema.graphql'] });
  ledger.recordWrite({ path: 'schema.graphql', revision: 3 });

  const receipt = ledger.admit({ participantId: 'guesser', path: 'handler.ts' });
  assert.equal(receipt.admitted, false);
  assert.equal(receipt.reason, 'dependency_read_unknown');
  assert.deepEqual(receipt.unknownDependencies, ['schema.graphql']);
});

test('a settled participant cannot write', () => {
  const ledger = twoParticipants();
  ledger.participants.get('builder').status = 'completed';
  const receipt = ledger.admit({ participantId: 'builder', path: 'ui.mjs' });
  assert.equal(receipt.admitted, false);
  assert.equal(receipt.reason, 'participant_settled');
});

test('an unknown participant is refused rather than defaulted', () => {
  const ledger = twoParticipants();
  assert.throws(() => ledger.admit({ participantId: 'ghost', path: 'x.mjs' }), FenceRefusal);
});

test('path traversal and absolute paths are refused', () => {
  const ledger = twoParticipants();
  for (const bad of ['../escape.mjs', '/etc/passwd', 'a/../../b', '']) {
    assert.throws(() => ledger.admit({ participantId: 'builder', path: bad }), FenceRefusal, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a human and an agent are participants with equal standing and different kinds', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'agent-1', kind: 'agent', dependencies: ['lib.mjs'] });
  ledger.register({ participantId: 'person-1', kind: 'human', dependencies: ['lib.mjs'] });
  ledger.recordWrite({ path: 'lib.mjs', revision: 1, contentHash: 'h1' });
  ledger.recordRead({ participantId: 'agent-1', path: 'lib.mjs' });

  const envelope = ledger.joinEnvelope('agent-1');
  const peer = envelope.participants.find(p => p.participantId === 'person-1');
  assert.equal(peer.kind, 'human', 'a human is visible to an agent as a peer');

  // The human's edit invalidates the agent exactly as another agent would.
  ledger.recordWrite({ path: 'lib.mjs', revision: 2, contentHash: 'h2', actorId: 'person-1' });
  const receipt = ledger.admit({ participantId: 'agent-1', path: 'app.ts' });
  assert.equal(receipt.admitted, false);
  assert.equal(receipt.staleDependencies[0].author, 'person-1');
});

test('the join envelope reports presence, intent and honest unknown', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'me', kind: 'agent', dependencies: ['a.mjs', 'never-written.mjs'] });
  ledger.register({ participantId: 'peer', kind: 'human', displayName: 'Sam' });
  ledger.setIntent('peer', 'rewriting the parser');
  ledger.recordWrite({ path: 'a.mjs', revision: 4, contentHash: 'x', actorId: 'peer' });

  const envelope = ledger.joinEnvelope('me');
  assert.equal(envelope.participants[0].displayName, 'Sam');
  assert.equal(envelope.participants[0].intent, 'rewriting the parser');
  assert.equal(envelope.participants[0].status, 'active');

  const known = envelope.dependencies.find(d => d.path === 'a.mjs');
  assert.equal(known.revision, 4);
  assert.equal(known.attribution, 'observed');

  // We did not read it, and we do not pretend otherwise.
  const unknown = envelope.dependencies.find(d => d.path === 'never-written.mjs');
  assert.equal(unknown.revision, null);
  assert.equal(unknown.attribution, 'unknown');
  assert.equal(unknown.yourReadRevision, null);
});

test('an unattributed write stays unattributed', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'watcher', dependencies: ['x.mjs'] });
  ledger.recordWrite({ path: 'x.mjs', revision: 1 });
  ledger.recordRead({ participantId: 'watcher', path: 'x.mjs' });

  const envelope = ledger.joinEnvelope('watcher');
  assert.equal(envelope.dependencies[0].author, null);
  assert.equal(envelope.dependencies[0].attribution, 'unknown', 'we must not invent an author');
});

test('every outcome is retained as a receipt, admissions and refusals alike', () => {
  const ledger = twoParticipants();
  ledger.admit({ participantId: 'builder', path: 'ok.mjs' });
  ledger.recordWrite({ path: 'engine.mjs', revision: 2, contentHash: 'h2', actorId: 'integrator' });
  ledger.admit({ participantId: 'builder', path: 'blocked.mjs' });

  const receipts = ledger.receiptsFor('builder');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].admitted, true);
  assert.equal(receipts[1].admitted, false);
  assert.ok(receipts.every(r => typeof r.fingerprint === 'string' && r.fingerprint.length > 0));
});

test('the ledger refuses to grow without bound', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p' });
  for (let i = 1; i <= 512; i++) ledger.recordWrite({ path: `f${i}.mjs`, revision: 1 });
  assert.throws(() => ledger.recordWrite({ path: 'one-too-many.mjs', revision: 1 }), /workspace_file_cap/);
});

test('a participant cannot declare an unbounded dependency list', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  const tooMany = Array.from({ length: 65 }, (_, i) => `f${i}.mjs`);
  assert.throws(() => ledger.register({ participantId: 'p', dependencies: tooMany }), /too_many_dependencies/);
});
// --- retention ------------------------------------------------------------

test('the read ledger is bounded per participant, so one cannot lock out the rest', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'greedy' });
  ledger.register({ participantId: 'polite' });

  // One participant exhausts their own budget.
  for (let i = 0; i < 512; i++) ledger.recordRead({ participantId: 'greedy', path: `g${i}.mjs` });
  assert.equal(ledger.reads.size, 512);
  assert.throws(
    () => ledger.recordRead({ participantId: 'greedy', path: 'one-too-many.mjs' }),
    error => error.reason === 'read_cap' && error.scope === 'participant'
  );

  // The other participant is unaffected. A shared budget made this a denial of
  // service with no authorisation required.
  assert.doesNotThrow(() => ledger.recordRead({ participantId: 'polite', path: 'p0.mjs' }));
  assert.ok(ledger.reads.has('polite:p0.mjs'));

  // Re-reading something already tracked is not growth.
  assert.doesNotThrow(() => ledger.recordRead({ participantId: 'greedy', path: 'g0.mjs' }));
  assert.equal(ledger.reads.size, 513);
});

test('the workspace-wide read cap still applies, and says so', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  // 16 participants at 512 each exactly fills 8192, so the next read trips it.
  for (let i = 0; i < 17; i++) ledger.register({ participantId: `p${i}` });
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 512; j++) ledger.recordRead({ participantId: `p${i}`, path: `f${j}.mjs` });
  }
  assert.equal(ledger.reads.size, 8192, 'nobody hit a per-participant cap');

  assert.throws(
    () => ledger.recordRead({ participantId: 'p16', path: 'one.mjs' }),
    error => {
      assert.equal(error.reason, 'read_cap');
      // The scope is what tells a caller whether to wait or to give up on the
      // workspace, so a refusal that does not say which cap it hit is half an answer.
      assert.equal(error.scope, 'workspace');
      return true;
    }
  );
});

test('the per-participant read count survives persistence', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p' });
  for (let i = 0; i < 512; i++) ledger.recordRead({ participantId: 'p', path: `f${i}.mjs` });

  const revived = WorkspaceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.throws(
    () => revived.recordRead({ participantId: 'p', path: 'another.mjs' }),
    /read_cap/,
    'a restart must not hand the same participant a fresh read budget'
  );
});

test('the receipt trail is capped, and the trim is counted', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p', dependencies: [] });
  ledger.register({ participantId: 'q', dependencies: [] });

  for (let i = 0; i < 5200; i++) {
    ledger.admit({ participantId: 'p', path: `f${i % 400}.mjs`, contentHash: `h${i}` });
  }

  assert.ok(ledger.receipts.length <= 5000, `expected the trail to be capped, got ${ledger.receipts.length}`);
  // The invariant that matters: retained + trimmed must account for every
  // decision ever made. If this drifts, the workspace is silently losing
  // evidence it claims to hold.
  assert.equal(ledger.receipts.length, 5000);
  assert.equal(ledger.receiptsTrimmed, 200, '5200 decisions, 5000 retained, 200 dropped and counted');
  assert.equal(ledger.receipts.length + ledger.receiptsTrimmed, 5200);
});

test('the trim count survives persistence, so a restarted workspace does not forget it', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p', dependencies: [] });
  for (let i = 0; i < 5100; i++) ledger.admit({ participantId: 'p', path: `f${i % 400}.mjs`, contentHash: `h${i}` });

  const revived = WorkspaceLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.equal(revived.receiptsTrimmed, ledger.receiptsTrimmed);
  assert.ok(revived.receiptsTrimmed > 0, 'a restart must not turn a partial history into a complete-looking one');
});

test('the snapshot reports what it retained and what it dropped', () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p', dependencies: [] });
  ledger.admit({ participantId: 'p', path: 'a.mjs', contentHash: 'h1' });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.receipts, 1);
  assert.equal(snapshot.receiptsTrimmed, 0);
});
