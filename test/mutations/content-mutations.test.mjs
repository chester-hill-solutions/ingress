/**
 * Mutations against the content retention policy.
 *
 * The method this project uses: a guard is only worth having if a deliberately broken copy of
 * the code fails it. Retention bugs are the quiet kind — nothing throws, `/content` still serves
 * the current revision, and the only symptom is a merge months later reporting a base that is
 * not there. So each mutation below breaks one rule and asserts something notices.
 *
 * In-process, by importing the mutated module and running the assertions against it — the shape
 * `router-auth-mutations.test.mjs` uses. A subprocess was tried first and was wrong: it asserted
 * on the child's exit status, and `node --test` exits 0 even when tests fail, so **every**
 * mutation appeared to survive. A mutation harness that cannot fail is worse than none, because
 * it reports thirteen guards that do not guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

// Two levels up: this file is in `test/mutations/`, so `../src` would resolve to `test/src`.
const MODULE = fileURLToPath(new URL('../../src/product/content.mjs', import.meta.url));
const original = readFileSync(MODULE, 'utf8');

/** Import a revision of the module fresh, bypassing the ESM cache. */
async function loadMutated(source) {
  const url = `${pathToFileURL(MODULE).href}?mutation=${Math.random()}`;
  const previous = readFileSync(MODULE, 'utf8');
  writeFileSync(MODULE, source);
  try {
    return await import(url);
  } finally {
    writeFileSync(MODULE, previous);
  }
}

/**
 * The properties that must hold after any mutation.
 *
 * Written as behaviour rather than by importing the test suite, because the suite's `test()`
 * calls register with the runner and cannot be awaited as a function. Each one is a plain
 * assertion so a mutation fails loudly at the point it breaks something.
 */
const ASSERTIONS = [
  {
    // The cursor bug needs an index that **already holds several entries**, because the cursor
    // only differs once the loop has run twice. Building that by writing revisions one at a
    // time does not do it: each call sees one prior entry, trims once, and never loops — which
    // is why three earlier attempts at this assertion passed against the broken code.
    //
    // Seeded directly, with the oldest far larger than the rest. Correct needs three drops; the
    // bug counts the same revision twice, satisfies the ceiling early, and stops at two — so it
    // drops two revisions and then `slice(2)` removes a *third* from the kept set, which is a
    // different set again.
    name: 'a multi-entry index trims to the ceiling, not one revision short',
    run(content) {
      const seeded = {
        entries: [
          { revision: 1, byteLength: 1000 },
          { revision: 2, byteLength: 10 },
          { revision: 3, byteLength: 10 },
          { revision: 4, byteLength: 10 },
          { revision: 5, byteLength: 10 },
        ],
        trimmed: 0,
      };
      const { index, drop } = content.retain(seeded, { revision: 6, byteLength: 10 }, { count: 100, bytes: 25 });
      const bytes = index.entries.reduce((total, entry) => total + entry.byteLength, 0);
      assert.deepEqual(drop, [1, 2, 3, 4], 'four drops, in order and without repeats');
      assert.deepEqual(index.entries.map(e => e.revision), [5, 6]);
      assert.ok(bytes <= 25, `kept ${bytes} bytes against a 25 ceiling`);
      assert.equal(index.trimmed, 4);
    },
  },
  {
    // The cursor bug only shows up when the *byte* ceiling needs two drops, because the
    // duplicate is invisible to `slice` and the count to `trimmed`. Here revision 1 is counted
    // against the byte total twice, so the loop stops one revision early and leaves 2 KiB
    // against a 1.5 KiB ceiling.
    name: 'the byte ceiling is met exactly when it needs two drops',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      for (const revision of [1, 2, 3]) {
        index = content.retain(index, { revision, byteLength: 1000 }, { count: 100, bytes: 1500 }).index;
      }
      const bytes = index.entries.reduce((total, entry) => total + entry.byteLength, 0);
      assert.deepEqual(index.entries.map(e => e.revision), [3], 'only the newest fits');
      assert.ok(bytes <= 1500, `kept ${bytes} bytes against a 1500 ceiling`);
    },
  },
  {
    // The floor of one entry. With a ceiling below a single revision there is nothing to keep
    // instead, and dropping the newest would answer `/content` and the seed with nothing for a
    // path that exists.
    name: 'a single revision survives a ceiling it cannot fit',
    run(content) {
      const { index } = content.retain({ entries: [], trimmed: 0 },
        { revision: 1, byteLength: 10 }, { count: 100, bytes: 1 });
      assert.deepEqual(index.entries.map(e => e.revision), [1]);
    },
  },
  {
    name: 'a count ceiling is honoured',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      for (const revision of [1, 2, 3, 4]) {
        index = content.retain(index, { revision, byteLength: 10 }, 2).index;
      }
      assert.deepEqual(index.entries.map(e => e.revision), [3, 4]);
    },
  },
  {
    name: 'the current revision always survives',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      for (const [revision, byteLength] of [[1, 10], [2, 900_000], [3, 900_000], [4, 1_500_000]]) {
        index = content.retain(index, { revision, byteLength }, 3).index;
        assert.ok(content.holdsCurrent(index, revision), `revision ${revision} was dropped`);
      }
    },
  },
  {
    name: 'an unsorted index still keeps the newest',
    run(content) {
      const { index } = content.retain({ entries: [{ revision: 3 }, { revision: 1 }, { revision: 2 }], trimmed: 0 },
        { revision: 4, byteLength: 10 }, 2);
      assert.deepEqual(index.entries.map(e => e.revision), [3, 4]);
    },
  },
  {
    name: 'the trim count is accurate',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      for (const revision of [1, 2, 3, 4]) index = content.retain(index, { revision, byteLength: 10 }, 2).index;
      assert.equal(index.trimmed, 2);
      assert.equal(new Set(index.entries.map(e => e.revision)).size, index.entries.length);
    },
  },
  {
    name: 'an evicted base is not substituted',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      for (const revision of [1, 2, 3, 4]) index = content.retain(index, { revision, byteLength: 10 }, 2).index;
      const found = content.findBase(index, { wantedRevision: 1, currentRevision: 4 });
      assert.equal(found.status, 'evicted');
      assert.equal(found.base, null, 'a nearby revision was offered as the base');
    },
  },
  {
    name: 'a stale base is not reported as exact',
    run(content) {
      let index = { entries: [], trimmed: 0 };
      index = content.retain(index, { revision: 1, byteLength: 10 }, 5).index;
      index = content.retain(index, { revision: 2, byteLength: 10 }, 5).index;
      const found = content.findBase(index, { wantedRevision: 1, currentRevision: 2 });
      assert.equal(found.status, 'older');
      assert.equal(found.base.revision, 1);
    },
  },
  {
    name: 'a malformed index is not trusted',
    run(content) {
      assert.deepEqual(content.indexFrom({ entries: [{ revision: 0 }, { revision: 'two' }, null] }),
        { entries: [], trimmed: 0 });
    },
  },
  {
    name: 'a malformed record revision is refused',
    run(content) {
      assert.throws(() => content.contentRecord({ bytes: new Uint8Array([1]), contentHash: 'x', revision: 0 }), TypeError);
    },
  },
  {
    name: 'a duplicate revision is not appended',
    run(content) {
      const first = content.retain({ entries: [], trimmed: 0 }, { revision: 1, byteLength: 10 }, 5);
      const again = content.retain(first.index, { revision: 1, byteLength: 10 }, 5);
      assert.deepEqual(again.index.entries.map(e => e.revision), [1]);
    },
  },
  {
    name: 'a nonsense bound falls back rather than disabling history',
    run(content) {
      assert.equal(content.retentionFromEnv({ INGRESS_MAX_REVISIONS_PER_PATH: '0' }).count,
        content.DEFAULT_MAX_REVISIONS_PER_PATH);
      assert.equal(content.retentionFromEnv({ INGRESS_MAX_REVISIONS_PER_PATH: 'lots' }).count,
        content.DEFAULT_MAX_REVISIONS_PER_PATH);
    },
  },
];

const MUTATIONS = [
  {
    // The whole ternary, not just its condition. Replacing only the condition leaves
    // `(Infinity ? bounds.bytes : DEFAULT)`, which evaluates to `bounds.bytes` — the original
    // value. The mutation survives because it is not a mutation, and a harness that reports
    // "caught" for a no-op edit is lying in the safe direction.
    name: 'the byte ceiling is ignored, so history grows unbounded',
    transform: source => source.replace(
      `const maxBytes = Number.isFinite(bounds.bytes) && bounds.bytes > 0
    ? bounds.bytes
    : DEFAULT_MAX_HISTORY_BYTES;`,
      'const maxBytes = Number.POSITIVE_INFINITY; // mutated',
    ),
  },
  {
    name: 'the count ceiling is ignored',
    transform: source => source.replace(
      `const maxCount = Number.isInteger(bounds.count) && bounds.count > 0
    ? bounds.count
    : DEFAULT_MAX_REVISIONS_PER_PATH;`,
      'const maxCount = Number.POSITIVE_INFINITY; // mutated',
    ),
  },
  {
    name: 'a nonsense count bound disables history instead of falling back',
    transform: source => source.replace(
      `  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;`,
      `  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0; // mutated`,
    ),
  },
  {
    name: 'the trim cursor re-reads the front, so one revision is dropped twice',
    transform: source => source.replace(
      'const oldest = entries[drop.length];',
      'const oldest = entries[0]; // mutated',
    ),
  },
  {
    name: 'the trim keeps the oldest instead of the newest',
    transform: source => source.replace(
      'index: { entries: entries.slice(drop.length), trimmed: index.trimmed + drop.length },',
      'index: { entries: entries.slice(0, drop.length), trimmed: index.trimmed + drop.length }, // mutated',
    ),
  },
  {
    name: 'the current revision is trimmed along with the rest',
    transform: source => source.replace(
      'while (kept > 1 && (kept > maxCount || bytes > maxBytes)) {',
      'while (kept > 0 && (kept > maxCount || bytes > maxBytes)) { // mutated',
    ),
  },
  {
    name: 'the trim count is not accumulated',
    transform: source => source.replace(
      'trimmed: index.trimmed + drop.length },',
      'trimmed: 0 }, // mutated',
    ),
  },
  {
    name: 'an evicted base is silently replaced by the nearest retained revision',
    transform: source => source.replace(
      `  return {
    status: 'evicted',
    base: null,
    trimmed: index.trimmed,
    retained: index.entries.map(entry => entry.revision),
  };`,
      `  // mutated
  const nearest = index.entries[index.entries.length - 1];
  if (nearest) return { status: 'evicted', base: nearest, trimmed: index.trimmed, retained: [] };
  return { status: 'evicted', base: null, trimmed: index.trimmed, retained: [] };`,
    ),
  },
  {
    name: 'a stale base is reported as exact, so a merge would run against the wrong bytes',
    transform: source => source.replace(
      "status: held.revision === currentRevision ? 'exact' : 'older',",
      "status: 'exact', // mutated",
    ),
  },
  {
    name: 'an unparseable index is trusted rather than emptied',
    transform: source => source.replace(
      '.filter(entry => entry && Number.isSafeInteger(entry.revision) && entry.revision >= 1)',
      '.filter(entry => entry) // mutated',
    ),
  },
  {
    name: 'a malformed record revision is accepted',
    transform: source => source.replace(
      `  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('contentRecord requires a positive integer revision');
  }`,
      "  if (false) throw new TypeError('unreachable'); // mutated",
    ),
  },
  {
    name: 'a duplicate revision is appended twice',
    transform: source => source.replace(
      'if (index.entries.some(entry => entry.revision === revision)) {',
      'if (false) { // mutated',
    ),
  },
  {
    name: 'the index is not sorted, so the trim drops the wrong end',
    transform: source => source.replace(
      'entries.sort((left, right) => left.revision - right.revision);',
      '// mutated: no sort',
    ),
  },
  {
    name: 'a nonsense bound disables history instead of falling back',
    transform: source => source.replace(
      `  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;`,
      `  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0; // mutated`,
    ),
  },
];

test('the unmutated module satisfies every assertion', async t => {
  const content = await import(pathToFileURL(MODULE).href);
  for (const assertion of ASSERTIONS) {
    await t.test(assertion.name, () => assertion.run(content));
  }
});

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async () => {
    const mutated = mutation.transform(original);
    assert.notEqual(mutated, original, 'the mutation changed nothing, so it would pass for the wrong reason');

    const content = await loadMutated(mutated);
    let caught = false;
    let firstFailure = null;
    for (const assertion of ASSERTIONS) {
      try {
        assertion.run(content);
      } catch (error) {
        caught = true;
        firstFailure ??= `${assertion.name}: ${error.message.split('\n')[0]}`;
      }
    }
    assert.ok(caught, `the mutation survived: ${mutation.name}`);
    // Not asserted on, only reported — which assertion tripped first is diagnostic detail, and
    // asserting on it would make the harness brittle to reordering.
    if (process.env.INGRESS_MUTATION_VERBOSE) console.log(`    caught by ${firstFailure}`);
  });
}