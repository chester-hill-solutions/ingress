/**
 * The manifest seam.
 *
 * This is the one place where two languages, two processes and a network hop meet,
 * so it is where a mismatch shows up as "the commit was empty" rather than as an
 * error. Every field is pinned here, including the string-versus-number coercion
 * that a real deployment hit and an in-process test could not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, summariseManifest, MANIFEST_VERSION } from '../src/product/manifest.mjs';

const file = (path, overrides = {}) => ({
  path,
  byteLength: 10,
  contentHash: 'a'.repeat(64),
  contentBase64: 'AAAA',
  ...overrides,
});

test('a well-formed manifest parses', () => {
  const result = parseManifest({
    manifestVersion: MANIFEST_VERSION,
    participantId: 'A',
    participantExit: 0,
    files: [file('a.mjs'), file('b.mjs')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
  assert.equal(result.participantExit, 0);
});

test('a manifest version arriving as a string is accepted', () => {
  // This is the real deployment shape. Environment variables are strings, so the
  // launcher sends "1" where the parser expected the number 1. Every commit was
  // refused with 422 before this was handled, while in-process tests passed.
  const result = parseManifest({
    manifestVersion: String(MANIFEST_VERSION),
    participantId: 'A',
    files: [file('a.mjs')],
  });
  assert.equal(result.ok, true, 'a version that is the right number in a string is still that version');
  assert.equal(result.files.length, 1);
});

test('a version that only looks like the right number is refused', () => {
  for (const bad of ['1abc', '1.5', '', null, undefined, {}, '01x']) {
    const result = parseManifest({ manifestVersion: bad, participantId: 'A', files: [file('a.mjs')] });
    assert.equal(result.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.equal(result.reason, 'manifest_version_mismatch');
  }
});

test('a future version is refused rather than best-guessed', () => {
  const result = parseManifest({ manifestVersion: MANIFEST_VERSION + 1, participantId: 'A', files: [file('a.mjs')] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest_version_mismatch');
});

test('a manifest with no participant or no files is refused', () => {
  assert.equal(parseManifest({ manifestVersion: MANIFEST_VERSION, files: [] }).reason, 'manifest_missing_participant');
  assert.equal(parseManifest({ manifestVersion: MANIFEST_VERSION, participantId: 'A' }).reason, 'manifest_missing_files');
  assert.equal(parseManifest({ manifestVersion: MANIFEST_VERSION, participantId: 'A', files: {} }).reason, 'manifest_missing_files');
});

test('a skipped file is dropped rather than treated as an error or a write', () => {
  const result = parseManifest({
    manifestVersion: MANIFEST_VERSION,
    participantId: 'A',
    files: [file('small.mjs'), file('huge.bin', { skipped: 'too_large', byteLength: 99999999 })],
  });
  assert.equal(result.ok, true, 'declining to send a file is a legitimate report');
  assert.deepEqual(result.files.map(f => f.path), ['small.mjs']);
});

test('an entry with no path is refused rather than silently dropped', () => {
  const result = parseManifest({
    manifestVersion: MANIFEST_VERSION,
    participantId: 'A',
    files: [file('ok.mjs'), { byteLength: 1 }],
  });
  assert.equal(result.ok, false, 'a half-understood manifest is how unattributed bytes arrive');
  assert.equal(result.reason, 'manifest_bad_path');
});

test('an empty commit parses cleanly, because writing nothing is a valid outcome', () => {
  const result = parseManifest({ manifestVersion: MANIFEST_VERSION, participantId: 'A', files: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, []);
});

test('a non-integer exit code is reported as unknown rather than invented', () => {
  const crashed = parseManifest({ manifestVersion: MANIFEST_VERSION, participantId: 'A', files: [], participantExit: 139 });
  assert.equal(crashed.participantExit, 139);
  const missing = parseManifest({ manifestVersion: MANIFEST_VERSION, participantId: 'A', files: [] });
  assert.equal(missing.participantExit, null, 'absent is not zero');
});

test('the summary reports shape without carrying the bytes', () => {
  const result = parseManifest({
    manifestVersion: MANIFEST_VERSION,
    participantId: 'A',
    participantExit: 0,
    files: [file('a.mjs', { byteLength: 100 }), file('b.mjs', { byteLength: 23 })],
  });
  const summary = summariseManifest(result);
  assert.deepEqual(summary, {
    ok: true,
    reason: 'manifest_parsed',
    participantExit: 0,
    fileCount: 2,
    totalBytes: 123,
  });
  assert.equal('contentBase64' in summary, false, 'a summary must not leak file contents');
});

test('garbage is refused without throwing', () => {
  for (const input of [null, undefined, 'string', 42, []]) {
    const result = parseManifest(input);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed_manifest');
    assert.deepEqual(result.files, []);
  }
});
// --- builtFrom: the provenance claim -------------------------------------------

test('builtFrom is parsed into path/revision pairs', () => {
  const parsed = parseManifest({
    manifestVersion: String(MANIFEST_VERSION),
    participantId: 'a',
    participantExit: 0,
    files: [{
      path: 'x.mjs',
      contentHash: 'a'.repeat(64),
      contentBase64: 'eA==',
      builtFrom: [{ path: 'engine.mjs', revision: 3 }],
    }],
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.files[0].builtFrom, [{ path: 'engine.mjs', revision: 3 }]);
});

test('absent builtFrom and an empty one are different claims', () => {
  // The distinction is load-bearing. Absent means "fall back to the participant-wide
  // dependency list"; empty means "I built this from nothing, check nothing". Collapsing
  // them either drops the fallback (fail open) or coerces every caller into it (fail closed).
  const files = payload => parseManifest({
    manifestVersion: String(MANIFEST_VERSION),
    participantId: 'a',
    participantExit: 0,
    files: [{ path: 'x.mjs', contentHash: 'a'.repeat(64), contentBase64: 'eA==', ...payload }],
  }).files[0];

  assert.equal(files({}).builtFrom, null, 'absent is null');
  assert.deepEqual(files({ builtFrom: [] }).builtFrom, [], 'empty is an explicit no-inputs claim');
});

test('a malformed builtFrom is refused rather than dropped', () => {
  // Dropping it would silently shrink a participant's declared dependency set — the
  // workspace would refuse less than the participant asked to be held to, which is the
  // direction that loses conflicts.
  for (const bad of [
    'engine.mjs',                                  // not an array
    [{ path: 'engine.mjs' }],                      // no revision: Number(undefined) is NaN,
                                                    // but a missing one must not read as r0
    [{ revision: 1 }],                              // no path
    [{ path: 'a.mjs', revision: 'x' }],             // revision not an integer
    [{ path: 'a.mjs', revision: -1 }],              // negative
    [{ path: 'a.mjs', revision: null }],            // Number(null) is 0 — must not pass as r0
    Array.from({ length: 33 }, () => ({ path: 'a.mjs', revision: 1 })),  // over the cap
  ]) {
    const parsed = parseManifest({
      manifestVersion: String(MANIFEST_VERSION),
      participantId: 'a',
      participantExit: 0,
      files: [{ path: 'x.mjs', contentHash: 'a'.repeat(64), contentBase64: 'eA==', builtFrom: bad }],
    });
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.equal(parsed.reason, 'manifest_bad_built_from');
    assert.equal(parsed.path, 'x.mjs', 'and the refusal names the offending path');
  }
});

test('a valid builtFrom at exactly the cap is accepted', () => {
  const parsed = parseManifest({
    manifestVersion: String(MANIFEST_VERSION),
    participantId: 'a',
    participantExit: 0,
    files: [{
      path: 'x.mjs',
      contentHash: 'a'.repeat(64),
      contentBase64: 'eA==',
      builtFrom: Array.from({ length: 32 }, (_, i) => ({ path: `f${i}.mjs`, revision: 1 })),
    }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files[0].builtFrom.length, 32);
});
