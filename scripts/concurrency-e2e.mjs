/**
 * Concurrency: do N participants actually run at the same time?
 *
 * Why this exists
 *
 * `ctx.container` is one container per Durable Object, so a workspace could only ever run one
 * participant — while the product's own documented scenario is "an agent builds while a human
 * edits the dependency it reads". Every cap, every lease and every fence was designed for
 * participants that overlap, and none of it could be exercised.
 *
 * The fix splits the two roles that were fighting over one object. The **workspace** object is
 * the arbiter: it holds the ledger, the leases, the tokens and the usage counters, and it
 * makes every decision. An **executor** object owns exactly one container and makes none. So
 * the fence keeps its single-turn decision in one place, and a workspace runs as many
 * containers as it has executor slots.
 *
 * What this script has to distinguish, because they are different claims:
 *
 *   CAPACITY   four starts succeed against a cap of four. Proves slots are allocated.
 *   OVERLAP    four 30-second commands finish in about 30 seconds, not 120. Proves they ran
 *              at the same time. Capacity alone does not show this — four instant commands
 *              finish just as fast whether they overlapped or ran in sequence.
 *
 * An earlier version of this check printed "each with a 60s sleep" while the commands
 * contained no sleep at all, and reported the result as a pass. The log line was the only
 * thing claiming concurrency, and it was false. The sleep is now in the command and the
 * elapsed time is asserted against the sequential bound.
 *
 * Nothing simulated. Real containers, real gate, real fence.
 */

import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('conc');
const { post, get } = client(WORKSPACE);

/** How many agents to try to run at once. One more than the cap, deliberately. */
const AGENTS = ['a', 'b', 'c', 'd', 'e'];

/** How long each command takes. Long enough that sequencing would be unmistakable. */
const SLEEP_SECONDS = 30;

const CAP = 4;

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const results = [];
const expect = (label, value) => results.push(ok(label, value));

/**
 * Write one file, and declare that it was built from nothing.
 *
 * `builtFrom: []` so each agent is scoped out of the dependency check — without it they fall
 * back to the participant-wide list, which is correct and would not demonstrate anything here.
 */
const writing = path => [
  'mkdir -p /workspace/.ingress',
  "cat > /workspace/.ingress/built-from.json <<'INGRESS_BF'",
  JSON.stringify({ [path]: [] }),
  'INGRESS_BF',
  `sleep ${SLEEP_SECONDS}`,
  `cat > /workspace/${path} <<'INGRESS_EOF'`,
  `export const who = '${path}';`,
  'INGRESS_EOF',
].join('\n');

const join = name => get(`/join?name=${name}&kind=agent&dependencies=`);

console.log(`workspace: ${WORKSPACE}`);
console.log(`cap: ${CAP} executors · ${AGENTS.length} agents · each command sleeps ${SLEEP_SECONDS}s`);

// Sequential would be AGENTS.length * SLEEP_SECONDS. Anything near that means they queued.
const SEQUENTIAL_MS = AGENTS.length * SLEEP_SECONDS * 1000;

step(`0. bootstrap, and join ${AGENTS.length} participants`);
const created = await post('/bootstrap', {
  author: 'creator',
  files: [await entry('engine.mjs', 'export const version = 1;\n')],
});
expect('the workspace is bootstrapped', created.status === 200);
for (const name of AGENTS) await join(name);

step(`1. issue ${AGENTS.length} starts at once`);
const started = Date.now();
const settled = await Promise.all(AGENTS.map(async name => {
  const path = `from-${name}.mjs`;
  const response = await post('/start', {
    participantId: name,
    kind: 'agent',
    writePaths: [path],
    runMs: 120_000,
    participantCommand: writing(path),
  });
  return { name, path, status: response.status, body: response.body };
}));
const elapsed = Date.now() - started;

for (const r of settled) {
  console.log(`  ${r.name}: ${r.status} ${r.body.reason ?? `admitted=${r.body.commit?.admitted} exit=${r.body.commit?.participantExit}`}`);
}
console.log(`  settled in ${Math.round(elapsed / 1000)}s (sequential would be ${AGENTS.length * SLEEP_SECONDS}s)`);

const admitted = settled.filter(r => r.status === 200 && r.body.commit?.admitted === true);
const refused = settled.filter(r => r.status !== 200);

step('2. capacity: the cap is honoured, and the refusal says so');
expect(`exactly ${CAP} starts were admitted`, admitted.length === CAP);
expect(`the rest were refused, not silently dropped`, refused.length === AGENTS.length - CAP);
expect('and the refusal is a slot refusal', refused.every(r => r.body.reason === 'too_many_concurrent_starts'));
expect('naming the cap it hit', refused.every(r => r.body.cap === CAP),
  `cap reported as ${refused[0]?.body?.cap}`);

step('3. overlap: the admitted agents ran at the same time, not in sequence');
// The claim under test. Capacity alone does not show it: four instant commands settle just as
// fast whether they overlapped or queued.
const overhead = 25_000;                 // boot, seed, commit, report
expect(
  `${CAP} x ${SLEEP_SECONDS}s commands settled in ${Math.round(elapsed / 1000)}s, not ${AGENTS.length * SLEEP_SECONDS}s`,
  elapsed < SEQUENTIAL_MS * 0.6,
);
expect('and each individual run took about its own sleep, not the sum',
  elapsed >= SLEEP_SECONDS * 1000 && elapsed < SLEEP_SECONDS * 1000 + overhead * 2);

step('4. every admitted agent landed, and the ledger says who wrote what');
const state = await get('/state');
console.log('  ' + state.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
for (const r of admitted) {
  expect(`${r.name}'s file landed`, state.body.files.some(f => f.path === r.path && f.author === r.name));
}
expect('and the refused agent wrote nothing',
  !state.body.files.some(f => refused.some(r => f.path === r.path)),
  'a refused start must leave no trace');

step('5. the usage ceiling counted them, and the slots were all released');
// `.body`, because the client returns `{status, body}`. Reading `.starts` off the wrapper
// gives `undefined`, and a comparison against `undefined` passes for the wrong reason — which
// is exactly what it did on the previous two runs of this script.
const usage = (await get('/usage')).body;
console.log(`  starts: ${usage.starts} | ceiling: ${JSON.stringify(usage.ceiling)}`);

// Counted where it is, which is after the slot is allocated and after the ceiling passes — so
// a start refused for contention costs no quota at all. That is the intent: the counter exists
// to bound *container time*, and a refusal bought none.
//
// An earlier version of this check asserted the opposite (five attempts, five counted) and
// failed against correct behaviour. Worth stating rather than "fixing", because the two
// designs are genuinely different and the number itself does not say which one you have.
expect(`only starts that reached a slot are counted, so ${usage.starts} of ${AGENTS.length} attempts`,
  usage.starts === admitted.length,
  `counted ${usage.starts}, admitted ${admitted.length}`);
expect('and that is not the number of attempts received',
  usage.starts !== AGENTS.length,
  'a slot refusal is a decision, not a container — it must not be billed as one');
expect('run-seconds counts only the admitted ones', usage.runSecondsRequested === admitted.length * 120,
  `run-seconds counted ${usage.runSecondsRequested}, expected ${admitted.length} x 120`);

// Every slot must be free, or the workspace is wedged for the next swarm.
const second = await post('/start', {
  participantId: 'after',
  kind: 'agent',
  runMs: 60_000,
  participantCommand: 'true',
});
expect('a further start succeeds, so every slot was released',
  second.status === 200 && second.body.commit?.admitted === true,
  `got ${second.status} ${second.body.reason ?? ''}`);

finish(
  results,
  passed => passed
    ? `${CAP} PARTICIPANTS RAN CONCURRENTLY, THE CAP WAS ENFORCED, AND EVERY SLOT WAS RELEASED`
    : 'CONCURRENCY DID NOT HOLD',
);