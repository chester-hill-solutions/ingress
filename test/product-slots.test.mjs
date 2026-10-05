/**
 * Which executor slot a start may use.
 *
 * This is the safety-relevant part of the split. Two starts landing in one slot means two
 * containers on one Durable Object, which is the platform error the whole design exists to
 * avoid — and it surfaces as `start() cannot be called on a container that is already
 * running`, with no indication of which two starts collided.
 *
 * Pure module, so every case here runs without an account.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSlot,
  maxConcurrentStarts,
  executorName,
  SlotRefusal,
  DEFAULT_MAX_CONCURRENT_STARTS,
  SLOT_TTL_MS,
} from '../src/product/slots.mjs';

const NOW = 1_700_000_000_000;
const held = (...slots) => slots.map(slot => ({ slot, expiresAt: NOW + 60_000 }));

// --- allocation ---------------------------------------------------------------

test('an empty workspace gets the lowest slot', () => {
  const { slot } = allocateSlot([], DEFAULT_MAX_CONCURRENT_STARTS, NOW);
  assert.equal(slot, 0);
});

test('slots are handed out in order, and never reused while held', () => {
  const taken = held(0, 1, 2);
  const { slot } = allocateSlot(taken, DEFAULT_MAX_CONCURRENT_STARTS, NOW);
  assert.equal(slot, 3);
});

test('a freed slot is reused before a higher one', () => {
  // The first version used `live.length`, which would hand out slot 0 while it was still
  // free-but-unlisted and slot 3 while it was held — the symptom being a platform "already
  // running" error attributed to no cause at all.
  const taken = held(0, 2, 3);
  const { slot } = allocateSlot(taken, DEFAULT_MAX_CONCURRENT_STARTS, NOW);
  assert.equal(slot, 1, 'the lowest free index, not the count of live slots');
});

test('a full workspace is refused, and says what is running', () => {
  assert.throws(
    () => allocateSlot(held(0, 1, 2, 3), 4, NOW),
    error => {
      assert.ok(error instanceof SlotRefusal);
      assert.equal(error.reason, 'too_many_concurrent_starts');
      assert.equal(error.running, 4);
      assert.equal(error.cap, 4);
      return true;
    },
  );
});

test('an expired slot is not running', () => {
  // A Durable Object can be evicted mid-run. The next instance must not inherit a full quota
  // from a process that no longer exists — and must not inherit a *half* one either.
  const stale = [{ slot: 0, expiresAt: NOW - 1 }, { slot: 1, expiresAt: NOW }];
  const { slot } = allocateSlot(stale, 4, NOW);
  assert.equal(slot, 0, 'an entry expiring exactly now is gone');
});

test('a slot outlives the maximum run it guards', () => {
  // If a slot expired before its container could finish, the next start would free the slot
  // while the container was still alive and collide with it.
  assert.ok(SLOT_TTL_MS > 15 * 60_000, `slot TTL ${SLOT_TTL_MS}ms must exceed the 15-minute run ceiling`);
});

// --- legacy and malformed entries ----------------------------------------------

test('a bare expiry from the old format is pruned, not given a slot', () => {
  // Before slots existed the array held bare timestamps. Interpreting one would mean inventing
  // a slot number, and two callers inventing the same one is exactly the collision this must
  // not have. It is dropped instead.
  const legacy = [NOW + 60_000, NOW + 120_000];
  const { slot, active } = allocateSlot(legacy, 4, NOW);
  assert.equal(slot, 0);
  assert.deepEqual(active, [], 'and the legacy entries do not count as occupied');
});

test('entries without a usable slot or expiry are dropped', () => {
  const junk = [
    { slot: 0 },
    { expiresAt: NOW + 60_000 },
    { slot: 'one', expiresAt: NOW + 60_000 },
    { slot: 1, expiresAt: 'soon' },
    null,
  ];
  const { slot, active } = allocateSlot(junk, 4, NOW);
  assert.equal(slot, 0);
  assert.deepEqual(active, []);
});

test('a non-array is treated as nothing running', () => {
  for (const junk of [null, undefined, 'busy', 42]) {
    assert.equal(allocateSlot(junk, 4, NOW).slot, 0);
  }
});

// --- the cap ------------------------------------------------------------------

test('the default cap is more than one', () => {
  // One would be the platform's limit restated, which is the mistake this module exists to
  // undo. The cap exists to bound cost and to keep contention explainable.
  assert.ok(DEFAULT_MAX_CONCURRENT_STARTS > 1, 'a cap of one reintroduces the original problem');
});

test('the cap is read from the environment', () => {
  assert.equal(maxConcurrentStarts({}), DEFAULT_MAX_CONCURRENT_STARTS);
  assert.equal(maxConcurrentStarts({ INGRESS_MAX_CONCURRENT_STARTS: '7' }), 7);
});

test('a nonsense cap falls back to the default rather than to zero or infinity', () => {
  // Zero would refuse every start with no explanation. Infinity would put the platform's
  // one-container-per-object error back in front of a caller with nothing to act on.
  for (const bad of ['0', '-3', 'abc', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      maxConcurrentStarts({ INGRESS_MAX_CONCURRENT_STARTS: bad }),
      DEFAULT_MAX_CONCURRENT_STARTS,
      `${String(bad)} should fall back`,
    );
  }
});

test('a fractional cap is floored', () => {
  assert.equal(maxConcurrentStarts({ INGRESS_MAX_CONCURRENT_STARTS: '3.9' }), 3);
});

test('allocation clamps a nonsense cap rather than looping forever', () => {
  assert.equal(allocateSlot([], 0, NOW).slot, 0);
  assert.equal(allocateSlot(held(0), -1, NOW).slot, 1, 'a negative cap still allocates from the default');
});

// --- the executor name --------------------------------------------------------

test('the executor name is stable and distinct per slot', () => {
  assert.equal(executorName('proj', 0), 'proj/executor-0');
  assert.equal(executorName('proj', 1), 'proj/executor-1');
  // Distinct per slot is the guarantee: an executor's identity is what caps it at one
  // container, so a name collision would silently break that.
  assert.notEqual(executorName('proj', 0), executorName('proj', 1));
});

test('workspaces do not share executors', () => {
  assert.notEqual(executorName('alpha', 0), executorName('beta', 0));
});

test('the allocation expiry matches the TTL the caller will store', () => {
  const { expiresAt } = allocateSlot([], 4, NOW);
  assert.equal(expiresAt, NOW + SLOT_TTL_MS);
});