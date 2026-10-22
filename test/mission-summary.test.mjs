/**
 * A flight's durable summary: small enough to commit, complete enough to cite.
 *
 * The interesting properties are about *what a summary refuses to lose*. A cohort that failed and a
 * cohort that was never run are different facts; a protected-file failure is not the same as a
 * criterion failure; the seed hash is what makes a later re-grade meaningful. All of those are one
 * line each here, and all of them would be silently lost by a summary that only counted passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightSummary } from '../src/mission-summary.mjs';

const evidence = {
  flight: 'flight-1',
  created: '2026-10-22T17:00:00.000Z',
  ended: '2026-10-22T18:00:00.000Z',
  status: 'complete',
  results: [{
    id: 'a-1-m-c',
    fixtureID: 'a',
    configID: 'c',
    actorModels: [{ providerID: 'opencode', id: 'm' }],
    outcome: 'completed',
    correct: true,
    elapsedMs: 100000,
    seedSHA256: 'seed',
    actors: [{ id: 'x', outcome: 'succeeded', usage: { input: 10, output: 5, cost: 0.1 } }, { id: 'y', outcome: 'deadline', usage: { input: 1, output: 1, cost: 0.05 } }],
    verification: { checks: [{ name: 'one', passed: true }, { name: 'two', passed: false }], instructionChecks: [{ name: 'protected:MISSION.md', passed: true }, { name: 'protected:BRIEF.md', passed: false }] },
    snapshots: [{ targetMs: 60000, verification: { checks: [{ name: 'one', passed: false }] } }],
    errors: [{ code: 'something' }],
  }],
  errors: [],
};

test('a summary keeps the facts a later reader needs and stays committable', () => {
  const summary = flightSummary(evidence, { source: { 'a.mjs': 'sha', 'b.mjs': 'sha' } });
  assert.equal(summary.totals.cohorts, 1);
  assert.equal(summary.totals.correct, 1);
  assert.equal(summary.totals.tokens, 17, 'input and output are summed across actors');
  assert.equal(summary.totals.cost, 0.15);
  assert.equal(summary.totals.actorFailures, 1, 'a deadline is an actor failure and is counted as one');
  assert.deepEqual(summary.cohorts[0].checks, { passed: 1, total: 2, failed: ['two'] });
  assert.deepEqual(summary.cohorts[0].protected.failed, ['protected:BRIEF.md'], 'a changed protected file is its own fact');
  assert.deepEqual(summary.cohorts[0].bands, [{ atMs: 60000, passed: 0, total: 1 }]);
  assert.equal(summary.cohorts[0].seedSHA256, 'seed');
  assert.deepEqual(summary.cohorts[0].errors, ['something']);
  assert.deepEqual(summary.sourceDigest, { files: 2, digest: summary.sourceDigest.digest });
  assert.ok(JSON.stringify(summary).length < 3000, 'a summary that is not small is not committable');
});

test('malformed evidence is refused rather than summarised as an empty flight', () => {
  for (const value of [null, undefined, {}, { results: 'no' }]) {
    assert.throws(() => flightSummary(value), /invalid_flight_evidence/, `accepted ${JSON.stringify(value)}`);
  }
});
