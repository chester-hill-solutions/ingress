/**
 * Publication evidence, and the outputs it has since been contradicted by.
 *
 * The property under test is a sequence, not a state: a consumer publishes an output
 * built from a file, somebody else moves that file, and the workspace must say that the
 * published output is no longer approved. The fence already refuses a *pending* write
 * whose input has moved; these tests are entirely about what happens after the write
 * landed, which the fence deliberately says nothing about.
 *
 * Two limits are asserted rather than glossed, because they are the limits the product
 * actually has:
 *
 *   - a republish clears the status, and a republish that still declares the stale
 *     revision does *not* clear it. The second half is the honest one: the workspace
 *     compares revisions, so a false declaration is visible as a false declaration
 *     rather than as health.
 *   - a file with no evidence is reported `uncovered`, never as approved and never as
 *     invalidated. Silence is not a verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLedger } from '../src/product/fence.mjs';
import { verifyCommit, evaluateCommit, applyCommit, sha256Hex } from '../src/product/commit.mjs';
import {
  normaliseEvidence,
  evidenceForCommit,
  invalidationReport,
  invalidatedByWrite,
  EVIDENCE_SOURCES,
} from '../src/product/invalidation.mjs';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

async function file(path, content, extra = {}) {
  return {
    path,
    contentBase64: b64(content),
    contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
    ...extra,
  };
}

function account(participants, seed = []) {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  for (const participant of participants) {
    ledger.register({ participantId: participant, dependencies: [] });
  }
  let revision = 0;
  for (const [path, content] of seed) {
    revision += 1;
    ledger.recordWrite({ path, revision, contentHash: `h${revision}-${content}` });
  }
  return ledger;
}

/** Commit and assert admission, so a fence refusal never reads as a failed derivation. */
async function commit(ledger, participantId, files) {
  const verified = await verifyCommit({ participantId, files });
  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, true, `refused: ${JSON.stringify(decision.refusals)}`);
  return applyCommit(ledger, decision);
}

/** The one invalidated entry for a path, or a failure that says what was there instead. */
function entryFor(report, path) {
  const entry = report.invalidated.find(value => value.path === path);
  assert.ok(entry, `${path} was not invalidated; report: ${JSON.stringify(report.invalidated)}`);
  return entry;
}

// --- the record ---------------------------------------------------------------

test('publication evidence is recorded on the ledger and carried in the receipt', async () => {
  const ledger = account(['builder']);
  const { files } = await commit(ledger, 'builder', [
    await file('policy.mjs', 'export const offer = 10;', { builtFrom: [] }),
  ]);
  await commit(ledger, 'builder', [
    await file('report.mjs', 'export const total = 10;', {
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);

  const stored = ledger.files.get('report.mjs');
  assert.deepEqual(stored.evidence, {
    inputs: [{ path: 'policy.mjs', revision: 1 }],
    source: 'manifest',
  });

  const admitted = ledger.receipts.filter(receipt => receipt.reason === 'commit_admitted').at(-1);
  const record = admitted.files.find(receipt => receipt.path === 'report.mjs');
  assert.deepEqual(record.builtFrom, [{ path: 'policy.mjs', revision: 1 }],
    'the receipt must say what the output was built from');
  assert.equal(record.evidenceSource, 'manifest');

  assert.equal(files.length, 1);
});

test('a file is not its own dependency, so a same-file edit does not invalidate itself', async () => {
  // A participant that read the file it is editing declares it in `builtFrom` — the swarm
  // test in `product-commit.test.mjs` does exactly that. Keeping the self-edge would make
  // every such publication invalid the instant it landed, which is the shape of bug that
  // makes a mechanism get switched off.
  const ledger = account(['builder'], [['shared.mjs', 'v1']]);
  await commit(ledger, 'builder', [
    await file('shared.mjs', 'v2', {
      baseRevision: 1,
      builtFrom: [{ path: 'shared.mjs', revision: 1 }],
    }),
  ]);

  assert.deepEqual(ledger.files.get('shared.mjs').evidence, { inputs: [], source: 'manifest' });
  assert.deepEqual(invalidationReport(ledger).invalidated, []);
});

test('an undeclared per-file input falls back to the participant-wide list, and says so', async () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'consumer', dependencies: ['engine.mjs'] });
  ledger.recordWrite({ path: 'engine.mjs', revision: 1, contentHash: 'h1' });
  ledger.recordRead({ participantId: 'consumer', path: 'engine.mjs' });

  await commit(ledger, 'consumer', [await file('derived.mjs', 'export const d = 1;')]);

  assert.deepEqual(ledger.files.get('derived.mjs').evidence, {
    inputs: [{ path: 'engine.mjs', revision: 1 }],
    source: EVIDENCE_SOURCES.participant_declared,
  });
});

test('a participant that declares nothing publishes uncovered, not approved', async () => {
  const ledger = account(['quiet']);
  await commit(ledger, 'quiet', [await file('orphan.mjs', 'export const o = 1;')]);

  const report = invalidationReport(ledger);
  assert.equal(ledger.files.get('orphan.mjs').evidence, null);
  assert.deepEqual(report.uncovered, ['orphan.mjs']);
  assert.equal(report.outputs, 0, 'an uncovered file is not an output with evidence');
  assert.deepEqual(report.invalidated, []);
});

test('malformed evidence is refused rather than quietly narrowed', async () => {
  for (const value of [
    { source: 'manifest', inputs: 'nope' },
    { source: 'guessed', inputs: [] },
    { source: 'none', inputs: [] },
    { source: 'manifest', inputs: [{ path: 'a.mjs', revision: 1 }, { path: 'a.mjs', revision: 2 }] },
    { source: 'manifest', inputs: [{ path: 'a.mjs', revision: 1.5 }] },
    { source: 'manifest', inputs: [{ revision: 1 }] },
  ]) {
    assert.throws(() => normaliseEvidence(value), /invalid_publication_evidence/,
      `accepted: ${JSON.stringify(value)}`);
  }
});

// --- the derivation -----------------------------------------------------------

test('an input that moves invalidates the output that was built from it', async () => {
  const ledger = account(['provider', 'consumer']);
  await commit(ledger, 'provider', [
    await file('policy.mjs', 'export const offer = 10;', { builtFrom: [] }),
  ]);
  await commit(ledger, 'consumer', [
    await file('report.mjs', 'export const total = 10;', {
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);

  assert.deepEqual(invalidationReport(ledger).invalidated, [], 'nothing has moved yet');

  await commit(ledger, 'provider', [
    await file('policy.mjs', 'export const offer = 20;', { baseRevision: 1, builtFrom: [] }),
  ]);

  const report = invalidationReport(ledger);
  const entry = entryFor(report, 'report.mjs');
  assert.equal(entry.depth, 0);
  assert.equal(entry.source, 'manifest');
  assert.equal(entry.revision, 1);
  assert.deepEqual(entry.staleInputs, [
    { path: 'policy.mjs', publishedRevision: 1, currentRevision: 2, author: 'provider', missing: false },
  ]);
  assert.deepEqual(entry.via, []);
  assert.deepEqual(report.counts, { invalidated: 1, direct: 1, transitive: 0, uncovered: 0 });
});

test('invalidation is transitive, one hop at a time, with the carrier named', async () => {
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('summary.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'b', [
    await file('digest.mjs', 'from summary v1', { builtFrom: [{ path: 'summary.mjs', revision: 1 }] }),
  ]);

  await commit(ledger, 'a', [
    await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] }),
  ]);

  const report = invalidationReport(ledger);
  assert.equal(entryFor(report, 'summary.mjs').depth, 0, 'its own input moved');
  const digest = entryFor(report, 'digest.mjs');
  assert.equal(digest.depth, 1, 'its input holds still but is itself invalidated');
  assert.deepEqual(digest.via, ['summary.mjs']);
  assert.deepEqual(digest.staleInputs, [], 'and it reports no contradiction of its own');
  assert.deepEqual(report.counts, { invalidated: 2, direct: 1, transitive: 1, uncovered: 0 });
});

test('a cycle is visited once and terminates', async () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.recordWrite({
    path: 'a.mjs', revision: 1, contentHash: 'ha',
    evidence: { inputs: [{ path: 'b.mjs', revision: 1 }], source: 'manifest' },
  });
  ledger.recordWrite({
    path: 'b.mjs', revision: 1, contentHash: 'hb',
    evidence: { inputs: [{ path: 'a.mjs', revision: 1 }], source: 'manifest' },
  });

  assert.deepEqual(invalidationReport(ledger).invalidated, [],
    'a cycle with no contradiction in it is not a contradiction');

  ledger.recordWrite({
    path: 'b.mjs', revision: 2, contentHash: 'hb2',
    // Rewritten with its declaration intact. A rewrite that dropped the evidence would
    // also drop the cycle, which is a different scenario.
    evidence: { inputs: [{ path: 'a.mjs', revision: 1 }], source: 'manifest' },
  });

  const report = invalidationReport(ledger);
  assert.equal(entryFor(report, 'a.mjs').depth, 0);
  assert.equal(entryFor(report, 'b.mjs').depth, 1, 'b depends on a, which is now invalid');
  assert.equal(report.invalidated.length, 2);
});

test('an input that is gone is reported missing rather than merely moved', async () => {
  // The commit path cannot currently produce this — `evaluateCommit` refuses a pending
  // write whose declared input does not exist — so it guards a restored ledger, where a
  // citation can outlive the file it cites. The distinction survives because the fix is
  // different: a move is a republish, an absence is a conversation.
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.recordWrite({
    path: 'report.mjs', revision: 3, contentHash: 'hr',
    evidence: { inputs: [{ path: 'gone.mjs', revision: 2 }], source: 'manifest' },
  });

  const entry = entryFor(invalidationReport(ledger), 'report.mjs');
  assert.equal(entry.staleInputs[0].missing, true);
  assert.equal(entry.staleInputs[0].currentRevision, null);
});

test('an explicit declaration of no inputs can never be invalidated', async () => {
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [await file('standalone.mjs', 'x', { builtFrom: [] })]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);

  const report = invalidationReport(ledger);
  assert.deepEqual(report.invalidated, []);
  assert.equal(report.outputs, 2, 'both files are covered; neither is contradicted');
});

test('the status is derived, so a moved input is visible without a commit through the gate', async () => {
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);

  ledger.recordWrite({ path: 'policy.mjs', revision: 2, contentHash: 'h-policy-2' });
  assert.equal(invalidationReport(ledger).counts.direct, 1,
    'nothing had to remember to clear or set a flag');
});

test('a republish from the current revision clears the status', async () => {
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);
  assert.equal(invalidationReport(ledger).counts.invalidated, 1);

  await commit(ledger, 'b', [
    await file('report.mjs', 'from v2', {
      baseRevision: 1,
      builtFrom: [{ path: 'policy.mjs', revision: 2 }],
    }),
  ]);

  assert.deepEqual(invalidationReport(ledger).invalidated, []);
});

test('a republish that still declares the moved revision is refused, not laundered into health', async () => {
  // The fence's per-file check and this record are the same declaration, so the two agree
  // by construction: an output cannot be republished against the revision that moved and
  // then reported clean. The refusal is the fence's, and it arrives before publication.
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);

  const decision = evaluateCommit(ledger, await verifyCommit({
    participantId: 'b',
    files: [
      await file('report.mjs', 'reworded, still from v1', {
        baseRevision: 1,
        builtFrom: [{ path: 'policy.mjs', revision: 1 }],
      }),
    ],
  }));

  assert.equal(decision.admitted, false);
  assert.equal(decision.refusals[0].reason, 'dependency_moved');
  assert.equal(ledger.files.get('report.mjs').revision, 1, 'nothing landed');
  assert.equal(invalidationReport(ledger).counts.invalidated, 1, 'and the status stands');
});

test('an explicit "built from nothing" clears the status, and is believed', async () => {
  // The limitation, stated rather than glossed. The relation is a declaration, so a
  // participant that declares no inputs is taken at its word — exactly as the fence takes
  // `builtFrom: []` at its word when it admits the commit. The workspace can compare
  // revisions; it cannot read the participant's mind. This is why the record carries the
  // source and the author: a reader can see that the output was cleared by declaration
  // rather than by evidence, and decide what to do about it.
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);
  assert.equal(invalidationReport(ledger).counts.invalidated, 1);

  await commit(ledger, 'b', [
    await file('report.mjs', 'built from nothing, allegedly', { baseRevision: 1, builtFrom: [] }),
  ]);

  const report = invalidationReport(ledger);
  assert.deepEqual(report.invalidated, []);
  assert.deepEqual(ledger.files.get('report.mjs').evidence, { inputs: [], source: 'manifest' },
    'the record says how it was cleared, so nobody has to guess');
});

test('an unchanged republish re-affirms the output instead of leaving it stale forever', async () => {
  // Found by running the mechanism rather than reading it. `src/notes.mjs` depends on the
  // policy and does not use its value, so redoing the work produces the same bytes -- and
  // identical bytes are `no_change`, which `applyCommit` skips. Without a refresh the output
  // keeps contradicted evidence no matter how often its owner regenerates, and the only way
  // out would be to perturb the output so the bytes differ. That is not a mechanism anybody
  // would keep.
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);
  assert.equal(invalidationReport(ledger).counts.invalidated, 1);

  const revisionBefore = ledger.files.get('notes.mjs').revision;
  const republished = await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      baseRevision: revisionBefore,
      builtFrom: [{ path: 'policy.mjs', revision: 2 }],
    }),
  ]);

  assert.deepEqual(republished.refreshed.map(receipt => receipt.path), ['notes.mjs']);
  assert.deepEqual(republished.files, [], 'no bytes landed, because none changed');
  assert.equal(ledger.files.get('notes.mjs').revision, revisionBefore, 'and no revision churned');
  assert.deepEqual(invalidationReport(ledger).invalidated, [],
    'the output is approved again, on the strength of the re-derivation it declared');

  const stored = ledger.files.get('notes.mjs');
  assert.deepEqual(stored.evidence, { inputs: [{ path: 'policy.mjs', revision: 2 }], source: 'manifest' });
  assert.ok(stored.evidenceRefreshedAtSequence > stored.writtenAtSequence,
    'the claim is newer than the bytes, and the record says so');
  assert.equal(stored.evidenceRefreshedBy, 'b');
});

test('a re-affirmation that cannot be honoured is refused and named', async () => {
  // `no_change` short-circuits before the dependency check, so an unchanged file never reaches
  // the fence's own staleness check. The declaration is checked before it is recorded instead.
  // A participant that re-sends an unchanged output still declaring the revision that moved
  // gets the output left contradicted -- which is the correct answer, and it is told so.
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);

  const republished = await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      baseRevision: 1,
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);

  assert.deepEqual(republished.refreshed, []);
  assert.equal(republished.unrefreshed.length, 1);
  assert.equal(republished.unrefreshed[0].path, 'notes.mjs');
  assert.equal(republished.unrefreshed[0].staleInputs[0].currentRevision, 2);
  assert.equal(invalidationReport(ledger).counts.invalidated, 1, 'and it stays contradicted');
});

test('a participant holding somebody else\'s file cannot re-affirm it', async () => {
  // The first deployed run of the recovery mission did exactly this and it was worse than a
  // no-op: the summary participant's container is seeded with the report it reads, so its
  // whole-tree commit re-sent the report. The coarse fallback recorded the *summary's*
  // dependency list as the report's evidence, replacing the report's real evidence -- built
  // from the policy -- and nothing then cited the policy at all. The mechanism appeared to
  // work while doing nothing, which is the failure mode that hides best.
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'report', dependencies: [] });
  ledger.register({ participantId: 'summary', dependencies: ['src/report.mjs'] });
  ledger.recordWrite({ path: 'src/report.mjs', revision: 1, contentHash: 'hr', actorId: 'report' });
  ledger.recordRead({ participantId: 'summary', path: 'src/report.mjs' });

  // The report publishes with a real declaration.
  await commit(ledger, 'report', [
    await file('src/report.mjs', 'export const offer = 10;', { builtFrom: [] }),
  ]);
  assert.deepEqual(ledger.files.get('src/report.mjs').evidence, { inputs: [], source: 'manifest' });

  // The summary commits its whole tree: its own output, and the report it was seeded with,
  // unchanged and without a per-file declaration for it.
  const run = await commit(ledger, 'summary', [
    await file('src/summary.mjs', 'export const total = 10;', { builtFrom: [{ path: 'src/report.mjs', revision: 2 }] }),
    await file('src/report.mjs', 'export const offer = 10;', { baseRevision: 2 }),
  ]);

  assert.deepEqual(run.refreshed, [], 'a file the manifest says nothing about is not re-affirmed');
  assert.deepEqual(ledger.files.get('src/report.mjs').evidence, { inputs: [], source: 'manifest' },
    "the report's own evidence is untouched by the participant that merely held it");
  assert.equal(ledger.files.get('src/report.mjs').evidenceRefreshedAtSequence, undefined);
});

test('a re-affirmation with nothing declared is not a re-affirmation', async () => {
  // A participant that says nothing about an unchanged file has said nothing. Recording an
  // empty claim on its behalf would clear an invalidation the participant never addressed.
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);

  const republished = await commit(ledger, 'b', [
    await file('notes.mjs', 'export const note = "reviewed";', { baseRevision: 1 }),
  ]);

  assert.deepEqual(republished.refreshed, []);
  assert.deepEqual(republished.unrefreshed, []);
  assert.equal(invalidationReport(ledger).counts.invalidated, 1);
});

test('a re-affirmation identical to the record is not re-receipted', async () => {
  // A whole-tree commit re-sends every file it holds. A receipt per output per commit would be
  // noise the audit trail pays for, and there is nothing new to record.
  const ledger = account(['a']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'a', [
    await file('notes.mjs', 'export const note = "reviewed";', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  const receiptsBefore = ledger.receipts.length;

  const again = await commit(ledger, 'a', [
    await file('notes.mjs', 'export const note = "reviewed";', {
      baseRevision: 1,
      builtFrom: [{ path: 'policy.mjs', revision: 1 }],
    }),
  ]);

  assert.deepEqual(again.refreshed, []);
  assert.equal(ledger.receipts.filter(receipt => receipt.reason === 'evidence_refreshed').length, 0);
  assert.equal(ledger.receipts.length, receiptsBefore + 1, 'the commit receipt, and nothing else');
});

test('a write drops the refresh marker, because a write is a new publication', async () => {
  const ledger = account(['a', 'b']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('notes.mjs', 'same', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('notes.mjs', 'same', { baseRevision: 1, builtFrom: [{ path: 'policy.mjs', revision: 2 }] }),
  ]);
  assert.ok(ledger.files.get('notes.mjs').evidenceRefreshedAtSequence !== undefined);

  await commit(ledger, 'b', [
    await file('notes.mjs', 'different', { baseRevision: 1, builtFrom: [{ path: 'policy.mjs', revision: 2 }] }),
  ]);

  assert.equal(ledger.files.get('notes.mjs').evidenceRefreshedAtSequence, undefined,
    'the bytes moved, so the claim is not newer than them any more');
  assert.equal(ledger.files.get('notes.mjs').revision, 2);
});

// --- the event ----------------------------------------------------------------

test('the commit that contradicts an output retains an invalidation event, once', async () => {
  const ledger = account(['provider', 'consumer', 'bystander']);
  await commit(ledger, 'provider', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'consumer', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);

  const caused = await commit(ledger, 'provider', [
    await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] }),
  ]);
  assert.deepEqual(caused.invalidations.map(event => event.path), ['report.mjs']);

  const events = ledger.receipts.filter(receipt => receipt.reason === 'output_invalidated');
  assert.equal(events.length, 1);
  assert.equal(events[0].causedBy, 'provider');
  assert.equal(events[0].admitted, null, 'an invalidation is neither an admission nor a refusal');
  assert.equal(events[0].depth, 0);
  assert.equal(events[0].staleInputs[0].path, 'policy.mjs');

  // A second commit that contradicts nothing must not repeat the event. An event that
  // fires on every write is an event nobody reads.
  const quiet = await commit(ledger, 'bystander', [await file('notes.md', 'hello', { builtFrom: [] })]);
  assert.deepEqual(quiet.invalidations, []);
  assert.equal(ledger.receipts.filter(receipt => receipt.reason === 'output_invalidated').length, 1);
});

test('an already-invalid output is not re-announced by an unrelated write', async () => {
  const ledger = account(['a', 'b', 'c']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  await commit(ledger, 'b', [
    await file('report.mjs', 'from v1', { builtFrom: [{ path: 'policy.mjs', revision: 1 }] }),
  ]);
  await commit(ledger, 'a', [await file('policy.mjs', 'v2', { baseRevision: 1, builtFrom: [] })]);

  const before = invalidationReport(ledger);
  const quiet = await commit(ledger, 'c', [await file('other.mjs', 'x', { builtFrom: [] })]);
  assert.deepEqual(invalidatedByWrite(before, invalidationReport(ledger), 'c'), []);
  assert.deepEqual(quiet.invalidations, []);
});

test('the report names the revision it was computed against', async () => {
  const ledger = account(['a']);
  await commit(ledger, 'a', [await file('policy.mjs', 'v1', { builtFrom: [] })]);
  const report = invalidationReport(ledger);
  assert.equal(report.epoch, 'e1');
  assert.equal(report.checkedAtSequence, ledger.receipts.length);
});
