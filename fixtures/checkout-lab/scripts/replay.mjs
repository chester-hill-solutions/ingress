// Exercise frozen candidate edits on disposable copies. This does not invoke an arbiter.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const oracle = JSON.parse(await readFile(resolve(root, 'test/checkout-cases.json'), 'utf8'));
const run = resolve(root, 'artifacts', `replay-${Date.now()}`);
await mkdir(run, { recursive: true });
const rows = [];
for (const scenario of oracle.cases.filter(entry => entry.mutation)) {
  const destination = resolve(run, scenario.id);
  await mkdir(destination);
  await cp(resolve(root, 'src'), resolve(destination, 'src'), { recursive: true });
  // Explicit check filenames prevent default `node --test` from discovering negative
  // candidate copies on a later baseline run.
  await mkdir(resolve(destination, 'checks'));
  await cp(resolve(root, 'test/behavior.test.mjs'), resolve(destination, 'checks/behavior-check.mjs'));
  await cp(resolve(root, 'contracts.json'), resolve(destination, 'contracts.json'));
  const file = resolve(destination, scenario.mutation.path);
  const source = await readFile(file, 'utf8');
  if (source.split(scenario.mutation.search).length - 1 !== 1) throw new Error('mutation_anchor_changed');
  const changed = (scenario.mutation.prepend ?? '') + source.replace(scenario.mutation.search, scenario.mutation.replace);
  await writeFile(file, changed);
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30_000 });
  const behavior = spawnSync(process.execPath, ['--test', '--test-timeout=30000', 'checks/behavior-check.mjs'], {
    cwd: destination, encoding: 'utf8', timeout: 30_000,
  });
  await writeFile(resolve(destination, 'syntax.log'), syntax.stdout + syntax.stderr);
  await writeFile(resolve(destination, 'behavior.log'), behavior.stdout + behavior.stderr);
  const syntaxValid = syntax.status === 0, behaviorValid = behavior.status === 0;
  const expectationMet = scenario.id === 'new-dependency-after-checkout' ? syntaxValid && behaviorValid
    : scenario.id === 'malformed-source' ? !syntaxValid && !behaviorValid
      : syntaxValid && !behaviorValid;
  rows.push({ id: scenario.id, expectedArbiterOutcome: scenario.expected, syntaxValid, behaviorValid,
    expectationMet: expectationMet && !syntax.error && !behavior.error,
    candidateHash: createHash('sha256').update(changed).digest('hex'),
    syntaxExit: syntax.status, behaviorExit: behavior.status,
    error: syntax.error?.message ?? behavior.error?.message ?? null });
}
const result = { corpus: 'checkout-lab-v1', assigned: rows.length, cases: rows,
  arbiterInvoked: false, note: 'Candidate behavior evidence only; prospective checkout decisions remain to be evaluated.',
  passed: rows.every(row => row.expectationMet) };
await writeFile(resolve(run, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ directory: run, ...result }, null, 2));
if (!result.passed) process.exitCode = 1;
