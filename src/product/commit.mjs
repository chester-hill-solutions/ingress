/**
 * Which of a file's declared inputs have moved since it was built.
 *
 * Compared against what the workspace currently holds, not against the participant's read
 * record. That is deliberate: this claim is about *the file*, and a file's base is the
 * revision it was built from. Using the read record would reintroduce exactly the coupling
 * this scoping exists to remove — a read of something the output does not depend on would
 * still block it.
 *
 * A declared input that **does not exist** counts as stale. A participant claiming to have
 * built something from a file nobody has written is either confused or lying, and either
 * way the claim cannot be satisfied. Treating a missing file as "not stale" would make
 * `builtFrom: [{path: 'never-written.mjs', revision: 0}]` a way to declare immunity.
 */
function staleAmong(builtFrom, ledger) {
  const stale = [];
  for (const declared of builtFrom) {
    const current = ledger.files.get(declared.path) ?? null;
    if (current == null || current.revision !== declared.revision) {
      stale.push({
        path: declared.path,
        readRevision: declared.revision,
        currentRevision: current?.revision ?? null,
        author: current?.author ?? null,
      });
    }
  }
  return stale;
}

/**
 * Commits: a batch of real file contents, admitted or refused as a unit.
 *
 * Why this exists separately from `ledger.admit`
 *
 * `admit` decides one path against one participant's evidence. That is the right
 * unit for a caller that already holds the bytes. It is the wrong unit for a
 * participant that hands over a whole tree, because:
 *
 *   - a commit is atomic. Two files that disagree about the world cannot both
 *     land; a half-applied commit is a state nobody chose.
 *   - the bytes arrive as content, not as a claimed hash. A participant that
 *     sends `path` + `content` cannot make the workspace store something other
 *     than what it sent, because the hash is computed here from the bytes that
 *     actually arrived.
 *
 * The property that makes this worth the extra code
 *
 * A participant cannot cause the workspace to store bytes that differ from what it
 * sent, because the hash is computed here from the bytes that actually arrived. A
 * commit cannot be admitted under a hash its content does not match.
 *
 * That is a statement about *storage*, not about truth. It does not establish that the
 * bytes came from the container's filesystem: a participant that replaces the
 * in-container reporter can send content it never wrote, and the workspace will hash it,
 * store it and attribute it to that participant. See `launcher.mjs`, where that boundary
 * is stated where the reporter is written.
 *
 * So a participant has two directions available to it, not one:
 *
 *   substitution -> possible with a replaced reporter; the workspace records what
 *                   arrived and who sent it
 *   omission     -> undetectable; a hidden change is simply never sent
 *
 * Both cost the participant its own honesty rather than another participant's
 * correctness, which is why this design can live without snapshot isolation: the fence
 * decides from revisions the workspace itself holds, so a participant that lies about
 * its changes cannot corrupt anyone else's view of them. What it cannot do is have its
 * work believed — every admission and refusal is receipted.
 *
 * Pure module. No I/O, no Cloudflare, no agents. The decision is the part that
 * has to be correct, and correctness should be testable without an account.
 */

import { FenceRefusal, validatePath } from './fence.mjs';
import { evidenceForCommit, refreshEvidenceFor, invalidationReport, invalidatedByWrite, staleInputsOf } from './invalidation.mjs';

/** Bound a single commit so a participant cannot turn one request into a DoS. */
export const MAX_COMMIT_FILES = 128;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_COMMIT_BYTES = 8 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

/** sha256, hex-encoded. Available in both workerd and Node without a polyfill. */
export async function sha256Hex(bytes) {
  // Always copy into a freshly allocated, exactly-sized buffer.
  //
  // Not defensive habit — a measured bug. Node's Buffer is a Uint8Array over a
  // shared pool, so `Buffer.from('short').buffer` is 8 KiB, and
  // `Buffer.prototype.slice` is deprecated precisely because it returns a view
  // rather than a copy. Hashing either would digest the pool instead of the
  // content, and every short file would hash to the same wrong answer.
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const exact = new Uint8Array(source.byteLength);
  exact.set(source);
  const digest = await crypto.subtle.digest('SHA-256', exact.buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw new FenceRefusal('invalid_encoding', {});
  // Standard base64 only. Tolerating whitespace costs nothing and avoids
  // rejecting a payload that is merely formatted oddly.
  const cleaned = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new FenceRefusal('invalid_encoding', {});
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Turn a wire commit into verified files.
 *
 * Verification is fail-closed. A declared hash that does not match the bytes we
 * received is not a warning, it is a rejected commit: the alternative is storing
 * content under a hash the sender chose, which is the self-reporting problem
 * this whole layer exists to remove.
 */
export async function verifyCommit(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new FenceRefusal('malformed_commit', {});
  }
  const { participantId, files } = payload;
  if (typeof participantId !== 'string' || !participantId) {
    throw new FenceRefusal('invalid_participant', {});
  }
  if (!Array.isArray(files)) throw new FenceRefusal('malformed_commit', { participantId });
  if (files.length === 0) throw new FenceRefusal('empty_commit', { participantId });
  if (files.length > MAX_COMMIT_FILES) {
    throw new FenceRefusal('too_many_files', { participantId, count: files.length });
  }

  const verified = [];
  let totalBytes = 0;
  const seen = new Set();

  for (const entry of files) {
    const path = entry?.path;
    const bytes = decodeBase64(entry?.contentBase64 ?? '');

    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new FenceRefusal('file_too_large', { participantId, path, bytes: bytes.byteLength });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_COMMIT_BYTES) {
      throw new FenceRefusal('commit_too_large', { participantId, bytes: totalBytes });
    }

    const actual = await sha256Hex(bytes);
    if (typeof entry?.contentHash !== 'string' || !HEX64.test(entry.contentHash)) {
      throw new FenceRefusal('missing_content_hash', { participantId, path });
    }
    if (entry.contentHash !== actual) {
      throw new FenceRefusal('content_hash_mismatch', {
        participantId,
        path,
        declared: entry.contentHash,
        actual,
      });
    }

    if (seen.has(path)) throw new FenceRefusal('duplicate_path', { participantId, path });
    seen.add(path);

    verified.push({
      path,
      contentHash: actual,
      bytes,
      byteLength: bytes.byteLength,
      // Carried through, not recomputed. Dropping it here would silently disable
      // the base-revision check downstream: an honest participant that declared
      // what it was building on would get a weaker fence than one that did not,
      // with no signal that anything had been dropped.
      baseRevision: typeof entry.baseRevision === 'number' ? entry.baseRevision : null,
      // Carried through for the same reason, and it is the same class of bug twice over: the
      // first version of the per-file dependency check read `file.builtFrom` from this
      // object, which is rebuilt here, so every manifest's provenance was silently dropped
      // and every scoped commit fell back to the coarse participant-wide check. The tests
      // caught it because they asserted `per_file` and got `participant_declared`.
      //
      // `undefined` means "did not declare" and is preserved as such; `[]` means "declared
      // no inputs". Collapsing them would either drop the fallback or coerce every caller
      // into it.
      builtFrom: entry.builtFrom === undefined ? null : entry.builtFrom,
    });
  }

  // Sorted so two commits carrying the same tree are byte-identical and can be
  // compared without re-deriving anything.
  verified.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { participantId, files: verified, totalBytes };
}

/**
 * Decide a verified commit, then apply it whole or not at all.
 *
 * Two phases on purpose. `evaluate` asks the fence about every file with no
 * mutation at all, so a refusal cannot leave the ledger half-updated; `apply`
 * then performs the mutations for a commit that was admitted in full. Splitting
 * them is what makes atomicity a property of the code rather than a hope about
 * ordering.
 *
 * This is the write decision that runs. It is not the only statement of the fence's
 * rules in the repository: `WorkspaceLedger.admit` in `fence.mjs` reimplements the same
 * four checks and has no production caller, so the rules currently exist twice and the
 * better-documented copy is the one that does not run. That duplication is recorded at
 * `fence.mjs` and in `docs/product-hardening-plan.md` item 4.
 */
export function evaluateCommit(ledger, verified) {
  const { participantId, files } = verified;

  // Every file is checked against the same starting evidence, so a refusal cites
  // the state the participant actually reasoned about rather than a state this
  // commit itself moved.
  const cut = ledger.decisionCut(participantId);
  const refusals = [];

  for (const file of files) {
    const target = ledger.files.get(file.path) ?? null;

    // Paths are policed before anything is decided, not at the moment of writing.
    //
    // Validation used to happen inside `recordWrite`, which meant a bad path
    // passed evaluation and then threw halfway through `applyCommit` — a
    // half-applied commit, which is precisely the state this two-phase design
    // exists to make impossible. An invalid path is a refusal like any other.
    try {
      validatePath(file.path);
    } catch (error) {
      refusals.push({ path: file.path, reason: error.reason ?? 'invalid_path' });
      continue;
    }

    if (ledger.isTerminal(participantId)) {
      refusals.push({
        path: file.path,
        reason: 'participant_settled',
        status: ledger.require(participantId).status,
      });
      continue;
    }

    // The declared base must match what is actually there.
    const declaredBase = file.baseRevision ?? null;
    if (declaredBase != null && (target == null || target.revision !== declaredBase)) {
      refusals.push({
        path: file.path,
        reason: 'write_base_stale',
        claimedRevision: declaredBase,
        currentRevision: target?.revision ?? null,
        author: target?.author ?? null,
      });
      continue;
    }

    // Unchanged content is not a write. Sending a file you did not modify must
    // not consume a revision, or every commit would churn the ledger and make
    // everyone else's dependencies look moved.
    if (target != null && target.contentHash === file.contentHash) {
      refusals.push({ path: file.path, reason: 'no_change' });
      continue;
    }

    // Dependencies: if what this file was built from moved, this file cannot be trusted.
    //
    // Scoped to the file. `file.builtFrom` is what the participant says *this output* was
    // derived from, so a dependency that moved refuses the outputs that actually used it and
    // nothing else.
    //
    // This was the defect that made the product unusable for a swarm. Dependencies were
    // declared once per participant at `/join` and held for that participant's whole life,
    // so one stale declaration refused *every* file that participant committed — including
    // files with no relationship to it. Fifty agents sharing a repo deadlocked the moment
    // anyone moved a shared file, and the pressure that deadlock creates is what drives
    // people to `--force`, which bypasses the fence entirely. That is strictly worse than
    // the merge conflict the fence was built to prevent.
    //
    // Two fallbacks, and they are not the same thing:
    //
    //   builtFrom absent (`null`)  fall back to the participant-wide list. Today's behaviour,
    //                              which refuses more than necessary. Kept so adopting
    //                              scoping is opt-in and cannot loosen anything silently.
    //   builtFrom present          use it. `[]` means "built from nothing", and no dependency
    //                              check applies to this file.
    //
    // `dependencyBasis` on the refusal says which of the two ran, so nobody has to guess
    // why a file was held.
    const basis = file.builtFrom === null || file.builtFrom === undefined ? 'participant_declared' : 'per_file';
    // A file that declared its base is governed by the base check above, not by the read
    // record. Reading a file in order to write it is not a dependency on it, and after a merge
    // brought the file up to date its own read is stale by construction -- so without this a
    // participant that read the very file it is editing is refused for having read it, and the
    // merge that would have reconciled it never runs.
    //
    // Scoped tightly on purpose: only the file's *own* path, and only when it declared a base.
    // A file that declares nothing is still held by its stale read, which is what keeps the
    // read check's teeth.
    const notOwnRead = entry => !(file.baseRevision != null && entry.path === file.path);
    const stale = basis === 'per_file'
      ? staleAmong(file.builtFrom, ledger)
      : cut.reads.filter(entry => entry.stale === true).filter(notOwnRead).map(entry => ({
        path: entry.path,
        readRevision: entry.readRevision,
        currentRevision: entry.currentRevision,
        author: entry.author,
      }));

    if (stale.length > 0) {
      refusals.push({
        path: file.path,
        reason: 'dependency_moved',
        dependencyBasis: basis,
        staleDependencies: stale,
      });
      continue;
    }

    const unknown = cut.reads.filter(entry => entry.readBasis === 'unknown').filter(notOwnRead);
    if (unknown.length > 0) {
      refusals.push({
        path: file.path,
        reason: 'dependency_read_unknown',
        unknownDependencies: unknown.map(entry => entry.path),
      });
      continue;
    }
  }

  // `no_change` is not a disagreement, it is a no-op. Drop it before deciding:
  // a commit that only re-sends the current tree is satisfied, not refused.
  const blocking = refusals.filter(r => r.reason !== 'no_change');
  const unchanged = refusals.filter(r => r.reason === 'no_change').map(r => r.path);

  return {
    participantId,
    admitted: blocking.length === 0,
    refusals: blocking,
    unchanged,
    fingerprint: cut.fingerprint,
    files,
  };
}

/** Perform the mutations for a commit that `evaluateCommit` admitted in full. */
export function applyCommit(ledger, decision) {
  if (!decision.admitted) {
    throw new Error('applyCommit called on a refused decision; this is a bug in the caller');
  }

  // What was already invalid before this commit touched anything. The invalidation
  // events at the end are the *difference*, so a workspace with a known-stale output
  // reports it once rather than on every unrelated commit.
  const before = invalidationReport(ledger);

  const receipts = [];
  for (const file of decision.files) {
    if (decision.unchanged.includes(file.path)) continue;
    const target = ledger.files.get(file.path) ?? null;
    const nextRevision = (target?.revision ?? 0) + 1;
    // Recorded here, at the moment of publication, not later and not by the caller.
    // The bytes that just landed and the inputs they were declared to rest on are the
    // same fact about the same event; splitting them would let a crash between the two
    // leave an output with no evidence at all, which is indistinguishable from one
    // whose author declared nothing.
    const evidence = evidenceForCommit(ledger, decision.participantId, file);
    ledger.recordWrite({
      path: file.path,
      revision: nextRevision,
      actorId: decision.participantId,
      contentHash: file.contentHash,
      evidence,
    });
    receipts.push({
      sequence: ledger.receipts.length,
      admitted: true,
      reason: 'commit_admitted',
      participantId: decision.participantId,
      kind: ledger.require(decision.participantId).kind,
      path: file.path,
      baseRevision: target?.revision ?? null,
      nextRevision,
      contentHash: file.contentHash,
      byteLength: file.byteLength,
      fingerprint: decision.fingerprint,
      // The publication record, in the receipt as well as in the ledger. A receipt is
      // what a caller reads back; a fact that exists only in the ledger is a fact the
      // caller has to go and derive, which is the shape of the bug this increment fixes.
      builtFrom: evidence?.inputs ?? null,
      evidenceSource: evidence?.source ?? 'none',
    });
  }

  // The re-affirmations, before the summary is built and before the invalidation diff.
  //
  // An unchanged file that declares its inputs has been re-derived against the current
  // revisions, and that is a claim the record has to be able to hold. Without this the
  // mechanism has a state with no exit: an output whose value does not depend on the change
  // that moved its input stays contradicted no matter how often its owner redoes the work,
  // because the bytes never differ and identical bytes are not a write. See
  // `WorkspaceLedger.refreshEvidence`.
  //
  // A declaration identical to the one already recorded is skipped rather than re-receipted:
  // there is nothing new to record, and a receipt per output on every whole-tree commit would
  // be noise the audit trail has to pay for.
  const refreshed = [];
  const unrefreshed = [];
  for (const file of decision.files) {
    if (!decision.unchanged.includes(file.path)) continue;
    // Only an explicit per-file declaration. See `refreshEvidenceFor`: a participant's container
    // holds everything it declared it depends on, so the coarse fallback here would let one
    // participant stamp its own dependency list onto a file another participant published.
    const evidence = refreshEvidenceFor(file);
    if (evidence == null) continue;
    // An unchanged file never reaches the dependency check in `evaluateCommit` -- `no_change`
    // short-circuits before it -- so the declaration is checked here instead. Checked first,
    // and before the "nothing new to record" comparison below, because a participant that
    // re-sends an unchanged output still declaring the revision that moved is the one case
    // where it most needs to be told why its output is still contradicted. A claim that cannot
    // be honoured is not honoured: the output keeps the evidence it had and stays stale, which
    // is the correct answer for a participant that has not shown it re-derived anything.
    const staleInputs = staleInputsOf(ledger, evidence);
    if (staleInputs.length > 0) {
      unrefreshed.push({ path: file.path, staleInputs });
      continue;
    }
    const current = ledger.files.get(file.path)?.evidence ?? null;
    if (current !== null && current.source === evidence.source
      && current.inputs.length === evidence.inputs.length
      && current.inputs.every((input, index) => input.path === evidence.inputs[index].path && input.revision === evidence.inputs[index].revision)) {
      continue;
    }
    const record = ledger.refreshEvidence({
      path: file.path,
      evidence,
      participantId: decision.participantId,
      sequence: ledger.receipts.length,
    });
    refreshed.push({
      sequence: ledger.receipts.length,
      admitted: true,
      reason: 'evidence_refreshed',
      participantId: decision.participantId,
      kind: ledger.require(decision.participantId).kind,
      path: file.path,
      // The revision does not move: the bytes are the ones that were already there.
      revision: record.revision,
      builtFrom: evidence.inputs,
      evidenceSource: evidence.source,
      fingerprint: decision.fingerprint,
    });
  }

  // One ledger receipt per commit, not per file, so the retained history reads
  // as "this participant committed these paths" rather than as noise.
  const summary = {
    sequence: ledger.receipts.length,
    admitted: true,
    reason: 'commit_admitted',
    participantId: decision.participantId,
    kind: ledger.require(decision.participantId).kind,
    paths: receipts.map(r => r.path),
    unchanged: decision.unchanged,
    refreshed: refreshed.map(receipt => receipt.path),
    fingerprint: decision.fingerprint,
    files: receipts,
  };
  ledger.receipts.push(summary);
  for (const receipt of refreshed) ledger.receipts.push(receipt);

  // Which published outputs this commit contradicted. A consequence of the admission,
  // so it is retained after it, and it never blocks anything: the bytes already landed.
  // The alternative -- refusing the write because it invalidates a dependent -- would
  // make the newest correct information the thing that cannot be written, which is the
  // deadlock the per-file scoping in `evaluateCommit` exists to avoid.
  const after = invalidationReport(ledger);
  const invalidations = invalidatedByWrite(before, after, decision.participantId)
    .map(event => ledger.retain({ ...event, sequence: ledger.receipts.length }));

  return { summary, files: receipts, invalidations, refreshed, unrefreshed };
}
