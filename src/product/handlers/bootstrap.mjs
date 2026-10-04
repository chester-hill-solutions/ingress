/**
 * Bootstrap: establish what a workspace starts as.
 */

import { verifyCommit } from '../commit.mjs';
import { json, readJSON, MAX_COMMIT_BODY } from '../http.mjs';
import { contentKey, encodeBase64 } from '../keys.mjs';

const BOOTSTRAP_AUTHOR = '__bootstrap__';

/**
 * Establish the starting tree. Only legal on an empty ledger.
 *
 * Someone has to be able to say what a workspace begins as. That is not a
 * self-report about *changes*, it is authorship of the initial state. The
 * restriction to an empty ledger is what stops it being a back door: call it twice
 * and the second call is refused, so it cannot be used to overwrite.
 */
export async function bootstrap(ctx, request) {
  const ledger = await ctx.getLedger();
  if (ledger.files.size > 0) {
    return json(409, {
      error: 'bootstrap_closed',
      reason: 'the ledger already holds files; bootstrap may only run on an empty workspace',
      files: ledger.files.size,
    });
  }

  const body = await readJSON(request, MAX_COMMIT_BODY);
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

  return json(200, { bootstrapped: written.length, files: written.map(record => record.path) });
}