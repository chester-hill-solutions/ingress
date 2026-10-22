/**
 * Watch a mission flight while it runs.
 *
 * A flight is long: eight actors per cohort, a deadline measured in tens of minutes, and two
 * cohorts in the air at once. `scripts/mission-benchmark.mjs` writes its evidence continuously
 * (every cohort update, every observation band, every load event), and `benchmark-view.mjs`
 * already serves that file -- but it takes an absolute path, so watching a flight meant going
 * and finding one first. This finds it.
 *
 * What it shows, and what it deliberately does not
 *
 * Cohorts, their configuration and model, per-actor outcomes, the verifier's checks and the
 * harness's own compliance checks, elapsed time and retained errors. What it does not show is
 * the prose: the blind review withholds authorship and scores until a human has rated a sample,
 * and a live view of the artifacts would break exactly that.
 *
 *   node scripts/mission-view.mjs                        # the newest flight under artifacts/
 *   node scripts/mission-view.mjs --flight=<dir>          # a specific one
 *   node scripts/mission-view.mjs --evidence=<file>       # any evidence file
 *   node scripts/mission-view.mjs --port=65392            # a fixed port
 */
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { startBenchmarkDashboard } from '../src/benchmark-dashboard.mjs';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(arg => arg.startsWith(key + '='));
  return found === undefined ? undefined : found.slice(key.length + 1);
};
if (args.some(arg => !['--flight', '--evidence', '--port'].some(key => arg.startsWith(key + '=')))) {
  console.error('Usage: node scripts/mission-view.mjs [--flight=DIR] [--evidence=FILE] [--port=N]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const explicit = value('--evidence');
  const flight = value('--flight');
  const portText = value('--port');
  const port = portText === undefined ? 0 : Number(portText);
  if (portText !== undefined && (!/^\d+$/.test(portText) || port < 0 || port > 65535)) {
    console.error('--port must be a port number');
    process.exitCode = 1;
  } else {
    let evidencePath = explicit;
    if (evidencePath === undefined) {
      const directory = flight === undefined ? newestFlight(join(root, 'artifacts')) : resolve(flight);
      if (directory === null) {
        console.error('No mission flight found under artifacts/. Start one with: npm run missions:real -- --real --missions=signal-analytics');
        process.exitCode = 1;
      } else {
        evidencePath = join(directory, 'evidence-private.json');
      }
    }
    if (evidencePath !== undefined && !isAbsolute(evidencePath)) {
      console.error('the evidence path must be absolute');
      process.exitCode = 1;
    } else if (evidencePath !== undefined) {
      try {
        const dashboard = await startBenchmarkDashboard({ evidencePath, port });
        console.log(`Flight view: ${dashboard.url}`);
        console.log(`Evidence:    ${evidencePath}`);
        console.log('Read-only and loopback-only. Artifacts stay behind the blind review until a human rates a sample.');
        const stop = () => { void dashboard.close(); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } catch {
        console.error(`No readable evidence at ${evidencePath}. A flight writes it as it runs; a view started against a missing file has nothing to show.`);
        process.exitCode = 1;
      }
    }
  }
}

/** The most recently written flight directory, or null when there is none. */
function newestFlight(directory) {
  let names = [];
  try { names = readdirSync(directory).filter(name => name.startsWith('mission-flight-')); } catch { return null; }
  const flights = names
    .map(name => ({ name, path: join(directory, name) }))
    .filter(candidate => { try { return statSync(join(candidate.path, 'evidence-private.json')).isFile(); } catch { return false; } })
    .map(candidate => ({ ...candidate, modified: statSync(join(candidate.path, 'evidence-private.json')).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  return flights.length > 0 ? flights[0].path : null;
}
