/**
 * Usage and the cost ceiling.
 *
 * `POST /start` boots a container and holds it for as long as the command runs. Nothing
 * counted those until this, so a workspace could be asked to start until the account holder
 * noticed the invoice. These are the counters and the bound that stops it.
 *
 * `src/product/usage.mjs` is pure, so all of the arithmetic is covered here without an
 * account. What is not covered here, and stated rather than implied: that a real container
 * costs what this assumes. The defaults are a starting bound, not a derived price, and the
 * reasoning is recorded at the constants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyUsage,
  usageFrom,
  usageSnapshot,
  startRefusal,
  startDelta,
  commitDelta,
  leaseConflictDelta,
  applyDelta,
  ceilingFromEnv,
  DEFAULT_MAX_STARTS,
  DEFAULT_MAX_RUN_SECONDS,
  USAGE_FIELDS,
} from '../src/product/usage.mjs';

const NOW = 1_700_000_000_000;
const CEILING = { maxStarts: 3, maxRunSeconds: 600 };

// --- counting ---------------------------------------------------------------

test('a fresh record is zeroed and stamped', () => {
  const usage = emptyUsage(NOW);
  for (const field of USAGE_FIELDS) {
    assert.equal(usage[field], 0, `${field} should start at zero`);
  }
  assert.equal(usage.firstSeenAt, new Date(NOW).toISOString());
  assert.equal(usage.lastSeenAt, new Date(NOW).toISOString());
});

test('a start is counted with the run time it asked for', () => {
  const usage = applyDelta(emptyUsage(NOW), startDelta({ runMs: 90_000 }), NOW);
  assert.equal(usage.starts, 1);
  assert.equal(usage.runSecondsRequested, 90,
    'run time is counted in seconds, rounded up — 90_000ms is not 89.999');
});

test('run time rounds up, because a container is billed for the second it is alive', () => {
  // Rounding down would let a workspace exceed the ceiling by one second per start, and a
  // caller could do that deliberately: 500 starts of 1999ms each is nearly 17 minutes of
  // unaccounted container time.
  const applied = runMs => applyDelta(emptyUsage(NOW), startDelta({ runMs }), NOW).runSecondsRequested;
  assert.equal(applied(1), 1);
  assert.equal(applied(1000), 1);
  assert.equal(applied(1001), 2);
});

test('commits are counted by verdict, and a refusal is not an admission', () => {
  let usage = emptyUsage(NOW);
  usage = applyDelta(usage, commitDelta({ admitted: true, bytes: 100 }), NOW);
  usage = applyDelta(usage, commitDelta({ admitted: true, bytes: 50 }), NOW);
  usage = applyDelta(usage, commitDelta({ admitted: false }), NOW);
  usage = applyDelta(usage, commitDelta({ admitted: null }), NOW);

  assert.equal(usage.commitsAdmitted, 2);
  assert.equal(usage.commitsRefused, 1);
  assert.equal(usage.commitsEmpty, 1);
  assert.equal(usage.bytesAdmitted, 150);
});

test('a lease conflict is counted but never refuses anything', () => {
  const usage = applyDelta(emptyUsage(NOW), leaseConflictDelta(), NOW);
  assert.equal(usage.leaseConflicts, 1);
  // Ten thousand conflicts and the ceiling still has room. A workspace being refused a
  // thousand times a second is a workspace whose callers are confused; cutting it off there
  // would hide the confusion rather than fix it.
  let many = emptyUsage(NOW);
  for (let i = 0; i < 10_000; i++) many = applyDelta(many, leaseConflictDelta(), NOW);
  assert.equal(startRefusal(many, CEILING, { runMs: 1000 }), null);
});

// --- the ceiling -------------------------------------------------------------

test('a start within the ceiling is allowed', () => {
  assert.equal(startRefusal(emptyUsage(NOW), CEILING, { runMs: 60_000 }), null);
});

test('the ceiling refuses at the bound, naming the limit it hit', () => {
  const usage = applyDelta(applyDelta(applyDelta(emptyUsage(NOW), startDelta({ runMs: 1000 }), NOW),
    startDelta({ runMs: 1000 }), NOW), startDelta({ runMs: 1000 }), NOW);
  const refusal = startRefusal(usage, CEILING, { runMs: 1000 });

  assert.ok(refusal, 'the fourth start must be refused at a ceiling of three');
  assert.equal(refusal.reason, 'cost_ceiling');
  assert.equal(refusal.limit, 'starts');
  assert.equal(refusal.used, 3);
  assert.equal(refusal.allowed, 3);
  assert.match(refusal.detail, /3/, 'and it must say the number');
});

test('the run-time ceiling refuses before the start that would cross it', () => {
  // The bound is on cumulative requested time, and the check has to include the start being
  // checked — otherwise a workspace one second short of the ceiling can request an
  // arbitrarily long run and blow straight through it.
  let usage = emptyUsage(NOW);
  usage = applyDelta(usage, startDelta({ runMs: 590_000 }), NOW);   // 590s of 600

  assert.equal(startRefusal(usage, CEILING, { runMs: 5_000 }), null, '590 + 5 = 595, under');
  const refusal = startRefusal(usage, CEILING, { runMs: 20_000 });  // 590 + 20 = 610, over
  assert.ok(refusal);
  assert.equal(refusal.limit, 'runSeconds');
  assert.equal(refusal.requested, 20);
  assert.equal(refusal.allowed, 10,
    'the refusal says what room is left, which is the number the caller can act on');
});

test('the start ceiling is checked before the run-time ceiling', () => {
  // Both exceeded at once. Starts is the coarser bound and the more likely to be the real
  // one, so it is the one named.
  let usage = emptyUsage(NOW);
  for (let i = 0; i < 5; i++) usage = applyDelta(usage, startDelta({ runMs: 600_000 }), NOW);
  const refusal = startRefusal(usage, CEILING, { runMs: 1000 });
  assert.equal(refusal.limit, 'starts');
});

// --- folding a stored record --------------------------------------------------

test('a record missing a counter reads as zero, not undefined', () => {
  // The failure this prevents is quiet: `undefined` in a sum is NaN, and NaN compares false
  // against every ceiling, so a workspace whose record predates a counter added later would
  // be permanently under its limit and the counter would never work again.
  const partial = { starts: 7, firstSeenAt: '2020-01-01T00:00:00.000Z' };
  const usage = usageFrom(partial, NOW);

  assert.equal(usage.starts, 7);
  for (const field of USAGE_FIELDS.filter(f => f !== 'starts')) {
    assert.equal(usage[field], 0, `${field} should fold in as zero`);
  }
  assert.equal(usage.firstSeenAt, '2020-01-01T00:00:00.000Z', 'and the original stamp survives');
});

test('a garbage counter folds in as zero rather than poisoning the sums', () => {
  const usage = usageFrom({ starts: 'many', runSecondsRequested: null, commitsAdmitted: NaN }, NOW);
  assert.equal(usage.starts, 0);
  assert.equal(usage.runSecondsRequested, 0);
  assert.equal(usage.commitsAdmitted, 0);
  assert.equal(Number.isNaN(usage.starts + usage.commitsAdmitted), false,
    'no NaN may reach the ceiling comparison');
});

test('a missing record is not an error', () => {
  assert.equal(usageFrom(null, NOW).starts, 0);
  assert.equal(usageFrom(undefined, NOW).starts, 0);
  assert.equal(usageFrom('nonsense', NOW).starts, 0);
});

// --- the snapshot -------------------------------------------------------------

test('the snapshot reports what is left, and whether it is gone', () => {
  const usage = applyDelta(emptyUsage(NOW), startDelta({ runMs: 60_000 }), NOW);

  const snapshot = usageSnapshot(usage, CEILING, NOW);
  assert.equal(snapshot.starts, 1);
  assert.equal(snapshot.remaining.starts, 2);
  assert.equal(snapshot.remaining.runSeconds, 540);
  assert.equal(snapshot.ceiling.maxStarts, 3);
  assert.equal(snapshot.exhausted, false);

  let spent = emptyUsage(NOW);
  for (let i = 0; i < 3; i++) spent = applyDelta(spent, startDelta({ runMs: 300_000 }), NOW);
  const exhausted = usageSnapshot(spent, CEILING, NOW);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.remaining.starts, 0);
  assert.equal(exhausted.remaining.runSeconds, 0);
});

test('remaining never goes negative', () => {
  // A counter that outran its ceiling — because the ceiling was lowered after the fact —
  // must not report negative room, which would read as "you may use -4 seconds".
  let usage = emptyUsage(NOW);
  for (let i = 0; i < 4; i++) usage = applyDelta(usage, startDelta({ runMs: 1000 }), NOW);
  const snapshot = usageSnapshot(usage, CEILING, NOW);

  assert.equal(snapshot.starts, 4);
  assert.equal(snapshot.remaining.starts, 0);
  assert.equal(snapshot.remaining.runSeconds >= 0, true);
});

// --- the ceiling from the environment -----------------------------------------

test('the defaults apply when nothing is configured', () => {
  const ceiling = ceilingFromEnv({});
  assert.equal(ceiling.maxStarts, DEFAULT_MAX_STARTS);
  assert.equal(ceiling.maxRunSeconds, DEFAULT_MAX_RUN_SECONDS);
});

test('a configured ceiling is read', () => {
  const ceiling = ceilingFromEnv({
    INGRESS_MAX_STARTS_PER_WORKSPACE: '7',
    INGRESS_MAX_RUN_SECONDS: '60',
  });
  assert.equal(ceiling.maxStarts, 7);
  assert.equal(ceiling.maxRunSeconds, 60);
});

test('a nonsense ceiling falls back to the default rather than failing open', () => {
  // `MAX_STARTS=0` is the one that matters: a deployment that set it by accident would
  // refuse every start, and a ceiling that fails open is worse than one that is merely
  // wrong. So 0, a negative, a word and an empty string all land on the default — never on
  // infinity.
  for (const bad of ['0', '-1', 'abc', '', null, undefined, Number.NaN]) {
    const ceiling = ceilingFromEnv({ INGRESS_MAX_STARTS_PER_WORKSPACE: bad });
    assert.equal(ceiling.maxStarts, DEFAULT_MAX_STARTS, `${String(bad)} should fall back`);
  }
});

test('a fractional ceiling is floored, not rounded up', () => {
  // Rounding up would grant a caller a start they did not ask for; flooring never does.
  assert.equal(ceilingFromEnv({ INGRESS_MAX_STARTS_PER_WORKSPACE: '3.9' }).maxStarts, 3);
});