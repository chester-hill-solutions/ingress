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
 * Opt-in, and it spends model budget: `node scripts/coordinator-trial.mjs --real`.
 */

import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { selectedProfile } from '../src/profile.mjs';
import { startOpenCode } from '../src/process.mjs';
import { OpenCodeClient, safeRuntimeError } from '../src/opencode.mjs';
import { installBenchmarkPlugin } from '../src/benchmark-plugin.mjs';
import { mapMissions, verifyMapMission } from '../fixtures/missions/map.mjs';

if (process.argv.slice(2).join(' ') !== '--real') throw Error('Opt-in coordinator trial: --real');

const fixture = mapMissions[0];
const deadlineMs = Number(process.env.INGRESS_COORDINATOR_DEADLINE_MS ?? 900_000);
const fenceTtlMs = Number(process.env.INGRESS_NATIVE_FENCE_TTL_MS ?? 90_000);
const base = await realpath(await mkdtemp(join(tmpdir(), 'ingress-coordinator-')));
const workspace = join(base, 'workspace');
const bridge = join(base, 'bridge');
await mkdir(bridge, { recursive: true });
for (const [path, content] of Object.entries(fixture.files)) {
  await mkdir(dirname(join(workspace, path)), { recursive: true });
  await writeFile(join(workspace, path), content);
}

const evidence = { kind: 'coordinator-trial', mission: fixture.id, date: new Date().toISOString(), fenceTtlMs, deadlineMs, actorOutcomes: [] };
let host; const clients = [];
try {
  const plugin = await installBenchmarkPlugin(workspace, bridge, { fenceTtlMs });
  evidence.fenced = plugin.fenceTtlMs !== null;
  const profile = await selectedProfile();
  evidence.model = profile.model;
  host = await startOpenCode({ ...profile, directory: workspace, stateDir: join(bridge, 'state') });
  const signal = AbortSignal.timeout(deadlineMs);
  // The last matching rule wins, so the shell denial must come last: file tools and the
  // subagent tool are allowed, shell is not. An earlier order put the deny first and the
  // wildcard allow overrode it, which let the coordinator run 29 shell commands.
  const client = new OpenCodeClient({ ...host, directory: workspace, model: profile.model, permissions: [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'deny' },
  ] });
  clients.push(client);
  const sessionID = await client.createSession('Ontario Drive coordinator', signal);
  evidence.sessionID = sessionID;
  const task = [
    'You are the coordinator for a team building the application described in PRODUCT.md.',
    'Read PRODUCT.md and the seeded files first. Decompose the work and delegate the modules to subagents using your subagent tool; do the integration and the shared view yourself.',
    'Build the complete application. Preserve every protected file byte-for-byte.',
    'Finish when the application is complete.',
  ].join(' ');
  const started = Date.now();
  try {
    await client.prompt(sessionID, task, { id: 'msg_coordinator_' + randomUUID().replaceAll('-', ''), signal });
    evidence.terminal = await client.wait(sessionID, signal, { pollIntervalMs: 500 });
  } catch (error) { evidence.error = safeRuntimeError(error); }
  evidence.elapsedMs = Date.now() - started;
} catch (error) {
  evidence.error = safeRuntimeError(error);
} finally {
  for (const client of clients) client.close();
  try { await host?.close(); evidence.stopped = true; } catch { evidence.stopped = false; }
}

const receipts = (await readFile(join(bridge, 'receipts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const fence = receipts.filter(row => row.type === 'fence');
evidence.fenceDecisions = fence.length;
evidence.fenceDenied = fence.filter(row => row.decision === 'deny').length;
evidence.fenceBySession = fence.filter(row => row.decision === 'deny').reduce((all, row) => { all[row.sessionID] = (all[row.sessionID] ?? 0) + 1; return all; }, {});
evidence.toolReceipts = receipts.filter(row => row.type === 'tool.after').length;

try {
  const verification = await verifyMapMission(fixture.id, workspace);
  evidence.verification = { correct: verification.correct, passed: verification.checks.filter(c => c.passed).length, total: verification.checks.length,
    failed: verification.checks.filter(c => !c.passed).map(c => c.name), isolationRefused: verification.isolationRefused };
} catch (error) { evidence.verificationError = safeRuntimeError(error); }

await writeFile(join(base, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 1));
