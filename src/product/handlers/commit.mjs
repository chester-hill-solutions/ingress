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

import { verifyCommit, evaluateCommit, applyCommit } from '../commit.mjs';
import { parseManifest, summariseManifest } from '../manifest.mjs';
import { json, readJSON, MAX_COMMIT_BODY } from '../http.mjs';
import { authenticateContainer, containerRefusal } from '../container-auth.mjs';
import {
  contentKey,
  commitKey,
  manifestsKey,
  MANIFEST_HISTORY,
  encodeBase64,
} from '../keys.mjs';
import * as leaseHandler from './leases.mjs';

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
    return json(422, { ...refusal, error: 'refused' });
  }

  const exitCode = manifest.participantExit;
  await recordManifestRun(ctx, participantId, exitCode, manifest);

  if (manifest.files.length === 0) {
    const outcome = {
      admitted: true,
      reason: 'commit_empty',
      participantExit: exitCode,
      landed: [],
      summary: summariseManifest(manifest),
    };
    await ctx.state.storage.put(commitKey(participantId), outcome);
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
  const held = table.leasesFor(participantId, { now });
  const unleased = verified.files
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
    return json(409, { ...refusal, participantId });
  }

  const { summary, files } = applyCommit(ledger, decision);

  // `verified.files` is already sorted; index it once rather than scanning it per
  // file. The original `.find` inside the loop was quadratic.
  const bytesByPath = new Map(verified.files.map(file => [file.path, file.bytes]));
  await ctx.state.storage.put(
    Object.fromEntries(
      files.map(file => [
        contentKey(file.path),
        { contentBase64: encodeBase64(bytesByPath.get(file.path)), contentHash: file.contentHash },
      ])
    )
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
  };
  await ctx.state.storage.put(commitKey(participantId), outcome);
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
