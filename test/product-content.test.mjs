/**
 * Content retention: which revisions a path keeps, and what it admits to dropping.
 *
 * The dangerous failure here is quiet. If retention drops the wrong revision, nothing throws —
 * a merge later reports a base it cannot find, or `/content` serves nothing for a path that
 * exists. So every case below is about which end gets dropped, and about the difference
 * between "that revision never existed" and "that revision is gone".
 *
 * Pure module, so every case runs without an account and without a deployment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retain,
  indexFrom,
  findBase,
  holdsCurrent,
  contentRecord,
  retentionFromEnv,
  DEFAULT_MAX_REVISIONS_PER_PATH,
} from '../src/product/content.mjs';

const entry = (revision, byteLength = 10) => ({ revision, byteLength });

// --- retaining ------------------------------------------------------------------

test('a new revision is added to the index', () => {
  const { index, drop } = retain({ entries: [], trimmed: 0 }, entry(1));
  assert.deepEqual(index.entries, [entry(1)]);
  assert.deepEqual(drop, []);
});

test('revisions accumulate in ascending order', () => {
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3]) index = retain(index, entry(revision)).index;
  assert.deepEqual(index.entries.map(e => e.revision), [1, 2, 3]);
});

test('an index handed back out of order is sorted before trimming', () => {
  // A ledger restored from storage is not this code's to trust. An unsorted index trimmed from
  // the front would drop the *newest* revision — and the current revision is the one thing
  // `retain` must never drop.
  const scrambled = { entries: [entry(3), entry(1), entry(2)], trimmed: 0 };
  const { index } = retain(scrambled, entry(4), 2);
  assert.deepEqual(index.entries.map(e => e.revision), [3, 4], 'kept the newest two, not the first two');
});

test('the same revision twice is not appended twice', () => {
  // A retried commit of identical content must not grow the index without the content growing,
  // or the count ceiling starts trimming real history against entries that were never written.
  const first = retain({ entries: [], trimmed: 0 }, entry(1));
  const again = retain(first.index, entry(1));
  assert.deepEqual(again.index.entries, [entry(1)]);
  assert.deepEqual(again.drop, [], 'and nothing is dropped for it');
});

// --- the count ceiling ----------------------------------------------------------

test('history past the count is trimmed from the oldest end', () => {
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3, 4, 5]) {
    index = retain(index, entry(revision), 3).index;
  }
  assert.deepEqual(index.entries.map(e => e.revision), [3, 4, 5], 'the three newest survive');
});

test('the current revision is never trimmed, however small the ceiling', () => {
  // A ceiling of 1 must still keep the newest. Dropping it would answer `/content` with null
  // for a path that exists, and the seed would hand a participant a tree with a hole in it.
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3]) index = retain(index, entry(revision), 1).index;
  assert.deepEqual(index.entries.map(e => e.revision), [3]);
});

test('a single revision is never trimmed even when it alone exceeds the byte ceiling', () => {
  // There is nothing to keep instead. Refusing to trim would grow without bound; trimming it
  // would lose the file. Keeping it is the only choice that leaves both properties intact, and
  // it is what makes "one oversized file" the only way to exceed the byte ceiling.
  const { index, drop } = retain({ entries: [], trimmed: 0 }, entry(1, 10_000_000), 100);
  assert.deepEqual(index.entries, [entry(1, 10_000_000)]);
  assert.deepEqual(drop, [], 'so a later merge against it is still possible');
});

// --- the byte ceiling -----------------------------------------------------------

test('large revisions are trimmed by size, not by count', () => {
  // The case count alone misses: three revisions is well under any sane count ceiling, but
  // three 512 KiB files is 1.5 MiB of history for one path.
  let index = { entries: [], trimmed: 0 };
  index = retain(index, entry(1, 900_000)).index;
  index = retain(index, entry(2, 900_000)).index;
  index = retain(index, entry(3, 900_000)).index;

  // Default ceiling is 2 MiB, so 2.7 MiB must lose its oldest.
  assert.deepEqual(index.entries.map(e => e.revision), [2, 3], 'trimmed by bytes, at a count of 2');
});

test('the byte ceiling is reachable through the limit shape callers actually pass', () => {
  // A ceiling that only applies when the environment is empty is worse than no ceiling at all:
  // the test exercising it passes while the deployed behaviour is unbounded. `storeRevisions`
  // passes the `{count, bytes}` object `retentionFromEnv` returns, so that is the shape that
  // must work — and passing only `limit.count` silently fell back to the default bytes.
  let index = { entries: [], trimmed: 0 };
  for (let revision = 1; revision <= 4; revision++) {
    index = retain(index, entry(revision, 1000), { count: 100, bytes: 2500 }).index;
  }
  // Two entries fit (2000 bytes); three do not (3000). Trimmed by bytes against a count of 100
  // that is never approached, which is the point — only the byte ceiling can be what bites.
  assert.deepEqual(index.entries.map(e => e.revision), [3, 4]);
});

test('each dropped revision is counted once', () => {
  // The trim cursor re-read `entries[0]` each pass, so one revision went into `drop` twice:
  // its bytes were decremented twice, the loop stopped a revision early, and a path kept three
  // entries against a ceiling of two while reporting three dropped.
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3, 4]) index = retain(index, entry(revision), 2).index;
  assert.deepEqual(index.entries.map(e => e.revision), [3, 4], 'the ceiling is met exactly');
  assert.equal(index.trimmed, 2, 'and two entries really were dropped');
  assert.equal(new Set(index.entries.map(e => e.revision)).size, index.entries.length, 'no duplicate revisions kept');
});

test('the trim count accumulates rather than resetting', () => {
  // A caller asking about revision 1 must be able to tell "never existed" from "dropped". That
  // is only possible if the count is retained, exactly as `receiptsTrimmed` is.
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3, 4]) index = retain(index, entry(revision), 2).index;
  assert.equal(index.trimmed, 2, 'two revisions dropped across two writes');
});

// --- finding a base -------------------------------------------------------------

test('a base at the current revision is exact', () => {
  const index = retain({ entries: [], trimmed: 0 }, entry(3)).index;
  assert.equal(findBase(index, { wantedRevision: 3, currentRevision: 3 }).status, 'exact');
});

test('a retained older base is reported as older, not exact', () => {
  // The distinction is the whole point: "exact" means nothing moved and a merge is trivial.
  // Reporting "exact" for a stale base would merge against the wrong bytes.
  const index = retain({ entries: [], trimmed: 0 }, entry(1)).index;
  const found = findBase(retain(index, entry(2)).index, { wantedRevision: 1, currentRevision: 2 });
  assert.equal(found.status, 'older');
  assert.equal(found.base.revision, 1);
});

test('an evicted base is refused rather than substituted', () => {
  // The critical case. Returning the nearest retained revision would be a base the agent never
  // saw, merged in under its name. `evicted` forces the caller to say so.
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3]) index = retain(index, entry(revision), 2).index;

  const found = findBase(index, { wantedRevision: 1, currentRevision: 3 });
  assert.equal(found.status, 'evicted');
  assert.equal(found.base, null, 'and no base is offered as a substitute');
  assert.equal(found.trimmed, 1, 'the caller is told history was dropped');
  assert.deepEqual(found.retained, [2, 3]);
});

test('an unknown base is unknown, not evicted', () => {
  // A participant with no base — a brand new file — is a different situation from one whose
  // base was trimmed. The first merges trivially; the second needs a human.
  assert.equal(findBase({ entries: [], trimmed: 0 }, { wantedRevision: null, currentRevision: 1 }).status, 'unknown');
  assert.equal(findBase({ entries: [], trimmed: 0 }, { wantedRevision: undefined, currentRevision: 1 }).status, 'unknown');
});

test('a base beyond the current revision is refused, not approximated', () => {
  // A participant claiming to have built on a future revision is confused, not stale. The
  // nearest retained revision is *below* what it asked for, and reporting that as its base is
  // the same substitution `evicted` exists to prevent — so there is no status that returns it.
  const index = retain({ entries: [], trimmed: 0 }, entry(2)).index;
  const found = findBase(index, { wantedRevision: 5, currentRevision: 2 });
  assert.equal(found.status, 'evicted');
  assert.equal(found.base, null, 'and nothing is offered in its place');
  assert.deepEqual(found.retained, [2], 'the caller is told what is actually there');
});

test('a trimmed base is never silently replaced by a nearby one', () => {
  // The case this module exists to get right. The nearest retained revision is a plausible
  // looking substitute and is *not* what the participant saw; merging against it lands a file
  // under an agent's name that it never wrote.
  let index = { entries: [], trimmed: 0 };
  for (const revision of [1, 2, 3, 4]) index = retain(index, entry(revision), 2).index;

  const found = findBase(index, { wantedRevision: 1, currentRevision: 4 });
  assert.equal(found.status, 'evicted');
  assert.equal(found.base, null);
  assert.equal(found.trimmed, 2);
  assert.deepEqual(found.retained, [3, 4]);
});

// --- index parsing --------------------------------------------------------------

test('a malformed index is empty rather than trusted', () => {
  for (const junk of [null, undefined, 'content', 42, {}, { entries: 'no' }]) {
    assert.deepEqual(indexFrom(junk), { entries: [], trimmed: 0 }, `${JSON.stringify(junk)} must not be trusted`);
  }
});

test('entries without a usable revision are dropped, not guessed at', () => {
  // The same rule `allocateSlot` follows: inventing a revision number is how a merge ends up
  // running against content that was never written.
  const junk = { entries: [{ revision: 0 }, { revision: 1.5 }, { revision: 'two' }, null, entry(4)], trimmed: 0 };
  assert.deepEqual(indexFrom(junk).entries, [entry(4)]);
});

test('a non-array index is not iterated as one', () => {
  assert.deepEqual(indexFrom({ entries: { length: 2 } }).entries, []);
});

// --- the record -----------------------------------------------------------------

test('a record carries its revision and author, because the ledger will not', () => {
  // `author` is copied rather than looked up: once a path has been rewritten, the ledger's
  // `author` is the *latest* writer, and an old revision's author is not recoverable.
  const record = contentRecord({
    bytes: new Uint8Array([104, 105]),
    contentHash: 'abc',
    revision: 2,
    author: 'agent-1',
  });
  assert.equal(record.revision, 2);
  assert.equal(record.author, 'agent-1');
  assert.equal(record.contentBase64, 'aGk=');
});

test('a record without a valid revision is refused', () => {
  for (const revision of [0, -1, 1.5, 'two', null, undefined]) {
    assert.throws(
      () => contentRecord({ bytes: new Uint8Array([1]), contentHash: 'x', revision }),
      TypeError,
      `revision ${String(revision)} must be refused`,
    );
  }
});

// --- configuration --------------------------------------------------------------

test('the default window is more than one revision', () => {
  // One revision is the behaviour this replaces. A window of one cannot support a merge, which
  // needs the base and something after it.
  assert.ok(DEFAULT_MAX_REVISIONS_PER_PATH >= 2);
});

test('bounds are read from the environment', () => {
  assert.equal(retentionFromEnv({}).count, DEFAULT_MAX_REVISIONS_PER_PATH);
  assert.equal(retentionFromEnv({ INGRESS_MAX_REVISIONS_PER_PATH: '9' }).count, 9);
});

test('a nonsense bound falls back rather than disabling history or unbounding it', () => {
  // Zero would make a merge impossible and Infinity would make it unbounded — the failure this
  // exists to prevent. Neither is a thing an operator meant to type.
  for (const bad of ['0', '-2', 'lots', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      retentionFromEnv({ INGRESS_MAX_REVISIONS_PER_PATH: bad }).count,
      DEFAULT_MAX_REVISIONS_PER_PATH,
      `${String(bad)} should fall back`,
    );
  }
});

test('a fractional bound is floored', () => {
  assert.equal(retentionFromEnv({ INGRESS_MAX_REVISIONS_PER_PATH: '3.9' }).count, 3);
});

// --- the invariant --------------------------------------------------------------

test('a path always retains its current revision', () => {
  // The single property every other rule serves. Asserted across a long run rather than one
  // case, because the failure is a boundary: a ceiling exactly at the count, exactly at the
  // bytes, and one over both.
  let index = { entries: [], trimmed: 0 };
  let revision = 0;
  for (const byteLength of [10, 900_000, 10, 900_000, 900_000, 1_500_000]) {
    revision += 1;
    index = retain(index, entry(revision, byteLength), 3).index;
    assert.ok(
      holdsCurrent(index, revision),
      `revision ${revision} at ${byteLength} bytes must be retained`,
    );
  }
});