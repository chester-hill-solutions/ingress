/**
 * Leases over the real HTTP surface.
 *
 * The pure layer is tested in `product-lease.test.mjs`. This file covers the part
 * that unit tests cannot: that the workspace actually *hands over content* when it
 * grants, and that the gate really refuses a write without a lease. A lease layer
 * that grants politely but authorises nothing is the advisory protocol this
 * repository has already learned not to trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceAgent } from '../src/product/workspace-agent.mjs';
import { sha256Hex } from '../src/product/commit.mjs';
import { MANIFEST_VERSION } from '../src/product/manifest.mjs';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

async function entry(path, content) {
  return { path, contentBase64: b64(content), contentHash: await sha256Hex(Buffer.from(content, 'utf8')) };
}

/**
 * A DurableObjectState stand-in.
 *
 * Shaped like the real thing, including the multi-key form of
 * `storage.get(keys)`. A shim that only supported the single-key form let a
 * batched-read change ship with the whole suite red, which is the shim's fault
 * rather than the code's.
 */
/**
 * A DurableObjectState stand-in.
 *
 * Deliberately faithful on the two places a shim is tempted to be convenient:
 *
 *   - `storage.get(keys)` returns a **Map**, not an array, because that is what
 *     workerd returns. A shim that returned an array agreed with a bug in the
 *     workspace and hid it behind a green suite.
 *   - `storage.put(map)` takes an object of key/value pairs, not a Map.
 */
function memoryStorage(data) {
  return {
    storage: {
      async get(key) {
        if (Array.isArray(key)) return new Map(key.map(k => [k, data.get(k)]));
        return data.get(key);
      },
      async put(key, value) {
        if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
          for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
          return;
        }
        data.set(key, structuredClone(value));
      },
    },
  };
}

function makeCall(instance) {
  return async (url, init = {}) => {
    const body = init.body;
    const request = new Request(new URL(url, 'https://workspace.invalid'), {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: body == null ? undefined : new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    return instance.fetch(request);
  };
}

function mountDO() {
  const data = new Map();
  const agent = new WorkspaceAgent(memoryStorage(data));
  return { call: makeCall(agent), data };
}

const join = (call, participantId, kind, dependencies) =>
  call(`https://x/join?${new URLSearchParams({ name: participantId, kind, dependencies: dependencies.join(',') })}`);

const post = (call, path, body) => call(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) });
const asJSON = async response => JSON.parse(await response.text());

function token(data, participantId) {
  const value = `test-token-${participantId}`;
  data.set(`token:${participantId}`, value);
  return value;
}

const manifest = (participantId, files, exit = 0) => ({
  manifestVersion: MANIFEST_VERSION,
  participantId,
  participantExit: exit,
  files,
});

/** Bootstrap, or refuse if the workspace is already populated. */
async function seed(call, files, author = 'creator') {
  const response = await post(call, '/bootstrap', { author, files });
  assert.equal(response.status, 200, `seed refused: ${JSON.stringify(await asJSON(response))}`);
}

// --- the guarantee that matters -------------------------------------------

test('a commit without a write lease is refused', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);

  const response = await post(call, '/internal/commit', {
    participantId: 'A',
    token: token(data, 'A'),
    ...manifest('A', [await entry('x.mjs', 'my work')]),
  });

  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.admitted, false);
  assert.equal(body.reason, 'lease_required');
  assert.deepEqual(body.unleasedPaths, ['x.mjs']);
  assert.match(body.hint, /lease\/checkout/);
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 0, 'nothing landed');
});

test('a read lease does not authorise a write', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);

  const lease = await post(call, '/lease/checkout', { participantId: 'A', paths: ['x.mjs'], mode: 'read' });
  assert.equal(lease.status, 200);
  assert.equal((await asJSON(lease)).mode, 'read');

  const response = await post(call, '/internal/commit', {
    participantId: 'A',
    token: token(data, 'A'),
    ...manifest('A', [await entry('x.mjs', 'my work')]),
  });
  assert.equal(response.status, 409);
  assert.equal((await asJSON(response)).reason, 'lease_required',
    'reading a file is not permission to change it');
});

test('taking the write lease makes the same commit admitted', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);

  const lease = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['x.mjs'], mode: 'write' }));
  assert.equal(lease.granted, true);
  assert.ok(lease.leaseId);

  const response = await post(call, '/internal/commit', {
    participantId: 'A',
    token: token(data, 'A'),
    ...manifest('A', [await entry('x.mjs', 'my work')]),
  });
  assert.equal(response.status, 200);
  assert.equal((await asJSON(response)).admitted, true);
});

test('a lease on one file does not authorise a write to another', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['mine.mjs'], mode: 'write' });

  const response = await post(call, '/internal/commit', {
    participantId: 'A',
    token: token(data, 'A'),
    ...manifest('A', [await entry('mine.mjs', 'ok'), await entry('not-mine.mjs', 'sneaky')]),
  });

  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.deepEqual(body.unleasedPaths, ['not-mine.mjs']);
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 0,
    'atomicity: the leased file does not land either');
});

// --- the read is verifiable now -------------------------------------------

test('a checkout hands over the content, which is what makes a read verifiable', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await seed(call, [await entry('engine.mjs', 'export const version = 1;')]);

  const body = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['engine.mjs'], mode: 'read' }));
  const file = body.files.find(f => f.path === 'engine.mjs');

  assert.equal(file.exists, true);
  assert.equal(file.revision, 1);
  assert.equal(Buffer.from(file.contentBase64, 'base64').toString('utf8'), 'export const version = 1;');
  assert.equal(file.contentHash, await sha256Hex(Buffer.from('export const version = 1;')));
  assert.ok(body.fingerprint, 'the grant cites the evidence cut it was made against');
});

test('a read grant includes declared dependencies, even when not asked for', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', ['engine.mjs', 'lib.mjs']);
  await seed(call, [await entry('engine.mjs', 'v1'), await entry('lib.mjs', 'l1'), await entry('other.txt', 'o')]);

  const body = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['other.txt'], mode: 'read' }));

  assert.deepEqual(body.requested, ['other.txt']);
  assert.deepEqual(body.includedDependencies.sort(), ['engine.mjs', 'lib.mjs'],
    'a lease on a file whose dependencies were not granted is a lease on a lie');
  assert.deepEqual(body.files.map(f => f.path).sort(), ['engine.mjs', 'lib.mjs', 'other.txt']);
});

test('a write grant does not drag dependencies into exclusivity', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', ['engine.mjs']);
  await join(call, 'B', 'agent', []);
  await seed(call, [await entry('engine.mjs', 'v1')]);

  // B holds the dependency exclusively.
  const held = await post(call, '/lease/checkout', { participantId: 'B', paths: ['engine.mjs'], mode: 'write' });
  assert.equal(held.status, 200);

  // A can still get a write lease on its own new file. Folding dependencies into
  // a write request would serialise the workspace into a queue.
  const mine = await post(call, '/lease/checkout', { participantId: 'A', paths: ['mine.mjs'], mode: 'write' });
  assert.equal(mine.status, 200, 'writing my own file must not require exclusive rights to a dependency');
});

test('a path nobody has written is reported as absent, not as empty', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await seed(call, [await entry('exists.txt', 'content')]);

  const body = await asJSON(await post(call, '/lease/checkout', {
    participantId: 'A', paths: ['exists.txt', 'never-written.txt'], mode: 'read',
  }));
  const known = body.files.find(f => f.path === 'exists.txt');
  const unknown = body.files.find(f => f.path === 'never-written.txt');

  assert.equal(known.exists, true);
  assert.equal(unknown.exists, false);
  assert.equal(unknown.revision, null);
  assert.equal(unknown.contentBase64, null, 'absent is not the same as empty');
});

// --- contention -----------------------------------------------------------

test('a second writer is refused with the holder named', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);

  assert.equal((await post(call, '/lease/checkout', { participantId: 'A', paths: ['shared.mjs'], mode: 'write' })).status, 200);
  const response = await post(call, '/lease/checkout', { participantId: 'B', paths: ['shared.mjs'], mode: 'write' });

  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.reason, 'lease_conflict');
  assert.deepEqual(body.blockedOn, ['A']);
  assert.equal(body.conflicts[0].heldBy, 'A');
  assert.ok(body.conflicts[0].expiresAt, 'the caller can see when it becomes free');
});

test('many readers share a file; one writer excludes them', async () => {
  const { call } = mountDO();
  for (const who of ['R1', 'R2', 'R3']) await join(call, who, 'agent', []);

  for (const who of ['R1', 'R2', 'R3']) {
    assert.equal((await post(call, '/lease/checkout', { participantId: who, paths: ['doc.md'], mode: 'read' })).status, 200);
  }
  const writer = await post(call, '/lease/checkout', { participantId: 'R1', paths: ['doc.md'], mode: 'write' });
  assert.equal(writer.status, 409, 'a write lease excludes even a co-reader');

  // And readers are not blocked from a different file.
  assert.equal((await post(call, '/lease/checkout', { participantId: 'R1', paths: ['other.md'], mode: 'read' })).status, 200);
});

test('release frees the path for the next writer', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);

  const lease = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['shared.mjs'], mode: 'write' }));
  assert.equal((await post(call, '/lease/checkout', { participantId: 'B', paths: ['shared.mjs'], mode: 'write' })).status, 409);

  const released = await asJSON(await post(call, '/lease/release', { leaseId: lease.leaseId, participantId: 'A' }));
  assert.deepEqual(released.released, ['shared.mjs']);
  assert.equal((await post(call, '/lease/checkout', { participantId: 'B', paths: ['shared.mjs'], mode: 'write' })).status, 200);
});

// --- liveness -------------------------------------------------------------

test('a heartbeat extends the lease', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  const lease = await asJSON(await post(call, '/lease/checkout', {
    participantId: 'A', paths: ['a.mjs'], mode: 'write', leaseMs: 5000,
  }));

  const beat = await post(call, '/lease/heartbeat', { leaseId: lease.leaseId, participantId: 'A', leaseMs: 5000 });
  assert.equal(beat.status, 200);
  const body = await asJSON(beat);
  assert.equal(body.alive, true);
  // Not `>` : a heartbeat within the same millisecond legitimately yields the same
  // expiry. What matters is that the lease is still live and still held.
  assert.ok(body.expiresAt >= lease.expiresAt, 'the lease did not move backwards');
  assert.ok(body.expiresAt > Date.now(), 'and it is still live');
  assert.deepEqual(body.heldBy, ['a.mjs']);
});

test('a heartbeat for a lease you do not hold is refused', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'impostor', 'agent', []);
  const lease = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['a.mjs'], mode: 'write' }));

  const beat = await post(call, '/lease/heartbeat', { leaseId: lease.leaseId, participantId: 'impostor' });
  assert.equal(beat.status, 409);
  assert.equal((await asJSON(beat)).reason, 'lease_not_yours');
});

test('retrieve refuses while the lease is live, however sure the caller is', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['a.mjs'], mode: 'write', leaseMs: 60_000 });

  const response = await post(call, '/lease/retrieve', { participantId: 'B', paths: ['a.mjs'] });
  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.reason, 'lease_conflict');
  assert.match(body.detail, /still live/);
});

test('retrieve takes over an expired lease and records from whom', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);
  await seed(call, [await entry('a.mjs', 'original content')]);
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['a.mjs'], mode: 'write', leaseMs: 1000 });

  // A's lease is live for a second. Ask immediately, then after it lapses.
  assert.equal((await post(call, '/lease/retrieve', { participantId: 'B', paths: ['a.mjs'] })).status, 409);
  await new Promise(resolve => setTimeout(resolve, 1100));

  const response = await post(call, '/lease/retrieve', { participantId: 'B', paths: ['a.mjs'] });
  assert.equal(response.status, 200);
  const body = await asJSON(response);
  assert.equal(body.retrieved, true);
  assert.equal(body.reclaimedFrom[0].participantId, 'A');
  assert.equal(Buffer.from(body.files[0].contentBase64, 'base64').toString('utf8'), 'original content',
    'the taker gets the last admitted content, so the work is not lost');
});

// --- deadlock -------------------------------------------------------------

test('a deadlock is refused and named, not entered', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);

  await post(call, '/lease/checkout', { participantId: 'A', paths: ['x.mjs'], mode: 'write' });
  await post(call, '/lease/checkout', { participantId: 'B', paths: ['y.mjs'], mode: 'write' });

  // A asks for B's file and is refused; the wait edge is recorded.
  const blocked = await post(call, '/lease/checkout', { participantId: 'A', paths: ['y.mjs'], mode: 'write' });
  assert.equal(blocked.status, 409);

  // B now asks for A's. This would close the loop.
  const cyclic = await post(call, '/lease/checkout', { participantId: 'B', paths: ['x.mjs'], mode: 'write' });
  assert.equal(cyclic.status, 409);
  const body = await asJSON(cyclic);
  assert.ok(Array.isArray(body.cycle) && body.cycle.length > 0, 'the cycle is reported, not discovered later');
  assert.match(body.detail, /deadlock/);
});

test('releasing clears the wait edge so a later request cannot manufacture a cycle', async () => {
  const { call } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);

  const lease = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['x.mjs'], mode: 'write' }));
  await post(call, '/lease/checkout', { participantId: 'B', paths: ['x.mjs'], mode: 'write' });

  const released = await asJSON(await post(call, '/lease/release', { leaseId: lease.leaseId, participantId: 'A' }));
  assert.deepEqual(released.woken, ['B'], 'the workspace is the broker: it wakes the waiter');

  // B can now proceed, and A can take a different file without a phantom cycle.
  assert.equal((await post(call, '/lease/checkout', { participantId: 'B', paths: ['x.mjs'], mode: 'write' })).status, 200);
  assert.equal((await post(call, '/lease/checkout', { participantId: 'A', paths: ['z.mjs'], mode: 'write' })).status, 200);
});

// --- the whole point ------------------------------------------------------

test('a reader blocks a writer: leases prevent the collision the fence would otherwise catch', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'agent', []);
  await seed(call, [await entry('engine.mjs', 'v1')]);

  // The builder reads engine.mjs and holds it.
  const grant = await asJSON(await post(call, '/lease/checkout', {
    participantId: 'builder', paths: ['engine.mjs'], mode: 'read',
  }));
  assert.equal(grant.files[0].revision, 1);
  // No `/read` call: the grant above already recorded the read, because the workspace is
  // what handed the content over. A separate assertion of "I read this" is exactly what
  // item 5 removed.

  // The integrator tries to rewrite it. This is refused before any work happens.
  const blocked = await post(call, '/lease/checkout', { participantId: 'integrator', paths: ['engine.mjs'], mode: 'write' });
  assert.equal(blocked.status, 409);
  assert.deepEqual((await asJSON(blocked)).blockedOn, ['builder']);

  // So the builder's understanding never becomes stale, and its commit is fine.
  await post(call, '/lease/checkout', { participantId: 'builder', paths: ['mine.mjs'], mode: 'write' });
  const response = await post(call, '/internal/commit', {
    participantId: 'builder',
    token: token(data, 'builder'),
    ...manifest('builder', [await entry('mine.mjs', 'built on a read that is still current')]),
  });
  assert.equal(response.status, 200, 'prevention, not detection: nothing had to be refused after the fact');
  assert.equal((await asJSON(response)).admitted, true);
});

test('the fence catches what leases cannot: a dependency that moved after release', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'agent', []);
  await seed(call, [await entry('engine.mjs', 'v1')]);

  const grant = await asJSON(await post(call, '/lease/checkout', {
    participantId: 'builder', paths: ['engine.mjs'], mode: 'read',
  }));

  // The builder lets go — or its lease lapses. Now the integrator can move it.
  await post(call, '/lease/release', { leaseId: grant.leaseId, participantId: 'builder' });
  const taken = await post(call, '/lease/checkout', { participantId: 'integrator', paths: ['engine.mjs'], mode: 'write' });
  assert.equal(taken.status, 200);
  const committed = await post(call, '/internal/commit', {
    participantId: 'integrator',
    token: token(data, 'integrator'),
    ...manifest('integrator', [await entry('engine.mjs', 'v2')]),
  });
  assert.equal(committed.status, 200);

  // The builder still believes in revision 1. The lease no longer stops it, so
  // the fence does — this is the backstop, not the primary mechanism.
  await post(call, '/lease/checkout', { participantId: 'builder', paths: ['mine.mjs'], mode: 'write' });
  const response = await post(call, '/internal/commit', {
    participantId: 'builder',
    token: token(data, 'builder'),
    ...manifest('builder', [await entry('mine.mjs', 'built on a read that has since moved')]),
  });

  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.reason, 'dependency_moved');
  assert.deepEqual(body.refusals[0].staleDependencies, [
    { path: 'engine.mjs', readRevision: 1, currentRevision: 2, author: 'integrator' },
  ]);
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 1, 'the builder landed nothing');
});

test('leases survive a cold restart of the workspace', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['a.mjs'], mode: 'write', leaseMs: 60_000 });

  // A DO eviction must not hand the same file to someone else.
  const revived = new WorkspaceAgent(memoryStorage(data));
  const revivedCall = makeCall(revived);
  const response = await post(revivedCall, '/lease/checkout', { participantId: 'B', paths: ['a.mjs'], mode: 'write' });
  assert.equal(response.status, 409, 'the lease outlived the instance');
});
// --- seeding --------------------------------------------------------------

test('a seed hands the whole workspace, with leased paths marked', async () => {
  // Builds need the whole committed tree to compile against, and the seed being
  // scoped to leased paths was the old gate pretending to enforce leases where the
  // fence cannot. The actual gate is the commit guard; the seed is honest.
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', ['engine.mjs']);
  await join(call, 'B', 'agent', []);
  await seed(call, [await entry('engine.mjs', 'v1'), await entry('secret.txt', 'not yours')]);

  // A leases only engine.mjs for reading. B leases nothing.
  const lease = await asJSON(await post(call, '/lease/checkout', { participantId: 'A', paths: ['engine.mjs'], mode: 'read' }));
  assert.ok(lease.leaseId);

  const result = await asJSON(await post(call, '/internal/seed', {
    participantId: 'A',
    token: token(data, 'A'),
  }));

  assert.deepEqual(result.leasedPaths, ['engine.mjs'],
    'leasedPaths still marks only what this participant holds a lease on');
  assert.equal(result.files.length, 2,
    'and nothing else has been withheld: the seed is not an ACL but an index');
  const engine = result.files.find(f => f.path === 'engine.mjs');
  assert.equal(engine.revision, 1,
    'and each delivered entry carries the revision the reporter records as base');
  assert.equal(Buffer.from(engine.contentBase64, 'base64').toString('utf8'), 'v1');
  assert.deepEqual(result.revisions, { 'engine.mjs': 1, 'secret.txt': 1 },
    'baseRevisions exist for the full tree, so an unleased write is refused by claim, not by not-being-a-base');

  // B holds nothing, so B still gets the tree to read. What B does not get is any
  // long-term claim on it -- and, concretely, no commit is possible without a lease.
  const nothing = await asJSON(await post(call, '/internal/seed', { participantId: 'B', token: token(data, 'B') }));
  assert.deepEqual(nothing.leasedPaths, []);
  assert.equal(nothing.files.length, 2, 'a zero-lease participant still gets the tree to compile against');
});

test('a seed covers read and write leases alike, and the union of both', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', ['dep.mjs']);
  await seed(call, [await entry('dep.mjs', 'dep'), await entry('mine.mjs', 'original')]);

  await post(call, '/lease/checkout', { participantId: 'A', paths: ['mine.mjs'], mode: 'write' });
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['dep.mjs'], mode: 'read' });

  const result = await asJSON(await post(call, '/internal/seed', { participantId: 'A', token: token(data, 'A') }));
  assert.deepEqual(result.leasedPaths, ['dep.mjs', 'mine.mjs']);
});

test('the seed refuses a caller with no token, and a caller with the wrong one', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await seed(call, [await entry('a.txt', 'a')]);

  assert.equal((await post(call, '/internal/seed', { participantId: 'A' })).status, 403);
  assert.equal((await post(call, '/internal/seed', { participantId: 'A', token: 'wrong' })).status, 403);

  // And a participant nobody has issued a token to cannot read a workspace it
  // never joined.
  await join(call, 'ghost', 'agent', []);
  const ghost = await asJSON(await post(call, '/internal/seed', { participantId: 'ghost', token: 'anything' }));
  assert.equal(ghost.reason, 'no_token_issued');
});

test('a seed never blanks a workspace for an unleased reader -- writes still wait', async () => {
  // A hold-out by the old ACL is not the mechanism anymore. What protects a file being
  // edited is the *commit* guard, not the seed: A may see shared.txt, but as long as B
  // holds a write lease on it, any commit A attempts against it is refused.
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await join(call, 'B', 'agent', []);
  await seed(call, [await entry('shared.txt', 'v1')]);

  await post(call, '/lease/checkout', { participantId: 'B', paths: ['shared.txt'], mode: 'write' });
  // A holds nothing, so A cannot *change* shared.txt even though it can see it.
  const aSeed = await asJSON(await post(call, '/internal/seed', { participantId: 'A', token: token(data, 'A') }));
  assert.deepEqual(aSeed.leasedPaths, [], 'A holds no active lease at all');
  assert.equal(aSeed.files.length, 1, 'and is still handed the tree');
  assert.equal(aSeed.files[0].path, 'shared.txt', 'the witness cannot pretend the tree is gone because B is editing it');
});

test('a never-written path is never materialised by the seed', async () => {
  const { call, data } = mountDO();
  await join(call, 'A', 'agent', []);
  await seed(call, [await entry('exists.txt', 'content')]);
  await post(call, '/lease/checkout', { participantId: 'A', paths: ['exists.txt', 'never-written.txt'], mode: 'read' });

  const result = await asJSON(await post(call, '/internal/seed', { participantId: 'A', token: token(data, 'A') }));
  const known = result.files.find(file => file.path === 'exists.txt');
  const unknown = result.files.find(file => file.path === 'never-written.txt');

  assert.equal(known.exists, true);
  assert.equal(unknown, undefined,
    'a path that was never written is not delivered by inventing an empty file for it');
  assert.equal(result.files.every(f => typeof f.contentBase64 === 'string'), true,
    'every delivered file carries real bytes, not a placeholder');
});

// --- the caps actually reach what they protect ---------------------------

test('a seed over its byte budget is refused whole, never truncated', async () => {
  const { call, data } = mountDO();
  await join(call, 'big', 'agent', []);
  // Ten files at the per-file cap: 5 MiB raw, ~6.8 MiB base64-encoded. The per-file
  // and per-lease caps are each satisfied; only a budget over the whole response
  // catches this, which is the point.
  const chunk = 'x'.repeat(512 * 1024);
  const paths = Array.from({ length: 10 }, (_, i) => `f${i}.bin`);
  await seed(call, await Promise.all(paths.map(path => entry(path, chunk))));
  await post(call, '/lease/checkout', { participantId: 'big', paths, mode: 'read' });

  const response = await post(call, '/internal/seed', { participantId: 'big', token: token(data, 'big') });
  assert.equal(response.status, 413, 'a truncated seed is worse than none: the participant would believe it holds files it only partly has');

  const body = await asJSON(response);
  assert.equal(body.refused, true);
  assert.equal(body.reason, 'seed_too_large');
  assert.equal(body.files, undefined, 'no partial file list is offered');
  assert.ok(body.exceedingPaths.length > 0);
  assert.match(body.detail, /workspace tree needs more/i);
});

test('a seed inside the budget is served whole', async () => {
  const { call, data } = mountDO();
  await join(call, 'ok', 'agent', []);
  await seed(call, [await entry('small.txt', 'tiny')]);
  await post(call, '/lease/checkout', { participantId: 'ok', paths: ['small.txt'], mode: 'read' });

  const body = await asJSON(await post(call, '/internal/seed', { participantId: 'ok', token: token(data, 'ok') }));
  assert.equal(body.refused, false);
  assert.equal(body.files.length, 1);
  assert.ok(body.bytes > 0, 'the seed reports what it cost');
});

test('a closure over the path cap is refused with a reason that names the cause', async () => {
  const { call } = mountDO();
  // 60 declared dependencies plus a 200-path request is a 260-path closure.
  const dependencies = Array.from({ length: 60 }, (_, i) => `dep${i}.mjs`);
  await join(call, 'greedy', 'agent', dependencies);
  const many = Array.from({ length: 200 }, (_, i) => `f${i}.mjs`);

  const response = await post(call, '/lease/checkout', { participantId: 'greedy', paths: many, mode: 'read' });
  assert.equal(response.status, 409);
  const body = await asJSON(response);

  assert.equal(body.reason, 'closure_too_large');
  assert.equal(body.requestedPaths, 200, 'the request size is reported');
  assert.equal(body.declaredDependencies, 60, 'and the dependency count that pushed it over');
  assert.equal(body.closurePaths, 260);
  assert.match(body.detail, /asked for 200 path\(s\) and declared 60 dependency/,
    'the refusal must name the cause, or the caller is pointed at the wrong number');
  assert.ok(body.hint);
});

test('a write grant is not inflated by declared dependencies', async () => {
  const { call } = mountDO();
  const dependencies = Array.from({ length: 60 }, (_, i) => `dep${i}.mjs`);
  await join(call, 'writer', 'agent', dependencies);
  await seed(call, [await entry('mine.mjs', 'x')]);

  // A write grant covers only what was asked for, so this is one path, not 61.
  const response = await post(call, '/lease/checkout', { participantId: 'writer', paths: ['mine.mjs'], mode: 'write' });
  assert.equal(response.status, 200);
  const body = await asJSON(response);
  assert.deepEqual(body.files.map(f => f.path), ['mine.mjs']);
  assert.deepEqual(body.includedDependencies, [], 'no dependency is dragged into a write grant');
});
