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

import { client, freshWorkspace } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';
import { MANIFEST_VERSION } from '../src/product/manifest.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('live');


const { post, get } = client(WORKSPACE);
const asEntry = async (path, content) => ({
  path,
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const step = message => console.log(`\n--- ${message}`);

// A commit requires a write lease on every file it touches. Every `/start` below passes
// `writePaths`, and the workspace grants the lease from that — the container renews it for
// as long as the command runs and gives it back as it exits.
//
// This helper used to do it by hand, with `leaseMs: 300000` on every call, and every call
// had to be followed by a matching release. That `300000` was not a choice: the default
// lease is 60 s, and a container takes tens of seconds to boot, so a command of any
// length would lose its lease and have its commit refused with `lease_required`. The
// number encoded a bug as a magic constant, in four places, and the default said nothing
// about it. Nothing here needs it now, so nothing here has it.

/**
 * Read a dependency, the way a participant must: take a lease and receive the content.
 *
 * There is no `/read` route. A read is recorded by the workspace handing the bytes over,
 * so the handover *is* the read record. The lease is then released, which is what makes
 * the rest of this scenario reachable: a read lease is exclusive against a write, so a
 * reader that never lets go would make step 4 impossible rather than stale.
 *
 * The read record outlives the lease, because it lives in the ledger. That is what makes
 * step 4 work — the fence compares the revision C was handed against the one now there.
 */
const readThenRelease = async (participantId, path) => {
  // The default 60 s, with no override. This lease lives for the length of one HTTP round
  // trip, so a long one would buy nothing — and specifying one here was the habit item 7
  // is removing, so it is left where the default is visibly sufficient rather than where
  // it is quietly over-specified.
  const { status, body } = await post('/lease/checkout', {
    participantId, paths: [path], mode: 'read',
  });
  if (status !== 200) {
    throw new Error(`read lease for ${participantId} on ${path} refused: ${JSON.stringify(body)}`);
  }
  const file = body.files.find(f => f.path === path);
  console.log(`  ${participantId} was handed ${path} at revision ${file.revision}, by ${file.author}`);
  const released = await post('/lease/release', { leaseId: body.leaseId, participantId });
  if (released.status !== 200) throw new Error(`release refused: ${JSON.stringify(released.body)}`);
  return file;
};

console.log(`workspace: ${WORKSPACE}`);


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
await get('/join?name=A&kind=agent&dependencies=engine.mjs').then(r => r.body)
  .then(e => console.log('A joined; sees', e.participants.length, 'peer(s)'));
await readThenRelease('A', 'engine.mjs');
{
  // `writePaths` and no `leaseFor`. Before item 7 the harness had to check the lease out
  // itself and remember to release it afterwards; `/start` now grants it, the container
  // renews it for as long as the command runs, and the launcher gives it back.
  const { status, body } = await post('/start', {
    participantId: 'A',
    kind: 'agent',
    writePaths: ['from-a.txt'],
    participantCommand:
      "cat > /workspace/from-a.txt <<'EOF'\nexport const fromA = 'participant A wrote this inside a container';\nEOF",
  });
  console.log('status', status, '| admitted:', body.commit?.admitted, '| landed:', JSON.stringify(body.commit?.landed));
  if (!body.commit?.admitted) throw new Error(`A's commit was refused: ${JSON.stringify(body.commit)}`);
}

const stateAfterA = await get('/state');
console.log('files now:', stateAfterA.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

// --- 3. participant C arrives and reads the shared dependency ----------
step('3. participant C reads engine.mjs at revision 1');
await get('/join?name=C&kind=agent&dependencies=engine.mjs').then(r => r.body);
await readThenRelease('C', 'engine.mjs');
{
  const cut = await get('/join?name=C&kind=agent&dependencies=engine.mjs').then(r => r.body);
  const dep = cut.dependencies.find(d => d.path === 'engine.mjs');
  console.log("C's view of engine.mjs: revision", dep.revision, '| stale:', dep.stale);
}

// --- 4. participant B moves the shared dependency out from under C ------
step('4. participant B rewrites engine.mjs from inside a container');
await get('/join?name=B&kind=human&dependencies=').then(r => r.body);
{
  const { status, body } = await post('/start', {
    participantId: 'B',
    kind: 'human',
    writePaths: ['engine.mjs'],
    participantCommand:
      "cat > /workspace/engine.mjs <<'EOF'\nexport const version = 2; export const addedBy = 'B';\nEOF",
  });
  console.log('status', status, '| admitted:', body.commit?.admitted, '| landed:', JSON.stringify(body.commit?.landed));
  if (!body.commit?.admitted) throw new Error(`B's commit was refused: ${JSON.stringify(body.commit)}`);
  // No explicit release, and none needed. The launcher gives the lease back as it exits,
  // which is what makes step 6 reachable: a read lease is exclusive against a write, so
  // while B held engine.mjs nobody else could even read it, let alone re-read it.
}

const stateAfterB = await get('/state');
console.log('files now:', stateAfterB.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

// --- 5. participant C commits from a stale read: REFUSED ---------------
step('5. participant C commits from a stale read');
{
  const { status, body } = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    writePaths: ['from-c.txt'],
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

// --- 6. C re-reads and commits again: ADMITTED --------------------------
step('6. C re-reads and commits again');
{
  // Re-read through a lease, not `POST /read`. The re-read lands on revision 2, so the
  // fence now sees a current basis and the same work is admitted. This is the whole
  // product: not "conflict detected" but "conflict detected, and the way out is a
  // re-read".
  const handed = await readThenRelease('C', 'engine.mjs');
  if (handed.revision !== 2) {
    throw new Error(`C re-read engine.mjs at revision ${handed.revision}, expected 2`);
  }

  const { status, body } = await post('/start', {
    participantId: 'C',
    kind: 'agent',
    writePaths: ['from-c.txt'],
    participantCommand:
      "cat > /workspace/from-c.txt <<'EOF'\nexport const fromC = 'C re-read, so this is based on what is actually there';\nEOF",
  });
  console.log('status', status);
  console.log('admitted:', body.commit?.admitted);
  console.log('landed: ', JSON.stringify(body.commit?.landed));
  if (!body.commit?.admitted) throw new Error(`C's second commit was refused: ${JSON.stringify(body.commit)}`);
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

// --- 7. a run longer than the lease still commits -------------------------
// The bug item 7 exists to fix, observed rather than asserted.
//
// A lease defaults to 60s and the participant command runs to completion. Before this,
// the harness had to lease for 300,000 ms to survive its own default: any task over a
// minute lost its lease and had its commit refused with `lease_required`, with nothing in
// the request saying why. Now `/start` issues the lease and the launcher renews it.
//
// `sleep 75` outlives the 60-second default by a quarter of a minute, so if the renewal
// did not work the commit is refused and this step says so. It costs about 75 seconds of
// container time.
step('7. a command that outlives the lease still commits');
const longRun = { admitted: null, reason: null, elapsed: null, revision: null };
{
  await get('/join?name=D&kind=agent&dependencies=').then(r => r.body);

  const started = Date.now();
  const { status, body } = await post('/start', {
    participantId: 'D',
    kind: 'agent',
    // The lease comes from `/start` now — no `leaseFor` call, and no `leaseMs` to guess.
    writePaths: ['from-d.txt'],
    participantCommand:
      "sleep 75\ncat > /workspace/from-d.txt <<'EOF'\nexport const fromD = 'D took longer than the default lease';\nEOF",
  });
  longRun.elapsed = Date.now() - started;

  if (status !== 200) {
    console.log(`  refused to start: ${status} ${JSON.stringify(body)}`);
    longRun.reason = `start_refused_${status}`;
  } else {
    longRun.admitted = body.commit?.admitted ?? null;
    longRun.reason = body.commit?.reason ?? null;
    console.log(`  ran for ${Math.round(longRun.elapsed / 1000)}s (default lease is 60s)`);
    console.log(`  status ${status} | admitted: ${body.commit?.admitted} | reason: ${body.commit?.reason}`);
    if (!body.commit?.admitted) {
      console.log(`  detail: ${body.commit?.detail ?? ''}`);
      console.log(`  unleased: ${JSON.stringify(body.commit?.unleasedPaths ?? [])}`);
    } else {
      const content = await get('/content?path=from-d.txt');
      longRun.revision = content.body.revision ?? null;
      console.log(`  landed from-d.txt@r${longRun.revision}`);
    }
  }
}

// The lease must be back after the run, not merely expired later. If `/start` only
// released at the deadline, the file would still be held here and the next participant
// could not take it.
const afterLongRun = await get('/leases');
const leftover = afterLongRun.body.leases.filter(l => (l.paths ?? []).includes('from-d.txt'));
console.log(`  from-d.txt still leased after the run: ${leftover.length > 0 ? 'YES (blocked until the expiry)' : 'no, released'}`);

console.log('\n--- final ledger');
const ledger = await get('/state');
console.log(ledger.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

// Every participant's lease should be free now that they have all finished. One still
// held means the release path does not work and someone else would wait a minute for it.
const stillHeld = afterLongRun.body.leases.length;
console.log(`live leases remaining: ${stillHeld}`);

const verdict =
  cContent.status === 404 &&
  finalC.status === 200 &&
  finalState.body.files.some(f => f.path === 'from-c.txt' && f.author === 'C');
const longRunOk = longRun.admitted === true && leftover.length === 0;

console.log('\nVERDICT:', verdict ? 'THE FENCE HELD ON CLOUDFLARE' : 'THE FENCE DID NOT HOLD');
console.log('VERDICT:', longRunOk
  ? `A ${Math.round(longRun.elapsed / 1000)}s COMMAND OUTLIVED THE 60s LEASE AND COMMITTED`
  : `A COMMAND LONGER THAN THE LEASE DID NOT COMMIT CLEANLY (${longRun.reason})`);
process.exit(verdict && longRunOk ? 0 : 1);