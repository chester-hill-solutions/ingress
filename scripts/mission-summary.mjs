/**
 * Write a flight's durable summary into `docs/flights/`, where a commit can keep it.
 *
 *   node scripts/mission-summary.mjs                        # the newest flight
 *   node scripts/mission-summary.mjs --flight=DIR
 *
 * Exits non-zero rather than writing a partial summary: a summary that quietly omits a cohort is
 * worse than none, because it reads as a complete record.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { flightSummary } from '../src/mission-summary.mjs';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(argument => argument.startsWith(`${key}=`));
  return found === undefined ? undefined : found.slice(key.length + 1);
};
if (args.some(argument => !argument.startsWith('--flight='))) {
  console.error('Usage: node scripts/mission-summary.mjs [--flight=DIR]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const flight = value('--flight') === undefined ? await newest(join(root, 'artifacts')) : resolve(value('--flight'));
  const evidence = JSON.parse(await readFile(join(flight, 'evidence-private.json'), 'utf8'));
  evidence.flight = basename(flight);
  const summary = flightSummary(evidence, { source: evidence.sourceFingerprints });
  await mkdir(join(root, 'docs', 'flights'), { recursive: true });
  const target = join(root, 'docs', 'flights', `${basename(flight)}.json`);
  await writeFile(target, `${JSON.stringify(summary, null, 2)}\n`);
  for (const cohort of summary.cohorts) {
    console.log(`${cohort.id}`);
    console.log(`  ${cohort.outcome}${cohort.correct ? ' · correct' : ''} · checks ${cohort.checks.passed}/${cohort.checks.total} · ${cohort.tokens.total} tokens · $${cohort.cost}`);
    if (cohort.checks.failed.length > 0) console.log(`  failed: ${cohort.checks.failed.join(', ')}`);
  }
  console.log(`totals: ${summary.totals.cohorts} cohort(s), ${summary.totals.correct} correct, ${summary.totals.tokens} tokens, $${summary.totals.cost}`);
  console.log(`wrote ${target}`);
}

async function newest(directory) {
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
