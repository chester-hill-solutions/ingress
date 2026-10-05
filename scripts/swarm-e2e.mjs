/**
 * A swarm: four agents on one workspace, and what the fence does to each of them.
 *
 * Why this script exists
 *
 * The product was built and hardened against a threat model it does not have. Everything
 * asked "can a stranger holding the token do damage?", and the answer was yes: arbitrary
 * root on the account holder's machine. Meanwhile the actual use is several trusted agents
 * editing one repository, tripping over each other — and *that* is what the fence was for.
 *
 * Running it exposed a defect no amount of reading would have. Dependencies were declared
 * once per participant at `/join` and held for that participant's whole life, and the fence
 * applied that single list to **every file in a commit**. So one stale dependency refused
 * files that had nothing to do with it. In a swarm, the first agent to move any shared file
 * blocks every other agent's entire commit. That is not conflict prevention; it is a
 * barrier, and the pressure a barrier creates is what makes people reach for `--force`,
 * which is worse than the merge conflicts the fence was built to prevent.
 *
 * The fix scopes dependencies to the file: a manifest entry may declare what *it* was built
 * from. A moved dependency then refuses the outputs that actually used it, and nothing else.
 *
 * The four agents below, and what each is here to demonstrate:
 *
 *   A  depends on engine.mjs and rebuilds it          -> admitted
 *   B  declares no inputs, writes something unrelated -> admitted. THIS is the fix. Before
 *                                                       it, A's landing blocked B outright.
 *   C  declares it was built from engine.mjs@r1       -> refused, precisely, and only for the
 *                                                       file that declared it
 *   D  and E  both want engine.mjs at once            -> one wins, the other is told who is
 *                                                       in the way. The conflict case is
 *                                                       unchanged by any of this.
 *
 * Every command runs in a real container. Nothing is simulated.
 */

import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('swarm');
const { post, get } = client(WORKSPACE);

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const entry = async (path, content) => ({
  path,
  contentBase64: b64(content),
  contentHash: await sha256Hex(Buffer.from(content, 'utf8')),
});

const results = [];
const expect = (label, value) => results.push(ok(label, value));

/** Join a participant. `/join` is a GET — posting to it is a 404 that reads like success. */
const join = name => get(`/join?name=${name}&kind=agent&dependencies=`);

/**
 * A participant command that writes one file and declares its provenance.
 *
 * The declaration goes in `.ingress/built-from.json`, which the reporter reads and attaches
 * to the matching manifest entries. It is ignored by the walk, so it can never itself become
 * a workspace file — a participant cannot smuggle its own provenance in as an edit.
 *
 * `builtFrom` omitted entirely means "did not declare", and the workspace falls back to the
 * participant-wide dependency check. The distinction is load-bearing: an empty list is an
 * explicit claim of no inputs, silence is consent to the coarse rule.
 */
const commandWriting = ({ path, content, builtFrom }) => [
  'mkdir -p /workspace/.ingress',
  builtFrom === undefined ? '' : [
    'cat > /workspace/.ingress/built-from.json <<\'INGRESS_BF_EOF\'',
    JSON.stringify(builtFrom),
    'INGRESS_BF_EOF',
  ].join('\n'),
  `cat > /workspace/${path} <<'INGRESS_EOF'`,
  content,
  'INGRESS_EOF',
].filter(Boolean).join('\n');

const start = (participantId, writePaths, participantCommand, runMs = 60_000) =>
  post('/start', { participantId, kind: 'agent', writePaths, runMs, participantCommand });

const revOf = async path => (await get(`/content?path=${path}`)).body.revision ?? null;

console.log(`workspace: ${WORKSPACE}`);

// --- the shared file everyone starts from ---------------------------------------

step('0. bootstrap a shared engine.mjs at revision 1');
const created = await post('/bootstrap', {
  author: 'creator',
  files: [await entry('engine.mjs', 'export const version = 1;\n')],
});
expect('the workspace is bootstrapped', created.status === 200);
expect('and engine.mjs is at revision 1', await revOf('engine.mjs') === 1);

// --- A: depends on engine.mjs, rebuilds it --------------------------------------

step('1. A depends on engine.mjs@r1 and rebuilds it — admitted');
await join('A');
{
  const { status, body } = await start('A', ['engine.mjs'], commandWriting({
    path: 'engine.mjs',
    content: 'export const version = 2;\n',
    builtFrom: { 'engine.mjs': [{ path: 'engine.mjs', revision: 1 }] },
  }));
  expect('A is admitted', body.commit?.admitted === true, `got ${body.commit?.reason}`);
  console.log(`  landed: ${JSON.stringify(body.commit?.landed?.map(f => `${f.path}@r${f.revision}`))}`);
}
expect('engine.mjs is now at revision 2', await revOf('engine.mjs') === 2);

// --- B: declares nothing, and this is the whole point ---------------------------

step('2. B declares no inputs and writes something unrelated — admitted');
await join('B');
{
  const { body } = await start('B', ['unrelated.mjs'], commandWriting({
    path: 'unrelated.mjs',
    content: 'export const u = 1;\n',
    builtFrom: { 'unrelated.mjs': [] },
  }));
  // Before the fix, this is where B was blocked: A had moved a file, and the dependency
  // check applied to every file in B's commit regardless of what B declared.
  expect('B is admitted — A landing does not block an unrelated agent',
    body.commit?.admitted === true, `got ${body.commit?.reason}`);
  console.log(`  landed: ${JSON.stringify(body.commit?.landed?.map(f => `${f.path}@r${f.revision}`))}`);
}

// --- C: genuinely stale, and held precisely --------------------------------------

step('3. C declares it was built from engine.mjs@r1 — refused, precisely');
await join('C');
{
  const { body } = await start('C', ['derived.mjs', 'also-fine.mjs'], commandWriting({
    path: 'derived.mjs',
    content: 'export const d = 1;\n',
    builtFrom: { 'derived.mjs': [{ path: 'engine.mjs', revision: 1 }] },
  }), 60_000);
  const verdict = body.commit;
  console.log(`  admitted: ${verdict?.admitted} | reason: ${verdict?.reason}`);
  console.log(`  refusals: ${JSON.stringify(verdict?.refusals ?? [], null, 1)}`);

  expect('C is refused', verdict?.admitted === false);
  expect('for dependency_moved', verdict?.reason === 'dependency_moved');
  expect('scoped per file, not participant-wide',
    verdict?.refusals?.[0]?.dependencyBasis === 'per_file');
  expect('and it names exactly what moved',
    verdict?.refusals?.[0]?.staleDependencies?.[0]?.path === 'engine.mjs'
    && verdict?.refusals?.[0]?.staleDependencies?.[0]?.currentRevision === 2);
  expect('only the file that declared it is refused',
    verdict?.refusals?.every(r => r.path === 'derived.mjs') === true);
}

// --- D and E: the conflict case, unchanged --------------------------------------

step('4. two agents want engine.mjs at once — one wins, one is told who is in the way');
await join('D');
await join('E');
const dLease = await post('/lease/checkout', {
  participantId: 'D', paths: ['engine.mjs'], mode: 'write',
});
expect('D takes a write lease on engine.mjs', dLease.status === 200);

{
  const blocked = await start('E', ['engine.mjs'], commandWriting({
    path: 'engine.mjs',
    content: 'export const version = 999;\n',
    builtFrom: { 'engine.mjs': [{ path: 'engine.mjs', revision: 2 }] },
  }));
  // Top level, NOT `body.commit`. A start refused before anything is created has no commit
  // verdict at all — `commit` is null — so reading `body.commit.reason` gives `undefined`
  // and the check silently inspects nothing. That is the same level confusion as two other
  // bugs in this session, and the only reason it showed up is that the assertion below
  // expected a specific string rather than merely "not undefined".
  const refusal = blocked.body;
  console.log(`  E -> ${blocked.status} ${refusal.reason}`);
  console.log(`  blockedOn: ${JSON.stringify(refusal.blockedOn)}`);
  // The refusal is the gate refusing the *start*, before any container. That is the same
  // exclusivity that made this scenario reachable at all, and scoping did not weaken it.
  expect('E is refused for the lease, not for a dependency',
    blocked.status === 409 && refusal.reason === 'lease_conflict');
  expect('and it is told who holds it', refusal.blockedOn?.includes('D') === true);
  expect('and no commit verdict is invented for a start that never happened',
    refusal.commit === undefined, 'there was no container, so there is nothing to report');
}

// --- and D can still land, after releasing ---------------------------------------

step('5. D releases and rebuilds — admitted, with correct provenance');
{
  await post('/lease/release', { leaseId: dLease.body.leaseId, participantId: 'D' });
  const { body } = await start('D', ['engine.mjs'], commandWriting({
    path: 'engine.mjs',
    content: 'export const version = 3;\n',
    builtFrom: { 'engine.mjs': [{ path: 'engine.mjs', revision: 2 }] },
  }));
  expect('D is admitted', body.commit?.admitted === true, `got ${body.commit?.reason}`);
}

step('6. the ledger');
const finalState = await get('/state');
console.log('  ' + finalState.body.files.map(f => `${f.path}@r${f.revision} by ${f.author}`).join(', '));
expect('C\'s derived.mjs never landed', !finalState.body.files.some(f => f.path === 'derived.mjs'));
expect('E\'s version 999 never landed',
  !finalState.body.files.some(f => f.path === 'engine.mjs' && f.contentHash.includes('999')));
expect('engine.mjs advanced exactly twice, by A and then D',
  finalState.body.files.find(f => f.path === 'engine.mjs')?.revision === 3);

finish(
  results,
  passed => passed
    ? 'A SWARM OF AGENTS: UNRELATED WORK IS NOT BLOCKED, STALE WORK IS HELD PRECISELY, '
      + 'AND CONTENTION ON ONE FILE IS STILL CONTENTION'
    : 'THE SWARM BEHAVIOUR DID NOT HOLD',
);