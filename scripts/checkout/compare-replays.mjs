// Model-free, paired mechanism study. Virtual ticks are not agent wall time.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ProductReplay } from './product-replay.mjs';
import { workloads, patchTask, acceptanceSource } from './replay-workloads.mjs';
import { schedules, replaySchedule } from './replay-schedule.mjs';
import { extractBindings } from './binding-producer.mjs';
import { normalizeGraph, sourceRevision } from '../../src/prototypes/checkout/graph-index.mjs';
import { CheckoutArbiter } from '../../src/prototypes/checkout/arbiter.mjs';
import { GraphCheckout } from '../../src/prototypes/checkout/graph-checkout.mjs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
import { introducedWrites } from './expansion-request.mjs';

const { values } = parseArgs({ options: { python: { type: 'string' }, repo: { type: 'string' }, output: { type: 'string' }, repeats: { type: 'string', default: '2' } } });
if (!values.python) throw new Error('Pass --python=/path/to/isolated/Tree-sitter/python; no models run');
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('invalid_repeats');
const repo = resolve(values.repo ?? '../checkout-arbiter-lab'), run = resolve(values.output ?? `artifacts/checkout-comparison-${Date.now()}`);
mkdirSync(run);
const files = Object.fromEntries(readdirSync(resolve(repo, 'src')).filter(path => path.endsWith('.mjs')).sort()
  .map(path => [`src/${path}`, readFileSync(resolve(repo, 'src', path), 'utf8')]));
const contracts = JSON.parse(readFileSync(resolve(repo, 'contracts.json'), 'utf8'));
const behavior = readFileSync(resolve(repo, 'test/behavior.test.mjs'), 'utf8');
const arms = ['current', 'blocks', 'graph'];
const assignments = [];
for (let repeat = 0; repeat < repeats; repeat++) for (let wi = 0; wi < workloads.length; wi++) for (let si = 0; si < schedules.length; si++) {
  const rotated = arms.map((_, i) => arms[(i + repeat + wi + si) % arms.length]);
  for (const arm of rotated) assignments.push({ id: `${repeat + 1}-${workloads[wi].id}-${schedules[si].id}-${arm}`,
    repeat: repeat + 1, workload: workloads[wi].id, schedule: schedules[si].id, arm });
}
const implementationPaths = ['product-replay.mjs', 'replay-workloads.mjs', 'replay-schedule.mjs', 'compare-replays.mjs', 'expansion-request.mjs', 'binding-producer.mjs', 'bindings.py',
  '../../src/prototypes/checkout/graph-checkout.mjs', '../../src/prototypes/checkout/graph-index.mjs', '../../src/prototypes/checkout/arbiter.mjs',
  '../../src/product/handlers/commit.mjs', '../../src/product/handlers/container.mjs', '../../src/product/lease.mjs', '../../src/product/merge.mjs'];
const protocol = { schema: 1, mode: 'deterministic-mechanism-replay', assignedAt: new Date().toISOString(), assignments,
  arms, workloads, schedules, repeats, seedRevision: sourceRevision(files), contractsHash: hashText(JSON.stringify(contracts)), behaviorHash: hashText(behavior),
  implementationHashes: Object.fromEntries(implementationPaths.map(path => [path, hashText(readFileSync(resolve(import.meta.dirname, path)))])),
  deadlineTicks: 40, workTicksPerAttempt: 10, maximumSubmissionAttempts: 3, configuredModel: null, modelRuns: 0,
  baseline: 'Actual product WorkspaceAgent commit route and LeaseTable; /start free-path/contended rule adapted locally; no deployment/container/transport timing',
  controls: 'Same private seed copies, patches, schedule, common baseline behavior validator, held mission checker, merge implementation; no result-based rescue',
  scopeExpansion: 'Both scoped arms request introduced blocks explicitly and candidate-derived dependencies after a scope refusal. Candidate-bound expansion is atomic; a changed head requires a fresh edit attempt. Every refusal/expansion is retained.',
  timing: 'Virtual work/wait ticks and measured local policy/producer/validator/evaluator costs reported separately; repeats estimate timing variability only',
  usefulnessQualified: false };
writeFileSync(resolve(run, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');
writeFileSync(resolve(run, 'seed.json'), JSON.stringify(files, null, 2) + '\n');
let artifactNumber = 0;
function materialize(candidate, destination) {
  for (const [path, text] of Object.entries(candidate)) { mkdirSync(dirname(resolve(destination, path)), { recursive: true }); writeFileSync(resolve(destination, path), text); }
  mkdirSync(resolve(destination, 'checks'));
  writeFileSync(resolve(destination, 'checks/behavior-check.mjs'), behavior);
}
function command(destination, args, name) {
  const result = spawnSync(process.execPath, args, { cwd: destination, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  writeFileSync(resolve(destination, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error) throw result.error;
  return result.status === 0;
}
// Establish that each seed fails its mission and that a reference sequence succeeds,
// before admitting any comparative assignment. No checker feedback goes to actors.
const references = [];
for (const workload of workloads) {
  const seedPath = resolve(run, 'reference', workload.id, 'seed'); materialize(files, seedPath);
  writeFileSync(resolve(seedPath, 'checks/acceptance-check.mjs'), acceptanceSource(workload));
  const seedCorrect = command(seedPath, ['checks/acceptance-check.mjs'], 'acceptance');
  let reference = structuredClone(files);
  for (const task of workload.tasks) Object.assign(reference, patchTask(task, reference));
  const referencePath = resolve(run, 'reference', workload.id, 'solution'); materialize(reference, referencePath);
  writeFileSync(resolve(referencePath, 'checks/acceptance-check.mjs'), acceptanceSource(workload));
  const behaviorValid = command(referencePath, ['--test', '--test-timeout=30000', 'checks/behavior-check.mjs'], 'behavior');
  const referenceCorrect = command(referencePath, ['checks/acceptance-check.mjs'], 'acceptance');
  references.push({ workload: workload.id, seedCorrect, referenceCorrect, behaviorValid });
}
writeFileSync(resolve(run, 'references.json'), JSON.stringify(references, null, 2) + '\n');
if (references.some(row => row.seedCorrect || !row.referenceCorrect || !row.behaviorValid)) throw new Error('reference_preflight_failed');
const rows = [];
for (const assignment of assignments) {
  const destination = resolve(run, 'trials', assignment.id); mkdirSync(destination, { recursive: true });
  const workload = workloads.find(w => w.id === assignment.workload), schedule = schedules.find(s => s.id === assignment.schedule);
  const clocks = { graphBuildMs: 0, graphBuilds: 0, validationMs: 0, validations: 0, checkerMs: 0, checks: 0, policyMs: 0 };
  const started = performance.now();
  const build = candidate => {
    const begin = performance.now();
    try {
      const ast = extractBindings(candidate, values.python);
      writeFileSync(resolve(destination, `ast-${++clocks.graphBuilds}.json`), JSON.stringify(ast, null, 2) + '\n');
      return normalizeGraph({ files: candidate, ast, contracts });
    } finally { clocks.graphBuildMs += performance.now() - begin; }
  };
  const validate = candidate => {
    const begin = performance.now();
    try {
      const target = resolve(destination, `validation-${++clocks.validations}`); materialize(candidate, target);
      for (const path of Object.keys(candidate)) if (!command(target, ['--check', path], `syntax-${path.replaceAll('/', '_')}`)) return false;
      return command(target, ['--test', '--test-timeout=30000', 'checks/behavior-check.mjs'], 'behavior');
    } finally { clocks.validationMs += performance.now() - begin; }
  };
  const acceptance = async candidate => {
    const begin = performance.now();
    try {
      const target = resolve(destination, `check-${++clocks.checks}`); materialize(candidate, target);
      writeFileSync(resolve(target, 'checks/acceptance-check.mjs'), acceptanceSource(workload));
      return command(target, ['checks/acceptance-check.mjs'], 'acceptance');
    } finally { clocks.checkerMs += performance.now() - begin; }
  };
  let system, initial, api;
  const call = async operation => { const begin = performance.now(); try { return await operation(); } finally { clocks.policyMs += performance.now() - begin; } };
  let row;
  try {
    if (assignment.arm === 'current') {
      system = new ProductReplay(validate); await system.seed(files);
      api = { snapshot: () => system.snapshot(), checkout: (task, participantId) => call(() => system.checkout({ participantId, paths: [task.path] })),
        submit: (grant, patch) => call(() => system.submit({ checkoutId: grant.checkoutId, participantId: grant.participantId, files: patch })),
        release: grant => system.release({ checkoutId: grant.checkoutId, participantId: grant.participantId }) };
    } else if (assignment.arm === 'blocks') {
      initial = build(files); system = new CheckoutArbiter({ files, blocks: initial.blocks, edges: [] });
      api = { snapshot: () => system.snapshot(0), checkout: (task, participantId, tick) => call(() => system.checkout({ participantId, writes: [{ blockId: `${task.path}#${task.symbol}` }], leaseMs: 900_000 }, tick)),
        submit: (grant, patch, tick) => call(() => {
          const result = system.submit({ checkoutId: grant.checkoutId, participantId: grant.participantId, files: patch, validate }, tick);
          if (result.admitted) system.reindex({ blocks: build(system.snapshot(tick).files).blocks, edges: [] });
          return result;
        }), release: (grant, tick) => system.release({ checkoutId: grant.checkoutId, participantId: grant.participantId }, tick) };
    } else {
      system = new GraphCheckout({ files, buildIndex: build, validate });
      api = { snapshot: () => system.snapshot(0), checkout: (task, participantId, tick) => call(() => system.checkout({ participantId, writes: [{ blockId: `${task.path}#${task.symbol}` }], leaseMs: 900_000 }, tick)),
        submit: (grant, patch, tick) => call(() => system.submit({ checkoutId: grant.checkoutId, participantId: grant.participantId, files: patch }, tick)),
        release: (grant, tick) => system.release({ checkoutId: grant.checkoutId, participantId: grant.participantId }, tick) };
    }
    if (assignment.arm !== 'current') api.expand = (grant, patch, tick) => call(() => {
      const candidate = { ...grant.files, ...patch }, additionalWrites = introducedWrites(grant.files, candidate, build);
      const request = { checkoutId: grant.checkoutId, participantId: grant.participantId };
      if (assignment.arm === 'graph') return { ...system.expand({ ...request, files: patch, additionalWrites }, tick), requestedAdditionalWrites: additionalWrites };
      const next = build(candidate);
      return { ...system.expand({ ...request, candidate, blocks: next.blocks, edges: [],
        writes: [...grant.writes.map(({ blockId }) => ({ blockId })), ...additionalWrites] }, tick), requestedAdditionalWrites: additionalWrites };
    });
    const setupMs = performance.now() - started;
    const outcome = await replaySchedule({ workload, schedule, api, patch: patchTask, acceptance,
      deadlineTicks: protocol.deadlineTicks, maxAttempts: protocol.maximumSubmissionAttempts });
    writeFileSync(resolve(destination, 'final-files.json'), JSON.stringify(outcome.finalFiles, null, 2) + '\n');
    delete outcome.finalFiles;
    const blocked = outcome.events.filter(e => e.phase === 'checkout' && !e.granted);
    row = { ...assignment, ...outcome, clocks, setupMs, wallMs: performance.now() - started,
      independentExclusions: workload.relationship.startsWith('independent') ? blocked.length : 0,
      admittedWrongMission: outcome.allPublished && !outcome.finalCorrect,
      failure: null };
  } catch (error) {
    row = { ...assignment, failure: error.message, finalCorrect: false, allPublished: false, clocks, wallMs: performance.now() - started };
  }
  rows.push(row); writeFileSync(resolve(destination, 'result.json'), JSON.stringify(row, null, 2) + '\n');
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ protocol, references, completed: rows.length, assigned: assignments.length, rows }, null, 2) + '\n');
  console.log(`${rows.length}/${assignments.length} ${assignment.id}: ${row.failure ?? (row.finalCorrect ? 'correct' : 'incomplete/incorrect')}`);
}
const median = values => { const sorted = values.toSorted((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const summary = arms.map(arm => {
  const subset = rows.filter(row => row.arm === arm);
  return { arm, assigned: subset.length, correct: subset.filter(r => r.finalCorrect).length,
    allPublishedButWrong: subset.filter(r => r.admittedWrongMission).length, apparatusFailures: subset.filter(r => r.failure).length,
    medianCorrectVirtualTicks: median(subset.filter(r => r.finalCorrect).map(r => r.firstCorrectTick)),
    totalWaitingTicks: subset.reduce((n, r) => n + (r.waitingTicks ?? 0), 0), rejectedWorkTicks: subset.reduce((n, r) => n + (r.rejectedWorkTicks ?? 0), 0),
    independentExclusions: subset.reduce((n, r) => n + (r.independentExclusions ?? 0), 0),
    medianGraphBuildMs: median(subset.map(r => r.clocks.graphBuildMs)), medianPolicyMs: median(subset.map(r => r.clocks.policyMs)),
    medianValidationMs: median(subset.map(r => r.clocks.validationMs)), medianEvaluatorMs: median(subset.map(r => r.clocks.checkerMs)) };
});
const report = { schema: 1, mode: protocol.mode, run, assigned: assignments.length, completed: rows.length, summary,
  perWorkload: workloads.map(workload => ({ workload: workload.id, arms: arms.map(arm => {
    const selected = rows.filter(row => row.arm === arm && row.workload === workload.id);
    return { arm, correct: selected.filter(r => r.finalCorrect).length, assigned: selected.length,
      refusalReasons: [...new Set(selected.flatMap(row => row.events?.filter(e => e.reason).map(e => e.reason) ?? []))] };
  }) })),
  apparatusPassed: rows.length === assignments.length && rows.every(row => !row.failure),
  modelRuns: 0, usefulBenefitQualified: false,
  interpretation: 'Selected hand-authored deterministic edits demonstrate mechanism tradeoffs only. Virtual ticks are synthetic; elapsed policy costs are local replay overhead. No agent productivity or statistical significance claim.' };
writeFileSync(resolve(run, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.apparatusPassed) process.exitCode = 1;
