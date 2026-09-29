import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { selectedProfile } from '../src/profile.mjs';
import { runRealTrial } from '../src/trial.mjs';
import { runApparatus } from '../src/apparatus.mjs';
import { startDashboard } from '../src/dashboard.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--real', '--serve', '--baseline', '--awareness'].includes(arg))) throw new Error('Supported options: --real --serve --baseline --awareness');
const abort = new AbortController();
const stop = () => abort.abort(new Error('probe_cancelled'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const output = resolve(import.meta.dirname, '../artifacts', randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const view = { phase: 'Starting', state: null, events: [], results: [] };
const results = [], dashboard = args.includes('--serve') ? await startDashboard(() => view) : null;
if (dashboard) console.log(`Live view: ${dashboard.url}`);
const update = value => { Object.assign(view, value, { results }); dashboard?.push(); };
const fingerprintPaths = ['scripts/probe.mjs', ...(await readdir(resolve(import.meta.dirname, '../src'))).filter(name => name.endsWith('.mjs')).sort().map(name => 'src/' + name), 'fixtures/money.mjs'];
const sourceFingerprints = Object.fromEntries(await Promise.all(fingerprintPaths.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, '..', path))).digest('hex')])));
const evidence = { version: 2, sourceFingerprints, date: new Date().toISOString(), mode: args.includes('--real') ? 'real-native-diagnostic' : 'deterministic-apparatus', results };
try {
  if (args.includes('--real')) {
    const profile = await selectedProfile();
    console.log(`Model: ${profile.model.providerID}/${profile.model.id}`);
    const order = args.includes('--baseline') ? [false] : args.includes('--awareness') ? [true] : randomInt(2) ? [true, false] : [false, true];
    evidence.order = order.map(awareness => awareness ? 'awareness-enabled' : 'awareness-disabled');
    for (const awareness of order) {
      if (abort.signal.aborted) break;
      console.log(`Assigned trial: ${awareness ? 'awareness-enabled' : 'awareness-disabled'}`);
      let priorPhase;
      const result = await runRealTrial({ profile, awareness, signal: abort.signal, onUpdate(value) { update(value); if (value.phase !== priorPhase) { priorPhase = value.phase; console.log(value.phase); } } });
      results.push(result); dashboard?.push();
      await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ condition: result.condition, correct: result.verification.correct, readBarrier: result.readBarrier, admissionOverlap: result.admissionOverlap ?? false, executionOverlap: result.executionOverlap ?? null, notificationOpportunity: result.notificationOpportunity, notices: result.notices.map(n => n.status), errors: result.errors }));
    }
  } else {
    results.push(await runApparatus(update)); update({ phase: 'Deterministic apparatus complete; real-agent behavior unqualified' });
  }
  evidence.completed = new Date().toISOString();
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${join(output, 'evidence.json')}`);
  if (dashboard && !abort.signal.aborted) {
    console.log('Read-only live view remains available; Ctrl-C closes it.');
    await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
  }
} finally { await dashboard?.close(); }
