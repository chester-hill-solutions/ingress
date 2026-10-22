/**
 * Re-grade a flight's artifacts with the judge as it stands now.
 *
 * A flight records the verdict of the judge that ran with it. If a judge defect is found
 * afterwards, the honest response is not to edit the flight's evidence -- that is the record of
 * what happened -- but to re-grade the retained artifacts and keep both numbers, with the reason
 * they differ.
 *
 * The artifacts must have been retained first (`npm run missions:retain`), because a cohort's
 * workspace lives in a temp directory. And the *fixture must be unchanged*: the verifier's
 * protected-file gate compares against the current fixture, so editing a mission after flying it
 * makes every artifact ungradable rather than re-gradable. `test/mission-freeze.test.mjs` records
 * the seed hash each flown mission was graded against for exactly that reason.
 *
 *   node scripts/mission-regrade.mjs                         # newest flight with traces
 *   node scripts/mission-regrade.mjs --flight=DIR
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { missionFixtures, verifyMissionFixture } from '../fixtures/missions.mjs';
import { configureMission } from '../fixtures/mission-configurations.mjs';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(arg => arg.startsWith(key + '='));
  return found === undefined ? undefined : found.slice(key.length + 1);
};

if (args.some(arg => !['--flight'].some(key => arg.startsWith(key + '=')))) {
  console.error('Usage: node scripts/mission-regrade.mjs [--flight=DIR]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const flight = value('--flight') === undefined ? await newestFlight(join(root, 'artifacts')) : resolve(value('--flight'));
  if (!isAbsolute(flight)) {
    console.error('the flight path must be absolute');
    process.exitCode = 1;
  } else {
    try {
      const evidence = JSON.parse(await readFile(join(flight, 'evidence-private.json'), 'utf8'));
      const traces = join(flight, 'traces');
      const rows = [];
      for (const cohort of evidence.results ?? []) {
        const workspace = join(traces, cohort.id, 'workspace');
        try { if (!(await stat(workspace)).isDirectory()) continue; } catch { continue; }
        const base = missionFixtures.find(fixture => fixture.id === cohort.fixtureID);
        // The seed hash is what the flight was graded against. A different one means the fixture
        // moved under the artifact, and the re-grade would be measuring the edit, not the work.
        const expected = cohort.seedSHA256;
        const current = createHash('sha256').update(JSON.stringify(configureMission(base, cohort.configID).files)).digest('hex');
        const result = await verifyMissionFixture(cohort.fixtureID, workspace);
        const passed = result.checks.filter(check => check.passed).length;
        rows.push({
          cohort: cohort.id,
          recorded: { checks: (cohort.verification?.checks ?? []).filter(check => check.passed).length, total: (cohort.verification?.checks ?? []).length, correct: cohort.correct },
          regraded: { checks: passed, total: result.checks.length, correct: result.correct },
          fixtureUnchanged: expected === current,
          failedNow: result.checks.filter(check => !check.passed).map(check => check.name),
        });
      }
      const output = {
        flight,
        regradedAt: new Date().toISOString(),
        judge: 'fixtures/missions/analytics.mjs as committed after the flight',
        note: 'Post-hoc re-grade of the retained artifacts. The flight\'s own evidence is unchanged and remains the record of what ran; where the two disagree, the judge changed, not the submission.',
        rows,
      };
      await writeFile(join(flight, 'regrade.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
      for (const row of rows) {
        const moved = row.regraded.checks - row.recorded.checks;
        console.log(`${row.cohort}`);
        console.log(`  recorded ${row.recorded.checks}/${row.recorded.total} -> re-graded ${row.regraded.checks}/${row.regraded.total}${moved === 0 ? '' : ` (${moved > 0 ? '+' : ''}${moved})`}`);
        console.log(`  fixture unchanged: ${row.fixtureUnchanged}${row.fixtureUnchanged ? '' : '  <-- the fixture moved; this re-grade measures the edit'}`);
        if (row.failedNow.length > 0) console.log(`  still failing: ${row.failedNow.join(', ')}`);
      }
      console.log(`\nwrote ${join(flight, 'regrade.json')}`);
    } catch (error) {
      console.error(`re-grade failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

async function newestFlight(directory) {
  let names = [];
  try { names = (await readdir(directory)).filter(name => name.startsWith('mission-flight-')); } catch { return directory; }
  const flights = [];
  for (const name of names) {
    const path = join(directory, name);
    try { if ((await stat(join(path, 'evidence-private.json'))).isFile()) flights.push({ path, modified: (await stat(join(path, 'evidence-private.json'))).mtimeMs }); }
    catch { /* not a flight */ }
  }
  flights.sort((a, b) => b.modified - a.modified);
  return flights.length > 0 ? flights[0].path : directory;
}
