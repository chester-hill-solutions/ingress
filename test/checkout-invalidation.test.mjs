import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED, INVALIDATED, PublicationEvidence, hashOf } from '../src/prototypes/checkout/invalidation.mjs';

// Pure records. No Python, Graphify, model, Stow, or deployment.
const provider = 'export const promotionPercent = 10;\n';
const consumer = 'export const label = `offer ${promotionPercent}%`;\n';
const seed = { 'src/config.mjs': provider, 'src/reports.mjs': consumer };

const inputsFor = (tree, path) => [{ path, hash: hashOf(tree[path]), source: 'declared_read' }];

test('a published output stays approved while its input holds still', () => {
  const evidence = new PublicationEvidence();
  const result = evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  assert.deepEqual(result.invalidated, []);
  assert.equal(evidence.status('src/reports.mjs').status, APPROVED);
  assert.equal(evidence.status('src/reports.mjs').coverage, 'declared');
});

test('a provider that advances after publication invalidates the dependent output', () => {
  // The case publication-time read checks cannot catch: nothing had moved when the
  // consumer published. The provider moved afterwards.
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  const result = evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']),
    inputs: [] }], tree: moved });
  assert.deepEqual(result.invalidated, ['src/reports.mjs']);
  const status = evidence.status('src/reports.mjs');
  assert.equal(status.status, INVALIDATED);
  assert.equal(status.invalidatedBy[0].path, 'src/config.mjs');
  assert.equal(status.invalidatedBy[0].currentHash, hashOf(moved['src/config.mjs']));
  assert.equal(status.invalidatedBy[0].recordedHash, hashOf(provider));
});

test('an output published against an input that has already moved is invalidated at publication', () => {
  const evidence = new PublicationEvidence();
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  const result = evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: moved });
  assert.deepEqual(result.invalidated, ['src/reports.mjs']);
});

test('an invalidated output is not silently re-approved by an unrelated publication', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  const later = { ...moved, 'src/other.mjs': 'export const other = 1;\n' };
  evidence.publish({ revision: 3, outputs: [{ path: 'src/other.mjs', hash: hashOf(later['src/other.mjs']), inputs: [] }], tree: later });
  assert.equal(evidence.status('src/reports.mjs').status, INVALIDATED);
});

test('revalidation that passes restores the status and refreshes the recorded versions', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  const result = evidence.revalidate({ path: 'src/reports.mjs', tree: moved, validate: () => true, revision: 3 });
  assert.equal(result.approved, true);
  const status = evidence.status('src/reports.mjs');
  assert.equal(status.status, APPROVED);
  assert.equal(status.invalidatedBy, null);
  assert.equal(status.inputs[0].hash, hashOf(moved['src/config.mjs']));
  assert.ok(status.history.some(entry => entry.event === 'invalidated'));
  assert.ok(status.history.some(entry => entry.event === 'revalidated'));
});

test('revalidation that fails leaves the output invalidated and records the attempt', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  const result = evidence.revalidate({ path: 'src/reports.mjs', tree: moved, validate: () => false, revision: 3 });
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'validation_failed');
  assert.equal(evidence.status('src/reports.mjs').status, INVALIDATED);
  assert.ok(evidence.status('src/reports.mjs').history.some(entry => entry.event === 'revalidation_failed'));
});

test('an output with no dependency evidence is approved but reports that it has none', () => {
  const evidence = new PublicationEvidence();
  const result = evidence.publish({ revision: 1, outputs: [{ path: 'src/other.mjs', hash: hashOf('export const other = 1;\n'),
    inputs: [] }], tree: { 'src/other.mjs': 'export const other = 1;\n' } });
  assert.deepEqual(result.invalidated, []);
  assert.deepEqual(result.unknown, ['src/other.mjs']);
  assert.equal(evidence.status('src/other.mjs').status, APPROVED);
  assert.equal(evidence.status('src/other.mjs').coverage, 'none');
  assert.equal(evidence.report().counts.withoutEvidence, 1);
});

test('an input that disappears invalidates the dependent output', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  // A different output publishes while the input is gone from the tree.
  const removed = { 'src/reports.mjs': consumer, 'src/other.mjs': 'export const other = 1;\n' };
  const result = evidence.publish({ revision: 2, outputs: [{ path: 'src/other.mjs', hash: hashOf(removed['src/other.mjs']),
    inputs: [] }], tree: removed });
  assert.deepEqual(result.invalidated, ['src/reports.mjs']);
  assert.equal(evidence.status('src/reports.mjs').invalidatedBy[0].currentHash, null);
});

test('regeneration replaces the record with fresh evidence and keeps the trail', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  const regenerated = 'export const label = `offer 20%`;\n';
  const tree = { ...moved, 'src/reports.mjs': regenerated };
  const result = evidence.publish({ revision: 3, outputs: [{ path: 'src/reports.mjs', hash: hashOf(regenerated),
    inputs: inputsFor(moved, 'src/config.mjs') }], tree });
  assert.deepEqual(result.invalidated, []);
  const status = evidence.status('src/reports.mjs');
  assert.equal(status.status, APPROVED);
  assert.equal(status.inputs[0].hash, hashOf(moved['src/config.mjs']));
  assert.deepEqual(status.history.map(entry => entry.event), ['published', 'invalidated', 'published']);
});

test('the report separates invalidated, approved and outputs without evidence', () => {
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [
    { path: 'src/reports.mjs', hash: hashOf(consumer), inputs: inputsFor(seed, 'src/config.mjs') },
    { path: 'src/other.mjs', hash: hashOf('export const other = 1;\n'), inputs: [] },
  ], tree: { ...seed, 'src/other.mjs': 'export const other = 1;\n' } });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20'), 'src/other.mjs': 'export const other = 1;\n' };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  const report = evidence.report();
  // reports.mjs is invalidated by the provider move. other.mjs and config.mjs are
  // approved, and both were published without dependency evidence, so neither could
  // have been invalidated. "Approved" and "known to have no stale input" are different
  // facts and the report keeps them apart.
  assert.equal(report.counts.invalidated, 1);
  assert.equal(report.counts.approved, 2);
  assert.equal(report.counts.withoutEvidence, 2);
  assert.equal(report.outputs.find(output => output.path === 'src/reports.mjs').invalidatedCount, 1);
  assert.equal(report.outputs.find(output => output.path === 'src/config.mjs').coverage, 'none');
});

test('the workspace records the declaration, so identical bytes with a fresh declaration clear the invalidation', () => {
  // The limit of this mechanism, asserted rather than described. The workspace can
  // check the bytes it stores and the versions of the inputs; it cannot check that
  // those bytes were derived from those inputs. A participant that re-sends stale
  // work with a fresh declaration therefore clears the invalidation. This is the
  // same trust the product already places in a declared `builtFrom`, and it is the
  // reason the invalidation is a status and not a guarantee.
  const evidence = new PublicationEvidence();
  evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed });
  const moved = { ...seed, 'src/config.mjs': provider.replace('10', '20') };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/config.mjs', hash: hashOf(moved['src/config.mjs']), inputs: [] }], tree: moved });
  assert.equal(evidence.status('src/reports.mjs').status, INVALIDATED);
  evidence.publish({ revision: 3, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(moved, 'src/config.mjs') }], tree: moved });
  assert.equal(evidence.status('src/reports.mjs').status, APPROVED);
});

test('a publication whose validation did not pass is not an approved output', () => {
  const evidence = new PublicationEvidence();
  const result = evidence.publish({ revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer),
    inputs: inputsFor(seed, 'src/config.mjs') }], tree: seed, validated: false });
  assert.deepEqual(result.invalidated, []);
  const status = evidence.status('src/reports.mjs');
  assert.equal(status.status, INVALIDATED);
  assert.equal(status.validated, false);
  assert.equal(status.invalidReason, 'validation_failed');
  // It is not approved by anything else either: an unrelated publication leaves it.
  const later = { ...seed, 'src/other.mjs': 'export const other = 1;\n' };
  evidence.publish({ revision: 2, outputs: [{ path: 'src/other.mjs', hash: hashOf(later['src/other.mjs']), inputs: [] }], tree: later });
  assert.equal(evidence.status('src/reports.mjs').status, INVALIDATED);
});

test('malformed evidence is refused rather than recorded', () => {
  const evidence = new PublicationEvidence();
  const tree = { 'src/reports.mjs': consumer };
  const bad = [
    { revision: 0, outputs: [], tree },
    { revision: 1, outputs: [{ path: 'src/reports.mjs', hash: 'not-a-hash', inputs: [] }], tree },
    { revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer), inputs: [{ path: 'x', hash: 'short', source: 's' }] }], tree },
    { revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer), inputs: [{ path: 'x', hash: hashOf('x'), source: '' }] }], tree },
    { revision: 1, outputs: [{ path: 'src/reports.mjs', hash: hashOf(consumer), inputs: [
      { path: 'x', hash: hashOf('x'), source: 's' }, { path: 'x', hash: hashOf('x'), source: 's' }] }], tree },
  ];
  for (const request of bad) assert.throws(() => evidence.publish(request), TypeError);
  assert.equal(evidence.report().counts.approved, 0);
});
