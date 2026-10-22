/**
 * The recovery plan and its tax.
 *
 * The property that matters is that the mechanism's *cost* is as visible as its benefit:
 * the campaign found half of all invalidations produced regenerations that changed nothing,
 * and a harness that only reports the benefit would hide that. These tests pin the policy
 * (who is asked, how often, and what happens when nobody owns the output) and the
 * arithmetic (what a regeneration cost, and how much of it was wasted).
 *
 * The two verdicts are asserted separately because they are the two ways a recovery run can
 * look like success and not be one: coherent-but-wrong is a laundered failure, and
 * correct-but-incoherent is a stale output nobody has noticed yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPlan, taxOf, recoveryVerdict } from '../src/mission-recovery.mjs';

const outputs = [
  { path: 'src/report.mjs', task: 'report' },
  { path: 'src/summary.mjs', task: 'summary' },
  { path: 'config/policy.json', task: 'policy' },
];

const invalidated = (...entries) => entries.map(([path, depth, extra = {}]) => ({
  path,
  depth,
  staleInputs: extra.staleInputs ?? [{ path: 'config/policy.json', publishedRevision: 1, currentRevision: 2, author: 'policy', missing: false }],
  via: extra.via ?? [],
}));

test('the owner of an invalidated output is asked to regenerate it, once', () => {
  const plan = recoveryPlan({ invalidated: invalidated(['src/report.mjs', 0]), outputs });
  assert.deepEqual(plan.regenerate, [{
    task: 'report',
    path: 'src/report.mjs',
    attempt: 1,
    depth: 0,
    staleInputs: [{ path: 'config/policy.json', publishedRevision: 1, currentRevision: 2, author: 'policy', missing: false }],
  }]);
  assert.deepEqual(plan.exhausted, []);
  assert.deepEqual(plan.unowned, []);
  assert.equal(plan.empty, false);
});

test('a task with two invalidated outputs is asked once, not twice', () => {
  const two = [
    { path: 'src/report.mjs', task: 'report' },
    { path: 'src/report.snapshot.mjs', task: 'report' },
  ];
  const plan = recoveryPlan({
    invalidated: invalidated(['src/report.mjs', 0], ['src/report.snapshot.mjs', 0]),
    outputs: two,
  });
  assert.deepEqual(plan.regenerate.map(entry => entry.path), ['src/report.mjs'],
    'the first output of a task is the one named; the task is what is re-run');
});

test('the transitive carrier and the direct contradiction are both asked for', () => {
  const plan = recoveryPlan({
    invalidated: invalidated(['src/summary.mjs', 1, { via: ['src/report.mjs'], staleInputs: [] }], ['src/report.mjs', 0]),
    outputs,
  });
  assert.deepEqual(plan.regenerate.map(entry => entry.task), ['report', 'summary'],
    'sorted by depth, so the cause is asked for before its consequence');
  assert.equal(plan.regenerate[1].depth, 1);
});

test('an invalidated output nobody owns is reported, not skipped', () => {
  const plan = recoveryPlan({ invalidated: invalidated(['docs/notes.md', 0]), outputs });
  assert.deepEqual(plan.regenerate, []);
  assert.deepEqual(plan.unowned.map(entry => entry.path), ['docs/notes.md']);
  assert.equal(plan.empty, false, 'a plan that does nothing is not an empty plan');
});

test('a task at the ceiling is recorded as exhausted rather than asked again', () => {
  const plan = recoveryPlan({
    invalidated: invalidated(['src/report.mjs', 0]),
    outputs,
    attempts: { report: 2 },
    ceiling: 2,
  });
  assert.deepEqual(plan.regenerate, []);
  assert.deepEqual(plan.exhausted, [{ task: 'report', path: 'src/report.mjs', attempts: 2, depth: 0 }]);
});

test('a task under the ceiling gets another attempt', () => {
  const plan = recoveryPlan({
    invalidated: invalidated(['src/report.mjs', 0]),
    outputs,
    attempts: { report: 1 },
    ceiling: 2,
  });
  assert.equal(plan.regenerate[0].attempt, 2);
});

test('a plan over nothing is empty, and an empty plan is not an error', () => {
  const plan = recoveryPlan({ invalidated: [], outputs });
  assert.deepEqual(plan.regenerate, []);
  assert.equal(plan.empty, true);
});

test('a malformed plan input is refused rather than guessed at', () => {
  assert.throws(() => recoveryPlan({ ceiling: 0 }), /invalid_recovery_ceiling/);
  assert.throws(() => recoveryPlan({ outputs: [{ path: 'a' }] }), /invalid_mission_output/);
  assert.throws(() => recoveryPlan({ invalidated: [{ depth: 0 }] }), /invalid_invalidation_entry/);
  assert.throws(() => recoveryPlan({ invalidated: invalidated(['src/report.mjs', 0]), outputs, attempts: { report: -1 } }),
    /invalid_recovery_attempts/);
});

// --- the tax ------------------------------------------------------------------

test('a regeneration that changes the bytes is counted as a changed output', () => {
  const tax = taxOf({
    publishes: [{ path: 'src/report.mjs', contentHash: 'h1', byteLength: 40, containerMs: 900 }],
    regenerations: [{ path: 'src/report.mjs', task: 'report', contentHash: 'h2', byteLength: 44, containerMs: 800 }],
  });
  assert.deepEqual(tax.changedOutputs, [{ path: 'src/report.mjs', task: 'report', before: 'h1', after: 'h2' }]);
  assert.deepEqual(tax.unchangedOutputs, []);
  assert.equal(tax.overInvalidationRate, 0);
  assert.equal(tax.totals.bytes, 84);
  assert.equal(tax.totals.containerMs, 1700);
  assert.equal(tax.totals.regenerationContainerMs, 800);
});

test('a regeneration that produces the bytes already there is the measured waste', () => {
  // The campaign's finding, as arithmetic: the output genuinely depended on what moved, and
  // its own content did not need to change.
  const tax = taxOf({
    publishes: [
      { path: 'src/report.mjs', contentHash: 'h1', byteLength: 40 },
      { path: 'src/notes.md', contentHash: 'n1', byteLength: 10 },
    ],
    regenerations: [
      { path: 'src/report.mjs', task: 'report', contentHash: 'h2', byteLength: 44 },
      { path: 'src/notes.md', task: 'notes', contentHash: 'n1', byteLength: 10 },
    ],
  });
  assert.equal(tax.regenerations, 2);
  assert.deepEqual(tax.unchangedOutputs.map(entry => entry.path), ['src/notes.md']);
  assert.equal(tax.overInvalidationRate, 0.5, 'half of the invalidations changed nothing');
});

test('a regeneration nobody can judge is neither wasted nor useful', () => {
  const tax = taxOf({
    publishes: [],
    regenerations: [{ path: 'src/report.mjs', contentHash: 'h2' }],
  });
  assert.deepEqual(tax.unknownOutputs, [{ path: 'src/report.mjs', task: null }]);
  assert.equal(tax.overInvalidationRate, null, 'a rate over nothing judged is not zero');
  assert.equal(tax.changedOutputs.length + tax.unchangedOutputs.length, 0);
});

test('a per-regeneration before-hash takes precedence over the publication map', () => {
  // A mission with two rounds of invalidation has two "before" values for the same output. A
  // map that kept only the latest publication would judge round two's waste against round
  // one's bytes and report the wrong answer in both directions.
  const tax = taxOf({
    publishes: [{ path: 'a.mjs', contentHash: 'first-round' }],
    regenerations: [{ path: 'a.mjs', contentHash: 'first-round', before: 'second-round' }],
  });
  assert.deepEqual(tax.changedOutputs, [{ path: 'a.mjs', task: null, before: 'second-round', after: 'first-round' }]);
});

test('model cost and container time are reported separately and never summed together', () => {
  const tax = taxOf({
    publishes: [{ path: 'a.mjs', contentHash: 'a1', containerMs: 1000, modelCost: 0.02, modelTokens: 1200 }],
    regenerations: [{ path: 'a.mjs', contentHash: 'a2', containerMs: 500, modelCost: 0.03, modelTokens: 900 }],
  });
  assert.equal(tax.totals.modelCost, 0.05);
  assert.equal(tax.totals.regenerationModelCost, 0.03);
  assert.equal(tax.totals.modelTokens, 2100);
  assert.equal(tax.totals.regenerationModelTokens, 900);
  assert.equal(tax.totals.containerMs, 1500);
  // The two units stay apart: a total that added 0.05 to 1500 would be a number that means
  // nothing and reads as a cost.
  assert.equal(tax.totals.containerMs === tax.totals.modelCost, false);
});

test('missing measurements are counted as absent, not as zero-cost work', () => {
  const tax = taxOf({
    publishes: [{ path: 'a.mjs', contentHash: 'a1' }],
    regenerations: [{ path: 'a.mjs', contentHash: 'a2', containerMs: null, modelCost: undefined }],
  });
  assert.equal(tax.totals.containerMs, 0);
  assert.equal(tax.totals.starts, 2, 'a start with an unknown duration is still a start');
});

test('a malformed tax entry is refused', () => {
  assert.throws(() => taxOf({ publishes: [{}] }), /invalid_tax_entry/);
  assert.throws(() => taxOf({ regenerations: [{}] }), /invalid_tax_entry/);
});

// --- the verdict --------------------------------------------------------------

test('coherent but wrong is a laundered failure, and is not correct', () => {
  const verdict = recoveryVerdict({
    after: { invalidated: [], content: { 'src/report.mjs': 'offer = 10' } },
    expected: { 'src/report.mjs': 'offer = 20' },
  });
  assert.equal(verdict.coherent, true, 'nothing the workspace knows about is invalidated');
  assert.equal(verdict.correct, false, 'and the output still says the old thing');
  assert.deepEqual(verdict.mismatched, [{ path: 'src/report.mjs', want: 'offer = 20', got: 'offer = 10' }]);
});

test('correct but incoherent is a stale output nobody has noticed yet', () => {
  const verdict = recoveryVerdict({
    after: { invalidated: [{ path: 'src/summary.mjs' }], content: { 'src/report.mjs': 'offer = 20' } },
    expected: { 'src/report.mjs': 'offer = 20' },
  });
  assert.equal(verdict.correct, true);
  assert.equal(verdict.coherent, false);
  assert.deepEqual(verdict.invalidated, ['src/summary.mjs']);
});

test('an expected output that is not there is missing, not mismatched', () => {
  const verdict = recoveryVerdict({ after: { invalidated: [], content: {} }, expected: { 'src/report.mjs': 'x' } });
  assert.deepEqual(verdict.missing, ['src/report.mjs']);
  assert.deepEqual(verdict.mismatched, []);
  assert.equal(verdict.correct, false);
});

test('a clean recovery is both coherent and correct', () => {
  const verdict = recoveryVerdict({
    after: { invalidated: [], content: { 'src/report.mjs': 'offer = 20', 'src/summary.mjs': 'total = 20' } },
    expected: { 'src/report.mjs': 'offer = 20', 'src/summary.mjs': 'total = 20' },
  });
  assert.deepEqual(verdict, { coherent: true, invalidated: [], correct: true, mismatched: [], missing: [] });
});
