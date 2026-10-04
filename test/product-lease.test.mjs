/**
 * Lease tests.
 *
 * The four properties this design claims, in order of how much they matter:
 *
 *   1. holding a file means the workspace gave it to you  (read is not self-reported)
 *   2. a finite lease means a dead holder cannot block anyone forever
 *   3. liveness reporting cannot compromise anyone but the liar
 *   4. a cycle is found rather than deadlocked into
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseTable, LeaseConflict, expandClosure, DEFAULT_LEASE_MS, MAX_LEASE_MS } from '../src/product/lease.mjs';

const NOW = 1_700_000_000_000;
const at = offset => NOW + offset;

function table() {
  return new LeaseTable();
}

test('a grant hands over exactly what was asked for', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['engine.mjs'], mode: 'write', now: NOW });

  assert.equal(lease.participantId, 'A');
  assert.equal(lease.mode, 'write');
  assert.deepEqual([...lease.paths], ['engine.mjs']);
  assert.equal(lease.expiresAt, NOW + DEFAULT_LEASE_MS);
});

test('many readers share a file; a writer excludes everyone', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['engine.mjs'], mode: 'read', now: NOW });
  leases.checkout({ participantId: 'B', paths: ['engine.mjs'], mode: 'read', now: NOW });

  // Reading is concurrent: neither blocked the other.
  assert.equal(leases.holdersOf('engine.mjs').length, 2);

  assert.throws(
    () => leases.checkout({ participantId: 'C', paths: ['engine.mjs'], mode: 'write', now: NOW }),
    error => {
      assert.equal(error.reason, 'lease_conflict');
      assert.deepEqual(error.blockedOn.sort(), ['A', 'B']);
      assert.equal(error.conflicts.length, 2);
      return true;
    }
  );
});

test('a writer excludes a later reader', () => {
  const leases = table();
  leases.checkout({ participantId: 'writer', paths: ['engine.mjs'], mode: 'write', now: NOW });
  assert.throws(
    () => leases.checkout({ participantId: 'reader', paths: ['engine.mjs'], mode: 'read', now: NOW }),
    LeaseConflict
  );
});

test('a grant is atomic over the closure: one blocked path refuses them all', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['engine.mjs'], mode: 'write', now: NOW });

  // B wants two files. One is free, one is held. B must get neither, because a
  // partial grant would hold a lease it cannot use while blocking others.
  assert.throws(
    () => leases.checkout({ participantId: 'B', paths: ['ui.mjs', 'engine.mjs'], mode: 'write', now: NOW }),
    error => error.conflicts.length === 1 && error.conflicts[0].path === 'engine.mjs'
  );

  assert.equal(leases.holdersOf('ui.mjs').length, 0, 'ui.mjs must NOT be granted');
  assert.deepEqual(leases.leasesFor('B', { now: NOW }), []);
});

test('a lease is finite, so a dead holder cannot block anyone forever', () => {
  const leases = table();
  leases.checkout({ participantId: 'dead', paths: ['engine.mjs'], mode: 'write', now: NOW, leaseMs: 1000 });

  assert.throws(
    () => leases.checkout({ participantId: 'B', paths: ['engine.mjs'], mode: 'write', now: at(500) }),
    LeaseConflict,
    'still blocked while the lease is live'
  );

  // After expiry the sweep clears it and B proceeds.
  const { lease } = leases.checkout({ participantId: 'B', paths: ['engine.mjs'], mode: 'write', now: at(2000) });
  assert.equal(lease.participantId, 'B');
});

test('a takeover records who it took over from', () => {
  const leases = table();
  leases.checkout({ participantId: 'dead', paths: ['engine.mjs'], mode: 'write', now: NOW, leaseMs: 1000 });
  const { reclaimedFrom } = leases.checkout({ participantId: 'B', paths: ['engine.mjs'], mode: 'write', now: at(2000) });

  assert.equal(reclaimedFrom.length, 1);
  assert.equal(reclaimedFrom[0].participantId, 'dead');
  assert.deepEqual(reclaimedFrom[0].paths, ['engine.mjs']);
});

test('a heartbeat extends a lease', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 5000 });

  const beat = leases.heartbeat({ leaseId: lease.leaseId, participantId: 'A', now: at(3000), leaseMs: 5000 });
  assert.equal(beat.alive, true);
  assert.equal(beat.expiresAt, at(8000));
  assert.deepEqual(beat.heldBy, ['a.mjs']);
  assert.equal(leases.leases.get(lease.leaseId).heartbeats, 1);
});

test('a heartbeat cannot revive an expired lease', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 1000 });
  // It lapsed and B took the path.
  leases.checkout({ participantId: 'B', paths: ['a.mjs'], mode: 'write', now: at(5000) });

  const beat = leases.heartbeat({ leaseId: lease.leaseId, participantId: 'A', now: at(6000) });
  assert.equal(beat.alive, false);
  assert.equal(beat.reason, 'lease_expired');
  assert.equal(leases.leasesFor('B', { now: at(6000) }).length, 1, 'B still holds it: no double grant');
});

test('a heartbeat for someone else\'s lease is refused', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW });
  const beat = leases.heartbeat({ leaseId: lease.leaseId, participantId: 'impostor', now: NOW });
  assert.equal(beat.alive, false);
  assert.equal(beat.reason, 'lease_not_yours');
});

test('liveness reporting cannot buy anyone extra time beyond the cap', () => {
  const leases = table();
  const { lease } = leases.checkout({
    participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 10 * MAX_LEASE_MS,
  });
  assert.equal(lease.expiresAt, NOW + MAX_LEASE_MS, 'a heartbeat cannot extend past the maximum');
});

test('a heartbeat from a dead holder only delays recovery; it cannot deny it', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 1000 });
  // A keeps beating right up to the moment it lapses, then goes silent.
  leases.heartbeat({ leaseId: lease.leaseId, participantId: 'A', now: at(900), leaseMs: 1000 });

  assert.throws(
    () => leases.checkout({ participantId: 'B', paths: ['a.mjs'], mode: 'write', now: at(1000) }),
    LeaseConflict,
    'live lease still blocks, even by a whisker'
  );

  const { lease: taken } = leases.checkout({ participantId: 'B', paths: ['a.mjs'], mode: 'write', now: at(2000) });
  assert.equal(taken.participantId, 'B', 'and once it lapses, recovery happens regardless');
});

test('retrieve refuses while the lease is live, however sure the caller is', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 60_000 });

  assert.throws(
    () => leases.retrieve({ participantId: 'B', paths: ['a.mjs'], now: at(1000) }),
    error => {
      assert.equal(error.reason, 'lease_conflict');
      assert.match(error.detail, /still live/);
      return true;
    }
  );
});

test('retrieve succeeds once the lease has expired', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 1000 });
  const { lease, reclaimedFrom } = leases.retrieve({ participantId: 'B', paths: ['a.mjs'], now: at(2000) });
  assert.equal(lease.participantId, 'B');
  assert.equal(lease.mode, 'write', 'a takeover is a write: the taker intends to change it');
  assert.equal(reclaimedFrom[0].participantId, 'A');
});

test('a cycle is found rather than deadlocked into', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['x.mjs'], mode: 'write', now: NOW });
  leases.checkout({ participantId: 'B', paths: ['y.mjs'], mode: 'write', now: NOW });

  // A wants B's file and is blocked.
  try {
    leases.checkout({ participantId: 'A', paths: ['y.mjs'], mode: 'write', now: NOW });
  } catch (error) {
    leases.noteBlocked('A', error.blockedOn);
  }

  // B now wants A's file. This would close the loop.
  assert.throws(
    () => leases.checkout({ participantId: 'B', paths: ['x.mjs'], mode: 'write', now: NOW }),
    error => {
      assert.equal(error.reason, 'lease_conflict');
      assert.ok(Array.isArray(error.cycle) && error.cycle.length > 0, 'the cycle is named');
      assert.match(error.detail, /deadlock/);
      return true;
    }
  );
});

test('a blocked participant that gets in stops blocking others', () => {
  const leases = table();
  leases.checkout({ participantId: 'A', paths: ['x.mjs'], mode: 'write', now: NOW });

  try {
    leases.checkout({ participantId: 'B', paths: ['x.mjs'], mode: 'write', now: NOW });
  } catch (error) {
    leases.noteBlocked('B', error.blockedOn);
  }
  assert.deepEqual([...leases.waits.get('B')], ['A']);

  const released = leases.release({ leaseId: leases.leasesFor('A', { now: NOW })[0].leaseId, participantId: 'A', now: NOW });
  assert.deepEqual(released.woken, ['B'], 'release wakes the waiter: the workspace is the broker');
  assert.equal(leases.waits.has('B'), false, 'and the stale edge is cleared, so no phantom cycle later');
});

test('release can free part of a lease', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs', 'b.mjs'], mode: 'write', now: NOW });
  const result = leases.release({ leaseId: lease.leaseId, participantId: 'A', paths: ['a.mjs'], now: NOW });

  assert.deepEqual(result.released, ['a.mjs']);
  assert.deepEqual(result.remaining, ['b.mjs']);
  assert.throws(() => leases.checkout({ participantId: 'C', paths: ['b.mjs'], mode: 'write', now: NOW }), LeaseConflict);
  assert.doesNotThrow(() => leases.checkout({ participantId: 'C', paths: ['a.mjs'], mode: 'write', now: NOW }));
});

test('the same participant re-checking out its own path is fine', () => {
  const leases = table();
  const first = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW });
  const second = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW });
  assert.notEqual(first.lease.leaseId, second.lease.leaseId);
  assert.equal(leases.holdersOf('a.mjs').length, 2, 'two leases, same holder');
});

test('a malformed checkout is refused rather than half-applied', () => {
  const leases = table();
  assert.throws(() => leases.checkout({ participantId: 'A', paths: [], mode: 'write', now: NOW }), LeaseConflict);
  assert.throws(() => leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'delete', now: NOW }), LeaseConflict);
  assert.throws(() => leases.checkout({ participantId: 'A', paths: 'a.mjs', mode: 'write', now: NOW }), LeaseConflict);
  assert.equal(leases.leases.size, 0, 'no malformed request may leave a lease behind');
});

test('the lease duration is clamped at both ends', () => {
  const leases = table();
  // Too short: clamped up to the floor, because a lease measured in
  // milliseconds would expire between the grant and the first use.
  const short = leases.checkout({ participantId: 'A', paths: ['a.mjs'], mode: 'write', now: NOW, leaseMs: 1 });
  assert.equal(short.lease.expiresAt, NOW + 1000);

  // Too long: clamped down to the ceiling, so no participant can hold a path
  // indefinitely by asking nicely.
  const long = leases.checkout({ participantId: 'B', paths: ['b.mjs'], mode: 'write', now: NOW, leaseMs: 99 * MAX_LEASE_MS });
  assert.equal(long.lease.expiresAt, NOW + MAX_LEASE_MS);
});

test('a lease cannot cover an unbounded number of paths', () => {
  const leases = table();
  const many = Array.from({ length: 257 }, (_, i) => `f${i}.mjs`);
  assert.throws(
    () => leases.checkout({ participantId: 'A', paths: many, mode: 'write', now: NOW }),
    /at most 256 paths/
  );
});

test('the closure includes declared dependencies, sorted and deduplicated', () => {
  const closure = expandClosure({
    requested: ['ui.mjs', 'engine.mjs'],
    declaredDependencies: ['engine.mjs', 'lib.mjs'],
  });
  assert.deepEqual(closure, ['engine.mjs', 'lib.mjs', 'ui.mjs']);
});

test('the closure ignores junk rather than granting a bad path', () => {
  assert.deepEqual(expandClosure({ requested: ['ok.mjs', '', null, 42], declaredDependencies: [undefined] }), ['ok.mjs']);
});

test('the table survives a round trip through storage', () => {
  const leases = table();
  const { lease } = leases.checkout({ participantId: 'A', paths: ['a.mjs', 'b.mjs'], mode: 'write', now: NOW });
  leases.checkout({ participantId: 'B', paths: ['c.mjs'], mode: 'read', now: NOW });
  try {
    leases.checkout({ participantId: 'C', paths: ['a.mjs'], mode: 'write', now: NOW });
  } catch (error) {
    leases.noteBlocked('C', error.blockedOn);
  }

  const revived = LeaseTable.fromJSON(JSON.parse(JSON.stringify(leases.toJSON())));
  assert.deepEqual([...revived.leasesFor('A', { now: NOW })[0].paths].sort(), ['a.mjs', 'b.mjs']);
  assert.deepEqual([...revived.waits.get('C')], ['A']);
  assert.throws(() => revived.checkout({ participantId: 'C', paths: ['a.mjs'], mode: 'write', now: NOW }), LeaseConflict);
});