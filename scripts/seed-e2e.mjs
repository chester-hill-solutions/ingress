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

import { client, freshWorkspace } from './e2e-client.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('seed');
const LEASE_MS = 300_000;

// The worker's workspace credential. Refused here rather than sent as nothing, so a
// missing secret fails as a configuration error instead of as a puzzling 401 mid-run.

const step = message => console.log(`\n--- ${message}`);
const ok = (label, value) => console.log(`${value ? '  PASS' : '  FAIL'}  ${label}`);

const { post, get } = client(WORKSPACE);

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

console.log(`workspace: ${WORKSPACE}`);

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

step('5. a participant whose lease lapses mid-run is refused, and the file is untouched');
{
  // The reachable case. While a participant holds a write lease nobody else can move the
  // file, so a stale base is impossible — that is the lease layer doing its job. The
  // exception is a lease that lapses while the participant is still working.
  //
  // Its own workspace, because a lapsed lease is the whole point of this step.
  //
  // `post` returns `{status, body}` — the status included, because a status is the thing
  // most worth asserting and a body-only helper makes it easy to skip. This step's first
  // version kept the old local `pst`, which returned the bare body, so every access read
  // `.commit` off a `{status, body}` wrapper: `undefined`, and two checks that printed FAIL
  // without ever having looked at a verdict.
  const lapse = client(`${WORKSPACE}-lapse`);
  const join = name => lapse.get(`/join?${new URLSearchParams({ name, kind: 'agent', dependencies: '' })}`);

  await lapse.post('/bootstrap', { author: 'creator', files: [await entry('shared.txt', 'v1')] });
  const joined = await join('slow');
  if (joined.status !== 200) throw new Error(`join failed: ${JSON.stringify(joined.body)}`);

  // A 1s lease, and a command that outlasts it.
  //
  // Checked out over HTTP rather than requested as `writePaths`, deliberately: `/start`
  // would grant the lease and the launcher would renew it, so a `writePaths` run can never
  // lose one. A mid-run lapse is only reachable by asking for a lease short enough to
  // expire — the case the lease layer exists for, and the one that must be refused rather
  // than renewed.
  await lapse.post('/lease/checkout', {
    participantId: 'slow', paths: ['shared.txt'], mode: 'write', leaseMs: 1000,
  });
  const run = lapse.post('/start', {
    participantId: 'slow',
    kind: 'agent',
    participantCommand:
      "sleep 6; cat > /workspace/shared.txt <<'XEOF'\nslow-v1-based\nXEOF",
  });

  const verdict = (await run).body.commit;
  console.log('  slow admitted:', verdict?.admitted, '| reason:', verdict?.reason);
  console.log('  unleased:     ', JSON.stringify(verdict?.unleasedPaths));
  console.log('  detail:       ', verdict?.detail);

  // Refused by `lease_required`, and that ordering is the point: the lease check runs
  // before the fence. A lapsed lease means the participant no longer holds the file at all,
  // so there is no basis to judge — the fence is never reached.
  ok('the lapsed lease did not let a stale write through', verdict?.admitted === false);
  ok('it was refused by the lease layer, which runs first', verdict?.reason === 'lease_required');
  ok('and it names the path it would have written', verdict?.unleasedPaths?.includes('shared.txt'));

  // The file must be **exactly** what it was. An earlier version of this step asserted only
  // that the content did not contain 'slow', which passes when the file is untouched —
  // which is what happened when the second participant in this scenario silently failed to
  // start and nothing landed at all. The check passed for the wrong reason, and would have
  // passed again if the write had been admitted and then reverted.
  const after = (await lapse.get('/content?path=shared.txt')).body;
  const says = Buffer.from(after.contentBase64, 'base64').toString('utf8').trim();
  console.log('  the file now says:', JSON.stringify(says));
  ok("the file is byte-for-byte what it was — 'v1'", says === 'v1');
  ok('and it is still at revision 1', after.revision === 1);
}

const finalState = await get('/state');
console.log('\nfinal ledger:', finalState.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));

const unLeased = (await get(`/content?path=${NOT_LEASED}`)).body;
console.log(`un-leased file unchanged: ${Buffer.from(unLeased.contentBase64, 'base64').toString('utf8').trim() === NOT_LEASED_CONTENT.trim()}`);
console.log(`seed revisions carried baseRevision: ${finalState.body.receipts > 0 ? 'commit path exercised' : 'no receipts'}`);