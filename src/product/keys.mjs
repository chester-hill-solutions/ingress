/**
 * Durable Object storage keys, and the two primitives every handler needs.
 *
 * One module because a storage key spelled two different ways in two different
 * files is a silent split-brain: one handler writes where another reads, both
 * return undefined, and nothing throws.
 */

export const ledgerKey = 'ledger';
export const leasesKey = 'leases';
export const manifestsKey = 'manifests';
export const gateLogKey = 'gate-log';
/**
 * Expiry timestamps of participant starts believed to be running.
 *
 * A single key holding an array, rather than one key per start, because the set is
 * small (bounded by `MAX_CONCURRENT_STARTS`) and is always read whole.
 */
export const startsKey = 'active-starts';

/**
 * Who created this workspace.
 *
 * A single record holding the *digest* of the workspace token, never the token itself: a
 * storage read — by this code, by an operator, by anything that can reach the Durable
 * Object — must not yield a credential that re-opens `/bootstrap`.
 */
export const ownerKey = 'owner';

/**
 * What this workspace has consumed.
 *
 * One key, always written whole. The record is a fixed set of counters — see
 * `usage.mjs` — so a per-counter key scheme would be eleven keys read to render one number
 * and eleven chances to read a key that was never written.
 */
export const usageKey = 'usage';

export const contentKey = path => `content:${path}`;
export const tokenKey = participantId => `token:${participantId}`;
export const commitKey = participantId => `commit:${participantId}`;

/** How many manifest summaries to retain. Oldest fall off the end. */
export const MANIFEST_HISTORY = 20;
/** How many gate log entries to retain. */
export const GATE_LOG_HISTORY = 100;

export function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * SHA-256 of a credential, as bytes.
 *
 * Exists so that "store a digest, compare digests" is one call rather than a digest
 * expression repeated at each site — and a repeated digest expression is where one site
 * ends up comparing a raw token against a stored digest, which fails closed and looks like
 * a bug.
 */
export async function digest(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
}

/**
 * SHA-256 of a credential, as hex.
 *
 * Separate from `digest` because the two callers want different things and the difference
 * is load-bearing:
 *
 *   - **bytes** for a value being *stored*, so nothing in storage is a usable credential
 *     even if it is read back verbatim.
 *   - **hex** for a value being *compared*, because `tokensMatch` digests both sides
 *     again, and digesting an `ArrayBuffer` with `String(buffer)` yields the text
 *     `"[object ArrayBuffer]"` — so every comparison against a stored digest matched.
 *
 * That was not theoretical. The first version of the ownership check stored bytes and
 * compared with `tokensMatch(owner.tokenDigest, digest(presented))`, and every
 * presentation matched, including none at all. The check was decorative: `tokensMatch`
 * digested `"[object ArrayBuffer]"` on one side and the double-digest on the other, both
 * times to the same constant, because `digest('')` is itself the hash of the empty string.
 */
export async function digestHex(value) {
  return bytesToHex(await digest(value));
}

/**
 * Hex, from bytes that are already hashed.
 *
 * Deliberately distinct from `digestHex`, because the two look interchangeable and are
 * not — and the mistake fails **closed** here, which is the dangerous direction: it locks
 * the owner out of their own workspace rather than letting a stranger in.
 *
 *   `digestHex(storedBytes)`  hashes `String(arrayBuffer)`, i.e. the text
 *                             `"[object ArrayBuffer]"`, so it can never equal the hex of
 *                             a presented token
 *   `bytesToHex(storedBytes)`  the stored digest itself, which is what a verification
 *                             needs to compare against
 */
export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two tokens without leaking where they diverge.
 *
 * `expected !== token` short-circircuits on the first differing character, which is a
 * timing channel on a route with no authentication in front of it. Comparing
 * fixed-length digests of both closes the character-by-character leak — the one an
 * attacker could actually use — at the cost of one hash per comparison.
 *
 * This is not a claim of perfect constant-time behaviour, and it does not need to
 * be: the goal is that a wrong token reveals nothing about how wrong it is.
 *
 * Honest limit: reverting this to `!==` fails no test, because it is semantically
 * identical and differs only in timing. It is verified by reasoning, not by test.
 */
export async function tokensMatch(a, b) {
  const [left, right] = await Promise.all([digestHex(a), digestHex(b)]);
  return equalHex(left, right);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Separate from `tokensMatch` because the two callers hold different things, and mixing
 * them up is silent in the dangerous direction:
 *
 *   `tokensMatch(raw, raw)`             two credentials, neither stored
 *   `equalHex(digestHex(a), digestHex(b))`  a stored digest against a fresh one
 *
 * Passing a *stored digest* to `tokensMatch` can never match, because it would be digested
 * a second time — which fails closed, so it is at least safe. Passing a raw token to
 * `equalHex` fails open, and that is the one to avoid.
 *
 * Compared as the hex strings they are. The obvious `new Uint8Array(hex)` is the trap:
 * given a string it yields an **empty array** rather than throwing, so both sides became
 * zero-length, the loop never ran, `diff` stayed 0, and this returned true for every input
 * including the empty token. The ownership check was, for one run, decorative — and nothing
 * about it looked wrong in review.
 *
 * Length is compared too. Two different digests have the same length, so it cannot be what
 * decides equality — but a length mismatch *is* a mismatch, and ignoring it would make this
 * correct only for inputs of exactly one size.
 */
export function equalHex(left, right) {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * Read several content keys at once.
 *
 * The multi-key form of `storage.get` returns a **Map**, not an array. Getting
 * that wrong is invisible locally if the test shim shares the mistake, and it
 * returns null for every path in production — which is how a batched read
 * shipped once already. This helper exists so the assumption lives in one place.
 */
export async function readContentMap(storage, paths) {
  const stored = await storage.get(paths.map(contentKey));
  return new Map(paths.map(path => [path, stored.get(contentKey(path)) ?? null]));
}