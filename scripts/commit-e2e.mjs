/**
 * The full path, against deployed infrastructure.
 *
 * Nothing here is simulated. A real container starts, a real command runs inside
 * it, the command writes real files, the workspace's own launcher hashes them,
 * and the commit arrives at a WorkerEntrypoint that the platform put in the
 * container's way. The Durable Object then decides.
 *
 * The scenario is the one the product exists for:
 *
 *   1. a workspace is created with a shared dependency
 *   2. participant A runs in a container, reads the dependency, commits a file
 *   3. participant B runs in a container and rewrites the dependency
 *   4. participant C runs in a container from a STALE read and tries to commit
 *      -> the workspace refuses, with evidence, and C's bytes do not land
 *   5. C re-reads and commits again
 *      -> admitted
 *
 * Step 4 is the product. Everything else is setup.
 */

import { sha256Hex } from '../src/product/commit.mjs';
import { MANIFEST_VERSION } from '../src/product/manifest.mjs';

const BASE = (process.env.INGRESS_BASE_URL ?? 'https://ingress-workspace.narfin.workers.dev')
  .replace(/\/+$/, '');
const WORKSPACE = process.env.INGRESS_WORKSPACE ?? `live-${Date.now()}`;

const url = suffix => `${BASE}/w/${WORKSPACE}${suffix}`;

const post = async (suffix, body) => {
  const response = await fetch(url(suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const get = async suffix => {
  const response = await fetch(url(suffix));
  return { status: response.status, body: await response.json() };
};
const asEntry = async (path, content) => ({
  path,
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const step = message => console.log(`\n--- ${message}`);

console.log(`workspace: ${url('')}`);


// --- 1. the workspace starts from an authored tree ----------------------
step('1. bootstrap the starting tree');
{
  const { status, body } = await post('/bootstrap', {
    author: 'creator',
    files: [await asEntry('engine.mjs', 'export const version = 1;\n')],
  });
  console.log('status', status, JSON.stringify(body));
}

// --- 2. participant A: a real container, a real command, a real commit ---
step('2. participant A commits from inside a container');
await fetch(`${BASE}/w/${WORKSPACE}/join?name=A&kind=agent&dependencies=engine.mjs`).then(r => r.json())
  .then(e => console.log('A joined; sees', e.participants.length, 'peer(s)'));
await post('/read', { participantId: 'A', path: 'engine.mjs' });
{
  const { status, body } = await post('/start', {
    participantId: 'A',
    kind: 'agent',
    participantCommand:
      "cat > /workspace/from-a.txt <<'EOF'\nexport const fromA = 'participant A wrote this inside a container';\nEOF",
  });
  console.log('status', status, '| admitted:', body.commit?.admitted, '| landed:', JSON.stringify(body.commit?.landed));
}

const stateAfterA = await get('/state');
console.log('files now:', stateAfterA.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

// --- 3. participant C arrives and reads the shared dependency ----------
step('3. participant C reads engine.mjs at revision 1');
await fetch(`${BASE}/w/${WORKSPACE}/join?name=C&kind=agent&dependencies=engine.mjs`).then(r => r.json());
await post('/read', { participantId: 'C', path: 'engine.mjs' });
{
  const cut = await fetch(`${BASE}/w/${WORKSPACE}/join?name=C&kind=agent&dependencies=engine.mjs`).then(r => r.json());
  const dep = cut.dependencies.find(d => d.path === 'engine.mjs');
  console.log("C's view of engine.mjs: revision", dep.revision, '| stale:', dep.stale);
}

// --- 4. participant B moves the shared dependency out from under C ------
step('4. participant B rewrites engine.mjs from inside a container');
await fetch(`${BASE}/w/${WORKSPACE}/join?name=B&kind=human&dependencies=`).then(r => r.json());
{
  const { status, body } = await post('/start', {
    participantId: 'B',
    kind: 'human',
    participantCommand:
      "cat > /workspace/engine.mjs <<'EOF'\nexport const version = 2; export const addedBy = 'B';\nEOF",
  });
  console.log('status', status, '| admitted:', body.commit?.admitted, '| landed:', JSON.stringify(body.commit?.landed));
}

const stateAfterB = await get('/state');
console.log('files now:', stateAfterB.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

// --- 5. participant C commits from a stale read: REFUSED ---------------
step('5. participant C commits from a stale read');
{
  const { status, body } = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    participantCommand:
      "cat > /workspace/from-c.txt <<'EOF'\nexport const fromC = 'C wrote this without noticing B moved engine.mjs';\nEOF",
  });
  console.log('status', status);
  console.log('admitted:', body.commit?.admitted);
  console.log('reason:  ', body.commit?.reason);
  console.log('refusals:', JSON.stringify(body.commit?.refusals, null, 1));
}

const afterC = await get('/state');
console.log('files now:', afterC.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
const cContent = await get('/content?path=from-c.txt');
console.log("C's file landed?", cContent.status === 200 ? 'YES (fence failed)' : 'NO (fence held)');

// --- 5. C re-reads and commits again: ADMITTED --------------------------
step('6. C re-reads and commits again');
await post('/read', { participantId: 'C', path: 'engine.mjs' });
{
  const { status, body } = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    participantCommand:
      "cat > /workspace/from-c.txt <<'EOF'\nexport const fromC = 'C re-read, so this is based on what is actually there';\nEOF",
  });
  console.log('status', status);
  console.log('admitted:', body.commit?.admitted);
  console.log('landed: ', JSON.stringify(body.commit?.landed));
}

const finalState = await get('/state');
console.log('\nfinal ledger:', finalState.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
const finalC = await get('/content?path=from-c.txt');
if (finalC.status === 200) {
  console.log("C's admitted content:", Buffer.from(finalC.body.contentBase64, 'base64').toString('utf8').trim());
}

// --- receipts -----------------------------------------------------------
step('receipts');
for (const who of ['A', 'B', 'C']) {
  const { body } = await get(`/receipts?participant=${who}`);
  console.log(`${who}:`, JSON.stringify(body.receipts.map(r => ({
    reason: r.reason,
    paths: r.paths ?? r.path,
    exit: r.participantExit,
  }))));
}

const verdict =
  cContent.status === 404 &&
  finalC.status === 200 &&
  finalState.body.files.some(f => f.path === 'from-c.txt' && f.author === 'C');
console.log('\nVERDICT:', verdict ? 'THE FENCE HELD ON CLOUDFLARE' : 'THE FENCE DID NOT HOLD');
process.exit(verdict ? 0 : 1);