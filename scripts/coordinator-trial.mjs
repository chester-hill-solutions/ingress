/**
 * A coordinator trial: one agent, given the whole goal, delegating to subagents.
 *
 * Why this exists
 *
 * The flat mission roster has no hierarchy: eight peers each own files and the only shared
 * state is the injected context. Contention there is incidental -- the Ontario Drive
 * collision happened because one agent wandered into another's file, and it did not recur on
 * the next run. Forcing contention with a fixture would measure a workload nobody runs.
 *
 * The realistic shape is a coordinator: one agent that decomposes the goal, spawns subagents
 * to do the parts, and integrates. That creates shared-file contention naturally, because the
 * coordinator edits the same shell the subagents wire into. And it is the shape the fence is
 * for -- subagent sessions have distinct ids, so the fence arbitrates between them.
 *
 * What it measures
 *
 *   - whether a coordinator can drive the mission to a correct result at all
 *   - how many writes the fence refuses, and to whom (the cost of arbitration)
 *   - whether the collision the flat roster produced is prevented
 *
 * And, when `INGRESS_COORDINATOR_CONTEXT` is on (default), whether Ingress peer context helps
 * a coordinator that already works. The context is built from a live `WorkspaceState` fed by
 * a file observer, and served to every session -- the coordinator by id, subagents through the
 * plugin's `default` entry, since their session ids are created at runtime.
 *
 * Opt-in, and it spends model budget:
 *   node scripts/coordinator-trial.mjs --real [--runs=N]
 */

import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { selectedProfile } from '../src/profile.mjs';
import { startOpenCode } from '../src/process.mjs';
import { OpenCodeClient, safeRuntimeError } from '../src/opencode.mjs';
import { installBenchmarkPlugin } from '../src/benchmark-plugin.mjs';
import { WorkspaceState } from '../src/workspace-state.mjs';
import { assembleAgentContext } from '../src/context.mjs';
import { boundedBenchmarkContext } from '../src/benchmark.mjs';
import { observeFiles } from '../src/file-observer.mjs';
import { mapMissions, verifyMapMission } from '../fixtures/missions/map.mjs';

const args = process.argv.slice(2);
if (!args.includes('--real')) throw Error('Opt-in coordinator trial: --real [--runs=N]');
const runsArg = args.find(arg => arg.startsWith('--runs='));
const runs = runsArg === undefined ? 1 : Number(runsArg.slice('--runs='.length));
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw Error('invalid_run_count');
if (args.some(arg => arg !== '--real' && !arg.startsWith('--runs='))) throw Error('unknown_argument');

const fixture = mapMissions[0];
const deadlineMs = Number(process.env.INGRESS_COORDINATOR_DEADLINE_MS ?? 900_000);
const fenceTtlMs = Number(process.env.INGRESS_NATIVE_FENCE_TTL_MS ?? 90_000);
const withContext = process.env.INGRESS_COORDINATOR_CONTEXT !== 'off';
const profile = await selectedProfile();

const task = [
  'You are the coordinator for a team building the application described in PRODUCT.md.',
  'Read PRODUCT.md and the seeded files first. Decompose the work and delegate the modules to subagents using your subagent tool; do the integration and the shared view yourself.',
  'Build the complete application. Preserve every protected file byte-for-byte.',
  'Finish when the application is complete.',
].join(' ');

async function runOnce(index) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ingress-coordinator-')));
  const workspace = join(base, 'workspace');
  const bridge = join(base, 'bridge');
  await mkdir(bridge, { recursive: true });
  for (const [path, content] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }

  const result = { index, base, fenceTtlMs, withContext, model: profile.model };
  let host; const clients = []; let observer; let cacheTimer;
  try {
    const plugin = await installBenchmarkPlugin(workspace, bridge, { fenceTtlMs });
    result.fenced = plugin.fenceTtlMs !== null;
    host = await startOpenCode({ ...profile, directory: workspace, stateDir: join(bridge, 'state') });
    const signal = AbortSignal.timeout(deadlineMs);
    const client = new OpenCodeClient({ ...host, directory: workspace, model: profile.model, permissions: [
      // The last matching rule wins, so the shell denial must come last.
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ] });
    clients.push(client);
    const sessionID = await client.createSession('Ontario Drive coordinator', signal);
    result.sessionID = sessionID;

    if (withContext) {
      const state = new WorkspaceState({ epoch: randomUUID() });
      state.register({ id: 'coordinator', sessionID, generation: 1, task: { id: 'coordinator', text: task, revision: 1 }, dependencies: [] });
      observer = await observeFiles({ root: workspace, paths: Object.keys(fixture.files), epoch: state.epoch, intervalMs: 200,
        onObservation: event => state.ingest(event), signal });
      const compile = () => {
        const join = state.joinFile('coordinator', fixture.editablePaths[0]);
        const projection = boundedBenchmarkContext(assembleAgentContext({ state, participantID: 'coordinator', join }), 32768);
        return { revision: state.version, compiledAt: Date.now(), actors: {}, default: { condition: 'awareness-on', contextID: projection.context.contextID, text: projection.text, bytes: projection.bytes } };
      };
      const write = () => writeFile(plugin.cachePath, JSON.stringify(compile()));
      await write();
      cacheTimer = setInterval(() => { void write().catch(() => {}); }, 500);
    }

    const started = Date.now();
    try {
      await client.prompt(sessionID, task, { id: 'msg_coordinator_' + randomUUID().replaceAll('-', ''), signal });
      result.terminal = await client.wait(sessionID, signal, { pollIntervalMs: 500 });
    } catch (error) { result.error = safeRuntimeError(error); }
    result.elapsedMs = Date.now() - started;
  } catch (error) {
    result.error = safeRuntimeError(error);
  } finally {
    clearInterval(cacheTimer);
    try { observer?.close(); } catch { /* observer close is best effort */ }
    for (const client of clients) client.close();
    try { await host?.close(); result.stopped = true; } catch { result.stopped = false; }
  }

  const receipts = (await readFile(join(bridge, 'receipts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const fence = receipts.filter(row => row.type === 'fence');
  result.fenceDecisions = fence.length;
  result.fenceDenied = fence.filter(row => row.decision === 'deny').length;
  result.sessions = new Set(receipts.filter(row => row.sessionID).map(row => row.sessionID)).size;
  result.subagentCalls = receipts.filter(row => row.type === 'tool.after' && row.tool === 'subagent').length;
  result.contextInjected = receipts.some(row => row.type === 'context' && row.injected === true);
  result.contextRequests = receipts.filter(row => row.type === 'request' && row.markerPresent === true).length;

  try {
    const verification = await verifyMapMission(fixture.id, workspace);
    result.verification = { correct: verification.correct, passed: verification.checks.filter(c => c.passed).length, total: verification.checks.length,
      failed: verification.checks.filter(c => !c.passed).map(c => c.name), isolationRefused: verification.isolationRefused };
  } catch (error) { result.verificationError = safeRuntimeError(error); }
  return result;
}

const results = [];
for (let index = 1; index <= runs; index++) {
  const result = await runOnce(index);
  results.push(result);
  console.log(`run ${index}: ${JSON.stringify({ outcome: result.terminal?.outcome ?? null, passed: result.verification?.passed, total: result.verification?.total,
    failed: result.verification?.failed, fenceDenied: result.fenceDenied, sessions: result.sessions, subagents: result.subagentCalls, contextInjected: result.contextInjected, elapsedMs: result.elapsedMs })}`);
}

const summary = { kind: 'coordinator-trial', mission: fixture.id, date: new Date().toISOString(), model: profile.model, withContext, fenceTtlMs, runs,
  results: results.map(r => ({ index: r.index, base: r.base, outcome: r.terminal?.outcome ?? null, error: r.error ?? null, elapsedMs: r.elapsedMs,
    passed: r.verification?.passed ?? null, total: r.verification?.total ?? null, failed: r.verification?.failed ?? null,
    fenceDenied: r.fenceDenied, sessions: r.sessions, subagents: r.subagentCalls, contextInjected: r.contextInjected })) };
await writeFile(join(process.cwd(), 'artifacts', `coordinator-trial-${Date.now()}.json`), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 1));
