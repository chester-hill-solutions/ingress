/**
 * Publication evidence, and the outputs it has since been contradicted by.
 *
 * The fence decides whether a write may land. It says nothing about what happens
 * afterwards: a participant publishes an output built from a file at revision 3,
 * somebody moves that file to revision 4, and the published output is now wrong
 * while the workspace shows it as the current state. That gap was measured, not
 * imagined — the [checkout campaign](../docs/checkout-invalidation-results.md)
 * reproduced six published-but-wrong missions per arm under exactly this sequence,
 * and the mechanism under test converted each one back to correct.
 *
 * What this module holds
 *
 * For every published output: the revision of each input it was built from, and
 * where that declaration came from. That is a *publication record*, not a fence
 * decision, and it is recorded where the admission completes rather than inside
 * the admission path — a refusal and a publication are different events and the
 * ledger should not conflate them.
 *
 * What it derives
 *
 * The current invalidated set, computed against the ledger's own file revisions
 * rather than against anybody's read record. A read is evidence that someone was
 * handed bytes; the output's base is the revision it was actually built from. The
 * campaign is the reason to be precise about the difference: the case that fails
 * is a data dependency with *no import edge at all* — a consumer reading a policy
 * value out of another module — so any relation derived from the code graph would
 * not have fired once. `builtFrom` is the relation that works, and the product
 * already carries it.
 *
 * **Invalidation is a status, not a guarantee.** It says the workspace no longer
 * considers an output approved. It does not make the bytes wrong, does not block
 * a reader, and does not restore anything: a participant (or the harness driving
 * it) has to republish. A republish over stale bytes clears the status in the same
 * way an honest one does, because the evidence recorded is whatever the new commit
 * declared. That is a real limitation and it is the reason the receipts record
 * *who* republished and *from what*.
 *
 * **Transitive closure, bounded.** If `summary.mjs` was built from `policy.mjs`
 * and `report.mjs` was built from `summary.mjs`, then `report.mjs` is invalidated
 * too, at one hop further from the contradiction. Depth is the shortest such
 * distance, and a cycle is visited once — see `invalidationReport` for why that is
 * enough rather than an approximation.
 *
 * **Undecided is reported, not approved.** A file with no recorded evidence is
 * listed as `uncovered`. It is not invalidated (there is nothing to contradict) and
 * it is emphatically not cleared: a workspace whose files predate this record, or
 * that were written by the bootstrap path, is exactly the case where a caller must
 * not read silence as health.
 *
 * Pure module. No I/O, no Cloudflare. The derivation is the part that has to be
 * correct, and it is testable without an account.
 */

/** Where a file's evidence came from. The distinction is part of the record, not a detail. */
export const EVIDENCE_SOURCES = Object.freeze({
  /** The participant declared this file's inputs in the commit manifest. */
  manifest: 'manifest',
  /** The participant declared no per-file inputs, so the participant-wide list applied. */
  participant_declared: 'participant_declared',
  /** Nothing was declared. Recorded so the absence is visible rather than implied. */
  none: 'none',
});

const SOURCES = new Set(Object.values(EVIDENCE_SOURCES));

/**
 * Normalise evidence into the stored form, or `null` for "none declared".
 *
 * Refuses rather than coerces. A malformed input list would otherwise become a
 * quietly smaller dependency set — the workspace would consider fewer outputs
 * contradicted than the participant asked to be held to, which is the direction
 * that loses correctness.
 *
 * `revision: null` is allowed and means "this input was absent when the output was
 * published". It is not the same as `0` (revisions start at 1), and it is treated
 * as immediately contradicted — publishing from a file nobody has written is
 * either a mistake or a claim of immunity, and the campaign's fence already treats
 * it the same way.
 */
export function normaliseEvidence(value) {
  if (value == null) return null;
  const { inputs, source } = value;
  if (!Array.isArray(inputs) || !SOURCES.has(source) || source === 'none') {
    throw new Error('invalid_publication_evidence');
  }
  const seen = new Set();
  const normalised = [];
  for (const entry of inputs) {
    if (typeof entry?.path !== 'string' || !entry.path) throw new Error('invalid_publication_evidence');
    if (seen.has(entry.path)) throw new Error('invalid_publication_evidence');
    seen.add(entry.path);
    const revision = entry.revision ?? null;
    if (revision !== null && !Number.isSafeInteger(revision)) throw new Error('invalid_publication_evidence');
    normalised.push({ path: entry.path, revision });
  }
  return { inputs: normalised, source };
}

/**
 * The evidence to record for one file that is about to be published.
 *
 * Three cases, and they are the same three `evaluateCommit` already distinguishes:
 *
 *   `builtFrom` present   use it. `[]` means "built from nothing" and is recorded
 *                         as such, so nothing can ever invalidate the file.
 *   `builtFrom` absent    fall back to the participant-wide dependency list, which
 *                         is the list the coarse check already held the commit to.
 *                         Recorded with its own source so a reader can tell a
 *                         precise declaration from a coarse one.
 *   neither               nothing to record; the file will be reported uncovered.
 *
 * **The file's own path is dropped from its inputs.** An output that declares it
 * was built from its own previous revision is describing its base, not a
 * dependency — the base check and the merge already govern that relation — and
 * keeping the self-edge would make every same-file edit invalidate itself the
 * instant it landed. This is the same exception `evaluateCommit` makes for
 * `notOwnRead`, for the same reason.
 */
export function evidenceForCommit(ledger, participantId, file) {
  if (Array.isArray(file.builtFrom)) {
    return normaliseEvidence({
      source: EVIDENCE_SOURCES.manifest,
      inputs: file.builtFrom.filter(entry => entry.path !== file.path),
    });
  }

  const declared = [...ledger.require(participantId).dependencies].sort();
  if (declared.length === 0) return null;

  return normaliseEvidence({
    source: EVIDENCE_SOURCES.participant_declared,
    // The revision is the one the workspace handed this participant, recorded when
    // the lease granted it. `evaluateCommit` refused the commit if any of these was
    // unknown, so a null here would mean the fence and this record disagree about
    // what the commit was allowed to rely on — which is worth knowing, not worth
    // hiding behind an empty list.
    inputs: declared.map(path => ({
      path,
      revision: ledger.reads.get(`${participantId}:${path}`)?.revision ?? null,
    })),
  });
}

/** What the workspace currently holds for a path, as the report cites it. */
function currentOf(ledger, path) {
  const file = ledger.files.get(path) ?? null;
  return {
    path,
    revision: file?.revision ?? null,
    author: file?.author ?? null,
    contentHash: file?.contentHash ?? null,
    present: file != null,
  };
}

/**
 * The invalidated set, derived from the ledger as it stands.
 *
 * Breadth-first from the contradictions outward, which is what makes the depth
 * meaningful and the closure terminate:
 *
 *   depth 0    the file's own evidence is contradicted — an input moved or vanished
 *   depth n    every input holds still, but one of them is itself invalidated at
 *              n-1. The file is not wrong because of what *it* read; it is wrong
 *              because what it read is no longer approved.
 *
 * A shortest distance is used rather than a longest one, so a file reachable by
 * two contradictions reports the closer one. A cycle is visited once and cannot be
 * re-entered, so a workspace where two outputs cite each other reports each of them
 * at its distance from a real contradiction and then stops — it does not report a
 * cycle as a contradiction in its own right, because it is not one.
 */
export function invalidationReport(ledger) {
  const files = [...ledger.files.values()];
  const dependents = new Map();
  for (const file of files) {
    for (const input of file.evidence?.inputs ?? []) {
      const list = dependents.get(input.path) ?? [];
      list.push(file.path);
      dependents.set(input.path, list);
    }
  }

  const entries = new Map();
  const queue = [];

  for (const file of files) {
    const evidence = file.evidence ?? null;
    if (evidence == null) continue;
    const staleInputs = [];
    for (const input of evidence.inputs) {
      const current = currentOf(ledger, input.path);
      if (current.present && current.revision === input.revision) continue;
      staleInputs.push({
        path: input.path,
        publishedRevision: input.revision,
        currentRevision: current.revision,
        author: current.author,
        // Named separately because it is a different fact and a different fix:
        // "the file moved" is a republish, "the file is gone" is a conversation.
        missing: !current.present,
      });
    }
    if (staleInputs.length === 0) continue;
    entries.set(file.path, {
      path: file.path,
      revision: file.revision,
      author: file.author,
      source: evidence.source,
      depth: 0,
      staleInputs,
      via: [],
    });
    queue.push(file.path);
  }

  for (let index = 0; index < queue.length; index++) {
    const source = entries.get(queue[index]);
    for (const dependentPath of dependents.get(source.path) ?? []) {
      const already = entries.get(dependentPath);
      const dependent = ledger.files.get(dependentPath);
      if (already) {
        // Reached twice. Add the second carrier, but never re-queue: the first visit
        // is the shortest distance and re-queueing would make a cycle unbounded.
        if (source.depth + 1 === already.depth && !already.via.includes(source.path)) {
          already.via.push(source.path);
        }
        continue;
      }
      if (!dependent?.evidence) continue;
      entries.set(dependentPath, {
        path: dependentPath,
        revision: dependent.revision,
        author: dependent.author,
        source: dependent.evidence.source,
        depth: source.depth + 1,
        staleInputs: [],
        via: [source.path],
      });
      queue.push(dependentPath);
    }
  }

  const invalidated = [...entries.values()].sort((a, b) =>
    a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const uncovered = files.filter(file => (file.evidence ?? null) == null).map(file => file.path).sort();

  return {
    epoch: ledger.epoch,
    checkedAtSequence: ledger.receipts.length,
    outputs: files.length - uncovered.length,
    counts: {
      invalidated: invalidated.length,
      direct: invalidated.filter(entry => entry.depth === 0).length,
      transitive: invalidated.filter(entry => entry.depth > 0).length,
      uncovered: uncovered.length,
    },
    invalidated,
    uncovered,
  };
}

/**
 * The invalidation event a write causes.
 *
 * `before` is the invalidated set computed *before* the write, so the events this
 * returns are the outputs that write newly contradicted rather than every output
 * that happens to be invalid. Without that difference a busy workspace would emit
 * the same event on every commit, and an event that repeats is an event nobody
 * reads.
 */
export function invalidatedByWrite(before, after, causedBy) {
  const known = new Set(before.invalidated.map(entry => entry.path));
  return after.invalidated
    .filter(entry => !known.has(entry.path))
    .map(entry => ({
      // `admitted` is deliberately null: this is neither an admission nor a refusal.
      // It is a consequence of one, and giving it a boolean would invite a reader to
      // count it as traffic.
      admitted: null,
      reason: 'output_invalidated',
      causedBy,
      path: entry.path,
      revision: entry.revision,
      author: entry.author,
      source: entry.source,
      depth: entry.depth,
      staleInputs: entry.staleInputs,
      via: entry.via,
    }));
}
