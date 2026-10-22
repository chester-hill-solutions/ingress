import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ProductReplay } from '../scripts/checkout/product-replay.mjs';
import { replaySchedule, schedules } from '../scripts/checkout/replay-schedule.mjs';
import { workloads, patchTask } from '../scripts/checkout/replay-workloads.mjs';
import { withPublicationEvidence } from '../scripts/checkout/evidence-layer.mjs';

// The product arm, the frozen workload and the invalidation mechanism. No Python,
// Graphify, model, Stow, or deployment.
const root = new URL('../fixtures/checkout-lab/src/', import.meta.url);
const files = Object.fromEntries(readdirSync(root).filter(path => path.endsWith('.mjs'))
  .map(path => [`src/${path}`, readFileSync(new URL(path, root), 'utf8')]));
const workload = workloads.find(w => w.id === 'contract-sensitive-read');

async function run(condition) {
  const system = new ProductReplay(() => true);
  await system.seed(files);
  const api = {
    snapshot: () => system.snapshot(),
    checkout: (task, participantId) => system.checkout({ participantId, paths: [task.path] }),
    submit: (grant, patch) => system.submit({ checkoutId: grant.checkoutId, participantId: grant.participantId, files: patch }),
    release: grant => system.release({ checkoutId: grant.checkoutId, participantId: grant.participantId }),
  };
  if (condition === 'on') withPublicationEvidence(api);
  const outcome = await replaySchedule({
    workload, schedule: schedules.find(s => s.id === 'reverse'), api, patch: patchTask,
    acceptance: candidate => candidate['src/reports.mjs']?.includes('offer 20%')
      && !candidate['src/reports.mjs']?.includes('offer 10%'),
  });
  return { outcome, api };
}

test('without the mechanism the consumer publishes a stale output and nothing says so', async () => {
  const { outcome, api } = await run('off');
  assert.equal(outcome.allPublished, true);
  assert.equal(outcome.finalCorrect, false);
  assert.equal(outcome.publications, 2);
  assert.deepEqual(outcome.invalidations, []);
  assert.equal(api.invalidatedOutputs, undefined);
  assert.match(outcome.finalFiles['src/reports.mjs'], /offer 10%/);
  assert.match(outcome.finalFiles['src/config.mjs'], /promotionPercent: 20/);
});

test('with the mechanism the consumer is invalidated after the provider moved, and regenerating restores the mission', async () => {
  const { outcome, api } = await run('on');
  assert.equal(outcome.allPublished, true);
  assert.equal(outcome.finalCorrect, true);
  assert.equal(outcome.publications, 3);
  assert.equal(outcome.invalidations.length, 1);
  assert.equal(outcome.invalidations[0].path, 'src/reports.mjs');
  assert.equal(outcome.invalidations[0].task, 'offer-report');
  assert.equal(outcome.regenerations, 1);
  assert.equal(outcome.jobs.find(job => job.id === 'offer-report').regenerationChangedOutput, true);
  assert.deepEqual(outcome.invalidatedOutputs, []);
  assert.match(outcome.finalFiles['src/reports.mjs'], /offer 20%/);
  assert.doesNotMatch(outcome.finalFiles['src/reports.mjs'], /offer 10%/);
});

test('the mechanism reports the invalidated output and clears it only when it is republished', async () => {
  const { api } = await run('on');
  const evidence = api.publicationEvidence();
  const status = evidence.status('src/reports.mjs');
  assert.equal(status.status, 'approved');
  assert.equal(status.coverage, 'declared');
  assert.deepEqual(status.inputs.map(input => input.path), ['src/config.mjs']);
  assert.ok(status.history.some(entry => entry.event === 'invalidated'));
  assert.ok(status.history.some(entry => entry.event === 'published'));
  // The provider published no dependency evidence of its own, and is reported as such
  // rather than as a validated output with known-clean inputs.
  assert.equal(evidence.status('src/config.mjs').coverage, 'none');
});

test('the mechanism does not change what the arm admits', async () => {
  const off = await run('off'), on = await run('on');
  const admits = outcome => outcome.events.filter(event => event.phase === 'submit')
    .map(event => ({ task: event.task, admitted: event.admitted, reason: event.reason ?? null }));
  assert.deepEqual(admits(off.outcome).slice(0, 2), admits(on.outcome).slice(0, 2));
});
