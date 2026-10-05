/**
 * Leases, against deployed infrastructure.
 *
 * Nothing simulated. Real Durable Object, real HTTP, real contention.
 *
 * The scenario:
 *
 *   1. two participants join a workspace with one shared file
 *   2. A checks out engine.mjs to READ  -> the workspace hands over the content
 *   3. B tries to check out engine.mjs to WRITE -> refused, A is named
 *   4. A releases; B now takes it and commits a real rewrite
 *   5. C commits with NO lease      -> refused, lease_required
 *   6. C takes a lease and commits  -> admitted
 *   7. A tries to start a container with a dead lease holder -> the path frees
 *
 * Steps 3, 5 and 6 are the product. Step 3 is prevention: the collision never
 * happens, rather than being reported after the fact.
 */

import { client, freshWorkspace } from './e2e-client.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('lease');
const LEASE_MS = Number(process.env.INGRESS_LEASE_MS ?? 30_000);

// The worker's workspace credential. Refused here rather than sent as nothing, so a
// missing secret fails as a configuration error instead of as a puzzling 401 mid-run.

const step = message => console.log(`\n--- ${message}`);
const ok = (label, value) => console.log(`${value ? '  PASS' : '  FAIL'}  ${label}`);

const { post, get } = client(WORKSPACE);
const join = async (name, kind, dependencies) =>
  (await get(`/join?name=${encodeURIComponent(name)}&kind=${kind}&dependencies=${dependencies.join(',')}`)).body;

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const { sha256Hex } = await import('../src/product/commit.mjs');
const { MANIFEST_VERSION } = await import('../src/product/manifest.mjs');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

console.log(`workspace: ${WORKSPACE}`);

step('1. bootstrap and join');
{
  const seeded = await post('/bootstrap', { author: 'creator', files: [await entry('engine.mjs', 'export const version = 1;\n')] });
  console.log('  bootstrap:', JSON.stringify(seeded.body));
  await join('A', 'agent', ['engine.mjs']);
  await join('B', 'agent', []);
  await join('C', 'agent', []);
  console.log('  A, B and C joined');
}

step('2. A checks out engine.mjs to READ — the workspace hands over the content');
let aLease;
{
  const response = await post('/lease/checkout', { participantId: 'A', paths: ['engine.mjs'], mode: 'read', leaseMs: LEASE_MS });
  aLease = response.body;
  console.log('  status', response.status);
  console.log('  granted:', aLease.granted, '| expiresAt:', new Date(aLease.expiresAt).toISOString());
  const file = aLease.files.find(f => f.path === 'engine.mjs');
  console.log('  engine.mjs @r' + file.revision, 'by', file.author);
  console.log('  content:', JSON.stringify(Buffer.from(file.contentBase64, 'base64').toString('utf8').trim()));
  console.log('  includedDependencies:', JSON.stringify(aLease.includedDependencies));
  ok('the read is served by the workspace, not self-reported', file.contentBase64 !== null);
}

step('3. B tries to WRITE engine.mjs while A holds it — refused');
{
  const response = await post('/lease/checkout', { participantId: 'B', paths: ['engine.mjs'], mode: 'write', leaseMs: LEASE_MS });
  console.log('  status', response.status, '| reason:', response.body.reason);
  console.log('  blockedOn:', JSON.stringify(response.body.blockedOn));
  console.log('  conflicts:', JSON.stringify(response.body.conflicts));
  ok('the writer is refused and the reader is named', response.status === 409 && response.body.blockedOn?.includes('A'));
}

step('4. A releases; B takes the file and commits a real rewrite');
{
  const released = await post('/lease/release', { leaseId: aLease.leaseId, participantId: 'A' });
  console.log('  released:', JSON.stringify(released.body.released), '| woken:', JSON.stringify(released.body.woken));

  const taken = await post('/lease/checkout', { participantId: 'B', paths: ['engine.mjs'], mode: 'write', leaseMs: LEASE_MS });
  ok('B now holds it', taken.status === 200);

  const started = await post('/start', {
    participantId: 'B',
    kind: 'agent',
    participantCommand: "cat > /workspace/engine.mjs <<'XEOF'\nexport const version = 2; export const by = 'B';\nXEOF",
  });
  const verdict = started.body.commit;
  console.log('  container commit admitted:', verdict?.admitted, '| landed:', JSON.stringify(verdict?.landed ?? verdict?.reason));
  ok('the rewrite landed', verdict?.admitted === true);

  const state = await get('/state');
  console.log('  ledger:', state.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
}

step('5. C commits with NO lease — refused');
{
  await join('C', 'agent', []);
  const started = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    participantCommand: "cat > /workspace/from-c.txt <<'XEOF'\nexport const fromC = 'committed with no lease';\nXEOF",
  });
  const verdict = started.body.commit;
  console.log('  admitted:', verdict?.admitted, '| reason:', verdict?.reason);
  console.log('  detail:  ', verdict?.detail);
  console.log('  hint:    ', verdict?.hint);
  ok('an un-leased commit lands nothing', verdict?.admitted === false && verdict?.reason === 'lease_required');
}

step('6. C takes the lease, then commits — admitted');
{
  const lease = await post('/lease/checkout', { participantId: 'C', paths: ['from-c.txt'], mode: 'write', leaseMs: LEASE_MS });
  console.log('  lease status', lease.status);
  const started = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    participantCommand: "cat > /workspace/from-c.txt <<'XEOF'\nexport const fromC = 'leased, then committed';\nXEOF",
  });
  const verdict = started.body.commit;
  console.log('  admitted:', verdict?.admitted, '| landed:', JSON.stringify(verdict?.landed));
  ok('the same commit is admitted once it is leased', verdict?.admitted === true);
}

step('7. a heartbeat keeps a lease alive; retrieve takes over a dead one');
{
  // C cannot read engine.mjs while B holds it for writing. That refusal is the
  // reader-writer lock working, so the heartbeat is exercised on C's own lease.
  const blockedRead = await post('/lease/checkout', { participantId: 'C', paths: ['engine.mjs'], mode: 'read', leaseMs: LEASE_MS });
  console.log('  C reads engine.mjs while B writes it ->', blockedRead.status, blockedRead.body.reason);
  ok('a reader is still excluded by a writer', blockedRead.status === 409);

  const cLease = (await get('/leases')).body.leases.find(l => l.participantId === 'C');
  const beat = await post('/lease/heartbeat', { leaseId: cLease.leaseId, participantId: 'C', leaseMs: LEASE_MS });
  console.log('  heartbeat alive:', beat.body.alive, '| heldBy:', JSON.stringify(beat.body.heldBy), '| expiresInMs:', beat.body.expiresAt - Date.now());
  ok('a heartbeat keeps the lease alive', beat.body.alive === true);

  const impostor = await post('/lease/heartbeat', { leaseId: cLease.leaseId, participantId: 'A', leaseMs: LEASE_MS });
  console.log('  A beats C\'s lease ->', impostor.status, impostor.body.reason);
  ok('a heartbeat for a lease you do not hold is refused', impostor.status === 409);

  // A short lease that nobody beats: after it lapses the path is recoverable.
  await post('/lease/release', { leaseId: cLease.leaseId, participantId: 'C' });
  const bLease = (await get('/leases')).body.leases.find(l => l.participantId === 'B');
  await post('/lease/release', { leaseId: bLease.leaseId, participantId: 'B' });
  const short = await post('/lease/checkout', { participantId: 'B', paths: ['engine.mjs'], mode: 'write', leaseMs: 1000 });
  console.log('  B holds engine.mjs on a 1s lease:', Boolean(short.body.leaseId));
  ok('B re-took it', short.status === 200);

  const early = await post('/lease/retrieve', { participantId: 'A', paths: ['engine.mjs'] });
  console.log('  retrieve while live ->', early.status, early.body.detail ?? '');
  ok('retrieve refuses a live lease', early.status === 409);

  await new Promise(resolve => setTimeout(resolve, 1400));
  const late = await post('/lease/retrieve', { participantId: 'A', paths: ['engine.mjs'] });
  console.log('  retrieve after expiry ->', late.status, '| reclaimedFrom:', JSON.stringify(late.body.reclaimedFrom));
  console.log('  recovered content:', JSON.stringify(Buffer.from(late.body.files[0].contentBase64, 'base64').toString('utf8').trim()));
  ok('an expired lease is recoverable, and the takeover is recorded', late.status === 200 && late.body.reclaimedFrom?.[0]?.participantId === 'B');
}

const finalState = await get('/state');
console.log('\nfinal ledger:', finalState.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
const held = (await get('/leases')).body.leases;
console.log('live leases:', held.map(l => `${l.participantId}:${l.mode}[${[...l.paths].join(',')}]`).join(' ') || 'none');
console.log(`manifest version in use: ${MANIFEST_VERSION}`);