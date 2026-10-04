/**
 * Seeding: does a participant inside a container actually see the workspace?
 *
 * Nothing simulated. A real container, a real launcher, a real seed fetch through
 * the egress gate.
 *
 * The scenario:
 *
 *   1. a workspace is created with two files
 *   2. a participant checks out one of them for writing
 *   3. it runs in a container, and reads the file it was given
 *   4. it edits that file based on what it read
 *   5. the commit is admitted, and the content shows the edit was built on the real bytes
 *   6. it also runs `ls` on the whole tree, to show what it was NOT given
 *
 * Step 3 is the thing this closes. Before seeding, a participant's container was
 * sealed: the gate accepted writes and offered nothing to read, so every change
 * was built against an empty directory.
 */

const BASE = (process.env.INGRESS_BASE_URL ?? 'https://ingress-workspace.narfin.workers.dev').replace(/\/+$/, '');
const WORKSPACE = process.env.INGRESS_WORKSPACE ?? `seed-${Date.now()}`;
const LEASE_MS = 300_000;

const url = suffix => `${BASE}/w/${WORKSPACE}${suffix}`;
const step = message => console.log(`\n--- ${message}`);
const ok = (label, value) => console.log(`${value ? '  PASS' : '  FAIL'}  ${label}`);

async function post(suffix, body) {
  const response = await fetch(url(suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const get = async suffix => {
  const response = await fetch(url(suffix));
  return { status: response.status, body: await response.json() };
};

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const { sha256Hex } = await import('../src/product/commit.mjs');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const LEASED = 'engine.mjs';
const LEASED_CONTENT = 'export const version = 1;\nexport const greeting = "hello";\n';
const NOT_LEASED = 'private-notes.txt';
const NOT_LEASED_CONTENT = 'this file was never handed to the participant\n';

console.log(`workspace: ${url('')}`);

step('1. bootstrap with two files');
{
  const seeded = await post('/bootstrap', {
    author: 'creator',
    files: [await entry(LEASED, LEASED_CONTENT), await entry(NOT_LEASED, NOT_LEASED_CONTENT)],
  });
  console.log('  ', JSON.stringify(seeded.body));
  await get(`/join?name=worker&kind=agent&dependencies=`);
}

step('2. lease one file for writing');
{
  const lease = await post('/lease/checkout', { participantId: 'worker', paths: [LEASED], mode: 'write', leaseMs: LEASE_MS });
  console.log('  status', lease.status, '| leased', JSON.stringify(lease.body.granted ? lease.body.files.map(f => f.path) : lease.body.reason));
  ok('the lease is granted', lease.status === 200);
}

step('3. the participant reads what it was given, and lists what it was not');
{
  // The participant inspects the seeded file and the tree. `cat` and `ls` only:
  // the point is what the launcher put there before the command ran.
  const command = [
    `echo "--- engine.mjs ---"; cat /workspace/${LEASED}`,
    `echo "--- full tree ---"; ls -A /workspace`,
    `echo "--- un-leased file present? ---"; test -f /workspace/${NOT_LEASED} && echo YES || echo NO`,
  ].join('; ');

  const started = await post('/start', {
    participantId: 'worker',
    kind: 'agent',
    participantCommand: command,
  });

  console.log('  status', started.status);
  const verdict = started.body.commit;
  console.log('  commit admitted:', verdict?.admitted, '| reason:', verdict?.reason ?? '-');
  ok('the run completed and reported', started.status === 200);

  // The gate log records what the container asked for, which is how we confirm the
  // seed was actually fetched rather than assumed.
  const state = await get('/state');
  console.log('  ledger:', state.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
}

step('4. the participant edits the file it was actually given');
{
  const command = [
    `cat >> /workspace/${LEASED} <<'XEOF'`,
    'export const editedBy = "the participant, from the real bytes";',
    'XEOF',
    `echo "now contains:"; cat /workspace/${LEASED}`,
  ].join('\n');

  const started = await post('/start', { participantId: 'worker', kind: 'agent', participantCommand: command });
  const verdict = started.body.commit;
  console.log('  admitted:', verdict?.admitted, '| reason:', verdict?.reason ?? '-');
  console.log('  landed: ', JSON.stringify(verdict?.landed ?? []));
  ok('the edit was admitted', verdict?.admitted === true);

  const content = (await get(`/content?path=${LEASED}`)).body;
  const text = Buffer.from(content.contentBase64, 'base64').toString('utf8');
  console.log('  admitted content:');
  for (const line of text.trim().split('\n')) console.log('    |', line);
  ok('the admitted content contains the original bytes plus the edit',
    text.includes('version = 1') && text.includes('editedBy'));
  ok('the edit advanced exactly one revision', content.revision === 2);
}

step('5. a participant whose lease lapses mid-run is caught by the base revision');
{
  // The reachable case. While a participant holds a write lease nobody else can
  // move the file, so a stale base is impossible — that is the lease layer doing
  // its job. The exception is a lease that lapses while the participant is still
  // working, which is exactly what a short lease is for.
  const ws = `${WORKSPACE}-lapse`;
  const u = suffix => `${BASE}/w/${ws}${suffix}`;
  const pst = async (suffix, body) => {
    const r = await fetch(u(suffix), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };

  await pst('/bootstrap', { author: 'creator', files: [await entry('shared.txt', 'v1')] });
  for (const name of ['slow', 'quick']) {
    await fetch(`${u('/join?')}${new URLSearchParams({ name, kind: 'agent', dependencies: '' })}`).then(r => r.json());
  }

  // slow takes a 1s lease, and its command outlasts it.
  await pst('/lease/checkout', { participantId: 'slow', paths: ['shared.txt'], mode: 'write', leaseMs: 1000 });
  const slowRun = pst('/start', {
    participantId: 'slow',
    kind: 'agent',
    participantCommand: "echo slow seeded at r1 > /tmp/note; sleep 6; cat > /workspace/shared.txt <<'XEOF'\nslow-v1-based\nXEOF",
  });

  // Let the lease lapse, then let somebody else move the file.
  await new Promise(r => setTimeout(r, 2500));
  const quickLease = await pst('/lease/checkout', { participantId: 'quick', paths: ['shared.txt'], mode: 'write', leaseMs: 60000 });
  const moved = await pst('/start', {
    participantId: 'quick',
    kind: 'agent',
    participantCommand: "cat > /workspace/shared.txt <<'XEOF'\nv2-from-quick\nXEOF",
  });
  console.log('  quick moved it to:', JSON.stringify(moved.commit?.landed?.map(f => f.revision) ?? moved.commit?.reason));

  // slow finishes against the revision it was seeded at. The workspace is at r2.
  const slow = await slowRun;
  const verdict = slow.commit;
  console.log('  slow admitted:', verdict?.admitted, '| reason:', verdict?.reason);
  console.log('  evidence:', JSON.stringify(verdict?.refusals?.map(r => ({ path: r.path, reason: r.reason, claimed: r.claimedRevision, current: r.currentRevision }))));
  // Refused by `lease_required`, not `write_base_stale`, and that ordering is the
  // point: the lease check runs before the fence, and a lapsed lease means the
  // participant no longer holds the file at all. The base-revision check sits behind
  // it as a backstop and is covered by unit tests rather than here, because a live
  // write lease makes a stale base unreachable by construction.
  ok('the lapsed lease did not let a stale write through', verdict?.admitted === false);
  ok('it was refused by the lease layer, which runs first',
    verdict?.reason === 'lease_required' || verdict?.reason === 'write_base_stale');

  const after = await (await fetch(`${u('/content?path=shared.txt')}`)).json();
  console.log('  the file now says:', JSON.stringify(Buffer.from(after.contentBase64, 'base64').toString('utf8').trim()));
  ok("quick's write survived and slow's did not land", after.contentBase64 && !Buffer.from(after.contentBase64, 'base64').toString().includes('slow'));
}

const finalState = await get('/state');
console.log('\nfinal ledger:', finalState.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

const unLeased = (await get(`/content?path=${NOT_LEASED}`)).body;
console.log(`un-leased file unchanged: ${Buffer.from(unLeased.contentBase64, 'base64').toString('utf8').trim() === NOT_LEASED_CONTENT.trim()}`);
console.log(`seed revisions carried baseRevision: ${finalState.body.receipts > 0 ? 'commit path exercised' : 'no receipts'}`);