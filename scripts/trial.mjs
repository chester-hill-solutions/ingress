/**
 * Trial: is the fence load-bearing, or is concurrency bought at no benefit?
 *
 * Why this exists
 *
 * Everything verified so far measures the fence against its own specification: it admits what
 * it should, refuses what it should. None of it measures whether the fence makes anything
 * *better*, which is the only question worth asking before building a merge on top of it.
 *
 * A separate measurement already settled part of this: a participant cannot reach a model API.
 * Every outbound request is intercepted into the gate, which answers 409 for anything that is
 * not a workspace route, and `enableInternet` is false. So there is no agent inside the
 * container and the product's stated purpose is not reachable as deployed. That is a fact about
 * the deployment, not an opinion about the design, and it is why this trial measures the
 * substrate rather than agent output.
 *
 * Three runs, same workload, and the comparison is the whole point:
 *
 *   CONCURRENT / disjoint   six agents, each writing only its own file
 *   SERIAL     / disjoint   the same six, one at a time
 *   CONCURRENT / shared     six agents, each also editing the SAME shared file, at a distinct
 *                           anchor line
 *
 * What each comparison answers:
 *
 *   concurrent/disjoint vs serial/disjoint
 *     Does the concurrency actually buy wall-clock? If the two are close, the fence is
 *     serialising everything and "concurrency" is a word rather than a property.
 *
 *   concurrent/shared vs concurrent/disjoint
 *     What does one shared file cost? Every refusal here is a change that was correct, was
 *     never in conflict with anything, and did not land. That number is the upper bound on
 *     what a merge could recover — which is the number a merge should be justified by.
 *
 * The shared-file edits are deliberately **disjoint**: each agent inserts at its own anchor
 * line, so no two touch the same line. Git would merge all six without a conflict. If the
 * product refuses them anyway, that is the fence refusing a merge that was free — which is the
 * argument for building the merge, measured rather than asserted.
 *
 * Honesty about what this cannot conclude: the agents are scripted, not models. So this
 * measures the *substrate's* behaviour under contention, not the quality of agent work. It can
 * tell you whether the fence costs throughput and refusals; it cannot tell you whether the
 * output is good.
 */

import { client, freshWorkspace, step, finish } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const SHARED = 'contract.mjs';
const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('trial');
const { post, get } = client(WORKSPACE);

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

/** One anchor line per agent, so every edit to the shared file is at a distinct place. */
const anchors = AGENTS.map(name => `// SLOT ${name}`);

/**
 * The shared file: six marked slots and nothing else.
 *
 * Kept trivially small so the measurement is about the fence and not about how hard the merge
 * problem is. A larger, more realistic file would be a better merge test and a worse
 * contention test.
 */
const sharedFile = () => [
  'export const registry = {',
  ...anchors.map(anchor => `  ${anchor}`),
  '};',
  '',
].join('\n');

/** The agent's own file. Unique per agent, so these can never collide. */
const ownFile = name => `src/${name}.mjs`;

/**
 * One agent's command.
 *
 * Writes its own file always. Writes the shared file only when `touchShared`, inserting at its
 * own anchor — a genuinely disjoint edit, by construction rather than by hope.
 *
 * `sed` is used because a whole-file rewrite would make every shared write identical and the
 * test would degenerate into `no_change`.
 */
const command = (name, touchShared) => [
  'mkdir -p /workspace/.ingress src',
  "cat > /workspace/.ingress/built-from.json <<'INGRESS_BF'",
  JSON.stringify(Object.fromEntries([
    [ownFile(name), []],
    ...(touchShared ? [[SHARED, []]] : []),
  ])),
  'INGRESS_BF',
  `cat > /workspace/${ownFile(name)} <<'INGRESS_EOF'`,
  `export const name = '${name}';`,
  'INGRESS_EOF',
  ...(touchShared ? [
    // Insert immediately after this agent's anchor. `sed -i` with a unique anchor is atomic
    // enough for a single short line, and — more to the point — it does not read-modify-write
    // the whole file, so two agents inserting at different anchors cannot lose each other's
    // line even if they were allowed to run at once.
    `sed -i '/\\/\\/ SLOT ${name}/a \\\\  "${name}": () => "${name}",' /workspace/${SHARED}`,
  ] : []),
  'sleep 20',
].join('\n');

/** Everything one agent writes, for the lease and the manifest. */
const writePaths = (name, touchShared) => [
  ownFile(name),
  ...(touchShared ? [SHARED] : []),
];

const start = (name, touchShared) => post('/start', {
  participantId: name,
  kind: 'agent',
  writePaths: writePaths(name, touchShared),
  runMs: 120_000,
  participantCommand: command(name, touchShared),
});

const summarise = results => ({
  admitted: results.filter(r => r.body.commit?.admitted === true).length,
  refused: results.filter(r => r.status !== 200).map(r => ({ reason: r.body.reason, detail: r.body.detail })),
  unchanged: results.filter(r => r.status === 200 && r.body.commit?.unchanged?.length).length,
  seconds: Math.round(results.elapsedMs / 1000),
});

const report = (label, results) => {
  const s = summarise(results);
  console.log(`\n${label}`);
  console.log(`  admitted: ${s.admitted}/${AGENTS.length}`);
  console.log(`  seconds:  ${s.seconds}`);
  if (s.refused.length) {
    const byReason = s.refused.reduce((counts, r) => ({ ...counts, [r.reason ?? 'unknown']: (counts[r.reason ?? 'unknown'] ?? 0) + 1 }), {});
    console.log(`  refused:  ${JSON.stringify(byReason)}`);
  }
  return s;
};

const results = [];
const check = (label, value, note = '') => {
  results.push({ label, pass: Boolean(value), note });
  console.log(`  ${value ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
};

console.log(`workspace: ${WORKSPACE}`);
console.log(`agents: ${AGENTS.length}, each command sleeps 20s`);

step('0. bootstrap the shared file and every participant');
await post('/bootstrap', { author: 'creator', files: [await entry(SHARED, sharedFile())] });
for (const name of AGENTS) await get(`/join?name=${name}&kind=agent&dependencies=`);
console.log(`  shared file has ${anchors.length} distinct anchor lines`);

// --- run 1: concurrent, disjoint ------------------------------------------------
step('1. CONCURRENT / disjoint — six agents, none touching the shared file');
const disjointStarted = Date.now();
const disjoint = await Promise.all(AGENTS.map(async name => {
  const response = await start(name, false);
  return { name, ...response };
}));
disjoint.elapsedMs = Date.now() - disjointStarted;
const disjointSummary = report('concurrent / disjoint:', disjoint);
const serialCeiling = AGENTS.length * 20;

// --- run 2: serial, disjoint ----------------------------------------------------
step('2. SERIAL / disjoint — the same six, one at a time');
const serialStarted = Date.now();
const serial = [];
for (const name of AGENTS) serial.push({ name, ...(await start(name, false)) });
serial.elapsedMs = Date.now() - serialStarted;
const serialSummary = report('serial / disjoint:', serial);

step('3. does the concurrency actually buy wall-clock?');
// Concurrency is demonstrated by the elapsed time being near ONE command's duration rather
// than the sum. The bar is deliberately loose: container boot and the seed round trip are
// serial per agent and dominate nothing here, but they are not zero.
check(
  `concurrent/disjoint finished in about one command's time, not six`,
  disjointSummary.seconds < serialSummary.seconds / 3,
  `${disjointSummary.seconds}s concurrent vs ${serialSummary.seconds}s serial, ceiling ${serialCeiling}s`,
);
check('and every agent landed', disjointSummary.admitted === AGENTS.length,
  `${disjointSummary.admitted} of ${AGENTS.length}`);

// --- run 3: concurrent, shared --------------------------------------------------
step('4. CONCURRENT / shared — each agent also inserts at its own anchor line');
const sharedStarted = Date.now();
const shared = await Promise.all(AGENTS.map(async name => {
  const response = await start(name, true);
  return { name, ...response };
}));
shared.elapsedMs = Date.now() - sharedStarted;
const sharedSummary = report('concurrent / shared:', shared);

step('5. does one shared file still cost anything, now that a moved base is merged?');
const lost = AGENTS.length - sharedSummary.admitted;
// Before the merge this read `lost > 0`: five of six were refused at `/start` and the file
// carried one edit. The merge is what this line now tests.
check('every disjoint edit to the shared file landed', lost === 0,
  `${sharedSummary.admitted} of ${AGENTS.length} admitted, ${lost} lost`);

const ledger = await get('/state');
const sharedRecord = ledger.body.files.find(f => f.path === SHARED);
const merged = await get(`/content?path=${encodeURIComponent(SHARED)}`);
const text = merged.status === 200 ? Buffer.from(merged.body.contentBase64, 'base64').toString() : '';
const present = AGENTS.filter(name => text.includes(`"${name}":`));

console.log(`\n  ${SHARED} is at r${sharedRecord?.revision}, written by ${sharedRecord?.author}`);
console.log(`  ${present.length} of ${AGENTS.length} edits are present: ${present.join(', ') || 'none'}`);

check('and the merged file carries all six edits', present.length === AGENTS.length,
  `${present.length} of ${AGENTS.length}`);

check('every refusal names a conflict rather than a crash',
  sharedSummary.refused.every(r => ['lease_conflict', 'too_many_concurrent_starts'].includes(r.reason)),
  `reasons: ${[...new Set(sharedSummary.refused.map(r => r.reason))].join(', ') || 'none'}`);

const usage = await get('/usage');
const merges = usage.body.mergesAdmitted ?? 0;
// The first writer lands without a merge; each of the rest reconciles a base that moved.
check('the landings after the first were merges, not overwrites', merges >= AGENTS.length - 1,
  `${merges} merge(s) admitted`);

step('6. the number the merge was justified by');
console.log(`
  Six agents made six disjoint edits to one file.
  Before the merge: 1 of 6 landed; 5 refused at \`/start\` with \`lease_conflict\`.
  Now: ${present.length} of 6 landed, ${merges} of them by merging a base that moved.
`);

finish(
  results,
  passed => passed
    ? 'CONCURRENCY IS REAL AND THE SHARED FILE IS WHERE IT IS LOST'
    : 'THE FENCE DID NOT BEHAVE AS THE TRIAL ASSUMED — READ THE NUMBERS',
);