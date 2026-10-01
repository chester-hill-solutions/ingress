import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { selectedProfile } from '../src/profile.mjs';
import { runRealSquad, validateSquadFixture } from '../src/squad.mjs';
import { startDashboard } from '../src/dashboard.mjs';

const args = process.argv.slice(2);
const usage = 'Explicit native-model admission required: node scripts/squad.mjs --real [--serve] [--max-concurrent=POSITIVE_INTEGER] [--fixture=extensions --root=ABSOLUTE_EXISTING_GAME]';
const keys = ['--max-concurrent=', '--fixture=', '--root='];
if (!args.includes('--real') || args.some(arg => !['--real', '--serve'].includes(arg) && !keys.some(key => arg.startsWith(key))) || keys.some(key => args.filter(arg => arg.startsWith(key)).length > 1)) throw new Error(usage);
const concurrencyArg = args.find(arg => arg.startsWith('--max-concurrent='))?.slice('--max-concurrent='.length);
const maxConcurrentNative = concurrencyArg === undefined ? undefined : Number(concurrencyArg);
if (concurrencyArg !== undefined && (!/^[1-9][0-9]*$/.test(concurrencyArg) || !Number.isSafeInteger(maxConcurrentNative))) throw new Error(usage);
const scenario = args.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const existingRoot = args.find(arg => arg.startsWith('--root='))?.slice('--root='.length);
if ((scenario !== undefined && scenario !== 'extensions') || (existingRoot !== undefined && !isAbsolute(existingRoot)) || Boolean(scenario) !== Boolean(existingRoot)) throw new Error(usage);
const fixture = scenario === 'extensions' ? validateSquadFixture((await import('../fixtures/ingress-extensions.mjs')).extensionFixture()) : undefined;
const verify = scenario === 'extensions' ? (await import('../fixtures/ingress-extension-verifier.mjs')).verifyIngressExtensions : undefined;
if (fixture && maxConcurrentNative !== undefined && maxConcurrentNative > fixture.tasks.length) throw new Error('squad_concurrency_exceeds_roster');
const abort = new AbortController();
const stop = () => abort.abort(new Error('squad_cancelled'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const output = resolve(import.meta.dirname, '../artifacts', randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const view = { phase: 'Connecting Canada: Crossroads squad', state: null, events: [], results: [] };
const dashboard = args.includes('--serve') ? await startDashboard(() => view) : null;
if (dashboard) console.log(`Live squad view: ${dashboard.url}`);
const root = resolve(import.meta.dirname, '..');
const fingerprintPaths = ['scripts/squad.mjs', ...(await readdir(join(root, 'src'))).filter(name => name.endsWith('.mjs')).sort().map(name => `src/${name}`), 'fixtures/ingress.mjs', 'fixtures/ingress-verifier.mjs', 'fixtures/canadian-history.json', ...(scenario === 'extensions' ? ['fixtures/ingress-extensions.mjs', 'fixtures/ingress-extension-verifier.mjs'] : [])];
const sourceFingerprints = Object.fromEntries(await Promise.all(fingerprintPaths.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
const evidence = { version: 1, kind: 'real-native-squad-build', date: new Date().toISOString(), plannedRoster: fixture ? [...fixture.tasks.map(task => task.id), ...(fixture.integrationTask ? [fixture.integrationTask.id] : [])] : null, fixture: scenario ?? 'base-game', maxConcurrentNative: maxConcurrentNative ?? null, concurrencyPolicy: maxConcurrentNative === undefined ? 'entire_roster_simultaneously' : 'explicit_limit', sourceFingerprints, result: null };
const evidencePath = join(output, 'squad-evidence.json');
let pendingJSON = null, writer = null, lastPhase;
function save() {
  pendingJSON = JSON.stringify(evidence, null, 2) + '\n';
  if (writer) return writer;
  writer = (async () => {
    while (pendingJSON !== null) {
      const bytes = pendingJSON; pendingJSON = null;
      const temporary = `${evidencePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, evidencePath);
    }
  })().finally(() => { writer = null; });
  return writer;
}
try {
  await save();
  const profile = await selectedProfile();
  console.log(`Squad model: ${profile.model.providerID}/${profile.model.id}`);
  evidence.result = await runRealSquad({ profile, fixture, verify, buildRoot: existingRoot, preserveExisting: Boolean(existingRoot), maxConcurrentNative, signal: abort.signal, onUpdate(value) {
    Object.assign(view, value, { results: [value.result] });
    evidence.result = value.result;
    evidence.plannedRoster = value.result.planned;
    dashboard?.push();
    void save().catch(() => { console.error('Progress evidence save failed'); });
    if (value.phase !== lastPhase) { lastPhase = value.phase; console.log(value.phase); }
  } });
  evidence.completed = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ buildRoot: evidence.result.buildRoot, correct: evidence.result.verification.correct, executionConcurrency: evidence.result.executionConcurrency, actors: evidence.result.actors.map(actor => ({ id: actor.id, outcome: actor.outcome, notices: actor.notices })), errors: evidence.result.errors }));
  console.log(`Evidence: ${evidencePath}`);
  if (dashboard && !abort.signal.aborted) { console.log('Read-only squad view remains available; Ctrl-C closes it.'); await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true })); }
} finally { await writer; await dashboard?.close(); }
