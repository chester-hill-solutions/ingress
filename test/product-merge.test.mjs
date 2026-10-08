import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mergeText, mergeBytes, MAX_MERGE_LINES } from '../src/product/merge.mjs';

const MODULE = fileURLToPath(new URL('../src/product/merge.mjs', import.meta.url));
const original = readFileSync(MODULE, 'utf8');

async function loadMutated(source) {
  const url = `${pathToFileURL(MODULE).href}?mutation=${Math.random()}`;
  const previous = readFileSync(MODULE, 'utf8');
  writeFileSync(MODULE, source);
  try { return await import(url); } finally { writeFileSync(MODULE, previous); }
}

test('a side that did not move takes the other side whole', () => {
  assert.deepEqual(mergeText('a\nb\n', 'a\nb\n', 'a\nB\n'), { clean: true, text: 'a\nB\n', conflicts: [] });
  assert.deepEqual(mergeText('a\nb\n', 'a\nB\n', 'a\nb\n'), { clean: true, text: 'a\nB\n', conflicts: [] });
});

test('identical changes on both sides land once, with no conflict', () => {
  const result = mergeText('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n');
  assert.equal(result.clean, true);
  assert.equal(result.text, 'a\nX\nc\n');
});

test('disjoint edits to one file merge cleanly — the case the fence used to refuse', () => {
  // This is the whole point: two participants edit different lines of the same file. The old
  // fence refused the second outright. It merges without a conflict.
  const result = mergeText('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
  assert.equal(result.clean, true);
  assert.equal(result.text, 'a\nB\nc\nd\nE\n');
});

test('adjacent edits — one line apart — merge cleanly, not as a conflict', () => {
  const result = mergeText('1\n2\n3\n4\n', '1\nTWO\n3\n4\n', '1\n2\nTHREE\n4\n');
  assert.equal(result.clean, true);
  assert.equal(result.text, '1\nTWO\nTHREE\n4\n');
});

test('overlapping edits conflict, with both sides preserved in markers', () => {
  const result = mergeText('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');
  assert.equal(result.clean, false);
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.text.includes('<<<<<<< ours'));
  assert.ok(result.text.includes('======='));
  assert.ok(result.text.includes('>>>>>>> theirs'));
  assert.ok(result.text.includes('X'));
  assert.ok(result.text.includes('Y'));
});

test('a deletion by one side and an edit by the other merge cleanly', () => {
  const result = mergeText('a\nb\nc\n', 'a\nc\n', 'a\nb\nC\n');
  assert.equal(result.clean, true);
  assert.equal(result.text, 'a\nC\n');
});

test('an insertion by one side merges cleanly', () => {
  const result = mergeText('a\nb\nc\n', 'a\nNEW\nb\nc\n', 'a\nb\nC\n');
  assert.equal(result.clean, true);
  assert.equal(result.text, 'a\nNEW\nb\nC\n');
});

test('insertions by both sides at the same point conflict when they differ', () => {
  const result = mergeText('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n');
  assert.equal(result.clean, false);
  assert.equal(result.conflicts.length, 1);
});

test('a trailing newline, and its absence, are both preserved', () => {
  assert.equal(mergeText('a\nb\n', 'a\nB\n', 'a\nb\n').text, 'a\nB\n');
  assert.equal(mergeText('a\nb', 'a\nB', 'a\nb').text, 'a\nB');
  assert.equal(mergeText('a\n', 'a\nX\n', 'a\n').text, 'a\nX\n');
});

test('a binary file is refused rather than line-merged', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x03, 0x04]);
  const result = mergeBytes(png, other, png);
  assert.equal(result.clean, false);
  assert.equal(result.binary, true);
  assert.equal(result.bytes, null);
});

test('a file past the line cap is refused, never approximated', () => {
  const big = Array.from({ length: MAX_MERGE_LINES + 10 }, (_, index) => `line ${index}\n`).join('');
  const result = mergeText(big, big.replace('line 1\n', 'line one\n'), big.replace('line 2\n', 'line two\n'));
  assert.equal(result.clean, false);
  assert.equal(result.refused, true);
  assert.equal(result.text, null);
});

test('bytes merge round-trips as UTF-8', () => {
  const encode = text => new TextEncoder().encode(text);
  const result = mergeBytes(encode('a\nb\nc\n'), encode('a\nB\nc\n'), encode('a\nb\nC\n'));
  assert.equal(result.clean, true);
  assert.equal(new TextDecoder().decode(result.bytes), 'a\nB\nC\n');
});

// --- mutations ------------------------------------------------------------------
//
// The method this project uses: a guard is only worth having if a deliberately broken copy
// fails it. The merge is the load-bearing new logic, so it gets the same treatment.

const MUTATIONS = [
  {
    // Treat every region as a conflict. Two sides that made the *same* change to a region must
    // not become a conflict just because a different region disagrees.
    name: 'identical changes on both sides are reported as a conflict',
    transform: source => source.replace(
      'if (sameLines(oursReplacement, theirsReplacement)) out.push(...oursReplacement);',
      'if (false) out.push(...oursReplacement); // mutated',
    ),
  },
  {
    // Never detect overlap, so two edits that share base lines are processed as independent
    // regions and a genuine conflict is silently resolved by taking one side.
    name: 'overlapping edits are no longer detected',
    transform: source => source.replace(
      'return hunk.start < region.end && region.start < hunk.end;',
      'return false; // mutated',
    ),
  },
  {
    // Drop the other side's change when one side did not move: the classic lost update, and
    // exactly the case the merge exists to stop losing.
    name: 'a one-sided region drops the moving side',
    transform: source => source.replace(
      'else if (sameLines(oursReplacement, baseReplacement)) out.push(...theirsReplacement);',
      'else if (sameLines(oursReplacement, baseReplacement)) out.push(...baseReplacement); // mutated',
    ),
  },
  {
    // Treat every pair of replacements as equal, so a real conflict is lost silently.
    name: 'different replacements are treated as equal',
    transform: source => source.replace(
      'const sameLines = (left, right) => left.length === right.length && left.every((line, index) => line === right[index]);',
      'const sameLines = () => true; // mutated',
    ),
  },
];

// Each case takes the module under test, so the same cases run against the mutated copy.
const CASES = [
  module => assert.equal(module.mergeText('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'a\nb\nc\nd\nE\n').text, 'a\nB\nc\nd\nE\n', 'disjoint edits must both land'),
  module => assert.equal(module.mergeText('1\n2\n3\n4\n', '1\nTWO\n3\n4\n', '1\n2\nTHREE\n4\n').text, '1\nTWO\nTHREE\n4\n', 'adjacent edits must both land'),
  module => assert.equal(module.mergeText('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n').clean, false, 'overlapping edits must conflict'),
  // Partial overlap: ours replaces b,c; theirs replaces c,d. They share line c, so this is a
  // conflict — not a clean "take one side".
  module => assert.equal(module.mergeText('a\nb\nc\nd\n', 'a\nX\nd\n', 'a\nb\nY\n').clean, false, 'a partial overlap must conflict'),
  // The same change to one region and a disagreement in another: one conflict, not two.
  module => assert.equal(module.mergeText('a\nb\nc\nd\n', 'a\nX\nc\nD-ours\n', 'a\nX\nc\nD-theirs\n').conflicts.length, 1, 'an identical region must not conflict'),
  module => assert.equal(module.mergeText('a\nb\n', 'a\nb\n', 'a\nB\n').text, 'a\nB\n', 'a one-sided change must land'),
];

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async () => {
    const mutated = mutation.transform(original);
    assert.notEqual(mutated, original, 'the mutation changed nothing, so it would pass for the wrong reason');
    const module = await loadMutated(mutated);
    let caught = false;
    for (const run of CASES) {
      try { run(module); } catch { caught = true; }
    }
    assert.ok(caught, `the mutation survived: ${mutation.name}`);
  });
}
