import test from 'node:test';
import assert from 'node:assert/strict';
import { runScale } from '../src/scale.mjs';

test('32 participants receive prior join positions, bounded contexts, scoped fanout and latest coalesced revisions', async () => {
  const evidence = await runScale({ participants: 32, eventCount: 224, batchSize: 28 });
  assert.equal(evidence.kind, 'deterministic-scale-apparatus');
  assert.equal(evidence.participantCount, 32);
  assert.equal(evidence.first_joins.length, 32);
  assert.deepEqual(evidence.first_joins.map(join => join.priorParticipants), Array.from({ length: 32 }, (_, index) => index));
  assert.ok(evidence.first_joins.every(join => join.selfExcluded && join.positionsPreserved));
  assert.equal(evidence.routing.recipientAttempts, 224 * 2);
  assert.equal(evidence.routing.recipients, 28);
  assert.equal(evidence.routing.unrelatedContexts, 0);
  assert.equal(evidence.routing.contexts, 56);
  assert.equal(evidence.coalescing.pending_before_ack, 28);
  assert.equal(evidence.coalescing.dirty_before_ack, 28);
  assert.equal(evidence.coalescing.peak_pending_per_actor, 1);
  assert.equal(evidence.coalescing.peak_dirty_paths_per_actor, 2);
  assert.equal(evidence.coalescing.latest_revisions_preserved, true);
  assert.ok(evidence.context_size.max_bytes > 0 && evidence.context_size.max_bytes <= 32 * 1024);
  for (const actor of evidence.recipients.filter(actor => actor.dependencies.length)) {
    assert.equal(actor.contexts, 2);
    assert.equal(actor.latestRevisions.length, 2);
    for (const entry of actor.latestRevisions) {
      assert.equal(entry.revision, evidence.finalRevisions[entry.path]);
      assert.ok(actor.firstRevisions.find(first => first.path === entry.path).revision < entry.revision);
    }
  }
  assert.equal(evidence.native_sse.frames, 96);
  assert.equal(evidence.native_sse.correlatedReads, 32);
  assert.equal(evidence.read_bases.unverified, 32);
  assert.equal(evidence.limits.liveModelBuilders, 0);
  assert.equal(evidence.limits.productBenefitEstablished, false);
});

test('real reducer rejects duplicate/reordered/retired controls and retains uncertainty after a gap', async () => {
  const evidence = await runScale({ participants: 8, eventCount: 24, batchSize: 4 });
  for (const [name, passed] of Object.entries(evidence.adverse_checks)) assert.equal(passed, true, name);
  assert.equal(evidence.dispatch_latency.count, 24);
  assert.equal(evidence.presence_latency.count, 8);
  assert.ok(evidence.dispatch_latency.max_ms >= evidence.dispatch_latency.p95_ms);
  assert.ok(evidence.context_compile_latency.max_ms >= evidence.context_compile_latency.p50_ms);
  assert.equal(evidence.limits.nativeWritesFenced, false);
});

test('resource bounds reject oversized or invalid loads before allocating participants', async () => {
  for (const options of [{ participants: 33 }, { participants: 7 }, { eventCount: 10_001 }, { eventCount: 0 }, { batchSize: 1_001 }]) {
    await assert.rejects(runScale(options), /invalid_scale_bounds/);
  }
});
