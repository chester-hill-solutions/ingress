/**
 * What a trace keeps, what it refuses, and what it admits dropping.
 *
 * The planner is tested without a filesystem because the interesting parts are decisions: a
 * file over the cap, a path that escapes the workspace, a receipts log too large to copy, a
 * flight that hits its total budget mid-way. A trace that silently stops being complete is worse
 * than one that never claimed completeness, so "did it say what it dropped" is the property
 * under test as much as "did it keep the right files".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retentionPlan, retentionLimits, tracePath } from '../src/mission-retention.mjs';

const cohort = id => ({ id, workspace: `/tmp/${id}`, sessions: [`ses_${id}`] });
const limits = { ...retentionLimits, fileBytes: 100, totalBytes: 250, receiptsBytes: 50, files: 3 };

test('a cohort within the caps is copied whole and the plan says it is complete', () => {
  const plan = retentionPlan({
    cohorts: [cohort('a')],
    inventory: { a: [{ path: 'tag/config.mjs', bytes: 40 }, { path: 'app.mjs', bytes: 60 }] },
    receipts: { a: 30 },
    capture: 'settled',
    limits,
  });
  assert.equal(plan.cohorts.length, 1);
  assert.deepEqual(plan.cohorts[0].files.map(file => file.path), ['tag/config.mjs', 'app.mjs']);
  assert.deepEqual(plan.cohorts[0].receipts, { include: true, bytes: 30 });
  assert.equal(plan.files, 2);
  assert.equal(plan.totalBytes, 100);
  assert.equal(plan.complete, true);
  assert.match(plan.note, /settled/i);
});

test('a file over the per-file cap is dropped and counted, not skipped', () => {
  const plan = retentionPlan({
    cohorts: [cohort('a')],
    inventory: { a: [{ path: 'fine.mjs', bytes: 10 }, { path: 'huge.bin', bytes: 101 }] },
    receipts: {},
    limits,
  });
  assert.deepEqual(plan.cohorts[0].files.map(file => file.path), ['fine.mjs']);
  assert.deepEqual(plan.oversized, [{ id: 'a', path: 'huge.bin', bytes: 101 }]);
  assert.equal(plan.complete, false, 'a trace that dropped a file is not complete');
});

test('the total budget stops the copy and the rest is reported as truncated', () => {
  const plan = retentionPlan({
    cohorts: [cohort('a')],
    inventory: { a: [{ path: 'one.mjs', bytes: 100 }, { path: 'two.mjs', bytes: 100 }, { path: 'three.mjs', bytes: 100 }] },
    receipts: {},
    limits,
  });
  assert.deepEqual(plan.cohorts[0].files.map(file => file.path), ['one.mjs', 'two.mjs']);
  assert.deepEqual(plan.truncated, [{ id: 'a', path: 'three.mjs', reason: 'total_cap' }]);
  assert.equal(plan.totalBytes, 200);
});

test('the per-cohort file cap bounds a pathological tree', () => {
  const plan = retentionPlan({
    cohorts: [cohort('a')],
    inventory: { a: Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.mjs`, bytes: 1 })) },
    receipts: {},
    limits,
  });
  assert.equal(plan.cohorts[0].files.length, 3);
  assert.equal(plan.truncated.filter(row => row.reason === 'file_cap').length, 2);
});

test('receipts over their cap are refused by name rather than half-copied', () => {
  const plan = retentionPlan({ cohorts: [cohort('a')], inventory: { a: [] }, receipts: { a: 51 }, limits });
  assert.deepEqual(plan.cohorts[0].receipts, { include: false, bytes: 51, reason: 'over_receipts_cap' });
  assert.equal(plan.complete, true, 'refusing the log is a stated outcome, not a truncated trace');
});

test('a path that escapes the workspace is refused outright', () => {
  for (const path of ['../secret', '/etc/passwd', 'a\\b', 'a/../b', '', 'a//b']) {
    assert.throws(() => tracePath(path, 'file'), /invalid_trace_path/, `accepted ${JSON.stringify(path)}`);
  }
  assert.equal(tracePath('tag/config.mjs', 'file'), 'tag/config.mjs');
  assert.equal(tracePath('a file with spaces.mjs', 'file'), 'a file with spaces.mjs');
});

test('a cohort whose id is not a safe directory is refused, and the rest still copy', () => {
  const plan = retentionPlan({
    cohorts: [{ id: '../escape', workspace: '/tmp/x', sessions: [] }, cohort('good')],
    inventory: { good: [{ path: 'app.mjs', bytes: 5 }] },
    receipts: {},
    limits,
  });
  assert.equal(plan.cohorts.length, 1);
  assert.equal(plan.cohorts[0].id, 'good');
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0].reason, /invalid_trace_path/);
});

test('the capture basis is stated, and a running capture never claims to be settled', () => {
  const running = retentionPlan({ cohorts: [cohort('a')], inventory: { a: [] }, receipts: {}, capture: 'running', limits });
  assert.match(running.note, /still running|moving object/i);
  assert.doesNotMatch(running.note, /the artifact the blind review froze/);
  const post = retentionPlan({ cohorts: [cohort('a')], inventory: { a: [] }, receipts: {}, capture: 'post-hoc', limits });
  assert.match(post.note, /after the flight ended/i);
  assert.throws(() => retentionPlan({ cohorts: [], capture: 'guessed' }), /invalid_capture_basis/);
});

test('a malformed cohort is refused rather than producing a nameless trace', () => {
  assert.throws(() => retentionPlan({ cohorts: [{ workspace: '/tmp' }] }), /invalid_trace_cohort/);
});
