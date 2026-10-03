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

/** Files the workspace never commits, whatever a participant says. */
export const ALWAYS_IGNORED = [
  '.git/',
  'node_modules/',
  '.ingress/',
  '.DS_Store',
  '*.swp',
];

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

  const files = [];
  for (const entry of payload.files) {
    if (typeof entry?.path !== 'string' || !entry.path) {
      return { ok: false, reason: 'manifest_bad_path', participantExit: null, files: [] };
    }
    // A skipped file is a legitimate report: the launcher saw it and declined to
    // send it. It is not an error, but it is not a write either.
    if (entry.skipped) continue;
    files.push({
      path: entry.path,
      byteLength: Number(entry.byteLength),
      contentHash: entry.contentHash,
      contentBase64: entry.contentBase64,
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