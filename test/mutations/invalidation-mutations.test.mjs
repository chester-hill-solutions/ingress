/**
 * Every mutation of the invalidation derivation, run against the checks meant to catch it.
 *
 * The rule this repository applies to a guard is that a guard never observed failing is not
 * known to work. The derivation in `src/product/invalidation.mjs` is the part of the
 * publication record that has to be *correct* — it decides which published outputs the
 * workspace stops approving, and every failure mode of it is silent: an output that should
 * be flagged and is not looks exactly like a workspace with nothing to report.
 *
 * So each mutation below is a one-line weakening of the real module, loaded from a temp copy,
 * and each one is run against the same assertions the real suite makes. `loadMutated` imports
 * the mutated file *outside* the `assert.throws`, so a mutation that fails to parse is an
 * error rather than a pass.
 *
 * The module is pure and imports nothing, so the copy needs no companions — unlike
 * `router-auth-mutations.test.mjs`, which has to bring `keys.mjs` along.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceLedger } from '../../src/product/fence.mjs';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const INVALIDATION = join(REPO, 'src/product/invalidation.mjs');
const original = await readFile(INVALIDATION, 'utf8');

async function loadMutated(transform, name) {
  const dir = await mkdtemp(join(tmpdir(), 'ingress-invalidation-mutation-'));
  const mutated = transform(original);
  assert.notEqual(mutated, original, `mutation ${name} changed nothing, so it proves nothing`);
  const file = join(dir, 'invalidation.mjs');
  await writeFile(file, mutated);
  const module = await import(pathToFileURL(file).href);
  return { module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The scenario the assertions run against, built with the real ledger.
 *
 *   policy.mjs    moved from revision 1 to 2
 *   summary.mjs   built from policy@1        -> contradicted directly
 *   digest.mjs    built from summary@1       -> contradicted through summary
 *   gone.mjs      built from absent.mjs@4    -> contradicted by an absence
 *   loose.mjs     no evidence at all         -> uncovered, neither approved nor invalidated
 */
function scenario() {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'p' });
  ledger.recordWrite({ path: 'policy.mjs', revision: 1, contentHash: 'h1', actorId: 'a' });
  ledger.recordWrite({
    path: 'summary.mjs', revision: 1, contentHash: 'h2', actorId: 'b',
    evidence: { inputs: [{ path: 'policy.mjs', revision: 1 }], source: 'manifest' },
  });
  ledger.recordWrite({
    path: 'digest.mjs', revision: 1, contentHash: 'h3', actorId: 'b',
    evidence: { inputs: [{ path: 'summary.mjs', revision: 1 }], source: 'manifest' },
  });
  ledger.recordWrite({
    path: 'gone.mjs', revision: 1, contentHash: 'h4', actorId: 'b',
    evidence: { inputs: [{ path: 'absent.mjs', revision: 4 }], source: 'manifest' },
  });
  ledger.recordWrite({ path: 'loose.mjs', revision: 1, contentHash: 'h5', actorId: 'c' });
  ledger.recordWrite({
    path: 'policy.mjs', revision: 2, contentHash: 'h6', actorId: 'a',
    // Recorded with its declaration, as a real republish is: the move must not also erase
    // the file's own coverage, or the scenario would be testing two things at once.
    evidence: { inputs: [], source: 'manifest' },
  });
  return ledger;
}

/** The assertions the real suite makes about the derivation. */
function assertions(mod) {
  const ledger = scenario();
  const report = mod.invalidationReport(ledger);
  const entry = path => {
    const found = report.invalidated.find(value => value.path === path);
    assert.ok(found, `${path} was not invalidated: ${JSON.stringify(report.invalidated)}`);
    return found;
  };

  assert.equal(report.counts.direct, 2, 'the moved input and the absent input are direct');
  assert.equal(report.counts.transitive, 1, 'the digest is contradicted through the summary');
  assert.equal(report.counts.uncovered, 1, 'a file with no evidence is reported, not approved');
  assert.equal(report.outputs, 4, 'an uncovered file is not an output with evidence');
  assert.equal(report.invalidated.length, 3);

  assert.equal(entry('summary.mjs').depth, 0);
  assert.deepEqual(entry('summary.mjs').staleInputs, [
    { path: 'policy.mjs', publishedRevision: 1, currentRevision: 2, author: 'a', missing: false },
  ]);
  assert.equal(entry('digest.mjs').depth, 1, 'one hop from the contradiction');
  assert.deepEqual(entry('digest.mjs').via, ['summary.mjs']);
  assert.deepEqual(entry('digest.mjs').staleInputs, [], 'it cites nothing that moved itself');
  assert.equal(entry('gone.mjs').staleInputs[0].missing, true, 'an absence is not a move');
  assert.equal(entry('gone.mjs').staleInputs[0].currentRevision, null);

  // A self-citation is a statement about the file's own base, not a dependency.
  const self = mod.evidenceForCommit(ledger, 'p', {
    path: 'shared.mjs',
    builtFrom: [{ path: 'shared.mjs', revision: 1 }],
  });
  assert.deepEqual(self, { inputs: [], source: 'manifest' });

  // An event is the *difference* a write makes, not the standing set.
  assert.deepEqual(mod.invalidatedByWrite(report, report, 'a'), [],
    'a write that contradicts nothing new emits nothing');

  assert.throws(() => mod.normaliseEvidence({ source: 'manifest', inputs: [{ path: 'a', revision: 1.5 }] }),
    /invalid_publication_evidence/);
  assert.equal(report.epoch, 'e1');
  return report;
}

test('the unmutated derivation passes the assertions the mutations are measured against', async () => {
  // Without this, a mutation "caught" by an assertion that would have failed anyway proves
  // nothing about the mutation.
  assertions(await import(pathToFileURL(INVALIDATION).href));
});

test('a loosened stale comparison is caught', async () => {
  // The fail-open direction: an input that moved is no longer compared at all, so nothing
  // is ever invalidated and every output looks approved.
  const { module, cleanup } = await loadMutated(
    source => source.replace(
      'if (current.present && current.revision === input.revision) continue;',
      'if (current.present) continue;'
    ),
    'stale-open'
  );
  try {
    assert.throws(() => assertions(module), /not invalidated|direct/);
  } finally {
    await cleanup();
  }
});

test('treating an absent input as fresh is caught', async () => {
  // `builtFrom: [{path: 'never-written.mjs', revision: 0}]` would become a way to declare
  // immunity, which is the same fail-open the fence already refuses at admission.
  const { module, cleanup } = await loadMutated(
    source => source.replace(
      'if (current.present && current.revision === input.revision) continue;',
      'if (!current.present || current.revision === input.revision) continue;'
    ),
    'missing-fresh'
  );
  try {
    assert.throws(() => assertions(module), /not invalidated|direct|missing/);
  } finally {
    await cleanup();
  }
});

test('dropping the closure is caught', async () => {
  // The direct contradiction is still reported, so this is the mutation a shallow test would
  // miss: an output built from an invalidated output would look approved.
  const { module, cleanup } = await loadMutated(
    source => source.replace(
      '  for (let index = 0; index < queue.length; index++) {',
      '  for (let index = 0; index < 0; index++) {'
    ),
    'no-closure'
  );
  try {
    assert.throws(() => assertions(module), /digest|transitive/);
  } finally {
    await cleanup();
  }
});

test('flattening the depth is caught', async () => {
  // A transitive contradiction reported as direct: the count is right and the distance is
  // wrong, which is how a consumer is told "this file read something that moved" when it did
  // not.
  const { module, cleanup } = await loadMutated(
    source => source.replace('depth: source.depth + 1,', 'depth: 0,'),
    'flat-depth'
  );
  try {
    assert.throws(() => assertions(module), /are direct/);
  } finally {
    await cleanup();
  }
});

test('counting an uncovered file as covered is caught', async () => {
  const { module, cleanup } = await loadMutated(
    source => source.replace('outputs: files.length - uncovered.length,', 'outputs: files.length,'),
    'uncovered-approved'
  );
  try {
    assert.throws(() => assertions(module), /output with evidence/);
  } finally {
    await cleanup();
  }
});

test('keeping the self-edge is caught', async () => {
  // Every same-file edit would invalidate itself on landing, which is the failure that gets
  // a mechanism switched off rather than fixed.
  const { module, cleanup } = await loadMutated(
    source => source.replace('.filter(entry => entry.path !== file.path)', ''),
    'self-edge'
  );
  try {
    assert.throws(() => assertions(module), /inputs|deepEqual|expected/);
  } finally {
    await cleanup();
  }
});

test('emitting the standing set instead of the difference is caught', async () => {
  const { module, cleanup } = await loadMutated(
    source => source.replace(
      '  const known = new Set(before.invalidated.map(entry => entry.path));',
      '  const known = new Set();'
    ),
    'no-diff'
  );
  try {
    assert.throws(() => assertions(module), /emits nothing|deepEqual/);
  } finally {
    await cleanup();
  }
});

test('accepting a non-integer revision is caught', async () => {
  const { module, cleanup } = await loadMutated(
    source => source.replace(
      'if (revision !== null && !Number.isSafeInteger(revision)) throw new Error',
      'if (false) throw new Error'
    ),
    'coerce-revision'
  );
  try {
    assert.throws(() => assertions(module), /invalid_publication_evidence|Missing expected exception/);
  } finally {
    await cleanup();
  }
});
