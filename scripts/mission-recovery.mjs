/**
 * A long-horizon mission, run as real work in the product's containers, with recovery.
 *
 * What this is for
 *
 * The invalidation increment was qualified in a deterministic replay and then built into the
 * product: a published output records what it was built from, and the workspace reports the
 * outputs a later write contradicted. Neither half had been exercised on the deployed
 * surface, where the participant is a container command that declares its own provenance and
 * the fence arbitrates what lands.
 *
 * This runs that whole sequence end to end, twice, with nothing simulated:
 *
 *   1. three participants build a small project in real containers. Each declares, at
 *      publication, the revision of each input it was handed -- written to
 *      `.ingress/built-from.json`, which the launcher attaches to the manifest and which is
 *      ignored by the reporter, so a participant cannot smuggle it in as content.
 *   2. a fourth participant moves the shared input. Nothing about the three outputs changed;
 *      the workspace must now say they are no longer approved, including the one that is two
 *      hops out through the transitive closure.
 *   3. the harness reads that report, asks each owner to redo its output, and measures the
 *      tax: container starts, wall time, bytes, and how many of the regenerations produced
 *      the bytes that were already there.
 *   4. the input moves again, and the whole loop runs a second time. One round is a
 *      demonstration; the second is the one that shows the mechanism survives repetition,
 *      which is what a long horizon means.
 *
 * What it measures, and what it does not
 *
 * The tax here is **container time and bytes**, because every participant is a deterministic
 * command. The campaign's other unit -- model cost -- needs model-driven participants, and
 * `src/mission-recovery.mjs` reports the two units separately for exactly that reason. This
 * run does not convert one into the other and does not claim a dollar figure.
 *
 * The recovery policy is a *stated* policy, not a measurement of agent behaviour: the
 * harness re-runs the owner's command because that is what a worker asked to redo its output
 * would do. Whether a model would do it is a separate experiment.
 *
 * Opt-in by credential and by invoice: it boots real containers on the account.
 *
 *   INGRESS_WORKSPACE_TOKEN=... node scripts/mission-recovery.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';
import { recoveryPlan, taxOf, recoveryVerdict } from '../src/mission-recovery.mjs';
import { recoveryMission } from '../fixtures/mission-recovery.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('recovery');
const { post, get } = client(WORKSPACE);
const RUN_MS = 240_000;
const RECOVERY_CEILING = 2;

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

// The mission itself lives in `fixtures/mission-recovery.mjs`: the participant commands are
// the mission, and a mission whose tools are wrong would fail as a product failure. Keeping
// them as data means the tools can be run on Node, offline, before anything is booted.
const mission = recoveryMission;
const tasks = mission.tasks;
const outputs = mission.outputs;

const results = [];
let containerStarts = 0;
const expectResult = (label, value, note = '') => {
  if (note) console.log(`  .. ${note}`);
  results.push(ok(label, value));
  return value;
};

/** One participant, from the join to the verdict, with its wall time measured by the harness. */
async function runParticipant({ id, task, command, writePaths }) {
  const spec = tasks[task];
  containerStarts += 1;
  const started = Date.now();

  // Declared dependencies are what the fence holds the commit to on the coarse path, and the
  // read lease is what puts those paths in the container's seed. Both are needed: the read is
  // recorded by the grant rather than asserted by the caller.
  await get(`/join?name=${encodeURIComponent(id)}&kind=agent&dependencies=${encodeURIComponent(spec.reads.join(','))}`);

  const leases = [];
  for (const path of spec.reads) {
    const granted = await post('/lease/checkout', { participantId: id, paths: [path], mode: 'read' });
    if (granted.status !== 200) throw new Error(`read lease refused for ${id} on ${path}: ${JSON.stringify(granted.body)}`);
    leases.push({ path, leaseId: granted.body.leaseId });
  }

  const started_ = await post('/start', {
    participantId: id,
    kind: 'agent',
    writePaths,
    runMs: RUN_MS,
    participantCommand: command,
  });

  // Released straight away. A read lease is exclusive against a write, so a reader that kept
  // one would block the very move this mission is about -- and the read *record* survives the
  // release, which is the part the fence needs.
  for (const lease of leases) {
    await post('/lease/release', { leaseId: lease.leaseId, participantId: id });
  }

  const wallMs = Date.now() - started;
  const commit = started_.body?.commit ?? null;
  const landed = commit?.landed ?? [];
  return {
    id,
    task,
    status: started_.status,
    wallMs,
    exit: started_.body?.participantExit ?? null,
    timedOut: started_.body?.timedOut ?? null,
    admitted: commit?.admitted === true,
    reason: commit?.reason ?? null,
    landed,
    // Bytes that were re-derived and came out the same. The workspace calls that `no_change`
    // and does not write them, but the work happened, and for the tax it is the difference
    // between a regeneration that was needed and one that was not.
    unchanged: commit?.unchanged ?? [],
    // Outputs re-affirmed rather than rewritten: the same bytes, declared against the current
    // inputs. Without this an output whose value does not depend on the change stays
    // contradicted however often its owner redoes the work.
    refreshed: commit?.refreshed ?? [],
    unrefreshed: commit?.unrefreshed ?? [],
    log: started_.body?.log ?? '',
  };
}

const record = async (entries, run) => {
  for (const file of run.landed) {
    // The commit verdict carries the hash and the revision; the byte count is read back from
    // the workspace, because the verdict does not carry it and a tax measured in bytes must
    // not be a guess.
    const stored = await get(`/content?path=${encodeURIComponent(file.path)}`);
    const byteLength = stored.status === 200
      ? Buffer.from(stored.body.contentBase64, 'base64').byteLength
      : null;
    entries.push({ task: run.task, path: file.path, contentHash: file.contentHash, containerMs: run.wallMs, byteLength });
  }
};

/** What the workspace says it no longer approves. */
async function invalidated() {
  const response = await get('/invalidated');
  if (response.status !== 200) throw new Error(`/invalidated answered ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

/** Read one path back as text, through the workspace rather than from a container. */
async function contentOf(path) {
  const response = await get(`/content?path=${encodeURIComponent(path)}`);
  if (response.status !== 200) return null;
  return Buffer.from(response.body.contentBase64, 'base64').toString('utf8');
}

const publishes = [];
const regenerations = [];
const attempts = {};
const rounds = [];
const evidence = {
  kind: 'mission-recovery-e2e',
  date: new Date().toISOString(),
  workspace: WORKSPACE,
  mission: { outputs, recoveryCeiling: RECOVERY_CEILING, runMs: RUN_MS },
  recoveryPolicy: 'the owner of an invalidated output re-runs its own command, at most twice',
  rounds: [],
  result: null,
};

console.log(`workspace: ${WORKSPACE}`);

step('0. seed the mission');
const seeded = await post('/bootstrap', {
  author: 'mission',
  files: await Promise.all(Object.entries(mission.files).map(([path, content]) => entry(path, content))),
});
expectResult('the mission is seeded through the fence', seeded.status === 200, `status ${seeded.status}`);

step('1. three participants build the project in real containers, declaring what they built from');
for (const id of ['report', 'notes', 'summary']) {
  const run = await runParticipant({ id, task: id, command: tasks[id].command, writePaths: [tasks[id].output] });
  console.log(`  ${id}: exit ${run.exit} in ${run.wallMs}ms — ${run.admitted ? 'admitted' : `refused (${run.reason})`}`);
  if (!run.admitted) console.log('    ' + JSON.stringify(run.log.split('\n').slice(-6).join('\n    ')));
  expectResult(`${id} landed its output through the fence`, run.admitted && run.landed.some(file => file.path === tasks[id].output));
  expectResult(`${id} printed its own result`, run.log.includes(tasks[id].emits));
  await record(publishes, run);
  attempts[id] = 0;
}

const clean = await invalidated();
expectResult('nothing is invalidated yet', clean.invalidated.length === 0, JSON.stringify(clean.counts));
expectResult('the generated outputs are covered by the record',
  outputs.every(output => !clean.uncovered.includes(output.path)),
  `uncovered: ${clean.uncovered.join(', ')}`);
expectResult('and the bootstrap files are reported uncovered rather than approved',
  clean.uncovered.includes('config/policy.json') && clean.uncovered.includes('tools/emit-report.mjs'),
  `uncovered: ${clean.uncovered.join(', ')}`);

// Two rounds of "somebody else moved the input". The second is the one that shows the loop is
// a loop: the recovery wave's own publications become the evidence the next round contradicts.
let offerAfterRounds = mission.initialOffer;
for (const round of [1, 2]) {
  const offer = mission.initialOffer + round * 10;
  offerAfterRounds = offer;
  step(`2.${round} the provider moves the shared input (offer ${offer - 10} -> ${offer})`);
  const move = await runParticipant({
    id: `policy-${round}`,
    task: 'policy',
    command: tasks.policy.command(offer),
    writePaths: ['config/policy.json'],
  });
  console.log(`  policy: exit ${move.exit} in ${move.wallMs}ms — ${move.admitted ? 'admitted' : `refused (${move.reason})`}`);
  expectResult(`round ${round}: the new policy landed`, move.admitted);
  await record(publishes, move);

  const afterMove = await invalidated();
  const paths = afterMove.invalidated.map(item => item.path).sort();
  console.log(`  workspace reports ${afterMove.counts.invalidated} invalidated: ${JSON.stringify(afterMove.invalidated.map(item => [item.path, item.depth, item.via]))}`);
  expectResult(`round ${round}: the direct dependents are invalidated`,
    paths.includes('src/report.mjs') && paths.includes('src/notes.mjs'), JSON.stringify(paths));
  const transitive = afterMove.invalidated.find(item => item.path === 'src/summary.mjs');
  expectResult(`round ${round}: the output built from an invalidated output is invalidated too`,
    transitive?.depth === 1 && transitive.via.includes('src/report.mjs'), JSON.stringify(transitive ?? null));
  const report = afterMove.invalidated.find(item => item.path === 'src/report.mjs');
  expectResult(`round ${round}: and the evidence names the revision that moved and who moved it`,
    report?.staleInputs?.[0]?.path === 'config/policy.json'
    && report.staleInputs[0].currentRevision === round + 1
    && report.staleInputs[0].author === `policy-${round}`,
    JSON.stringify(report?.staleInputs ?? null));

  step(`3.${round} recovery: each owner re-runs its own command`);
  const plan = recoveryPlan({ invalidated: afterMove.invalidated, outputs, attempts, ceiling: RECOVERY_CEILING });
  expectResult(`round ${round}: every invalidated output has an owner to ask`, plan.unowned.length === 0, JSON.stringify(plan.unowned));
  expectResult(`round ${round}: nothing is exhausted at this point`, plan.exhausted.length === 0);
  console.log(`  plan: ${JSON.stringify(plan.regenerate.map(item => [item.task, item.attempt, item.depth]))}`);

  const before = new Map();
  for (const output of outputs) {
    const response = await get(`/content?path=${encodeURIComponent(output.path)}`);
    before.set(output.path, response.status === 200 ? response.body.contentHash : null);
  }

  for (const item of plan.regenerate) {
    const output = tasks[item.task].output;
    const run = await runParticipant({ id: `${item.task}-r${round}`, task: item.task, command: tasks[item.task].command, writePaths: [output] });
    console.log(`  ${item.task}: exit ${run.exit} in ${run.wallMs}ms — ${run.admitted ? 'admitted' : `refused (${run.reason})`}`);
    expectResult(`round ${round}: ${item.task} republished`, run.admitted);
    attempts[item.task] = item.attempt;

    // Exactly one regeneration per run, and it is the task's own output. The launcher commits
    // the whole tree, so `unchanged` lists every file the container was seeded with -- counting
    // those as regenerations would multiply the tax by the size of the tree and call the
    // container's re-send of somebody else's file work.
    const landed = run.landed.find(file => file.path === output) ?? null;
    const stored = landed ? null : await get(`/content?path=${encodeURIComponent(output)}`);
    regenerations.push({
      task: item.task,
      path: output,
      contentHash: landed ? landed.contentHash : (stored?.status === 200 ? stored.body.contentHash : null),
      containerMs: run.wallMs,
      // The hash of what this output held before the recovery wave, so "did the work change
      // anything" is a measurement rather than an opinion.
      previousHash: before.get(output) ?? null,
    });

    if (run.unchanged.includes(output)) {
      // The case the mechanism has to be able to clear, and the one the first deployed run
      // found broken: identical bytes, re-derived against the current inputs.
      expectResult(`round ${round}: ${item.task} re-affirmed its unchanged output rather than leaving it stale`,
        run.refreshed.includes(output),
        JSON.stringify({ unchanged: run.unchanged.includes(output), refreshed: run.refreshed, unrefreshed: run.unrefreshed }));
    } else {
      expectResult(`round ${round}: ${item.task} republished changed bytes`, landed !== null,
        JSON.stringify({ landed: run.landed.map(file => file.path), unchanged: run.unchanged }));
    }
  }

  const afterRecovery = await invalidated();
  expectResult(`round ${round}: nothing is invalidated once the owners have republished`,
    afterRecovery.invalidated.length === 0, JSON.stringify(afterRecovery.counts));

  rounds.push({ round, offer, movedTo: round + 1, invalidated: afterMove.invalidated, plan, after: afterRecovery.counts });
}

step('4. read the mission back, and measure what the recovery cost');
const content = {};
for (const path of ['config/policy.json', ...mission.outputs.map(output => output.path)]) {
  content[path] = await contentOf(path);
}
const expected = mission.expected(offerAfterRounds);

// The tax needs the content hash each output held *immediately before* each regeneration, so
// a regeneration that produced the bytes already there is measurable rather than invisible.
// `before` is read from `/content` at the start of each round, so it is per-round rather than
// per-path -- a two-round mission has two different "before" values for the same output.
const tax = taxOf({
  publishes,
  regenerations: regenerations.map(entry => ({ ...entry, before: entry.previousHash })),
});

const final = await invalidated();
const verdict = recoveryVerdict({ after: { invalidated: final.invalidated, content }, expected });
expectResult('the mission is coherent: the workspace approves everything it knows about', verdict.coherent, JSON.stringify(final.counts));
expectResult('the mission is correct: every output holds the value the mission asked for', verdict.correct, JSON.stringify({ mismatched: verdict.mismatched, missing: verdict.missing }));
expectResult('the tax counts the container starts the mission actually made',
  tax.totals.starts === containerStarts, `tax says ${tax.totals.starts}, the run made ${containerStarts}`);
const changedPaths = [...new Set(tax.changedOutputs.map(item => item.path))].sort();
const unchangedPaths = [...new Set(tax.unchangedOutputs.map(item => item.path))].sort();
expectResult('every regeneration of an output that uses the source changed its bytes',
  changedPaths.join(',') === 'src/report.mjs,src/summary.mjs' && tax.changedOutputs.length === 2 * rounds.length,
  JSON.stringify({ changed: changedPaths, count: tax.changedOutputs.length, rounds: rounds.length }));
expectResult('while the one that only depended on the change changed nothing, on both rounds',
  unchangedPaths.join(',') === 'src/notes.mjs' && tax.unchangedOutputs.length === rounds.length,
  JSON.stringify({ unchanged: unchangedPaths, count: tax.unchangedOutputs.length }));
expectResult('and the waste is one regeneration in three, which is the tax the mechanism charges',
  tax.overInvalidationRate === 1 / 3, `rate ${tax.overInvalidationRate}`);

const output = resolve(import.meta.dirname, '../artifacts', `mission-recovery-${randomUUID()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
evidence.rounds = rounds;
evidence.tax = tax;
evidence.verdict = verdict;
evidence.counts = final.counts;
evidence.content = content;
evidence.publishes = publishes;
evidence.regenerations = regenerations;
await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

console.log(`\n  regenerations: ${tax.regenerations}`);
console.log(`  changed:       ${tax.changedOutputs.map(item => item.path).join(', ') || 'none'}`);
console.log(`  unchanged:     ${tax.unchangedOutputs.map(item => item.path).join(', ') || 'none'}`);
console.log(`  over-invalidation rate: ${tax.overInvalidationRate === null ? 'not judgeable' : tax.overInvalidationRate}`);
console.log(`  container time: ${tax.totals.containerMs}ms across ${tax.totals.starts} starts (recovery: ${tax.totals.regenerationContainerMs}ms)`);
console.log(`  model cost:     ${tax.totals.modelCost} (deterministic participants: no model ran)`);
console.log(`  evidence:       ${output}/evidence.json`);

finish(results, passed => passed
  ? 'THE DEPLOYED PRODUCT REPORTS ITS OWN STALE OUTPUTS, AND THE RECOVERY TAX IS MEASURED'
  : 'THE PUBLICATION RECORD DOES NOT HOLD ON THE DEPLOYED SURFACE');
