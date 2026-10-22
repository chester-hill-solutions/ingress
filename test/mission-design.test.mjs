/**
 * The design mission's judge has to be satisfiable, and it has to be decisive.
 *
 * Two properties, and neither is free. A judge that nothing can pass is a trap, and the fleet that
 * meets it learns nothing except that the harness is unfair. A judge that a stub passes is worse:
 * it reports evidence where there is none. So the fixture is tested from both ends -- the seeded
 * stubs must score zero, and a reference implementation that follows the brief and nothing else
 * must score everything.
 *
 * The reference lives in `fixtures/reference/signal-open/` and is deliberately plain: a
 * table, a list, one closure for the tag. It exists to prove the floor is reachable, not to show
 * what a good answer looks like.
 *
 * Both tests need a browser, because the judge is one. A machine without Chrome skips with a
 * reason rather than failing, the same way the isolated verifier refuses rather than blaming a
 * submission for the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missionFixtures, verifyMissionFixture } from '../fixtures/missions.mjs';
import { browserAvailable } from '../src/browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mission = missionFixtures.find(fixture => fixture.id === 'signal-open');
const skip = browserAvailable() ? false : 'the design mission is judged by a browser, and this machine has none';

/** The four files a submission may rewrite; the rest is the customer's. */
const OVERLAY = ['server.mjs', 'public/signal.js', 'public/dashboard.css', 'README.md'];

async function seed({ reference = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'signal-open-'));
  for (const [path, content] of Object.entries(mission.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (reference) {
    for (const path of OVERLAY) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), await readFile(join(here, '..', 'fixtures', 'reference', 'signal-open', path), 'utf8'));
    }
  }
  return root;
}

test('the seeded stubs score nothing, so the judge is not satisfied by the brief alone', { skip }, async () => {
  const root = await seed();
  const result = await verifyMissionFixture('signal-open', root);
  const passed = result.checks.filter(check => check.passed).map(check => check.name);
  assert.deepEqual(passed, [], `the stubs scored ${passed.join(', ')}`);
  assert.equal(result.correct, false);
  // The one thing a stub *can* be charged for is not starting; the rest fail by absence.
  assert.ok(result.checks.some(check => check.name === 'runs-in-one-command' && !check.passed), 'a stub that throws was not reported as failing to run');
});

test('a reference implementation passes every check, so the floor is reachable', { skip }, async () => {
  const root = await seed({ reference: true });
  const result = await verifyMissionFixture('signal-open', root);
  const failed = result.checks.filter(check => !check.passed).map(check => check.name);
  const instructions = result.instructionChecks.filter(check => !check.passed).map(check => check.name);
  assert.deepEqual(failed, [], `checks failed: ${failed.join(', ')}`);
  assert.deepEqual(instructions, [], `instruction checks failed: ${instructions.join(', ')}`);
  assert.equal(result.correct, true);
});

test('the mission states the product facts and none of the design', () => {
  // The brief is the whole point: it may fix what an observer needs, and it may not fix the
  // product. These assertions are a ratchet on that -- if someone later edits the brief to name a
  // schema, an event or a module, the mission has quietly become the analytic one again.
  const brief = mission.files['BRIEF.md'];
  for (const fact of ['node server.mjs', '$PORT', '/dashboard', '12 KB', 'data-private']) {
    assert.ok(brief.includes(fact), `the brief no longer states the product fact: ${fact}`);
  }
  for (const design of ['must export', 'exports a function', 'function signature', 'JSON schema']) {
    assert.ok(!brief.includes(design), `the brief dictates design: ${design}`);
  }
  // The criteria are outcome words, not function names.
  assert.ok(mission.criteria.every(criterion => !/\.mjs|export|function/.test(criterion.id)), 'a criterion names an implementation');
  assert.equal(mission.reviewInvocation, undefined, 'a design mission must not be reviewed as a rendered string');
});

test('the judge catches a leak and an unescaped error, and only those', { skip }, async () => {
  // Passing a good submission is half of it. The other half is failing a bad one for the right
  // reason: a judge that cannot tell a leak from a layout is not measuring privacy, and one that
  // fails everything when anything is wrong is the bug this repository already fixed once.
  const root = await seed({ reference: true });
  const tagPath = join(root, 'public/signal.js');
  const tag = await readFile(tagPath, 'utf8');
  await writeFile(tagPath, tag.replace(
    "const body = JSON.stringify({ session, events: queue.splice(0, queue.length) });",
    "const typed = [...document.querySelectorAll('input')].map(input => input.value).join(' ');\n    const body = JSON.stringify({ session, typed, events: queue.splice(0, queue.length) });",
  ));
  const serverPath = join(root, 'server.mjs');
  const server = await readFile(serverPath, 'utf8');
  await writeFile(serverPath, server.replace('${escape(message)}', '${message}'));

  const result = await verifyMissionFixture('signal-open', root);
  const failed = result.checks.filter(check => !check.passed).map(check => check.name).sort();
  assert.deepEqual(failed, ['dashboard-escapes-the-error', 'never-collects-typed-values'], `a mutated submission failed: ${failed.join(', ') || 'nothing'}`);
});

test('every mission fits the cohort runner\'s evaluator budget', () => {
  // The runner rejects a fixture outside [1000, 35000] ms at cohort start, with a message that
  // names the budget and nothing about which mission is wrong -- a flight was lost to it once.
  for (const fixture of missionFixtures) {
    const budget = fixture.evaluatorTimeoutMs ?? 6000;
    assert.ok(Number.isInteger(budget) && budget >= 1000 && budget <= 35000, `${fixture.id} has an evaluator budget the runner will reject: ${budget}`);
  }
});
