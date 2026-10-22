/**
 * The recovery mission's tools, run on Node with no container and no account.
 *
 * Why this is separate from the live run
 *
 * `scripts/mission-recovery.mjs` boots real containers on a real account, so every way it can
 * fail is expensive to discover. The part that can be wrong *before* anything is booted is the
 * mission itself: whether the generators emit what the mission claims, whether the provenance
 * declarations name the right revisions, and — the one the tax depends on — whether the output
 * that depends on the policy without using its value really does not change when the policy
 * does.
 *
 * `tool()` models one container run, because that is what it is: a fresh `/start` seeds the
 * tree and writes `.ingress/built-from.json` from nothing, and the workspace accumulates the
 * evidence across runs rather than the file doing it. A helper that let the declaration file
 * persist would be testing a container that does not exist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recoveryMission } from '../fixtures/mission-recovery.mjs';

const run = promisify(execFile);
const node = process.execPath;

/** The mission's tree in a temp directory, with the revisions the launcher would have written. */
async function scaffold({ revisions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mission-recovery-'));
  for (const [path, content] of Object.entries(recoveryMission.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const revisionsPath = join(root, 'revisions.json');
  await writeFile(revisionsPath, JSON.stringify(revisions));
  return { root, revisionsPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** What the workspace would have been handed for this run. */
async function hand({ revisionsPath }, revisions) {
  await writeFile(revisionsPath, JSON.stringify(revisions));
}

/**
 * Run one of the mission's tools the way a container would, and return its stdout and the
 * declaration it left behind.
 */
async function tool({ root, revisionsPath }, command, args = []) {
  // A fresh container: no declaration file from a previous run, because a previous run was a
  // different container.
  await rm(join(root, '.ingress'), { recursive: true, force: true });

  const script = command.replace('cd /workspace && ', '');
  const [runner, ...rest] = script.split(' ');
  assert.equal(runner, 'node', `the mission's commands are node scripts; got ${runner}`);
  const { stdout } = await run(node, [...rest, ...args], {
    cwd: root,
    env: { ...process.env, INGRESS_REVISIONS_PATH: revisionsPath },
  });

  let declared = null;
  try { declared = JSON.parse(await readFile(join(root, '.ingress/built-from.json'), 'utf8')); }
  catch { declared = null; }
  return { stdout: stdout.trim(), declared };
}

const readText = (root, path) => readFile(join(root, path), 'utf8');

test('the mission builds the tree it claims, and declares what each output was built from', async () => {
  const sandbox = await scaffold();
  try {
    await hand(sandbox, { 'config/policy.json': 1 });
    const report = await tool(sandbox, recoveryMission.tasks.report.command);
    assert.match(report.stdout, /REPORT_EMITTED offer=10/);
    assert.deepEqual(report.declared, { 'src/report.mjs': [{ path: 'config/policy.json', revision: 1 }] });

    const notes = await tool(sandbox, recoveryMission.tasks.notes.command);
    assert.match(notes.stdout, /NOTES_EMITTED/);
    assert.deepEqual(notes.declared, { 'src/notes.mjs': [{ path: 'config/policy.json', revision: 1 }] });

    // The summary reads the report, so it is handed the revision the report landed at.
    await hand(sandbox, { 'src/report.mjs': 1 });
    const summary = await tool(sandbox, recoveryMission.tasks.summary.command);
    assert.match(summary.stdout, /SUMMARY_EMITTED total=10/);
    assert.deepEqual(summary.declared, { 'src/summary.mjs': [{ path: 'src/report.mjs', revision: 1 }] });

    for (const [path, content] of Object.entries(recoveryMission.expected(10))) {
      assert.equal(await readText(sandbox.root, path), content, `${path} is not what the mission claims`);
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('moving the policy changes the two outputs that use it and not the one that does not', async () => {
  // This is the mission's whole point, and it is checkable without a product: the notes output
  // depends on the policy and does not read its value, so its regeneration produces the bytes
  // already there. The tax in the live run measures that; this is what makes the measurement a
  // property of the mission rather than an accident of one run.
  const sandbox = await scaffold();
  try {
    await hand(sandbox, { 'config/policy.json': 1 });
    await tool(sandbox, recoveryMission.tasks.report.command);
    await tool(sandbox, recoveryMission.tasks.notes.command);
    await hand(sandbox, { 'src/report.mjs': 1 });
    await tool(sandbox, recoveryMission.tasks.summary.command);
    const before = {
      report: await readText(sandbox.root, 'src/report.mjs'),
      notes: await readText(sandbox.root, 'src/notes.mjs'),
      summary: await readText(sandbox.root, 'src/summary.mjs'),
    };

    const bump = await tool(sandbox, recoveryMission.tasks.policy.command(20));
    assert.match(bump.stdout, /POLICY_BUMPED offer=20/);
    assert.deepEqual(bump.declared, { 'config/policy.json': [] },
      'the source declares itself built from nothing, so it can never be invalidated');

    await hand(sandbox, { 'config/policy.json': 2 });
    await tool(sandbox, recoveryMission.tasks.report.command);
    await tool(sandbox, recoveryMission.tasks.notes.command);
    await hand(sandbox, { 'src/report.mjs': 2 });
    await tool(sandbox, recoveryMission.tasks.summary.command);

    assert.notEqual(await readText(sandbox.root, 'src/report.mjs'), before.report, 'the report uses the value');
    assert.notEqual(await readText(sandbox.root, 'src/summary.mjs'), before.summary, 'and the summary inherits it');
    assert.equal(await readText(sandbox.root, 'src/notes.mjs'), before.notes,
      'the notes depend on the policy and do not use its value: this is the waste the tax measures');

    for (const [path, content] of Object.entries(recoveryMission.expected(20))) {
      assert.equal(await readText(sandbox.root, path), content);
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('the regenerated outputs declare the revision they were rebuilt from, not the old one', async () => {
  // The clearing half of the mechanism, offline: a republish that cites the revision that
  // moved would be refused by the fence, and a republish that cites the current one is what
  // takes the output back out of the invalidated set.
  const sandbox = await scaffold();
  try {
    await hand(sandbox, { 'config/policy.json': 2 });
    const report = await tool(sandbox, recoveryMission.tasks.report.command);
    assert.deepEqual(report.declared, { 'src/report.mjs': [{ path: 'config/policy.json', revision: 2 }] });

    await hand(sandbox, { 'src/report.mjs': 2 });
    const summary = await tool(sandbox, recoveryMission.tasks.summary.command);
    assert.deepEqual(summary.declared, { 'src/summary.mjs': [{ path: 'src/report.mjs', revision: 2 }] });
  } finally {
    await sandbox.cleanup();
  }
});

test('without the revisions file an output declares nothing rather than guessing', async () => {
  // The launcher writes the revisions file at seed time, so in a real run it is there. When it
  // is not, the participant was handed nothing it can cite, and a guessed revision would be a
  // false statement about the work. Declaring nothing leaves the output uncovered in the
  // workspace's record, which is the honest answer, and the tool says so on stdout.
  const sandbox = await scaffold();
  try {
    await rm(sandbox.revisionsPath);
    const report = await tool(sandbox, recoveryMission.tasks.report.command);
    assert.match(report.stdout, /REPORT_UNDECLARED/);
    assert.match(report.stdout, /REPORT_EMITTED offer=10/, 'the work still happens; only the claim is withheld');
    assert.equal(report.declared, null, 'no declaration file is written at all');
  } finally {
    await sandbox.cleanup();
  }
});

test('the mission declares the same outputs it produces', async () => {
  // A mission whose plan names a path its tools never write would ask the workspace about an
  // output that does not exist, and the recovery plan would report it `unowned`.
  const declaredPaths = recoveryMission.outputs.map(output => output.path).sort();
  const taskPaths = ['report', 'notes', 'summary'].map(task => recoveryMission.tasks[task].output).sort();
  assert.deepEqual(declaredPaths, taskPaths);
  for (const output of recoveryMission.outputs) {
    assert.equal(recoveryMission.tasks[output.task].output, output.path);
  }
});
