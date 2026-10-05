/**
 * Content, one copy per revision.
 *
 * Why this exists
 *
 * `contentKey(path)` held exactly one version per path, overwritten on every commit. That is
 * enough to decide *whether* a write is admissible and completely enough to merge it: by the
 * time the second agent commits, the bytes it built on are gone, so a 3-way merge has no base
 * and the only remaining answer is "refused".
 *
 * For a single participant doing one thing that is correct — if the file moved under you,
 * you should be told. For a swarm it is the whole problem. Two agents editing different
 * functions of the same file collide over a base neither of them is looking at, and the
 * refusal names the right reason and still leaves the human merging by hand. Fifty of those
 * is the 50 merge conflicts the product exists to remove.
 *
 * What this module does and does not do
 *
 * It makes the base *retrievable*. It does not merge anything. Merging is a separate decision
 * with its own failure modes — a line-based merge that is wrong is worse than a refusal,
 * because it lands a file nobody wrote — and it is not this layer's job to decide it. See
 * `docs/product-hardening-plan.md` item 13, leg 3.
 *
 * Retention is part of the design, not an afterthought
 *
 * Content-per-revision is unbounded by construction. The fence allows `MAX_FILES` (512) paths
 * of up to `MAX_FILE_BYTES` (512 KiB) each, so keeping every revision forever is 512 × N ×
 * 512 KiB with no term. A ledger that records 5000 receipts to remember the last one is
 * already a cost problem here — `toJSON` copies the whole ledger on every request, so every
 * retained byte is paid for on every subsequent write.
 *
 * So each path keeps a bounded window of recent revisions and the count of what it dropped is
 * **retained**, the same rule `WorkspaceLedger.receiptsTrimmed` follows. A trim that does not
 * report itself is worse than one that admits it: a caller asking "what was revision 3?" must
 * be able to tell the difference between "revision 3 never existed" and "revision 3 has been
 * dropped, and here is a merge you can no longer attempt".
 *
 * Pure module. Storage is the caller's; this is the retention policy and the arithmetic of
 * finding a base, and both are testable without an account.
 */

/** Revisions kept per path. Five is enough for a merge — the base plus the ones since. */
export const DEFAULT_MAX_REVISIONS_PER_PATH = 5;

/** Bytes of history kept per path. A second ceiling, because count alone does not bound size. */
export const DEFAULT_MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/**
 * The window of revisions a path keeps.
 *
 * Both ceilings, because each catches what the other misses: a path rewritten a thousand times
 * with tiny files exhausts the count long before the bytes, and a path written twice with
 * 512 KiB files exhausts the bytes immediately.
 *
 * Read from the environment on every use so a change is a variable, not a migration.
 */
export function retentionFromEnv(env = {}) {
  const count = readBound(env.INGRESS_MAX_REVISIONS_PER_PATH, DEFAULT_MAX_REVISIONS_PER_PATH);
  const bytes = readBound(env.INGRESS_MAX_HISTORY_BYTES, DEFAULT_MAX_HISTORY_BYTES);
  return { count, bytes };
}

/**
 * Read one bound, falling back rather than failing.
 *
 * A nonsense value falls back to the default in both directions. Zero would disable history
 * and make a merge impossible; Infinity would make it unbounded, which is the failure this
 * module exists to prevent. Neither is a thing an operator meant.
 */
function readBound(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

/**
 * The record stored for one revision of one path.
 *
 * `revision` and `author` are copied from the ledger rather than looked up at read time,
 * because the ledger's answer changes as the path moves on: an old revision's author is not
 * recoverable from current state once the path has been rewritten.
 */
export function contentRecord({ bytes, contentHash, revision, author = null, byteLength = null }) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('contentRecord requires a positive integer revision');
  }
  return {
    revision,
    contentHash,
    author,
    byteLength: byteLength ?? bytes?.byteLength ?? null,
    contentBase64: encodeBase64Local(bytes),
  };
}

/** Base64, locally. Duplicated from `keys.mjs` to keep this module free of that import cycle. */
function encodeBase64Local(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Which revisions a path retains, and what it has dropped.
 *
 * The index is an array of `{revision, byteLength}` in commit order, oldest first. Ordered
 * because the trim is "drop from the front", and because the merge looks for a base that is
 * the *nearest* retained revision at or before the one it wants.
 *
 * `trimmed` counts revisions this path has dropped. It is the difference between "that
 * revision never existed" and "that revision is gone", and a caller cannot tell them apart
 * without it.
 */
export function indexFrom(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
    return { entries: [], trimmed: raw?.trimmed ?? 0 };
  }
  return {
    entries: raw.entries
      .filter(entry => entry && Number.isSafeInteger(entry.revision) && entry.revision >= 1)
      .map(entry => ({ revision: entry.revision, byteLength: Number(entry.byteLength) || 0 })),
    trimmed: Number(raw.trimmed) || 0,
  };
}

/**
 * Record a new revision and decide what falls out.
 *
 * Returns the index to store and the revisions that must be **deleted**, rather than deleting
 * anything: this module has no storage. The caller writes both, and the fact that they are two
 * steps is why the caller has to do them.
 *
 * A revision already in the index is not appended twice. A retried commit of identical content
 * would otherwise make the index grow without the content growing, and the count ceiling would
 * start trimming real history against entries that were never written.
 *
 * `limit` accepts **either** a number (the count ceiling) or the `{count, bytes}` object
 * `retentionFromEnv` returns. Both are accepted because the callers differ: `storeRevisions`
 * has the environment and passes the object, while tests pass a bare number.
 *
 * The byte ceiling was ignored entirely at first, because this read it from a fresh
 * `retentionFromEnv({})` rather than from `limit`. That made it active only when the
 * environment was *empty* — which is never in production, where every caller passes an
 * env-derived limit. A ceiling that only applies in tests is worse than none, because the test
 * that exercises it passes while the deployed behaviour is unbounded. Caught by a test whose
 * expected answer did not match.
 *
 * @returns {{index: object, drop: number[]}}
 */
export function retain(indexRaw, { revision, byteLength = 0 }, limit = DEFAULT_MAX_REVISIONS_PER_PATH) {
  const index = indexFrom(indexRaw);
  if (index.entries.some(entry => entry.revision === revision)) {
    return { index, drop: [] };
  }

  const entries = [...index.entries, { revision, byteLength: Number(byteLength) || 0 }];
  // Ascending, so trimming from the front drops the oldest rather than an arbitrary one.
  // Revisions only ever increase for a path, so appending already keeps it sorted — the sort is
  // here because a caller restoring a ledger from storage could not be trusted to have
  // preserved that, and an unsorted index would trim the wrong end.
  entries.sort((left, right) => left.revision - right.revision);

  const bounds = typeof limit === 'object' && limit !== null
    ? limit
    : { count: limit, bytes: undefined };
  const maxCount = Number.isInteger(bounds.count) && bounds.count > 0
    ? bounds.count
    : DEFAULT_MAX_REVISIONS_PER_PATH;
  const maxBytes = Number.isFinite(bounds.bytes) && bounds.bytes > 0
    ? bounds.bytes
    : DEFAULT_MAX_HISTORY_BYTES;

  const drop = [];
  let kept = entries.length;
  let bytes = entries.reduce((total, entry) => total + entry.byteLength, 0);

  // Trim from the oldest end while either ceiling is exceeded, and never below one entry.
  //
  // The floor of one is the current revision, and it is not negotiable: dropping it would answer
  // `/content` and the seed with null for a path that exists, and the reporter reads null as
  // "this file does not exist" and silently skips writing it — so a participant would be handed
  // a tree with a hole in it and no indication anything was missing.
  //
  // `drop.length` as the cursor rather than re-reading `entries[0]` each pass. Reading the front
  // again after pushing a drop selected the *same* revision twice: `drop` gained a duplicate, its
  // bytes were subtracted twice, and the loop stopped one revision early — so a path kept three
  // entries against a ceiling of two, and `trimmed` counted revisions that were never removed.
  while (kept > 1 && (kept > maxCount || bytes > maxBytes)) {
    const oldest = entries[drop.length];
    drop.push(oldest.revision);
    bytes -= oldest.byteLength;
    kept -= 1;
  }

  return {
    index: { entries: entries.slice(drop.length), trimmed: index.trimmed + drop.length },
    drop,
  };
}

/**
 * The base a merge needs, if this path still has it.
 *
 * `wantedRevision` is what the participant says it built from — the revision it was seeded at,
 * carried through the container in the revisions file. `currentRevision` is what the ledger
 * says the path is at now.
 *
 * Two outcomes, and the difference matters:
 *
 *   exact        the base is the current revision; nothing moved, merge is trivial
 *   older        the base is retained but stale; this is the mergeable case
 *
 * Everything else is `evicted`: the base was trimmed, or it never existed, or the participant
 * claims a base newer than the path has ever reached. None of those are mergeable and none
 * gets a substitute.
 *
 * There is deliberately **no** "nearest revision" fallback. One was here first, and it
 * contradicted the principle stated directly above it: reporting a revision that is merely
 * close as `base` hands the caller something to merge against that the participant never saw,
 * and the merge lands a file attributed to an agent that did not write it. The retained list
 * is returned instead, so a caller can say what *is* available without being handed a
 * substitute for what is not.
 */
export function findBase(indexRaw, { wantedRevision, currentRevision }) {
  const index = indexFrom(indexRaw);
  if (!Number.isSafeInteger(wantedRevision)) return { status: 'unknown', base: null };

  const held = index.entries.find(entry => entry.revision === wantedRevision);
  if (held) {
    return {
      status: held.revision === currentRevision ? 'exact' : 'older',
      base: { ...held },
    };
  }

  return {
    status: 'evicted',
    base: null,
    trimmed: index.trimmed,
    retained: index.entries.map(entry => entry.revision),
  };
}

/** Does this index still hold the current revision? Never drop it, so always true after a write. */
export function holdsCurrent(indexRaw, currentRevision) {
  return indexFrom(indexRaw).entries.some(entry => entry.revision === currentRevision);
}