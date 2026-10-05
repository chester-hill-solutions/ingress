/**
 * Bootstrap: establish what a workspace starts as, and who owns it.
 *
 * Why ownership is here at all
 *
 * A workspace used to be a name in a URL and nothing else. Anyone holding the
 * deployment-wide credential could bootstrap any name — including one they did
 * not intend to use — and the genuine owner could then never bootstrap it, because the
 * only rule was "an empty ledger" and the squatter's bootstrap had made it non-empty.
 *
 * That is name squatting, and on a product whose whole claim is that authorship is
 * provable it is the wrong kind of hole: the ledger records who wrote every byte
 * correctly, and says nothing about who may start the ledger.
 *
 * So the first bootstrap mints a **workspace token**, returned exactly once, and stored
 * only as a digest. A later bootstrap must present it.
 *
 * The token is minted rather than chosen, deliberately. A caller-supplied owner token is
 * only as strong as the caller's password hygiene, and a workspace token that the server
 * generated cannot be guessed, reused from another workspace, or forgotten to rotate.
 *
 * What this does *not* do, because it is a bigger decision than this item: make the token
 * administer anything else. Every other route still takes the deployment credential. The
 * gap between "one token owns the workspace" and "one token owns every route" is real and
 * is not closed here — see `docs/product-hardening-plan.md` item 3, where the equivalent
 * question about the command surface is already waiting on a product decision.
 */

import { verifyCommit } from '../commit.mjs';
import { json, readJSON, MAX_COMMIT_BODY } from '../http.mjs';
import { contentKey, encodeBase64, ownerKey, digest, digestHex, bytesToHex, equalHex } from '../keys.mjs';

const BOOTSTRAP_AUTHOR = '__bootstrap__';

/**
 * Establish the starting tree, and claim the workspace if it is unclaimed.
 *
 * Two rules, in this order, and the order is the security property:
 *
 *   1. If an owner exists, prove you are it. Checked *first*, so a stranger learns
 *      "not the owner" rather than "this workspace already has N files" — the refusal
 *      does not become a way to probe what a workspace contains.
 *   2. The ledger must still be empty. A second bootstrap with the right token is refused
 *      here, for the reason it always was.
 *
 * Rule 1 before rule 2 is what stops the squat. Without it, the squatter's own bootstrap
 * is enough to lock the name: the genuine owner arrives, is told the ledger is not empty,
 * and has no way to prove the tree they would have written was theirs.
 */
export async function bootstrap(ctx, request) {
  const ledger = await ctx.getLedger();
  const owner = await ctx.state.storage.get(ownerKey);

  const body = await readJSON(request, MAX_COMMIT_BODY);

  if (owner) {
    // The stored digest, as hex, against a fresh digest of what was presented.
    //
    // Not `tokensMatch`: that takes two *raw* credentials, and handing it the stored digest
    // would hash it a second time — which fails closed, so it is safe, but it can never
    // match, and the owner would be locked out of their own workspace. And not
    // `digestHex` on the stored side either, for the same reason: that would hash
    // `String(arrayBuffer)`, the text `"[object ArrayBuffer]"`.
    if (!equalHex(bytesToHex(owner.tokenDigest), await digestHex(body.workspaceToken ?? ''))) {
      return json(403, {
        error: 'refused',
        reason: 'not_workspace_owner',
        detail: 'this workspace was created by another token; present it as `workspaceToken`',
        createdAt: owner.createdAt,
      });
    }
  }

  if (ledger.files.size > 0) {
    // Reached with a valid owner token, or on a workspace that holds files but has no
    // owner record — which is a pre-existing workspace from before ownership existed. That
    // case is refused rather than adopted: adopting would hand the workspace to whoever
    // asked next, which is the squat this rule exists to prevent.
    const unowned = !owner;
    return json(409, unowned ? {
      error: 'workspace_exists_unowned',
      reason: 'this workspace already holds files and predates ownership; an operator must claim it',
      files: ledger.files.size,
    } : {
      error: 'bootstrap_closed',
      reason: 'the ledger already holds files; bootstrap may only run on an empty workspace',
      files: ledger.files.size,
    });
  }

  const author = body.author ?? 'bootstrap';
  const verified = await verifyCommit({ participantId: BOOTSTRAP_AUTHOR, files: body.files ?? [] });
  ledger.register({ participantId: BOOTSTRAP_AUTHOR, kind: 'human', displayName: author });

  // Recorded directly rather than through `admit`: there is no prior state to be
  // stale against, so the dependency checks have nothing to say.
  const written = [];
  for (const file of verified.files) {
    written.push(
      ledger.recordWrite({ path: file.path, revision: 1, actorId: author, contentHash: file.contentHash })
    );
  }
  await ctx.state.storage.put(
    Object.fromEntries(
      verified.files.map(file => [
        contentKey(file.path),
        { contentBase64: encodeBase64(file.bytes), contentHash: file.contentHash },
      ])
    )
  );
  await ctx.saveLedger();

  // Claim it, if nobody has. Written after the ledger so a storage failure cannot leave a
  // workspace holding files with no owner — which the next call would then refuse as
  // `workspace_exists_unowned`, a state no caller could recover from.
  let workspaceToken = null;
  if (!owner) {
    workspaceToken = crypto.randomUUID();
    await ctx.state.storage.put(ownerKey, {
      tokenDigest: await digest(workspaceToken),
      createdAt: new Date().toISOString(),
      author,
    });
  }

  return json(200, {
    bootstrapped: written.length,
    files: written.map(record => record.path),
    // Returned once and never again — only the digest is kept. A caller that loses it
    // cannot bootstrap this workspace again, which is correct: they can still do
    // everything else, and re-claiming would mean letting anyone mint a second owner.
    ...(workspaceToken ? { workspaceToken } : {}),
  });
}