/**
 * The manifest contract.
 *
 * Both sides of the gate parse manifests, and they are on opposite sides of a
 * network hop written in two languages. This is the single description of what a
 * manifest is, so there is exactly one thing to change when it changes.
 *
 * Kept small and pure on purpose: it is the seam most likely to rot silently,
 * because a mismatch on either side shows up as "the commit was empty" rather
 * than as an error.
 */

export const MANIFEST_VERSION = 1;

/**
 * How many files one manifest entry may declare it was built from.
 *
 * Bounded because this is a claim the workspace then acts on, and an unbounded list is both
 * a payload-size lever and a way to make one commit's refusal enormous. 32 is well above
 * what a real generated file depends on.
 */
export const MAX_BUILT_FROM = 32;

/**
 * Parse a `builtFrom` claim: `[{path, revision}, ...]`.
 *
 * Returns `null` when absent, and `[]` when present but empty — the two mean different
 * things and the difference is load-bearing:
 *
 *   `null`   this participant does not declare provenance; fall back to the participant-wide
 *            dependency list, which is today's behaviour and refuses more than necessary
 *   `[]`     this participant declares it was built from *nothing*; no dependency check
 *            applies to this file at all
 *
 * Collapsing those two would either silently drop the fallback (fail open) or make an
 * explicit "I depend on nothing" indistinguishable from silence (fail closed, and every
 * caller would be silently coerced into the coarse path).
 *
 * A malformed entry is refused rather than dropped. Dropping one would turn a participant's
 * typo into a quietly smaller dependency set — the workspace would refuse less than the
 * participant asked to be held to, which is the direction that loses conflicts.
 */
function parseBuiltFrom(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return undefined;      // malformed: refused below
  if (value.length > MAX_BUILT_FROM) return undefined;
  if (value.length === 0) return [];

  const parsed = [];
  for (const entry of value) {
    if (typeof entry?.path !== 'string' || !entry.path) return undefined;
    // Checked for null/empty *before* `Number`, because `Number(null)` is 0 and `Number('')`
    // is 0 — so a revision that is absent or null would silently become "revision 0". That
    // happens to fail closed here, since revisions start at 1 and so nothing is ever at 0,
    // but a claim that is quietly reinterpreted is a claim whose meaning is not what the
    // sender wrote. Refuse it.
    if (entry.revision === null || entry.revision === undefined || entry.revision === '') {
      return undefined;
    }
    const revision = Number(entry.revision);
    if (!Number.isInteger(revision) || revision < 0) return undefined;
    parsed.push({ path: entry.path, revision });
  }
  return parsed;
}

/**
 * Files the workspace never commits, whatever a participant says.
 *
 * Applied in **both** places that can put a path in front of the fence: the in-container
 * reporter's walk, and `parseManifest` here. The second is not redundant paranoia — it is
 * the only one that a hand-written client cannot avoid, since it builds its own manifest.
 *
 * This list was documented as authoritative and applied by nothing until the reporter's
 * provenance work needed `.ingress/` to be genuinely unreachable. A participant that ran
 * `npm install` or `git init` sent the whole tree, and the workspace stored it.
 *
 * The reporter inlines an identical copy — it runs in a container and cannot import — so
 * `test/product-launcher.test.mjs` asserts the two agree.
 */
export const ALWAYS_IGNORED = [
  '.git/',
  'node_modules/',
  '.ingress/',
  '.DS_Store',
  '*.swp',
];

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.ingress', '.DS_Store']);

/** Does this workspace-relative path match the ignore list? */
export function isIgnored(relPath) {
  const segments = String(relPath).split('/');
  if (segments.some(segment => IGNORED_NAMES.has(segment))) return true;
  return segments.some(segment => segment.endsWith('.swp'));
}

/**
 * Parse the launcher's payload into something the fence can decide on.
 *
 * Fails closed. An unparseable manifest yields an empty commit and a reason,
 * never a partial one — a manifest the workspace half-understands is how bytes
 * arrive that nobody accounted for.
 */
export function parseManifest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    // An array is an object, so without this it would fall through and be
    // reported as a version mismatch — technically true, diagnostically useless.
    return { ok: false, reason: 'malformed_manifest', participantExit: null, files: [] };
  }
  // The version crosses a process boundary as an environment variable, and
  // environment variables are strings. Comparing it to the integer directly
  // rejected every real manifest with a 422 while the unit tests passed, because
  // the tests constructed the object in-process where `1` really was a number.
  // Coerce, and reject anything that is not the integer rather than merely
  // stringifying it — `'1abc'` must not pass as 1.
  const version = Number(payload.manifestVersion);
  if (!Number.isInteger(version) || version !== MANIFEST_VERSION) {
    return {
      ok: false,
      reason: 'manifest_version_mismatch',
      detail: `expected ${MANIFEST_VERSION}, got ${JSON.stringify(payload.manifestVersion)}`,
      participantExit: null,
      files: [],
    };
  }
  if (typeof payload.participantId !== 'string' || !payload.participantId) {
    return { ok: false, reason: 'manifest_missing_participant', participantExit: null, files: [] };
  }
  if (!Array.isArray(payload.files)) {
    return { ok: false, reason: 'manifest_missing_files', participantExit: null, files: [] };
  }

  // A malformed `builtFrom` is one clear refusal naming the path, checked up front. Dropping
  // the entry instead would turn a participant's typo into a quietly smaller dependency set
  // — the workspace would refuse less than the participant asked to be held to, which is
  // the direction that loses conflicts.
  const badBuiltFrom = payload.files.find(
    entry => entry?.builtFrom !== undefined && parseBuiltFrom(entry.builtFrom) === undefined
  );
  if (badBuiltFrom) {
    return {
      ok: false,
      reason: 'manifest_bad_built_from',
      detail: `builtFrom must be an array of at most ${MAX_BUILT_FROM} {path, revision} entries, revisions non-negative integers`,
      path: typeof badBuiltFrom.path === 'string' ? badBuiltFrom.path : null,
      participantExit: null,
      files: [],
    };
  }

  const files = [];
  for (const entry of payload.files) {
    if (typeof entry?.path !== 'string' || !entry.path) {
      return { ok: false, reason: 'manifest_bad_path', participantExit: null, files: [] };
    }
    // Dropped here as well as in the reporter's walk, so the guarantee is the receiving
    // end's rather than the sender's. A participant that hand-builds a manifest — or one
    // whose reporter has been replaced — still cannot land a dependency tree.
    if (isIgnored(entry.path)) continue;
    // A skipped file is a legitimate report: the launcher saw it and declined to
    // send it. It is not an error, but it is not a write either.
    if (entry.skipped) continue;
    files.push({
      path: entry.path,
      byteLength: Number(entry.byteLength),
      contentHash: entry.contentHash,
      contentBase64: entry.contentBase64,
      baseRevision: entry.baseRevision ?? null,
      // What THIS file was built from, at the revision this participant had it.
      //
      // The distinction this buys is the whole reason a swarm can work. Dependencies
      // declared at `/join` are per-participant and last for the participant's whole life,
      // so one stale declaration used to refuse *every* file that participant committed —
      // including files with nothing to do with it. Fifty agents on one repo deadlocked on
      // the first agent to move a shared file, and the pressure that deadlock creates is
      // what makes people reach for `--force`, which is worse than the conflict it avoided.
      //
      // Per-file provenance scopes the check to the outputs that actually depended on the
      // thing that moved. A file that declares nothing keeps the old participant-wide check
      // rather than silently losing it — see `evaluateCommit`.
      builtFrom: parseBuiltFrom(entry.builtFrom),
    });
  }

  return {
    ok: true,
    reason: 'manifest_parsed',
    participantExit: Number.isInteger(payload.participantExit) ? payload.participantExit : null,
    files,
  };
}

/**
 * Summarise a manifest for humans without shipping the bytes.
 *
 * Used in the join envelope so a participant can see what its peers have landed
 * without the workspace having to serve anyone's file contents to anyone.
 */
export function summariseManifest(manifest) {
  return {
    ok: manifest.ok,
    reason: manifest.reason,
    participantExit: manifest.participantExit ?? null,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + (Number(file.byteLength) || 0), 0),
  };
}