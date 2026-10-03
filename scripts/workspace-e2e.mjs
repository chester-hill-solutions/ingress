/**
 * End-to-end proof against a deployed Durable Object.
 *
 * Runs the real product scenario over real HTTP on Cloudflare:
 *
 *   1. a human and an agent join the same workspace, both depending on a file
 *   2. the agent reads it
 *   3. the human changes it
 *   4. the agent tries to write  ->  the workspace REFUSES, with evidence
 *   5. the agent re-reads       ->  the same write is admitted
 *
 * Steps 4 and 5 are the product. Everything else is setup.
 */

import { execFileSync } from 'node:child_process';
import { WorkspaceClient, WriteRefused } from '../src/product/workspace-client.mjs';

const WORKER = process.env.INGRESS_WORKER ?? 'ingress-workspace';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '6b149553c5075c79bbc132c481f387fe';

function wranglerBin() {
  return process.env.WRANGLER_BIN ?? execFileSync('which', ['wrangler'], { encoding: 'utf8' }).trim();
}

function hostname() {
  const bin = wranglerBin();
  try {
    const out = execFileSync(bin, ['deployments', 'list', '--name', WORKER, '--json'], { encoding: 'utf8' });
    const rows = JSON.parse(out);
    const host =
      rows?.[0]?.hosts?.[0]?.hostname ??
      rows?.[0]?.url?.replace(/^https:\/\//, '').split('/')[0] ??
      null;
    if (!host) throw new Error('no host in deployments output');
    return host;
  } catch (error) {
    console.error('Could not determine the deployed hostname:', error.message);
    console.error('Falling back to the workers.dev subdomain.');
    return `${WORKER}.workers.dev`;
  }
}

const host = process.env.INGRESS_BASE_URL
  ? process.env.INGRESS_BASE_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  : hostname();
const base = `https://${host}`;
const workspace = `e2e-${Date.now()}`;

console.log(`workspace: ${base}/w/${workspace}`);
const health = await (await fetch(`${base}/health`)).json();
console.log('health:', JSON.stringify(health));

const url = suffix => `${base}/w/${workspace}${suffix}`;

// 1. Two participants, one shared dependency.
const agent = new WorkspaceClient({ baseUrl: url(''), participantId: 'builder', kind: 'agent', dependencies: ['engine.mjs'] });
const human = new WorkspaceClient({ baseUrl: url(''), participantId: 'integrator', kind: 'human', dependencies: ['engine.mjs'] });

await WorkspaceClient.observe(url(''), [{ path: 'engine.mjs', revision: 1, contentHash: 'h1' }]);
await agent.join();
await human.join();
await human.declareIntent('rewriting the engine while the builder works on the UI');
const agentEnvelope = await agent.join();
console.log('agent sees participants:', agentEnvelope.participants.map(p => `${p.participantId}:${p.kind}`).join(', '));
console.log('agent sees human intent:  ', agentEnvelope.participants.find(p => p.participantId === 'integrator')?.intent);

// 2. The agent reads what it will depend on.
await agent.read('engine.mjs');
console.log('agent read engine.mjs at revision 1');

// 3. The human changes it.
await WorkspaceClient.observe(url(''), [{ path: 'engine.mjs', revision: 2, contentHash: 'h2', actorId: 'integrator' }]);
console.log('human wrote engine.mjs revision 2');

// 4. The agent, still working from revision 1, tries to write.
let refused = null;
try {
  await agent.write({ path: 'ui.mjs', contentHash: 'ui-draft' });
  console.log('UNEXPECTED: the stale write was admitted');
} catch (error) {
  if (!(error instanceof WriteRefused)) throw error;
  refused = error.receipt;
}
console.log('\n--- the fence ---');
console.log('admitted:', refused?.admitted);
console.log('reason:  ', refused?.reason);
console.log('evidence:', JSON.stringify(refused?.staleDependencies));
console.log('fingerprint:', refused?.fingerprint?.slice(0, 32));

// 5. Re-read and try again.
await agent.read('engine.mjs');
const retry = await agent.tryWrite({ path: 'ui.mjs', contentHash: 'ui-draft' });
console.log('\nafter re-read, admitted:', retry.admitted);

// Both decisions are retained.
const receipts = await agent.receipts();
console.log('receipts retained for builder:', receipts.receipts.length);

// And the workspace agrees about what exists.
const state = await agent.state();
console.log('files in workspace:', state.files.map(f => `${f.path}@r${f.revision}`).join(', '));

// 6. A third participant arriving now is told what happened, without asking.
const latecomer = new WorkspaceClient({ baseUrl: url(''), participantId: 'latecomer', kind: 'agent', dependencies: ['engine.mjs'] });
const lateEnvelope = await latecomer.join();
console.log('\nlatecomer sees:', lateEnvelope.participants.map(p => p.participantId).join(', '));
console.log('latecomer intent of integrator:', lateEnvelope.participants.find(p => p.participantId === 'integrator')?.intent ?? '(none)');

// 7. A latecomer that never read engine.mjs is refused as unknown, not assumed safe.
const blind = await latecomer.tryWrite({ path: 'blind.mjs' });
console.log('latecomer blind write admitted:', blind.admitted, '| reason:', blind.receipt?.reason ?? '-');

const verdict = refused?.admitted === false && retry.admitted === true;
console.log('\nVERDICT:', verdict ? 'FENCE WORKS ON CLOUDFLARE' : 'FENCE DID NOT HOLD');
process.exit(verdict ? 0 : 1);