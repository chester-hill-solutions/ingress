/**
 * The rule that decides whether a model turn's bytes may be published.
 *
 * It exists because the first model-mode run published empty files: every turn failed on an
 * expired provider key, and the harness sent containers to write nothing. The workspace
 * recorded nine legitimate-looking publications, the mission reported a coherent workspace
 * full of empty files, and every downstream check measured a mechanism that had never run.
 *
 * So the rule is tested directly, and it is blunt on purpose: succeeded, produced bytes, and
 * reported no error of its own. A run that cannot satisfy it must stop rather than publish.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationOf, MAX_MODEL_FILE_BYTES } from '../src/model-worker.mjs';

test('a successful turn with a file in it may be published', () => {
  const publication = publicationOf({ outcome: 'succeeded', error: null, content: 'export const offer = 20;\n' });
  assert.equal(publication.ok, true);
  assert.equal(publication.content, 'export const offer = 20;\n');
  assert.equal(publication.bytes, 25);
});

test('a turn that failed publishes nothing, whatever it left behind', () => {
  // The expired-key case: the session ends `failed`, and the file it did not write must not
  // become a publication with a declaration attached to it.
  const failed = publicationOf({ outcome: 'failed', error: null, content: '' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'outcome_failed');

  const partial = publicationOf({ outcome: 'interrupted', error: null, content: 'export const offer = 20;\n' });
  assert.equal(partial.ok, false, 'an interrupted turn is not a finished one');
});

test('a turn that produced no bytes publishes nothing', () => {
  assert.equal(publicationOf({ outcome: 'succeeded', error: null, content: '' }).reason, 'empty_content');
  assert.equal(publicationOf({ outcome: 'succeeded', error: null, content: null }).reason, 'empty_content');
  assert.equal(publicationOf({ outcome: 'succeeded', error: 'model_wrote_no_output', content: null }).reason, 'model_wrote_no_output');
  assert.equal(publicationOf(null).reason, 'no_result');
});

test('a file too large to carry in a participant command is refused, and says so', () => {
  const big = publicationOf({ outcome: 'succeeded', error: null, content: 'x'.repeat(MAX_MODEL_FILE_BYTES + 1) });
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'output_too_large');
  assert.equal(big.bytes, MAX_MODEL_FILE_BYTES + 1);
  assert.equal(publicationOf({ outcome: 'succeeded', error: null, content: 'x'.repeat(MAX_MODEL_FILE_BYTES) }).ok, true,
    'the bound is inclusive, so a file that fits is not refused');
});
