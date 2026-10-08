/**
 * The commit route: the only path that admits bytes.
 *
 * Reached exclusively from the WorkerEntrypoint the container's egress is
 * intercepted into, and authenticated by a token the workspace minted for that
 * one container. Nothing else in the product can write a file.
 *
 * Both halves of "exclusively" are now enforced rather than asserted. The public router
 * refuses the `/internal/` prefix, so an authenticated caller cannot post here from the
 * internet; and the only token that exists is minted here, for one container, by the
 * workspace that owns it. Before both changes the claim was aspirational: `/write`
 * admitted without a lease, and `/internal/commit` was reachable from outside.
 */

import { verifyCommit, evaluateCommit, applyCommit, sha256Hex } from '../commit.mjs';
import { parseManifest, summariseManifest } from '../manifest.mjs';
import { json, readJSON, MAX_COMMIT_BODY } from '../http.mjs';
import { authenticateContainer, containerRefusal } from '../container-auth.mjs';
import { commitDelta } from '../usage.mjs';
import {
  commitKey,
  manifestsKey,
  logKey,
  MANIFEST_HISTORY,
} from '../keys.mjs';
import { storeRevisions, readRevision } from '../content-store.mjs';
import { retentionFromEnv } from '../content.mjs';
import { mergeBytes } from '../merge.mjs';
import * as leaseHandler from './leases.mjs';

/** Base64 to bytes, the inverse of what the manifest decoder does. */
function decodeBase64(value) {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Reconcile files whose declared base moved, instead of refusing them.
 *
 * The old behaviour was `write_base_stale`: a file whose base revision had advanced was
 * refused and the participant's work was discarded. That cost correct work -- the contention
 * trial measured five of six *disjoint* same-file edits refused -- when the two edits could
 * simply be combined. This merges them.
 *
 * The base is exact, not inferred: `file.baseRevision` is the revision the participant
 * declared it built from, and the content store retains those bytes. So this is a three-way
 * merge with a known base, which is the one thing git has to guess at.
 *
 * A clean merge replaces the file's bytes with the merged result and moves its base to the
 * current revision, so `evaluateCommit` sees a file that is up to date. A conflict is
 * collected, not thrown, so the caller can refuse with the material to resolve it.
 */
async function resolveStaleBases(ctx, ledger, verified) {
  const storage = ctx.state.storage;
  const merged = [];
  const conflicts = [];
  for (const file of verified.files) {
    const declared = file.baseRevision;
    if (declared == null) continue;
    const target = ledger.files.get(file.path) ?? null;
    if (target == null || target.revision === declared) continue;

    const base = await readRevision(storage, file.path, declared);
    const current = await readRevision(storage, file.path, target.revision);
    if (!base || !current) {
      // The base was trimmed before the merge ran. Refused rather than guessed; the participant
      // must re-read the current revision and rebuild.
      conflicts.push({ path: file.path, reason: 'merge_base_unavailable', baseRevision: declared, currentRevision: target.revision });
      continue;
    }

    const result = mergeBytes(decodeBase64(base.contentBase64), file.bytes, decodeBase64(current.contentBase64));
    if (result.binary) { conflicts.push({ path: file.path, reason: 'merge_binary', baseRevision: declared, currentRevision: target.revision }); continue; }
    if (result.refused) { conflicts.push({ path: file.path, reason: 'merge_too_large', baseRevision: declared, currentRevision: target.revision }); continue; }
    if (!result.clean) { conflicts.push({ path: file.path, reason: 'merge_conflict', baseRevision: declared, currentRevision: target.revision, regions: result.conflicts.length }); continue; }

    file.bytes = result.bytes;
    file.byteLength = result.bytes.byteLength;
    file.contentHash = await sha256Hex(result.bytes);
    file.baseRevision = target.revision;
    merged.push({ path: file.path, baseRevision: declared, currentRevision: target.revision });
  }
  return { merged, conflicts };
}

export async function commit(ctx, request) {
  const body = await readJSON(request, MAX_COMMIT_BODY);
  const { participantId, token } = body;
  const ledger = await ctx.getLedger();

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) {
    return json(403, containerRefusal(identity, { admitted: false }));
  }

  const manifest = parseManifest(body);
  if (!manifest.ok) {
    const refusal = { admitted: false, reason: manifest.reason, detail: manifest.detail ?? null };
    await ctx.state.storage.put(commitKey(participantId), refusal);
    // Even a refused manifest carries the output that was there. A build that could not be
    // parsed still wants to be read -- its log is the thing a harness acts on.
    if (typeof body.log === 'string') await ctx.state.storage.put(logKey(participantId), body.log);
    return json(422, { ...refusal, error: 'refused' });
  }

  const exitCode = manifest.participantExit;
  await recordManifestRun(ctx, participantId, exitCode, manifest);

  // The output is stored on every path. A participant that produces nothing to commit is the
  // case the harness most wants to see the output of -- "empty" is a verdict, and the log is
  // the evidence for it.
  if (typeof body.log === 'string') await ctx.state.storage.put(logKey(participantId), body.log);

  if (manifest.files.length === 0) {
    const outcome = {
      admitted: true,
      reason: 'commit_empty',
      participantExit: exitCode,
      landed: [],
      summary: summariseManifest(manifest),
    };
    await ctx.state.storage.put(commitKey(participantId), outcome);
    // Counted, not lumped with an admission. A workspace whose participants all exit
    // without writing anything is a usage signal in itself, and it looks identical to an
    // admission in every other field of this route.
    await ctx.addUsage(commitDelta({ admitted: null }));
    return json(200, { ...outcome, participantId });
  }

  const verified = await verifyCommit({ participantId, files: manifest.files });

  // A commit must be authorised by a write lease on every file it touches.
  //
  // This is the line that makes leases load-bearing rather than decorative. A
  // lease that participants merely *hold* is a protocol, and this repository has a
  // long record of protocols that agents route around — the MCP probe made 16
  // native tool calls and zero mediated ones. If the commit did not check the
  // lease, holding one would change nothing and the whole layer would be advisory
  // in the way everything else here has been.
  //
  // Checked before the fence and refused as a whole, for the same reason the
  // commit is atomic: a participant with no lease has not earned the right to land
  // bytes, so nothing lands, not even the files it did have leases for.
  const table = await ctx.leases();
  const now = Date.now();
  table.sweep(now);
  // Whether a path counts as a write is what `no_change` already knows: identical bytes
  // are not a write. Apply the same rule before the lease check.
  //
  // A whole-tree walk commits every file the participant has, not only the ones it
  // changed — `package.json`, `tsconfig.json`, and the edited source are all in the
  // same manifest. Requiring a lease on an *unchanged* byte recurrence is what
  // blocked every integration test, since a fresh container re-walks its seeded tree
  // wholesale.
  const changedFiles = verified.files.filter(file => {
    const target = ledger.files.get(file.path);
    return target == null || target.contentHash !== file.contentHash;
  });
  const held = table.leasesFor(participantId, { now });
  const unleased = changedFiles
    .filter(file => !held.some(entry => entry.mode === 'write' && entry.paths.has(file.path)))
    .map(file => file.path);

  if (unleased.length > 0) {
    const writable = held.filter(entry => entry.mode === 'write').flatMap(entry => [...entry.paths]);
    const refusal = {
      admitted: false,
      reason: 'lease_required',
      participantExit: exitCode,
      unleasedPaths: unleased,
      detail: held.length === 0
        ? 'no write lease is held'
        : `write leases cover ${[...new Set(writable)].sort().join(', ') || 'nothing'}; these were not leased for writing`,
      hint: `POST /lease/checkout with ${JSON.stringify(unleased)} before committing`,
    };
    await ctx.state.storage.put(commitKey(participantId), refusal);
    await ctx.addUsage(commitDelta({ admitted: false }));
    return json(409, { ...refusal, participantId });
  }

  // A base that moved is reconciled, not refused. See `resolveStaleBases`: this is the merge
  // the product was missing, and it is what makes the fence non-lossy.
  const merge = await resolveStaleBases(ctx, ledger, verified);
  if (merge.conflicts.length > 0) {
    const refusal = {
      admitted: false,
      reason: 'merge_conflict',
      participantExit: exitCode,
      conflicts: merge.conflicts,
      detail: 'a base moved while this participant worked, and the changes could not be merged automatically',
      hint: 're-read the current revision of each path, merge it with your change, and commit again against it',
    };
    await ctx.state.storage.put(commitKey(participantId), refusal);
    await ctx.addUsage(commitDelta({ admitted: false }));
    return json(409, { ...refusal, participantId });
  }

  const decision = evaluateCommit(ledger, verified);

  if (!decision.admitted) {
    // Nothing is stored. A refused commit leaves no bytes behind and no partial
    // state to reason about later — but it does leave a *receipt*, because an audit
    // trail that only records successes cannot answer the only question anyone
    // asks of it: what was turned down, and why.
    ledger.receipts.push({
      sequence: ledger.receipts.length,
      admitted: false,
      reason: decision.refusals[0]?.reason ?? 'commit_refused',
      participantId,
      kind: ledger.require(participantId).kind,
      paths: decision.files.map(file => file.path),
      refusals: decision.refusals,
      participantExit: exitCode,
      fingerprint: decision.fingerprint,
    });
    await ctx.saveLedger();

    const refusal = {
      admitted: false,
      reason: decision.refusals[0]?.reason ?? 'commit_refused',
      participantExit: exitCode,
      refusals: decision.refusals,
      fingerprint: decision.fingerprint,
      unchanged: decision.unchanged,
    };
    await ctx.state.storage.put(commitKey(participantId), refusal);
    await ctx.addUsage(commitDelta({ admitted: false }));
    return json(409, { ...refusal, participantId });
  }

  const { summary, files } = applyCommit(ledger, decision);

  // `verified.files` is already sorted; index it once rather than scanning it per
  // file. The original `.find` inside the loop was quadratic.
  const bytesByPath = new Map(verified.files.map(file => [file.path, file.bytes]));

  // Stored per revision as well as current. This is what makes a base retrievable: when the
  // next agent commits this same path, the bytes it was handed are still here rather than
  // overwritten. Nothing reads these keys yet — see `content-store.mjs` — so a fault here
  // cannot yet corrupt a read, and the seed, `/content` and `retrieve` are untouched.
  //
  // `nextRevision` is the ledger's number, not a count of what is in storage. If the two ever
  // disagreed, `findBase` would report `exact` for a revision with no bytes behind it, and a
  // merge would run against nothing.
  await storeRevisions(
    ctx.state.storage,
    files.map(file => ({
      path: file.path,
      bytes: bytesByPath.get(file.path),
      contentHash: file.contentHash,
      revision: file.nextRevision,
      author: decision.participantId,
      byteLength: file.byteLength,
    })),
    retentionFromEnv(ctx.env ?? {}),
  );
  await ctx.saveLedger();

  const outcome = {
    admitted: true,
    reason: 'commit_admitted',
    participantExit: exitCode,
    landed: files.map(file => ({
      path: file.path,
      revision: file.nextRevision,
      contentHash: file.contentHash,
    })),
    unchanged: decision.unchanged,
    fingerprint: decision.fingerprint,
    receipt: summary,
    summary: summariseManifest(manifest),
    // What was reconciled rather than refused. A landing that merged two participants' edits
    // is not the same event as one that simply stored bytes, and the outcome should say so.
    ...(merge.merged.length > 0 ? { merged: merge.merged } : {}),
  };
  await ctx.state.storage.put(commitKey(participantId), outcome);
  // Byte count from the *admitted* files, which is what was stored. The manifest's own
  // summary is what was offered; this is what cost something.
  await ctx.addUsage(commitDelta({
    admitted: true,
    bytes: files.reduce((total, file) => total + (file.byteLength ?? 0), 0),
  }));
  return json(200, { ...outcome, participantId });
}

/**
 * Retain a summary of each manifest that arrives.
 *
 * The participant's exit code lives here, which is the only record of a container
 * that crashed after doing real work.
 */
async function recordManifestRun(ctx, participantId, exitCode, manifest) {
  const existing = ((await ctx.state.storage.get(manifestsKey)) ?? []);
  await ctx.state.storage.put(manifestsKey, [
    ...existing,
    {
      participantId,
      exitCode,
      files: manifest.files.length,
      bytes: summariseManifest(manifest).totalBytes,
      reason: manifest.reason,
    },
  ].slice(-MANIFEST_HISTORY));
}

/** The most recent participant exit code the workspace saw, if any. */
export async function lastContainerExit(state) {
  const manifests = await state.storage.get(manifestsKey);
  return manifests?.length ? manifests[manifests.length - 1].exitCode : null;
}
/**
 * Serve a participant the tree it is entitled to start from.
 *
 * Gate-only, token-checked, and limited to leased paths. Without it a
 * participant's container is sealed: the gate accepted writes but offered nothing
 * to read, so the participant built its work against an empty directory and the
 * fence was judging changes made against a tree it never received.
 *
 * Refuses rather than returning an empty seed, because an empty seed and a
 * legitimate "you hold nothing" must not look alike to the launcher.
 */
export async function seed(ctx, request) {
  const body = await readJSON(request, MAX_COMMIT_BODY);
  const { participantId, token } = body;

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) {
    return json(403, containerRefusal(identity));
  }

  // `ledger.require` so an unknown participant is an error rather than an empty
  // seed that looks like a workspace with no files.
  (await ctx.getLedger()).require(participantId);

  const result = await leaseHandler.seed(ctx, participantId);
  if (result.refused) {
    // 413 rather than 200-with-a-refusal-in-it. The container's launcher treats a
    // non-2xx as "no seed", so this has to be a status and not a field it has to
    // know to look for.
    return json(413, result);
  }
  return json(200, result);
}
