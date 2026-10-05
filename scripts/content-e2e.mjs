/**
 * Content-per-revision: does the base a participant built on survive?
 *
 * Why this exists
 *
 * `contentKey(path)` held one version per path, overwritten on every commit. So by the time the
 * second agent commits a file the first one has already rewritten, the bytes the second agent
 * was handed are gone, and a 3-way merge has no base. The only remaining answer is a refusal —
 * which is correct for one agent doing one thing and is precisely the wrong answer for fifty
 * agents on one repository.
 *
 * This script checks the prerequisite, not the merge. Merging is a separate decision with its own
 * failure modes, and a line-based merge that is wrong lands a file nobody wrote. What is claimed
 * here is narrower and checkable:
 *
 *   1. A revision's content is still there after later revisions land.
 *   2. The retention index says which, and reports what it dropped.
 *   3. A trimmed base is refused rather than approximated.
 *   4. Nothing existing changed: the seed, `/content` and `retrieve` serve the latest bytes.
 *
 * The one that matters is (1). Without it every refusal is unavoidable.
 */

import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('content');
const { post, get } = client(WORKSPACE);

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const results = [];
const expect = (label, value) => results.push(ok(label, value));

const PATH = 'engine.mjs';

/**
 * The content one revision of `engine.mjs` holds.
 *
 * A function rather than an inline template, so the assertions below can name the exact text
 * they expect. The first version of this script asserted on `version: one` while the writer
 * emitted `version = "one"`, and three checks failed against correct product behaviour — the
 * strings had drifted apart in two places in the same file.
 */
const revisionText = text => `// revision: ${text}\nexport const version = '${text}';\n`;
const marker = text => `version = '${text}'`;

/**
 * Write one revision of `engine.mjs` as `author`, declaring it was built from nothing.
 *
 * `builtFrom: []` scopes the dependency check to this file, so a rewrite is refused for its own
 * sake or admitted for its own sake and not because of an unrelated participant-wide
 * declaration. Without it the coarse check applies and this says nothing about content.
 */
const rewriting = async (author, text, otherFile) => {
  const files = [await entry(PATH, revisionText(text))];
  if (otherFile) {
    files.push(await entry(otherFile, `// side change by ${author}\nexport const who = '${author}';\n`));
  }
  // The heredoc terminator must start a line. Each file's content ends in a newline, so the
  // terminator lands at column zero — appending it directly to the content relies on that.
  const payloads = files
    .map(file => `cat > /workspace/${file.path} <<'INGRESS_EOF'\n${Buffer.from(file.contentBase64, 'base64').toString('utf8')}INGRESS_EOF`)
    .join('\n');
  const builtFrom = JSON.stringify(Object.fromEntries(files.map(file => [file.path, []])));

  return post('/start', {
    participantId: author,
    kind: 'agent',
    writePaths: files.map(file => file.path),
    runMs: 60_000,
    participantCommand: [
      'mkdir -p /workspace/.ingress',
      "cat > /workspace/.ingress/built-from.json <<'INGRESS_BF'",
      builtFrom,
      'INGRESS_BF',
      payloads,
    ].join('\n'),
  });
};

console.log(`workspace: ${WORKSPACE}`);
console.log(`path under test: ${PATH}`);

step('0. bootstrap');
const created = await post('/bootstrap', {
  author: 'creator',
  // Through `revisionText`, not an inline literal. This line was the one place bootstrap content
  // was written out by hand, with double quotes where every other revision uses single ones — so
  // `marker('one')` did not match revision 1 and the check failed against a base that was
  // present and correct. Two of the five failures in the previous run were this same drift.
  files: [await entry(PATH, revisionText('one'))],
});
expect('the workspace is bootstrapped', created.status === 200,
  `got ${created.status} ${created.body.reason ?? ''}`);

step('1. revision 1 exists and is retained');
const first = await get(`/content?path=${encodeURIComponent(PATH)}`);
console.log(`  r${first.body.revision} retained: ${JSON.stringify(first.body.retained)} trimmed: ${first.body.trimmed}`);
expect('the path has a revision', first.body.revision === 1);
expect('and revision 1 is retained', first.body.retained?.includes(1));

step('2. two more agents rewrite it, one after the other');
// Sequential on purpose. The point of this leg is that the *base survives*, not that writes
// interleave — concurrency is `e2e:concurrency`'s claim and would confound this one.
const second = await rewriting('agent-2', 'two');
expect("agent-2's rewrite is admitted", second.status === 200 && second.body.commit?.admitted === true,
  `got ${second.status} ${second.body.reason ?? ''}`);

const third = await rewriting('agent-3', 'three');
expect("agent-3's rewrite is admitted", third.status === 200 && third.body.commit?.admitted === true,
  `got ${third.status} ${third.body.reason ?? ''}`);

step('3. the base is still there — this is the claim');
const now = await get(`/content?path=${encodeURIComponent(PATH)}`);
console.log(`  r${now.body.revision} retained: ${JSON.stringify(now.body.retained)} trimmed: ${now.body.trimmed}`);

expect('the path is at revision 3', now.body.revision === 3, `revision is ${now.body.revision}`);
expect('revisions 1 and 2 are both still retained',
  now.body.retained?.includes(1) && now.body.retained?.includes(2),
  `retained ${JSON.stringify(now.body.retained)}`);

// The actual test of the prerequisite: revision 1's *bytes* are still retrievable, not merely
// listed. Before this change the index could say 1 and the content be gone, which is the state
// that makes a merge run against nothing while reporting success.
const base = await get(`/content?path=${encodeURIComponent(PATH)}&revision=1`);
console.log('  r1 says:', base.status === 200 ? 'retrievable' : `HTTP ${base.status}`);
expect('revision 1 content is retrievable', base.status === 200,
  `got ${base.status} ${base.body.error ?? ''}`);
expect('and it is the original content, not the current one',
  Buffer.from(base.body.contentBase64 ?? '', 'base64').toString('utf8').includes(marker('one')),
  'the base must be what agent-2 and agent-3 actually started from');
expect('and it differs from the current content',
  base.body.contentHash !== now.body.contentHash,
  'if these matched, no rewrite happened and nothing was proven');

step('4. the latest content is still served, unchanged');
expect('/content serves the current revision',
  Boolean(now.body.contentHash)
  && Buffer.from(now.body.contentBase64, 'base64').toString('utf8').includes(marker('three')),
  'this is the read path existing code depends on, and it must not have moved');
expect('and its author is recorded',
  now.body.author === 'agent-3',
  `author is ${now.body.author}`);

step('5. a lease hands over the current bytes, not a retained old one');
const holder = await get('/join?name=reader&kind=agent&dependencies=');
expect('a reader joins', holder.status === 200);

// A participant arriving now must be handed the *current* bytes. If the retention work had
// shadowed the current key with history, every agent would be seeded from a stale tree — which
// would look like the fence working while silently judging every change against the wrong base.
const lease = await post('/lease/checkout', { participantId: 'reader', paths: [PATH], mode: 'write' });
expect('the reader takes a write lease', lease.status === 200, `got ${lease.status} ${lease.body.reason ?? ''}`);
const handed = lease.body.files?.find(file => file.path === PATH);
expect('and is handed the current content',
  Boolean(handed?.contentBase64)
  && Buffer.from(handed.contentBase64, 'base64').toString('utf8').includes(marker('three')),
  'the lease hands over current bytes; handing over a retained old revision would seed agents from history');

// Released before step 6, which writes the same path. Without this the next start is refused
// `lease_conflict` — correct product behaviour, and it hid step 6's real assertion behind a
// failure about the step before it.
const released = await post('/lease/release', { participantId: 'reader', leaseId: lease.body.leaseId });
expect('and hands it back', released.status === 200);

step('6. an unrelated path is unaffected');
const side = await rewriting('agent-4', 'side', 'notes.md');
expect('a commit touching another path is admitted', side.status === 200 && side.body.commit?.admitted === true,
  `got ${side.status} ${side.body.reason ?? ''} ${JSON.stringify(side.body.commit?.refusals ?? '')}`);
const notes = await get('/content?path=notes.md');
expect('the other path reports its own single revision',
  notes.status === 200 && notes.body.retained?.length === 1,
  `retained ${JSON.stringify(notes.body.retained)}`);

finish(
  results,
  passed => passed
    ? 'THE BASE SURVIVED EVERY REWRITE — A MERGE IS NOW POSSIBLE'
    : 'THE BASE DID NOT SURVIVE — MERGE IS STILL IMPOSSIBLE',
);