import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProductReplay } from '../scripts/checkout/product-replay.mjs';
import { replaySchedule, schedules } from '../scripts/checkout/replay-schedule.mjs';
import { workloads, patchTask } from '../scripts/checkout/replay-workloads.mjs';
import { readFileSync, readdirSync } from 'node:fs';

const files = { 'x.mjs': 'export const x=1;\nexport const y=2;\n' };
test('comparison baseline preserves contended starts and current product three-way publication', async () => {
  const system = new ProductReplay(() => true); await system.seed(files);
  const a = await system.checkout({ participantId: 'a', paths: ['x.mjs'] });
  const b = await system.checkout({ participantId: 'b', paths: ['x.mjs'] });
  assert.equal(a.granted && b.granted, true);
  assert.deepEqual(b.contendedPaths, ['x.mjs']);
  assert.equal((await system.submit({ checkoutId: a.checkoutId, participantId: 'a', files: { 'x.mjs': a.files['x.mjs'].replace('x=1', 'x=3') } })).admitted, true);
  const second = await system.submit({ checkoutId: b.checkoutId, participantId: 'b', files: { 'x.mjs': b.files['x.mjs'].replace('y=2', 'y=4') } });
  assert.equal(second.admitted, true); assert.equal(second.merged.length, 1);
  assert.equal((await system.snapshot()).files['x.mjs'], 'export const x=3;\nexport const y=4;\n');
});
test('comparison baseline refuses an unleased unchanged-base write and validation failure', async () => {
  const system = new ProductReplay(() => true); await system.seed(files);
  await system.checkout({ participantId: 'a', paths: ['x.mjs'] });
  const b = await system.checkout({ participantId: 'b', paths: ['x.mjs'] });
  assert.equal((await system.submit({ checkoutId: b.checkoutId, participantId: 'b', files: { 'x.mjs': b.files['x.mjs'].replace('y=2', 'y=4') } })).reason, 'lease_required');
  assert.deepEqual((await system.snapshot()).files, files);
  const invalid = new ProductReplay(() => false); await invalid.seed(files);
  const c = await invalid.checkout({ participantId: 'c', paths: ['x.mjs'] });
  assert.equal((await invalid.submit({ checkoutId: c.checkoutId, participantId: 'c', files: { 'x.mjs': c.files['x.mjs'].replace('y=2', 'y=4') } })).reason, 'validation_failed');
  assert.deepEqual((await invalid.snapshot()).files, files);
});
test('virtual scheduler retains refused work and retries on a fresh base with unchanged goals', async () => {
  const system = new ProductReplay(() => true); await system.seed(files);
  const workload = { tasks: [{ id: 'a', path: 'x.mjs', workTicks: 10 }, { id: 'b', path: 'x.mjs', workTicks: 10 }] };
  const result = await replaySchedule({ workload, schedule: schedules[2],
    patch: (task, base) => ({ files: { 'x.mjs': task.id === 'a' ? base['x.mjs'].replace('x=1', 'x=3') : base['x.mjs'].replace('y=2', 'y=4') }, reads: [] }),
    acceptance: candidate => candidate['x.mjs'].includes('x=3') && candidate['x.mjs'].includes('y=4'),
    api: { snapshot: () => system.snapshot(), checkout: (task, participantId) => system.checkout({ participantId, paths: [task.path] }),
      submit: (grant, patch) => system.submit({ checkoutId: grant.checkoutId, participantId: grant.participantId, files: patch }),
      release: grant => system.release(grant) } });
  assert.equal(result.finalCorrect, true); assert.equal(result.firstCorrectTick, 20);
  assert.equal(result.rejectedWorkTicks, 10);
  assert.equal(result.jobs.find(job => job.id === 'b').attempts, 2);
  assert.equal(result.events.find(e => e.phase === 'submit' && !e.admitted).reason, 'lease_required');
});
test('all frozen task anchors are unambiguous and dependency-sensitive actor uses its actual checkout', () => {
  const root = new URL('../fixtures/checkout-lab/src/', import.meta.url);
  const seed = Object.fromEntries(readdirSync(root).filter(path => path.endsWith('.mjs')).map(path => [`src/${path}`, readFileSync(new URL(path, root), 'utf8')]));
  for (const workload of workloads) {
    let candidate = structuredClone(seed);
    for (const task of workload.tasks) Object.assign(candidate, patchTask(task, candidate).files);
  }
  const workload = workloads.find(w => w.id === 'contract-sensitive-read');
  const stale = patchTask(workload.tasks[1], seed).files['src/reports.mjs'];
  const updated = { ...seed, ...patchTask(workload.tasks[0], seed).files };
  const fresh = patchTask(workload.tasks[1], updated).files['src/reports.mjs'];
  assert.match(stale, /offer 10%/); assert.match(fresh, /offer 20%/);
});
test('the dependency evidence is derived from what the patch read, not asserted beside it', () => {
  const root = new URL('../fixtures/checkout-lab/src/', import.meta.url);
  const seed = Object.fromEntries(readdirSync(root).filter(path => path.endsWith('.mjs')).map(path => [`src/${path}`, readFileSync(new URL(path, root), 'utf8')]));
  const consumer = patchTask(workloads.find(w => w.id === 'contract-sensitive-read').tasks[1], seed);
  assert.deepEqual(consumer.reads, [{ path: 'src/config.mjs', source: 'declared_read' }]);
  // A task that only edits its own file takes no dependency on anything else.
  const independent = workloads.find(w => w.id === 'independent-same-file');
  assert.deepEqual(patchTask(independent.tasks[0], seed).reads, []);
  // A patch that introduces an import takes the dependency from that moment on.
  const introducing = workloads.find(w => w.id === 'new-dependency').tasks[0];
  assert.deepEqual(patchTask(introducing, seed).reads, [{ path: 'src/reports.mjs', source: 'introduced_import' }]);
});
