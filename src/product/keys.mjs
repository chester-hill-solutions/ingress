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
 * Compare two tokens without leaking where they diverge.
 *
 * `expected !== token` short-circuits on the first differing character, which is a
 * timing channel on a route with no authentication in front of it. Comparing
 * fixed-length digests of both closes the character-by-character leak — the one an
 * attacker could actually use — at the cost of one hash per commit.
 *
 * This is not a claim of perfect constant-time behaviour, and it does not need to
 * be: the goal is that a wrong token reveals nothing about how wrong it is.
 *
 * Honest limit: reverting this to `!==` fails no test, because it is semantically
 * identical and differs only in timing. It is verified by reasoning, not by test.
 */
export async function tokensMatch(a, b) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < leftBytes.length; i++) diff |= leftBytes[i] ^ rightBytes[i];
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