/**
 * Tail a mission flight: what is landing, where, and what it is costing.
 *
 * A flight is long and the observatory is aggregate: it answers "how many cohorts settled" and
 * not "what did actor three just write". The individual trace exists — the harness records each
 * cohort's workspace path, each actor's tool calls, usage and native activity, and the artifact
 * snapshots it takes at the observation bands — but reading it meant opening a large JSON file
 * and diffing workspaces by hand.
 *
 * So this prints the change stream:
 *
 *   HH:MM:SS  cohort  model        path                       what changed
 *
 * plus a periodic line per cohort with actor outcomes and measured usage. It is read-only. It
 * never writes into a flight, and it does not touch the harness: an edit to the harness mid-run
 * would invalidate the source fingerprints the flight recorded at its start.
 *
 * What it does not print is model prose or provider context. Neither is retained by the harness,
 * by design: the repository records what was done and what it cost, not what the model said.
 *
 *   node scripts/mission-trace.mjs                     # newest flight
 *   node scripts/mission-trace.mjs --flight=DIR
 *   node scripts/mission-trace.mjs --interval=2000     # milliseconds between ticks
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = key => {
  const found = args.find(arg => arg.startsWith(key + '='));
  return found === undefined ? undefined : found.slice(key.length + 1);
};
if (args.some(arg => !['--flight', '--evidence', '--interval'].some(key => arg.startsWith(key + '=')))) {
  console.error('Usage: node scripts/mission-trace.mjs [--flight=DIR] [--evidence=FILE] [--interval=MS]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const interval = Number(value('--interval') ?? 5000);
  const explicit = value('--evidence');
  const flight = value('--flight');
  const evidencePath = explicit !== undefined
    ? resolve(explicit)
    : join(flight !== undefined ? resolve(flight) : newestFlight(join(root, 'artifacts')), 'evidence-private.json');
  if (!isAbsolute(evidencePath) || !Number.isFinite(interval) || interval < 250) {
    console.error('the evidence path must be absolute and the interval at least 250 ms');
    process.exitCode = 1;
  } else {
    console.log(`tracing ${evidencePath}`);
    console.log('time      cohort                actor/model              path                            change');
    const seen = new Map();
    const summary = new Map();
    let reading = false;
    const tick = () => {
      if (reading) return;
      reading = true;
      try { look(read()); } catch { /* a flight writes continuously; a half-written file is expected */ } finally { reading = false; }
    };
    const timer = setInterval(tick, interval);
    process.once('SIGINT', () => { clearInterval(timer); printSummary(); process.exit(0); });
    process.once('SIGTERM', () => { clearInterval(timer); printSummary(); process.exit(0); });
    tick();

    function read() {
      // The harness renames into place, so this is either the previous or the next complete file.
      return JSON.parse(readFileSync(evidencePath, 'utf8'));
    }
    function look(evidence) {
      for (const result of evidence.results ?? []) {
        const workspace = result.workspace;
        if (typeof workspace !== 'string') continue;
        const label = `${result.configID}/${String(result.actorModels?.[0]?.id ?? '?').replace('deepseek-v4-flash', 'v4-flash').replace('gpt-5-nano', 'nano')}`;
        const previous = seen.get(workspace) ?? new Map();
        const current = new Map();
        for (const file of walk(workspace)) {
          let info;
          try { info = statSync(file); } catch { continue; }
          current.set(file, info.size);
          const before = previous.get(file);
          const short = file.slice(workspace.length + 1);
          if (before === undefined) console.log(`${stamp()}  ${label.padEnd(20)} ${' '.repeat(20)} ${short.padEnd(32)} +${info.size} bytes`);
          else if (before !== info.size) console.log(`${stamp()}  ${label.padEnd(20)} ${' '.repeat(20)} ${short.padEnd(32)} ${before} -> ${info.size} bytes`);
        }
        seen.set(workspace, current);
        const settled = (result.actors ?? []).filter(actor => ['succeeded', 'failed', 'interrupted', 'setup-failed', 'runtime-failed', 'deadline-or-cancel'].includes(actor.outcome)).length;
        const line = `${result.outcome} actors ${settled}/${(result.actors ?? []).length} settled — ${actorLine(result)}`;
        if (summary.get(workspace) !== line) {
          summary.set(workspace, line);
          console.log(`${stamp()}  ${label.padEnd(20)} ${line}`);
        }
      }
    }
    function actorLine(result) {
      const parts = (result.actors ?? []).map(actor => {
        const steps = Array.isArray(actor.nativeActivities) ? actor.nativeActivities.length : null;
        const usage = actor.usage ?? {};
        const tokens = Number.isFinite(usage.input) || Number.isFinite(usage.output)
          ? `${usage.input ?? '?'}in/${usage.output ?? '?'}out`
          : null;
        return `${actor.id}:${actor.outcome}${steps !== null ? `(${steps} steps)` : ''}${tokens ? ` ${tokens}` : ''}`;
      });
      return parts.join(' ');
    }
    function printSummary() {
      console.log('\nfinal:');
      for (const [workspace, line] of summary) console.log(`  ${workspace}\n    ${line}`);
    }
  }
}

const stamp = () => new Date().toTimeString().slice(0, 8);

/** Workspace files, bounded: the mission tree is small and the trace should not walk a home dir. */
function walk(directory, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (['node_modules', '.git', '.ingress'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, depth + 1, out);
    else out.push(path);
  }
  return out;
}

/** The most recently written flight directory, or the root when there is none. */
function newestFlight(directory) {
  let names = [];
  try { names = readdirSync(directory).filter(name => name.startsWith('mission-flight-')); } catch { return directory; }
  const flights = names
    .map(name => join(directory, name))
    .filter(path => { try { return statSync(join(path, 'evidence-private.json')).isFile(); } catch { return false; } })
    .map(path => ({ path, modified: statSync(join(path, 'evidence-private.json')).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  return flights.length > 0 ? flights[0].path : directory;
}
