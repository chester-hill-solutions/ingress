/**
 * A mission fixture is frozen once a flight has run against it.
 *
 * Twice in one afternoon this mattered, and neither time did anything complain.
 *
 * The first was a spec sentence reworded so the ingest contract read more clearly. The verifier's
 * protected-file gate compares every protected file against the *current* fixture, so the edit
 * made all four of the flight's artifacts fail the gate -- which skips the evaluator entirely and
 * reports every criterion as failed, in nineteen milliseconds, without saying why.
 *
 * The second was the same class of thing from the other direction: the re-grade script recomputes
 * the seed hash and compares it with what the flight recorded, which is how anyone finds out that
 * an artifact and its fixture have drifted apart.
 *
 * So the discipline is written down as a number. A mission that has flown goes in this table, and
 * changing its files means a new mission id -- because the artifacts of the old one are evidence,
 * and evidence that cannot be re-graded is not evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { missionFixtures } from '../fixtures/missions.mjs';
import { configureMission } from '../fixtures/mission-configurations.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Every mission that has been flown, against the seed hash its flight recorded.
 *
 * `signal-analytics` was flown on 2026-10-22 in `artifacts/mission-flight-8ce2fc74`: four cohorts,
 * and the number below is the `seedSHA256` those four assignments carry.
 */
const flown = {
  'signal-analytics': 'f3c4993d2e29bbc55de8574dd32be5cbeb027c2b040601bbcc5a7c3f052f4533',
};

test('a mission that has flown still has the seed its flight was graded against', () => {
  for (const [id, hash] of Object.entries(flown)) {
    const fixture = missionFixtures.find(value => value.id === id);
    assert.ok(fixture, `${id} is flown and no longer in the registry`);
    // The seed is the base files plus the injected directive, which is what a cohort is given.
    // Every configuration gives the same seed; only the roster and the treatment differ.
    for (const configID of ['stock-eight', 'ingress-eight']) {
      assert.equal(digest(configureMission(fixture, configID).files), hash,
        `${id}'s seed changed after a flight was graded against it: its artifacts can no longer be re-graded, so this needs a new mission id`);
    }
  }
});

test('every flown mission is still in the registry, so its artifacts stay gradable', () => {
  for (const id of Object.keys(flown)) {
    assert.ok(missionFixtures.some(fixture => fixture.id === id), `${id} was removed after being flown`);
  }
});
