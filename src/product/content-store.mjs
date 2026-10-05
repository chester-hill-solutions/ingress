/**
 * Storing content, one revision at a time.
 *
 * Why this is separate from `content.mjs`
 *
 * `content.mjs` is the retention *policy* — pure arithmetic over revisions, testable without an
 * account. This is the *effect*: three keys per write, one of them a batch delete, and an
 * ordering that matters. Splitting them keeps the policy testable and makes the effect the only
 * place that touches storage, so a change to how bytes are kept cannot quietly change which
 * bytes are kept.
 *
 * The three keys
 *
 *   content:<path>              current content. Every existing reader wants this, unchanged.
 *   content:<path>@<revision>   this revision, kept so a later merge has a base.
 *   content-index:<path>        which revisions are retained, and how many were dropped.
 *
 * Writing all three in one `put` is not tidiness. The index names revisions whose content must
 * already be there: if the index commits and the content does not, `findBase` reports `exact`
 * for a revision whose bytes are missing, and a merge built on that would be a merge against
 * nothing. One write, or an ordering that cannot produce that state.
 *
 * What this does *not* do
 *
 * It does not merge. It makes a base retrievable and nothing more. Merging is a separate
 * decision with its own failure modes — a line-based merge that is wrong lands a file nobody
 * wrote, which is worse than a refusal — and this layer does not make it.
 */

import { contentKey, contentRevisionKey, contentIndexKey } from './keys.mjs';
import { contentRecord, retain, findBase, indexFrom, holdsCurrent } from './content.mjs';

/**
 * Store one revision of one path.
 *
 * @param {object} storage a Durable Object storage
 * @param {object} file    `{path, bytes, contentHash, revision, author, byteLength}`
 * @param {object} [limit] `{count, bytes}` from `retentionFromEnv`
 * @returns {Promise<{revision: number, trimmed: number[], dropped: number}>} the retained index,
 *   so a caller can report what history this write cost without reading it back.
 */
export async function storeRevision(storage, file, limit) {
  const { path, bytes, contentHash, revision, author = null } = file;
  const record = contentRecord({
    bytes,
    contentHash,
    revision,
    author,
    byteLength: file.byteLength ?? bytes?.byteLength ?? null,
  });

  // Read the index before writing, so the trim decision is made against what is actually
  // stored. Reading it after the write would see this revision already counted and never trim.
  const previous = indexFrom(await storage.get(contentIndexKey(path)));
  // The whole bounds object, not `limit.count`. Passing only the count made the byte ceiling
  // unreachable — `retain` fell back to the default, so a deployment with a small history
  // budget kept the default's worth anyway, silently.
  const { index, drop } = retain(previous, record, limit);

  const puts = {
    // Current first in the object, but all in one call: see the header on why the ordering is
    // a correctness property rather than a convention.
    [contentKey(path)]: record,
    [contentRevisionKey(path, revision)]: record,
    [contentIndexKey(path)]: index,
  };
  await storage.put(puts);

  // Deleting trimmed content is a second operation and cannot be in the same `put`, since a
  // `put` only writes. Left behind, an evicted revision costs storage forever while the index
  // says it is gone — which would make `trimmed` a claim rather than a fact.
  if (drop.length > 0) {
    await storage.delete(drop.map(rev => contentRevisionKey(path, rev)));
  }

  return { revision, index, trimmed: drop, dropped: previous.trimmed };
}

/**
 * Store several revisions in one call.
 *
 * A commit is atomic by design — `evaluateCommit` then `applyCommit` exist so a commit either
 * lands whole or not at all — and batching keeps the storage effect atomic in the same sense.
 * One `put` per file would leave a commit half-stored if the object were evicted midway, which
 * is the exact state the two-phase design in `commit.mjs` exists to prevent.
 *
 * The indexes are read first, in one multi-key get, because each file's trim depends on its own
 * prior index and a sequential read/write per file would be a read-modify-write per file with
 * no transaction over the set.
 */
export async function storeRevisions(storage, files, limit) {
  if (files.length === 0) return { stored: [], trimmed: {} };

  const indexKeys = files.map(file => contentIndexKey(file.path));
  const stored = await storage.get(indexKeys);

  const puts = {};
  const trimmed = {};
  const drops = {};

  for (const file of files) {
    const record = contentRecord({
      bytes: file.bytes,
      contentHash: file.contentHash,
      revision: file.revision,
      author: file.author ?? null,
      byteLength: file.byteLength ?? file.bytes?.byteLength ?? null,
    });
    const previous = indexFrom(stored.get(contentIndexKey(file.path)));
    const result = retain(previous, record, limit);

    puts[contentKey(file.path)] = record;
    puts[contentRevisionKey(file.path, file.revision)] = record;
    puts[contentIndexKey(file.path)] = result.index;

    if (result.drop.length > 0) {
      trimmed[file.path] = result.index.trimmed;
      drops[file.path] = result.drop;
    }
  }

  await storage.put(puts);

  // One delete per path that actually lost history. `storage.delete` accepts an array, but
  // these are *different* paths' keys — batching them would delete revisions of a file whose
  // own index says they are still retained.
  for (const [path, revisions] of Object.entries(drops)) {
    await storage.delete(revisions.map(revision => contentRevisionKey(path, revision)));
  }

  return { stored: files.map(file => file.path), trimmed };
}

/**
 * One revision of one path, if it is retained.
 *
 * Returns the stored record, or `null` when that revision was never written or has been
 * trimmed. `null` rather than the *current* content, because a caller asking for revision 2 and
 * silently receiving revision 7 would merge against something the participant never saw.
 */
export async function readRevision(storage, path, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return (await storage.get(contentRevisionKey(path, revision))) ?? null;
}

/**
 * The base a merge would need for one file, and whether it is usable.
 *
 * The `status` is returned as well as the base because "here is a base" and "there was never a
 * base" are different situations that both otherwise read as `null`. See `findBase`.
 */
export async function baseFor(storage, path, { wantedRevision, currentRevision }) {
  const index = await storage.get(contentIndexKey(path));
  return findBase(index, { wantedRevision, currentRevision });
}

/** What this path retains. Cheap enough to serve on a route; see `/content`. */
export async function readIndex(storage, path) {
  return indexFrom(await storage.get(contentIndexKey(path)));
}

/**
 * Sanity check on an index: does it still hold the current revision?
 *
 * A merge base is worthless without its target, and the one case that silently produces a
 * `null` base is the current revision having been trimmed away. This asserts it rather than
 * trusting the write path — it is the check that would catch a retention policy that dropped
 * the newest entry.
 */
export async function currentIsRetained(storage, path, currentRevision) {
  if (!Number.isSafeInteger(currentRevision)) return true;
  return holdsCurrent(await storage.get(contentIndexKey(path)), currentRevision);
}