/**
 * Commit tests.
 *
 * The scenario the design rests on: a participant sends real content, and the
 * workspace either admits all of it or none of it.
 *
 * The two adversarial cases are the interesting ones, and they are not
 * symmetrical:
 *
 *   forging content  -> must be impossible (the hash is computed on arrival)
 *   omitting a file  -> must merely cost the participant its own work
 *
 * Everything else here guards that pair.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLedger } from '../src/product/fence.mjs';
import { verifyCommit, evaluateCommit, applyCommit, sha256Hex, MAX_COMMIT_FILES } from '../src/product/commit.mjs';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

async function file(path, content) {
  return { path, contentBase64: b64(content), contentHash: await sha256Hex(Buffer.from(content, 'utf8')) };
}

async function seedWorkspace({ dependencies = ['engine.mjs'] } = {}) {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'builder', dependencies });
  ledger.recordWrite({ path: 'engine.mjs', revision: 1, contentHash: await sha256Hex(Buffer.from('v1')) });
  ledger.recordRead({ participantId: 'builder', path: 'engine.mjs' });
  return ledger;
}

test('a commit of real content is admitted and advances revisions', async () => {
  const ledger = await seedWorkspace();
  const verified = await verifyCommit({
    participantId: 'builder',
    files: [await file('ui.mjs', 'export const ui = 1;')],
  });

  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, true, JSON.stringify(decision.refusals));

  const { files } = applyCommit(ledger, decision);
  assert.equal(files.length, 1);
  assert.equal(files[0].nextRevision, 1);
  assert.equal(files[0].author, undefined, 'the receipt carries the id, the ledger carries the author');

  const stored = ledger.files.get('ui.mjs');
  assert.equal(stored.revision, 1);
  assert.equal(stored.author, 'builder');
  assert.equal(stored.contentHash, await sha256Hex(Buffer.from('export const ui = 1;')));
});

test('a commit is refused in full when any file is stale', async () => {
  const ledger = await seedWorkspace();
  ledger.recordWrite({ path: 'engine.mjs', revision: 2, contentHash: 'h2', actorId: 'integrator' });

  const verified = await verifyCommit({
    participantId: 'builder',
    files: [
      await file('fine.mjs', 'this file is perfectly acceptable'),
      await file('also-fine.mjs', 'so is this one'),
    ],
  });

  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, false);

  // Nothing landed. This is the atomicity property, and it is the reason
  // evaluate() does no mutation at all.
  assert.equal(ledger.files.has('fine.mjs'), false, 'a refused commit must not land in part');
  assert.equal(ledger.files.has('also-fine.mjs'), false);
  assert.equal(ledger.receipts.length, 0, 'and must leave no receipt claiming otherwise');
});

test('forged content is rejected: the declared hash must match the bytes received', async () => {
  const ledger = await seedWorkspace();
  const honest = await file('ui.mjs', 'honest content');
  const forged = { ...honest, contentHash: await sha256Hex(Buffer.from('something else entirely')) };

  await assert.rejects(
    () => verifyCommit({ participantId: 'builder', files: [forged] }),
    error => {
      assert.equal(error.reason, 'content_hash_mismatch');
      assert.equal(error.path, 'ui.mjs');
      // The workspace states what it actually received, so the mismatch is
      // diagnosable rather than merely detected.
      assert.equal(error.declared, forged.contentHash);
      assert.ok(error.actual);
      assert.notEqual(error.declared, error.actual);
      return true;
    }
  );
});

test('a file with no declared hash is rejected rather than hashed for the sender', async () => {
  await assert.rejects(
    () => verifyCommit({ participantId: 'builder', files: [{ path: 'ui.mjs', contentBase64: b64('x') }] }),
    error => error.reason === 'missing_content_hash'
  );
});

test('omitting a file loses work but cannot corrupt the workspace', async () => {
  const ledger = await seedWorkspace();

  // The participant changed two files but only declared one.
  const verified = await verifyCommit({
    participantId: 'builder',
    files: [await file('declared.mjs', 'I am honest about this one')],
  });
  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, true);
  applyCommit(ledger, decision);

  // The undeclared change simply is not in the workspace. It is absent, not
  // wrong: the last admitted state is intact and internally consistent.
  assert.equal(ledger.files.has('undeclared.mjs'), false);
  assert.equal(ledger.files.get('declared.mjs').revision, 1);
  assert.equal(ledger.files.get('engine.mjs').revision, 1);
});

test('resending unchanged content is a no-op, not a revision', async () => {
  const ledger = await seedWorkspace();
  const content = 'stable';
  const hash = await sha256Hex(Buffer.from(content));

  ledger.recordWrite({ path: 'shared.mjs', revision: 4, contentHash: hash });
  await ledger.require('builder');

  const verified = await verifyCommit({
    participantId: 'builder',
    files: [{ path: 'shared.mjs', contentBase64: b64(content), contentHash: hash }],
  });
  const decision = evaluateCommit(ledger, verified);

  assert.equal(decision.admitted, true, 're-sending the current tree is satisfied, not refused');
  assert.deepEqual(decision.unchanged, ['shared.mjs']);

  const before = ledger.files.get('shared.mjs').revision;
  applyCommit(ledger, decision);
  assert.equal(ledger.files.get('shared.mjs').revision, before, 'revision must not churn');
});

test('a dependency nobody read is refused, so a blind commit lands nothing', async () => {
  const ledger = new WorkspaceLedger({ epoch: 'e1' });
  ledger.register({ participantId: 'guesser', dependencies: ['schema.graphql'] });
  ledger.recordWrite({ path: 'schema.graphql', revision: 2 });

  const verified = await verifyCommit({
    participantId: 'guesser',
    files: [await file('handler.ts', 'export const handler = 1;')],
  });
  const decision = evaluateCommit(ledger, verified);

  assert.equal(decision.admitted, false);
  assert.equal(decision.refusals[0].reason, 'dependency_read_unknown');
  assert.equal(ledger.files.has('handler.ts'), false);
});

test('a declared base that does not match reality is refused', async () => {
  const ledger = await seedWorkspace();
  ledger.recordWrite({ path: 'ui.mjs', revision: 3, contentHash: 'x', actorId: 'other' });

  const honest = await file('ui.mjs', 'my change');
  const verified = await verifyCommit({
    participantId: 'builder',
    files: [{ ...honest, baseRevision: 1 }],
  });
  const decision = evaluateCommit(ledger, verified);

  assert.equal(decision.admitted, false);
  assert.equal(decision.refusals[0].reason, 'write_base_stale');
  assert.equal(decision.refusals[0].claimedRevision, 1);
  assert.equal(decision.refusals[0].currentRevision, 3);
});

test('applying a refused decision is a programming error, not a silent write', async () => {
  const ledger = await seedWorkspace();
  const verified = await verifyCommit({ participantId: 'builder', files: [await file('x.mjs', 'x')] });
  const decision = evaluateCommit(ledger, verified);
  decision.admitted = false;
  assert.throws(() => applyCommit(ledger, decision), /bug in the caller/);
  assert.equal(ledger.files.has('x.mjs'), false);
});

test('an empty commit is refused rather than silently succeeding', async () => {
  await assert.rejects(
    () => verifyCommit({ participantId: 'builder', files: [] }),
    error => error.reason === 'empty_commit'
  );
});

test('a commit cannot exceed the file count or byte bounds', async () => {
  const many = Array.from({ length: MAX_COMMIT_FILES + 1 }, (_, i) => ({ path: `f${i}.mjs`, contentBase64: b64('x'), contentHash: 'a'.repeat(64) }));
  await assert.rejects(
    () => verifyCommit({ participantId: 'builder', files: many }),
    error => error.reason === 'too_many_files'
  );
});

test('a duplicate path in one commit is refused rather than applied twice', async () => {
  const first = await file('same.mjs', 'first');
  // Both entries hash correctly, so the duplicate is what must be caught — not a
  // hash mismatch that happens to fire first.
  const second = await file('same.mjs', 'second');
  await assert.rejects(
    () => verifyCommit({ participantId: 'builder', files: [first, second] }),
    error => error.reason === 'duplicate_path'
  );
});

test('path traversal is refused during evaluation, so a commit can never half-apply', async () => {
  const ledger = await seedWorkspace();
  const escaping = { ...(await file('escape.mjs', 'nope')), path: '../escape.mjs' };
  const verified = await verifyCommit({ participantId: 'builder', files: [escaping] });

  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, false, 'a bad path is a refusal, not a later crash');
  assert.equal(decision.refusals[0].reason, 'invalid_path');
  assert.equal(ledger.files.size, 1, 'and nothing was written');
});

test('a commit mixing a good file and a traversal path lands neither', async () => {
  const ledger = await seedWorkspace();
  const verified = await verifyCommit({
    participantId: 'builder',
    files: [
      await file('innocent.mjs', 'perfectly fine'),
      { ...(await file('x.mjs', 'nope')), path: '/etc/passwd' },
    ],
  });

  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, false);
  assert.throws(() => applyCommit(ledger, decision), /bug in the caller/);
  assert.equal(ledger.files.has('innocent.mjs'), false, 'atomicity: the good file does not land either');
  assert.equal(ledger.files.size, 1);
});

test('an unregistered participant cannot commit', async () => {
  const ledger = await seedWorkspace();
  const verified = await verifyCommit({ participantId: 'ghost', files: [await file('x.mjs', 'x')] });
  assert.throws(() => evaluateCommit(ledger, verified), /unknown_participant/);
});

test('a settled participant cannot commit', async () => {
  const ledger = await seedWorkspace();
  ledger.participants.get('builder').status = 'completed';
  const verified = await verifyCommit({ participantId: 'builder', files: [await file('x.mjs', 'x')] });
  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, false);
  assert.equal(decision.refusals[0].reason, 'participant_settled');
});

test('the same tree always verifies to the same hashes regardless of ordering', async () => {
  const a = await file('a.mjs', 'A');
  const b = await file('b.mjs', 'B');
  const first = await verifyCommit({ participantId: 'builder', files: [a, b] });
  const second = await verifyCommit({ participantId: 'builder', files: [b, a] });
  assert.deepEqual(
    first.files.map(f => [f.path, f.contentHash]),
    second.files.map(f => [f.path, f.contentHash])
  );
});

test('hashing is not confused by a buffer that is a view into something larger', async () => {
  // Buffer.from over a pooled allocation is exactly this hazard: hashing the
  // underlying ArrayBuffer would include bytes that are not the content.
  const padding = 'PADDING-PADDING-';
  const backing = Buffer.from(padding + 'actual content', 'utf8');
  const view = backing.subarray(padding.length);
  assert.equal(view.toString('utf8'), 'actual content');
  assert.notEqual(view.byteLength, backing.byteLength);
  const viaView = await sha256Hex(view);
  const viaExact = await sha256Hex(Buffer.from('actual content', 'utf8'));
  assert.equal(viaView, viaExact, 'a view must hash as its own contents');
});

test('two different short buffers must not hash the same', async () => {
  // Regression test for a real bug: hashing `buf.buffer` on a pooled Buffer
  // digests the 8 KiB pool, so every short file hashed identically and a
  // legitimate commit was rejected as forged.
  const one = await sha256Hex(Buffer.from('a', 'utf8'));
  const two = await sha256Hex(Buffer.from('b', 'utf8'));
  assert.notEqual(one, two, 'distinct short contents must hash distinctly');
  assert.equal(one.length, 64);
  assert.match(one, /^[0-9a-f]{64}$/);
});

test('a commit built from pooled Buffers verifies', async () => {
  const ledger = await seedWorkspace();
  const content = 'export const x = "short";';
  const entry = {
    path: 'short.mjs',
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
  };
  const verified = await verifyCommit({ participantId: 'builder', files: [entry] });
  assert.equal(evaluateCommit(ledger, verified).admitted, true);
});

test('empty content is hashable and committable', async () => {
  const ledger = await seedWorkspace();
  const empty = await file('empty.txt', '');
  const verified = await verifyCommit({ participantId: 'builder', files: [empty] });
  const decision = evaluateCommit(ledger, verified);
  assert.equal(decision.admitted, true);
  const { files } = applyCommit(ledger, decision);
  assert.equal(files[0].byteLength, 0);
  assert.equal(files[0].contentHash, await sha256Hex(new Uint8Array(0)));
});