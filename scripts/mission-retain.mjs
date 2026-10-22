/**
 * Keep a flight's trace, instead of letting it evaporate with the temp directory.
 *
 *   node scripts/mission-retain.mjs                       # the newest flight
 *   node scripts/mission-retain.mjs --flight=DIR           # a specific one
 *   node scripts/mission-retain.mjs --capture=running      # label how this capture happened
 *
 * This is the thin command. The decision about what to keep lives in `src/mission-retention.mjs`
 * so the harness can call the same code when a cohort settles, which is the only point at which
 * a capture is a record rather than a rescue.
 */
import { readFile, stat, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { retain } from '../src/mission-retention.mjs';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(arg => arg.startsWith(key + '='));
  return found === undefined ? undefined : found.slice(key.length + 1);
};

if (args.some(arg => !['--flight', '--evidence', '--capture'].some(key => arg.startsWith(key + '=')))) {
  console.error('Usage: node scripts/mission-retain.mjs [--flight=DIR] [--evidence=FILE] [--capture=settled|running|post-hoc]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const capture = value('--capture') ?? 'post-hoc';
  const explicit = value('--evidence');
  const flight = value('--flight');
  const evidencePath = explicit !== undefined
    ? resolve(explicit)
    : join(flight !== undefined ? resolve(flight) : await newestFlight(join(root, 'artifacts')), 'evidence-private.json');
  if (!isAbsolute(evidencePath)) {
    console.error('the evidence path must be absolute');
    process.exitCode = 1;
  } else {
    try {
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      const result = await retain({ evidence, directory: dirname(evidencePath), capture });
      console.log(`flight:   ${dirname(evidencePath)}`);
      console.log(`capture:  ${capture} — ${result.plan.note}`);
      console.log(`cohorts:  ${result.plan.cohorts.length} traced, ${result.plan.files} files, ${result.plan.totalBytes} bytes`);
      for (const cohort of result.plan.cohorts) {
        const receipts = cohort.receipts === null
          ? 'none recorded'
          : cohort.receipts.include ? `${cohort.receipts.bytes} bytes` : `refused (${cohort.receipts.reason})`;
        console.log(`  ${cohort.id}: ${cohort.files.length} files, receipts ${receipts}`);
      }
      if (!result.plan.complete) {
        console.log(`  dropped: ${result.plan.truncated.length} truncated, ${result.plan.oversized.length} oversized, ${result.plan.refused.length} refused`);
        for (const row of result.plan.oversized.slice(0, 5)) console.log(`    oversized: ${row.path} (${row.bytes} bytes)`);
        for (const row of result.plan.refused.slice(0, 5)) console.log(`    refused:   ${row.path ?? row.id} — ${row.reason}`);
      }
      console.log(`traces:   ${result.directory}`);
    } catch (error) {
      console.error(`retention failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

/** The newest flight with evidence, or the artifacts directory itself. */
async function newestFlight(directory) {
  let names = [];
  try { names = (await readdir(directory)).filter(name => name.startsWith('mission-flight-')); } catch { return directory; }
  const flights = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const info = await stat(join(path, 'evidence-private.json'));
      if (info.isFile()) flights.push({ path, modified: info.mtimeMs });
    } catch { /* not a flight */ }
  }
  flights.sort((a, b) => b.modified - a.modified);
  return flights.length > 0 ? flights[0].path : directory;
}
