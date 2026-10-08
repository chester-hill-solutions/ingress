/**
 * The workspace's HTTP surface, driven end to end.
 *
 * Note what these tests can no longer do: seed a workspace by telling it what
 * someone wrote. `/observe` is gone, and its absence is asserted below. The only
 * ways file state changes are `/bootstrap` (once, on an empty ledger) and the
 * gate's `/internal/commit`.
 *
 * `WorkspaceAgent` is the production class throughout. Only `ctx.state` is
 * substituted, and it is shaped like the real DurableObjectState — a shim more
 * convenient than the runtime would let a wiring bug through green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkspaceAgent } from '../src/product/workspace-agent.mjs';
import { WorkspaceClient, WriteLeaseRefused, demoParticipant } from '../src/product/workspace-client.mjs';
import { sha256Hex } from '../src/product/commit.mjs';
import { MANIFEST_VERSION } from '../src/product/manifest.mjs';
import * as leaseHandler from '../src/product/handlers/leases.mjs';
import { LeaseConflict } from '../src/product/lease.mjs';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

async function entry(path, content) {
  return { path, contentBase64: b64(content), contentHash: await sha256Hex(Buffer.from(content, 'utf8')) };
}

/**
 * Establish that a participant has read a path, the way a participant must.
 *
 * A read is recorded by the workspace handing over the content, so this takes a read
 * lease rather than asserting a read. It used to POST `/read`, which recorded whatever
 * the caller claimed and made `readBasis: 'verified'` a self-report.
 *
 * The lease is then released, and that is not incidental. A read lease is exclusive
 * against a write, so while the reader holds it nobody else can move the file — which
 * means the stale-write scenario these tests exist to reach is *unreachable* until the
 * reader lets go. Releasing models the real sequence: read the file, then move on.
 *
 * The read record survives the release, because it lives in the ledger rather than in
 * the lease table. That is what makes the refusal reachable at all: the fence compares
 * the revision the participant was handed against the revision now there.
 */
async function read(call, participantId, path) {
  const response = await post(call, '/lease/checkout', { participantId, paths: [path], mode: 'read' });
  const body = await asJSON(response);
  assert.equal(response.status, 200, `read lease for ${participantId} on ${path} was refused: ${JSON.stringify(body)}`);
  assert.equal(body.files[0].revision !== undefined, true, 'a grant must report the revision it handed over');

  const released = await post(call, '/lease/release', { leaseId: body.leaseId, participantId });
  assert.equal(released.status, 200, 'releasing a read lease must succeed');
  return body;
}

/**
 * Ask the fence directly, with no HTTP in the way.
 *
 * The `/write` route these assertions used to travel through is gone: it called `admit`
 * without consulting the lease table, so it admitted writes the gate refuses. The
 * decision did not go with it — `WorkspaceLedger.admit` is the same function, reachable
 * directly. These tests are better for the change: the fence's decision is now tested
 * without a router, a storage shim and a Durable Object in between.
 *
 * Reads the object's *cached* ledger, so a `/read` performed over HTTP in the same test
 * is visible to the decision. Behaviour that genuinely needs persistence — surviving an
 * eviction — is tested through the gate, which is the path that persists.
 */
async function admit(instance, request) {
  const ledger = await instance.getLedger();
  return ledger.admit(request);
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
      // Real Durable Object storage has this. It was missing here, and the gap was invisible
      // until content retention actually trimmed something: `storeRevisions` writes the index
      // and then deletes the evicted revisions in a second operation, so a shim without
      // `delete` failed *after* a successful write. Which is the right way round to find out —
      // the failure was loud, and the order means the index could never claim a revision was
      // dropped when its content was still there.
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      },
      // Exposed so a test can reach in and age a lease rather than sleeping through its
      // expiry. Only ever read by tests; nothing in the product uses it.
      data,
      /**
       * Optimistic-concurrency transactions, serialised.
       *
       * A real Durable Object transaction retries on conflict; this queues instead, which is
       * the same guarantee by a different mechanism — the body runs to completion before the
       * next one starts, so two of them cannot both read the same revision.
       *
       * It queues rather than throwing on overlap because that is what the runtime does, and
       * a shim that rejected the second caller would make the concurrency test pass by
       * refusing to run rather than by not losing anything.
       */
      transaction(fn) {
        const previous = data.get('__transactionQueue') ?? Promise.resolve();
        const next = previous.then(() => fn(), () => fn());
        data.set('__transactionQueue', next.catch(() => {}));
        return next;
      },
    },
  };
}

function makeCall(instance) {
  return async (url, init = {}) => {
    const body = init.body;
    // The DO reads request bodies as a stream. A Request built without a duplex
    // hint will not stream a string body on this runtime, so the stream is
    // supplied explicitly.
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
  return { instance: agent, call: makeCall(agent), data };
}

/** A cold instance over existing storage — what a DO eviction looks like. */
function mountWithInstance(instance, data) {
  instance.state = memoryStorage(data);
  return { instance, storage: data, call: makeCall(instance) };
}

// `kind` and `dependencies` default rather than being required, and `dependencies` is
// guarded. The helper predates the tests below and took them positionally, so calling it
// with two arguments threw on `dependencies.join` — a failure in the helper that looked
// like a failure in the lease routes.
const join = (base, participantId, kind = 'agent', dependencies = []) =>
  base(`https://x/join?${new URLSearchParams({
    name: participantId,
    kind,
    dependencies: (dependencies ?? []).join(','),
  })}`);

const post = (base, path, body) => base(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) });

const asJSON = async response => JSON.parse(await response.text());

/**
 * A response as `{status, ...body}`.
 *
 * Needed wherever a test asserts on both. `asJSON` throws the status away — it reads the
 * body and nothing else — so `const r = await asJSON(...)` then `r.status` is `undefined`,
 * which reads as a product that answered without a status rather than a helper that threw
 * one away.
 */
async function asResult(response) {
  const body = await asJSON(response);
  return { status: response.status, ...body };
}

/** Establish a starting tree the legitimate way. */
async function bootstrap(base, files, author = 'creator', workspaceToken = undefined) {
  return asJSON(await post(base, '/bootstrap', { author, files, ...(workspaceToken ? { workspaceToken } : {}) }));
}

/**
 * Mint a token exactly as `/start` does, without needing a container.
 *
 * Writes straight into the same storage map the Durable Object reads, because
 * the token check is a storage lookup and there is nothing else to exercise.
 */
function issueToken(data, participantId) {
  const token = `test-token-${participantId}`;
  data.set(`token:${participantId}`, token);
  return token;
}

/**
 * Take a write lease on every path in a commit, then commit it.
 *
 * Every commit in this file goes through here, because a commit without a write
 * lease is refused with `lease_required`. That refusal is the product working:
 * holding a lease has to be what authorises a write, or the lease layer is the
 * advisory protocol this repository has learned not to trust.
 */
async function commitWithLease(base, data, participantId, files) {
  const paths = files.map(file => file.path);
  const lease = await post(base, '/lease/checkout', { participantId, paths, mode: 'write' });
  assert.equal(
    lease.status,
    200,
    `lease for ${participantId} on ${paths.join(', ')} was refused: ${JSON.stringify(lease.body)}`
  );
  const granted = await asJSON(lease);

  const response = await post(base, '/internal/commit', {
    participantId,
    token: issueToken(data, participantId),
    ...manifest(participantId, files),
  });

  // Release afterwards, as a real participant does: a container commits and then exits,
  // so its lease is not held forever. Without this the writer keeps the file exclusively
  // and no one else can read it — correct lease behaviour that would make the
  // re-read scenarios in this file unreachable.
  await post(base, '/lease/release', { leaseId: granted.leaseId, participantId });

  return response;
}

/**
 * Rewrite one path through a real commit, so the retention window advances.
 *
 * Goes through `commitWithLease` like every other commit in this file — a commit without a
 * write lease is refused, and a refusal would not advance the revision at all, so a retention
 * test built on a shortcut would be testing nothing.
 */
async function rewrite(base, data, participantId, path, content) {
  // `commitWithLease` answers a Response. Read before asserting: `response.admitted` off a
  // Response is `undefined`, so the assertion below compared undefined to true and reported a
  // refusal for a commit that had been admitted.
  const response = await asJSON(await commitWithLease(base, data, participantId, [await entry(path, content)]));
  assert.equal(response.admitted, true, `rewrite of ${path} was refused: ${JSON.stringify(response)}`);
  return response;
}

/**
 * Call `grantWrite`, the in-workspace write grant `/start` uses.
 *
 * Straight to the module rather than over HTTP, because `/start` calls it directly and
 * there is no route for it. The handler's own use — refusing with a 409 having created
 * nothing — is exercised by the atomicity test above.
 */
async function leaseGrant(instance, options) {
  return leaseHandler.grantWrite(instance.ctx, options);
}

/** The instance's storage contents, so a cold instance can be mounted over it. */
async function storageOf(instance) {
  return instance.state.storage.data;
}

/**
 * Mount a fresh instance over the same storage — a Durable Object eviction — and return its
 * `fetch`, ready to call like any other.
 *
 * The returned thing is a *function*, not `{instance, call}`. An earlier version returned
 * the mount object and the callers wrote `call(coldInstance(...), '/leases')`, which
 * resolved to `call(fn, ...)` — the outer `call` treating the instance as a URL and
 * building `https://xhttps://x/leases`. It answered 404, and the assertion on
 * `reloaded.leases` then failed on `undefined`, which reads like a lease that failed to
 * persist rather than a request that never arrived.
 */
function coldInstance(instance, data) {
  return makeCall(new WorkspaceAgent(memoryStorage(data)));
}

/** A manifest as the in-container launcher would produce. */
function manifest(participantId, files, exit = 0) {
  return {
    manifestVersion: MANIFEST_VERSION,
    participantId,
    participantExit: exit,
    files,
  };
}

// --- the fence ------------------------------------------------------------

// --- the gate's lease surface ---------------------------------------------------

test('the container lease routes refuse a caller with no token', async () => {
  const { call } = mountDO();

  for (const path of ['/internal/lease/heartbeat', '/internal/lease/release']) {
    const response = await call(`https://x${path}`, {
      method: 'POST',
      body: JSON.stringify({ participantId: 'a', leaseId: 'whatever' }),
    });
    assert.equal(response.status, 403, `${path} answered ${response.status} with no token`);
    const body = await asJSON(response);
    assert.equal(body.reason, 'no_token_issued');
  }
});

test('the container lease routes refuse a token that was never issued', async () => {
  const { call } = mountDO();

  const response = await call('https://x/internal/lease/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ participantId: 'a', leaseId: 'whatever', token: 'forged' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await asJSON(response)).reason, 'no_token_issued');
});

test("a container cannot renew or release another participant's lease", async () => {
  // The token check passes — this *is* a real container — and the lease belongs to someone
  // else. Both operations must refuse, or holding any token is authority over every file
  // in the workspace.
  const { call, data } = mountDO();
  await join(call, 'victim');
  const victimLease = await asResult(await post(call, '/lease/checkout', {
    participantId: 'victim',
    paths: ['engine.mjs'],
    mode: 'write',
  }));

  await join(call, 'attacker');
  const attackerToken = issueToken(data, 'attacker');

  const renewed = await asResult(await post(call, '/internal/lease/heartbeat', {
    participantId: 'attacker',
    token: attackerToken,
    leaseId: victimLease.leaseId,
  }));
  assert.equal(renewed.status, 409);
  assert.equal(renewed.reason, 'lease_not_yours');

  const released = await asResult(await post(call, '/internal/lease/release', {
    participantId: 'attacker',
    token: attackerToken,
    leaseId: victimLease.leaseId,
  }));
  assert.equal(released.status, 200);
  assert.equal(released.reason, 'lease_not_yours',
    'and the release must not have freed the victim\'s paths');

  // The victim's lease is still live.
  const leases = await asJSON(await call('https://x/leases'));
  assert.equal(leases.leases.length, 1);
  assert.equal(leases.leases[0].participantId, 'victim');
});

test('a container renewing its own lease keeps it alive past the original expiry', async () => {
  // The property `/start` now depends on: a run longer than the lease still holds it.
  //
  // The lease is aged in storage before the renewal rather than after, so the renewal is
  // arriving at a lease that *has* expired. Renewing one of those must fail, so the way to
  // show a renewal works is to make the original expiry sit close behind — the assertion
  // is that the renewal recomputes the expiry from *now*, not that the clock advanced.
  const { call, data } = mountDO();
  await join(call, 'worker');
  const token = issueToken(data, 'worker');

  const granted = await asResult(await post(call, '/lease/checkout', {
    participantId: 'worker',
    paths: ['engine.mjs'],
    mode: 'write',
    leaseMs: 60_000,
  }));
  assert.equal(granted.status, 200);
  const firstExpiry = granted.expiresAt;

  const renewed = await asResult(await post(call, '/internal/lease/heartbeat', {
    participantId: 'worker',
    token,
    leaseId: granted.leaseId,
    leaseMs: 60_000,
  }));
  assert.equal(renewed.status, 200);
  assert.equal(renewed.alive, true);
  assert.deepEqual(renewed.heldBy, ['engine.mjs']);
  assert.equal(renewed.heartbeats, undefined, 'the snapshot shape and the result shape differ; only one carries heartbeats');

  // The renewal must be a *full* lease from the moment it ran, and it must not have
  // shortened what it was granted. `renewed.expiresAt` is within a millisecond or two of
  // now + 60s; comparing to the original expiry would be a comparison of two nearly equal
  // numbers and would pass or fail on scheduling.
  const drift = Math.abs(renewed.expiresAt - (Date.now() + 60_000));
  assert.ok(drift < 1_000, `the renewed expiry should be a full lease from now; it was ${drift}ms off`);
  assert.ok(renewed.expiresAt >= firstExpiry, 'and it must never move backwards');
});

test('a renewal cannot revive a lease that already lapsed', async () => {
  // Renewing an expired lease would hand the same file to two participants, so it fails
  // even for the rightful holder — and says which of the two things went wrong.
  const { call, data } = mountDO();
  await join(call, 'worker');
  const token = issueToken(data, 'worker');

  const granted = await asResult(await post(call, '/lease/checkout', {
    participantId: 'worker',
    paths: ['engine.mjs'],
    mode: 'write',
    leaseMs: 1000,
  }));

  // Aged in storage rather than by sleeping. `memoryStorage` exposes its map, so the
  // table is rewritten with an expiry in the past and the next `sweep` treats it as gone —
  // the same path a genuinely lapsed lease takes, without a one-second test.
  const stored = data;
  const leases = stored.get('leases');
  for (const lease of leases.leases) lease.expiresAt = 1;
  stored.set('leases', leases);

  const renewed = await asResult(await post(call, '/internal/lease/heartbeat', {
    participantId: 'worker',
    token,
    leaseId: granted.leaseId,
  }));
  assert.equal(renewed.status, 409);
  assert.equal(renewed.alive, false);
  assert.equal(renewed.reason, 'lease_expired');
});

test('the container release frees the paths, and the commit is already in', async () => {
  // Ordering is the point. The launcher commits and *then* releases; if these were
  // reversed the commit would be refused with `lease_required` every time.
  const { call, data } = mountDO();
  await bootstrap(call, [{ path: 'engine.mjs', content: 'export const v = 1;' }]);
  await join(call, 'worker');
  const token = issueToken(data, 'worker');

  const granted = await asResult(await post(call, '/lease/checkout', {
    participantId: 'worker',
    paths: ['engine.mjs'],
    mode: 'write',
  }));

  const commit = await post(call, '/internal/commit', {
    participantId: 'worker',
    token,
    ...manifest('worker', [await entry('engine.mjs', 'export const v = 2;')]),
  });
  assert.equal(commit.status, 200, await commit.clone().text());

  const released = await asResult(await post(call, '/internal/lease/release', {
    participantId: 'worker',
    token,
    leaseId: granted.leaseId,
  }));
  assert.equal(released.status, 200);
  assert.deepEqual(released.released, ['engine.mjs']);
  assert.equal((await asJSON(await call('https://x/leases'))).leases.length, 0);
});

test('releasing a lease that is already gone is not an error', async () => {
  // The launcher releases on its way out whether or not the participant ran at all, and
  // `/start` releases again afterwards as a backstop. Both must be able to.
  const { call, data } = mountDO();
  await join(call, 'worker');
  const token = issueToken(data, 'worker');

  const response = await asResult(await post(call, '/internal/lease/release', {
    participantId: 'worker',
    token,
    leaseId: 'never-existed',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.reason, 'lease_unknown');
});

test('the workspace grants the lease /start needs, without an HTTP round trip', async () => {
  // `grantWrite` is what `/start` calls. Asserted directly because the whole point of
  // item 7 is that the caller no longer has to do this over HTTP.
  const { instance, call } = mountDO();
  await join(call, 'worker');

  const granted = await leaseGrant(instance, { participantId: 'worker', paths: ['engine.mjs'] });
  assert.equal(granted.mode, 'write');
  assert.deepEqual(granted.paths, ['engine.mjs']);
  assert.ok(granted.leaseId);
  assert.equal(granted.leaseMs, 60_000, 'the default duration, renewed rather than stretched');
  assert.ok(granted.renewIntervalMs < granted.leaseMs,
    'renewals must outrun the expiry, or the lease lapses mid-run');

  // And the grant is durable, not an in-memory artefact of one request. A lease held only
  // in the instance that granted it would vanish on the next eviction and the commit would
  // be refused for no reason the caller could see.
  const reloaded = await asResult(await coldInstance(instance, await storageOf(instance))('https://x/leases'));
  assert.equal(reloaded.leases.length, 1);
  assert.equal(reloaded.leases[0].participantId, 'worker');
});

test('the workspace refuses a start lease it cannot grant, and grants nothing at all', async () => {
  // Atomicity. A caller that gets half a grant holds a lease on files it cannot use while
  // blocking everyone who can — the failure mode the lease table refuses to produce.
  const { instance, call } = mountDO();
  await join(call, 'first');
  await join(call, 'second');

  await leaseGrant(instance, { participantId: 'first', paths: ['engine.mjs'] });

  await assert.rejects(
    () => leaseGrant(instance, { participantId: 'second', paths: ['engine.mjs'] }),
    error => error instanceof LeaseConflict && error.conflicts[0].heldBy === 'first',
  );

  // Only the first holder remains: nothing partial leaked onto the second's side.
  const leases = await asJSON(await call('https://x/leases'));
  assert.equal(leases.leases.length, 1);
  assert.equal(leases.leases[0].participantId, 'first');
});

test('a start lease registers the participant it hands files to', async () => {
  // `grantWrite` is given the registration because it is the party deciding this
  // participant may work, and a handover to someone who has not joined is a decision about
  // them as well as the file.
  //
  // This ordering is load-bearing and was got wrong first: `/start` used to register
  // *before* granting, because `recordRead` calls `require` and that throws for an unknown
  // participant. The live run then showed a `/start` refused for `lease_conflict` leaving
  // the participant registered — no token, no container, no lease, and a roster entry
  // nobody asked for and nobody can remove.
  const { instance, call } = mountDO();

  const granted = await leaseGrant(instance, { participantId: 'latecomer', paths: ['engine.mjs'] });
  assert.ok(granted.leaseId);

  const state = await asResult(await call('https://x/state'));
  const registered = state.participants.find(p => p.participantId === 'latecomer');
  assert.ok(registered, 'the holder of a lease must be a participant');
  assert.equal(registered.kind, 'agent', 'and its kind is the one the grant was given');
});

test('a start lease records the kind it was asked for', async () => {
  // A human and an agent are not interchangeable in the ledger, and the grant is what
  // knows which. Defaulted to `agent` so a caller that omits it gets the conservative
  // answer rather than a gap.
  const { instance, call } = mountDO();
  await leaseGrant(instance, { participantId: 'someone', paths: ['engine.mjs'], kind: 'human' });

  const state = await asResult(await call('https://x/state'));
  assert.equal(state.participants.find(p => p.participantId === 'someone').kind, 'human');
});

test('a refused start lease registers nobody', async () => {
  // The regression, asserted on the ledger rather than through `/start`, which needs a
  // container binding to exercise.
  const { instance, call } = mountDO();
  await leaseGrant(instance, { participantId: 'holder', paths: ['engine.mjs'] });

  await assert.rejects(
    () => leaseGrant(instance, { participantId: 'rejected', paths: ['engine.mjs'] }),
    error => error instanceof LeaseConflict,
  );

  const state = await asResult(await call('https://x/state'));
  assert.equal(
    state.participants.some(p => p.participantId === 'rejected'),
    false,
    'a refused grant must leave no trace of the participant it was for',
  );
});

test('a start lease is a handover, so it records the read it implies', async () => {
  // Same reasoning as `checkout`: the workspace decided to give these paths to this
  // participant, so the read follows from the fact rather than from a claim.
  const { instance, call } = mountDO();
  await bootstrap(call, [{ path: 'engine.mjs', content: 'export const v = 1;' }]);
  await join(call, 'worker');

  // Reads live in `toJSON` but not in `snapshot`, and `/state` serves the snapshot. An
  // earlier version of this test read them from `/state`, where they do not appear — so
  // `after.reads` was `undefined` and `.some` threw. What `/start` actually writes is
  // storage, so the assertion is made there, which is also the surface the fence reads.
  const before = (await storageOf(instance)).get('ledger');
  assert.equal(before.reads.length, 0, 'nothing has been handed over yet');

  await leaseGrant(instance, { participantId: 'worker', paths: ['engine.mjs'] });

  const readPaths = ledger => ledger.reads
    .filter(read => read.participantId === 'worker')
    .map(read => read.path);
  assert.ok(
    readPaths((await storageOf(instance)).get('ledger')).includes('engine.mjs'),
    'a start-issued lease must record the read, or the fence judges this run against no basis',
  );

  // And it must survive a reload — a read held only in the instance that made it is not
  // evidence, and a Durable Object can be evicted between the grant and the commit.
  await coldInstance(instance, await storageOf(instance))('https://x/state');
  assert.ok(
    readPaths((await storageOf(instance)).get('ledger')).includes('engine.mjs'),
    'the recorded read must be durable',
  );
});

// --- workspace ownership -------------------------------------------------------

test('the first bootstrap claims the workspace and returns a token once', async () => {
  const { call } = mountDO();

  const response = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));

  assert.equal(response.status, 200);
  assert.equal(response.bootstrapped, 1);
  assert.ok(response.workspaceToken, 'a claimed workspace must hand back the token that claims it');
});

test("a stranger cannot bootstrap a workspace someone else created", async () => {
  // The squat, stated as the attack it is. Before ownership, this call succeeded and the
  // genuine owner could never bootstrap the name again — the only rule was "an empty
  // ledger", and the squatter's own bootstrap had made it non-empty.
  const { call } = mountDO();
  const owner = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));

  const squatter = await asResult(await post(call, '/bootstrap', {
    author: 'stranger',
    files: [await entry('engine.mjs', 'export const mine = 1;')],
  }));

  assert.equal(squatter.status, 403);
  assert.equal(squatter.reason, 'not_workspace_owner');
});

test('an owned workspace always holds at least one file, so the squat is unreachable', async () => {
  // Which asserts a *consequence* rather than constructing the attack the ownership check
  // was written for.
  //
  // The original reasoning was "the ownership check runs first, so a stranger cannot
  // bootstrap an *empty* workspace someone else created". But `/bootstrap` with zero files
  // is refused as `empty_commit`, so an owned workspace always holds at least one file —
  // and a rule that only checked the ledger would have refused the stranger anyway.
  //
  // Worth stating plainly, because it bounds what ownership here is worth: it buys
  // attribution and a stable owner identity. It does **not** prevent first-come squatting,
  // because the deployment credential is shared and whoever bootstraps first becomes the
  // owner. Preventing that needs per-caller credentials, which is a product decision and
  // not this item.
  const { call } = mountDO();

  const noFiles = await asResult(await post(call, '/bootstrap', { author: 'creator', files: [] }));
  assert.equal(noFiles.status, 400);
  assert.equal(noFiles.error, 'empty_commit',
    'an owned workspace therefore always has files, so the ledger rule alone refuses a stranger');

  const created = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));
  const state = await asResult(await call('https://x/state'));
  assert.equal(state.files.length, 1);
  assert.ok(created.workspaceToken, 'and it is claimed');
});

test('the owner can still bootstrap again, and is refused for the original reason', async () => {
  const { call } = mountDO();
  const created = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));

  const again = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    workspaceToken: created.workspaceToken,
    files: [await entry('other.mjs', 'export const o = 1;')],
  }));

  assert.equal(again.status, 409);
  assert.equal(again.error, 'bootstrap_closed',
    'the owner is authenticated but the ledger rule still applies');
  assert.equal(again.files, 1);
});

test('the workspace token is stored only as a digest', async () => {
  // A storage read — by this code, by an operator, by anything reaching the Durable Object
  // — must not yield a credential that re-opens `/bootstrap`.
  const { call, data } = mountDO();
  const created = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));

  const stored = data.get('owner');
  assert.ok(stored, 'the owner record must be written');
  assert.ok(stored.tokenDigest instanceof ArrayBuffer, 'the token must be stored as a digest');
  assert.equal(JSON.stringify(stored).includes(created.workspaceToken), false,
    'the token itself must not appear anywhere in the stored record');
  assert.equal(stored.author, 'creator', 'and the record says who created it');
  assert.ok(stored.createdAt, 'and when');
});

test('two workspaces get different tokens', async () => {
  // Otherwise a token from one workspace would authenticate against another, and the
  // ownership record would be a naming convention rather than a boundary.
  //
  // Each workspace gets its own storage, which is what makes two Durable Objects out of one
  // module. An earlier version of this test reused a single mount and asserted two
  // bootstraps of it produced two tokens — which is not two workspaces at all, and the
  // second bootstrap is refused. `assert.notEqual(undefined, undefined)` then failed, as it
  // should have.
  const a = mountDO();
  const b = mountDO();
  const tree = [await entry('engine.mjs', 'export const v = 1;')];

  const first = await asResult(await post(a.call, '/bootstrap', { author: 'x', files: tree }));
  const second = await asResult(await post(b.call, '/bootstrap', { author: 'x', files: tree }));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(first.workspaceToken);
  assert.ok(second.workspaceToken);
  assert.notEqual(first.workspaceToken, second.workspaceToken);
});

test('a workspace holding files but no owner is refused rather than adopted', async () => {
  // A workspace from before ownership existed. Adopting it would hand it to whoever asked
  // next, which is the squat the rule exists to prevent — so it fails closed and says an
  // operator is needed. No such workspace exists on this deployment, which is exactly why
  // the state has to be handled rather than ignored.
  const { call, data } = mountDO();
  await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));
  data.delete('owner');

  const response = await asResult(await post(call, '/bootstrap', {
    author: 'stranger',
    files: [await entry('mine.mjs', 'export const m = 1;')],
  }));

  assert.equal(response.status, 409);
  assert.equal(response.error, 'workspace_exists_unowned');
  assert.match(response.reason, /operator/, 'and it must say who can fix it');

  // Refusing to adopt must not mean the workspace is stuck forever. It is recoverable, but
  // only by an operator writing the owner record — so the check that matters is that the
  // route never mints one on its own.
  const fresh = mountDO();
  const created = await asResult(await post(fresh.call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));
  assert.ok(created.workspaceToken, 'an ordinary workspace is claimable');
  // Parenthesised. `await asJSON(await post(...)).reason` binds `.reason` to the *Response*,
  // which has none, rather than to the parsed body — so the comparison silently inspected
  // `undefined`.
  const guessed = await asJSON(await post(fresh.call, '/bootstrap', {
    author: 'creator',
    workspaceToken: 'a-guess',
    files: [await entry('mine.mjs', 'export const m = 1;')],
  }));
  assert.equal(guessed.reason, 'not_workspace_owner', 'and a guessed token is refused');
});

test('a missing workspace token is refused like a wrong one', async () => {
  const { call } = mountDO();
  await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('engine.mjs', 'export const v = 1;')],
  }));

  const response = await asResult(await post(call, '/bootstrap', {
    author: 'creator',
    files: [await entry('other.mjs', 'export const o = 1;')],
  }));

  assert.equal(response.status, 403);
  assert.equal(response.reason, 'not_workspace_owner');
  assert.match(response.detail, /workspaceToken/, 'and it must say what to present');
});

// --- usage and the cost ceiling -----------------------------------------------

/**
 * A Durable Object with a cost ceiling and a container that starts.
 *
 * The container is a stub because `/start` checks the ceiling *before* looking at
 * `ctx.container`, and then records the start *after* the ledger write. With no binding at
 * all every start answers 501 and nothing is ever counted — so a test written that way
 * asserts nothing about the ceiling, which is how the first draft of this passed for the
 * wrong reason.
 *
 * `monitor` resolves immediately: these tests are about bookkeeping, not about waiting.
 */
/**
 * `POST /start`, as the router delivers it.
 *
 * Two things the router does and this file's `post` does not: it stamps
 * `x-ingress-workspace`, without which `/start` answers 400 `unknown_workspace`. Calling the
 * Durable Object directly has always skipped the router, which was invisible until `/start`
 * became testable here.
 */
function startIn(call, body) {
  return call(`https://x/start`, {
    method: 'POST',
    headers: { 'x-ingress-workspace': 'demo', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mountCapped(maxStarts, maxRunSeconds) {
  const data = new Map();
  const env = {
    INGRESS_MAX_STARTS_PER_WORKSPACE: String(maxStarts),
    INGRESS_MAX_RUN_SECONDS: String(maxRunSeconds),
  };
  const container = {
    intercepted: [],
    started: [],
    async interceptAllOutboundHttp(target) { this.intercepted.push(target); },
    start(options) { this.started.push(options); },
    async monitor() { return { exitCode: 0 }; },
    // No `stop`, deliberately: that is the shape of this runtime, and `waitBounded` has to
    // cope with it. A stub that provided one would test the other branch.
  };

  /**
   * An executor stub.
   *
   * `/start` no longer boots a container itself — it delegates to a separate Durable Object,
   * because `ctx.container` is one container per object. So a shim without an executor is
   * testing a deployment that cannot start anything, and answering 409 for every start for
   * exactly the wrong reason.
   */
  const runs = [];
  const EXECUTOR = {
    idFromName: name => ({ name }),
    get: id => ({
      fetch: async (_url, init) => {
        runs.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ timedOut: false, stopAvailable: false, stopError: null, containerError: null }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
  env.EXECUTOR = EXECUTOR;

  const agent = new WorkspaceAgent(memoryStorage(data), env, container);
  return { instance: agent, call: makeCall(agent), data, container, env, runs };
}

test('concurrent increments do not lose any of them', async () => {
  // The lost update, asserted.
  //
  // Every counter used to be folded as `saveUsage(recordX(await usage()))` — read the cached
  // record, build a replacement, store it. Two of those interleaving on an `await` both read
  // revision 0, both compute revision 1, and one increment vanishes with no error anywhere.
  //
  // It was found by the first live concurrent run, where five starts were counted as four.
  // Nothing in the single-threaded suite could have caught it, because one request at a time
  // never loses anything.
  const { instance } = mountCapped(100, 60_000);
  const ctx = instance.ctx;

  // Interleaved the way a Durable Object actually interleaves: each increment reads the
  // record, and all of them read it *before* any of them writes.
  const reads = await Promise.all(Array.from({ length: 25 }, () => ctx.usage()));
  await Promise.all(reads.map(() => ctx.addUsage({ commitsRefused: 1 })));

  // `ctx.usage()` returns the record, not a Response — so it is read directly. Wrapping it in
  // `asResult` is the same wrong-level mistake as elsewhere this session, and it threw rather
  // than silently comparing undefined, which is the better of the two failure modes.
  const usage = await ctx.usage();
  assert.equal(usage.commitsRefused, 25,
    `every increment must land; ${usage.commitsRefused} of 25 did`);

  // And it survives a cold read, so the transaction really wrote rather than only caching.
  const stored = (await storageOf(instance)).get('usage');
  assert.equal(stored.commitsRefused, 25);
});

test('usage is visible, and it starts empty with the ceiling attached', async () => {
  const { call } = mountCapped(5, 600);

  const usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.status, 200);
  assert.equal(usage.starts, 0);
  assert.equal(usage.commitsAdmitted, 0);
  assert.equal(usage.ceiling.maxStarts, 5);
  assert.equal(usage.remaining.starts, 5);
  assert.equal(usage.exhausted, false);
});

test('a refused start consumes no quota, and an advisory lease conflict is still counted', async () => {
  // The difference between a ceiling and a counter. A counter that increments on refusal
  // lets a caller lock themselves out by retrying, and the resulting error is
  // indistinguishable from the one that locked them out.
  const { call } = mountCapped(2, 600);

  // Refused for a reason unrelated to cost: a malformed run bound.
  for (let attempt = 0; attempt < 3; attempt++) {
    const refused = await asResult(await startIn(call, {
      participantId: 'blocked', kind: 'agent', runMs: 999, participantCommand: 'true',
    }));
    assert.equal(refused.status, 409, `attempt ${attempt} should be refused`);
    assert.equal(refused.reason, 'invalid_run_ms');
  }
  let usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.starts, 0, 'three refused starts must not consume any of the two allowed');

  // A lease held elsewhere is advisory now: the start proceeds, and the conflict is reported
  // and counted rather than being the thing that discards the participant's work.
  await join(call, 'holder');
  const held = await post(call, '/lease/checkout', {
    participantId: 'holder', paths: ['contested.mjs'], mode: 'write',
  });
  assert.equal(held.status, 200);

  const advisory = await asResult(await startIn(call, {
    participantId: 'blocked', kind: 'agent', writePaths: ['contested.mjs'], runMs: 1000, participantCommand: 'true',
  }));
  assert.equal(advisory.status, 200, 'a held path no longer refuses the start');
  assert.ok(advisory.intentConflict, 'the conflict is reported rather than hidden');

  usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.starts, 1, 'the advisory start ran, so it is counted once');
  assert.equal(usage.leaseConflicts, 1, 'and the conflict is counted even though the start proceeded');
});

test('the ceiling refuses at the bound and says which bound it was', async () => {
  const { call } = mountCapped(2, 600);
  await join(call, 'runner');

  const start = () => startIn(call, {
    participantId: 'runner', kind: 'agent', runMs: 1000, participantCommand: 'true',
  });

  const first = await start();
  assert.equal(first.status, 200);
  const second = await start();
  assert.equal(second.status, 200);

  const usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.starts, 2, 'both cleared the ceiling and are counted');
  assert.equal(usage.remaining.starts, 0);

  const third = await asResult(await start());
  assert.equal(third.status, 429, 'the third is over the ceiling');
  assert.equal(third.reason, 'cost_ceiling');
  assert.equal(third.limit, 'starts');
  assert.equal(third.used, 2);
  assert.equal(third.allowed, 2);
  // The refusal carries the usage, so the caller does not have to make a second request to
  // find out what it has used — which is the whole reason the counters exist.
  assert.equal(third.usage.starts, 2);
});

test('a workspace over the run-time ceiling cannot start a long command', async () => {
  const { call } = mountCapped(100, 600);

  // Burn most of the budget with three starts that clear the ceiling.
  await join(call, 'spender');
  for (const runMs of [300_000, 200_000, 100_000]) {
    await startIn(call, { participantId: 'spender', kind: 'agent', runMs, participantCommand: 'true' });
  }

  const usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.runSecondsRequested, 600);

  const refused = await asResult(await startIn(call, {
    participantId: 'spender', kind: 'agent', runMs: 60_000, participantCommand: 'true',
  }));
  assert.equal(refused.status, 429);
  assert.equal(refused.limit, 'runSeconds');
  assert.equal(refused.allowed, 0, 'and it says there is no room left');
});

test('a ceiling set to nonsense falls back to the default rather than refusing everything', async () => {
  const { call } = mountCapped(0, 'abc');

  const usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.ceiling.maxStarts, 500, 'the default, not zero');

  const response = await startIn(call, {
    participantId: 'a', kind: 'agent', runMs: 1000, participantCommand: 'true',
  });
  assert.notEqual(response.status, 429, 'and a start is not refused for a configuration mistake');
});

test('commits are counted by verdict, including refusals', async () => {
  const { call, data } = mountDO();
  await bootstrap(call, [{ path: 'engine.mjs', content: 'export const v = 1;' }]);
  await join(call, 'writer');

  await commitWithLease(call, data, 'writer', [{
    path: 'engine.mjs',
    contentBase64: b64('export const v = 2;'),
    contentHash: await sha256Hex(Buffer.from('export const v = 2;')),
  }]);

  // Now a write the fence refuses: base the writer on revision 1 by reading, then move the
  // file underneath them.
  const usageAfterAdmit = await asResult(await call('https://x/usage'));
  assert.equal(usageAfterAdmit.commitsAdmitted, 1);
  assert.ok(usageAfterAdmit.bytesAdmitted > 0, 'and the stored bytes are counted');

  await join(call, 'other');
  await commitWithLease(call, data, 'other', [{
    path: 'engine.mjs',
    contentBase64: b64('export const v = 3;'),
    contentHash: await sha256Hex(Buffer.from('export const v = 3;')),
  }]);

  // A commit with no lease at all is the refusal that needs no setup.
  await join(call, 'unleased');
  const unleased = await post(call, '/internal/commit', {
    participantId: 'unleased',
    token: issueToken(data, 'unleased'),
    ...manifest('unleased', [{
      path: 'engine.mjs',
      contentBase64: b64('export const v = 4;'),
      contentHash: await sha256Hex(Buffer.from('export const v = 4;')),
    }]),
  });
  assert.equal(unleased.status, 409);

  const usage = await asResult(await call('https://x/usage'));
  assert.equal(usage.commitsAdmitted, 2);
  assert.equal(usage.commitsRefused, 1,
    'a refusal is counted as a refusal, not as an admission');
});

test('usage survives a reload', async () => {
  // A counter held only in the instance that incremented it resets when the Durable Object
  // is evicted, and a cost ceiling that resets is not a ceiling.
  const { instance, call } = mountCapped(5, 600);
  await join(call, 'ephemeral');
  await startIn(call, {
    participantId: 'ephemeral', kind: 'agent', runMs: 1000, participantCommand: 'true',
  });

  const cold = await asResult(await coldInstance(instance, await storageOf(instance))('https://x/usage'));
  assert.equal(cold.starts, 1, 'the count must outlive the instance that made it');
});

test('the workspace fences a stale write', async () => {
  const { instance, call, data } = mountDO();

  // Two participants arrive. The builder depends on the file; the human does
  // not declare it, because a human editing a file directly is not reasoning
  // from a read of it. Declaring a dependency you never read is refused by the
  // fence, which is the correct direction to fail.
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'human', []);

  // The file exists, and the builder has read it.
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await read(call, 'builder', 'engine.mjs');

  // Nothing has moved yet, so the builder's write is admitted.
  assert.equal((await admit(instance, { participantId: 'builder', path: 'ui.mjs' })).admitted, true);

  // The human changes what the builder was working from.
  await commitWithLease(call, data, 'integrator', [await entry('engine.mjs', 'v2')]);

  const blocked = await admit(instance, { participantId: 'builder', path: 'other.mjs' });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'dependency_moved');
  assert.deepEqual(blocked.staleDependencies, [
    { path: 'engine.mjs', readRevision: 1, currentRevision: 2, author: 'integrator' },
  ]);
  assert.ok(blocked.fingerprint, 'a refusal must be fingerprintable');
});

test('a re-read clears the refusal and the same write is admitted', async () => {
  const { instance, call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'other', 'human', []);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await read(call, 'builder', 'engine.mjs');

  await commitWithLease(call, data, 'other', [await entry('engine.mjs', 'v2')]);

  assert.equal((await admit(instance, { participantId: 'builder', path: 'ui.mjs' })).admitted, false);
  await read(call, 'builder', 'engine.mjs');
  assert.equal((await admit(instance, { participantId: 'builder', path: 'ui.mjs' })).admitted, true,
    'the fence must be recoverable');
});

test('the workspace survives a reload of its stored state', async () => {
  const { call, data } = mountDO();
  await join(call, 'a', 'agent', ['x.mjs']);
  await join(call, 'someone', 'human', []);
  await bootstrap(call, [await entry('x.mjs', 'v1')]);
  await read(call, 'a', 'x.mjs');
  await commitWithLease(call, data, 'someone', [await entry('x.mjs', 'v2')]);

  // A cold instance over the *same* storage. This is what a DO eviction looks
  // like: the ledger is rebuilt from durable state, not carried in memory.
  const { instance: revived } = mountWithInstance(new WorkspaceAgent(memoryStorage(data)), data);

  // Asked directly rather than over HTTP: `/write` no longer exists, and the gate is
  // the path that persists anyway. What is under test is that the *rebuilt* ledger
  // still refuses, which is the property an eviction could silently lose.
  const refused = await admit(revived, { participantId: 'a', path: 'y.mjs' });
  assert.equal(refused.admitted, false, 'the fence must survive eviction');
  assert.equal(refused.reason, 'dependency_moved');
});

test('an unknown route is a 404 and an unknown participant never writes', async () => {
  const { instance, call } = mountDO();
  assert.equal((await call('https://x/nope')).status, 404);

  // `/write` is gone, so the only way in is the gate — and the gate's own tests cover
  // its refusals. What matters here is that the fence itself still refuses to admit for
  // a participant it has never seen. `rejects`, not `throws`: `admit` awaits the ledger,
  // so `assert.throws` would see no synchronous throw and leak an unhandled rejection.
  await assert.rejects(
    () => admit(instance, { participantId: 'ghost', path: 'x.mjs' }),
    error => {
      assert.equal(error.name, 'FenceRefusal');
      assert.equal(error.reason, 'unknown_participant');
      return true;
    },
    'a non-participant must not receive an admission',
  );
});

// --- the self-reporting hole is closed ------------------------------------

test('/observe no longer exists: a caller cannot report a write', async () => {
  const { call, data } = mountDO();
  const response = await post(call, '/observe', {
    writes: [{ path: 'engine.mjs', revision: 1, actorId: 'someone-else' }],
  });
  assert.equal(response.status, 404, 'the route that let anyone describe any write must be gone');
  const state = await asJSON(await call('https://x/state'));
  assert.equal(state.files.length, 0, 'and nothing was recorded');
});

test('a commit with no token is refused', async () => {
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  const response = await post(call, '/internal/commit', manifest('p', [await entry('x.mjs', 'x')]));
  assert.equal(response.status, 403);
  const body = await asJSON(response);
  assert.equal(body.admitted, false);
  assert.equal(body.reason, 'no_token_issued');
});

test('a commit with the wrong token is refused and lands nothing', async () => {
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  issueToken(data, 'p');
  const response = await post(call, '/internal/commit', {
    participantId: 'p',
    token: 'not-the-token',
    ...manifest('p', [await entry('x.mjs', 'x')]),
  });
  assert.equal(response.status, 403);
  assert.equal((await asJSON(response)).reason, 'token_mismatch');
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 0);
});

test('a participant cannot commit as someone else', async () => {
  const { call, data } = mountDO();
  await join(call, 'alice', 'agent', []);
  issueToken(data, 'alice');
  // alice knows her own token and tries to use it as bob.
  const response = await post(call, '/internal/commit', {
    participantId: 'bob',
    token: `test-token-alice`,
    ...manifest('bob', [await entry('x.mjs', 'x')]),
  });
  assert.equal(response.status, 403);
  assert.equal((await asJSON(response)).reason, 'no_token_issued', 'bob was never issued one');
});

// --- commits of real content ----------------------------------------------

test('a commit of real content is admitted and the bytes are retrievable', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', []);
  const token = issueToken(data, 'builder');

  const response = await commitWithLease(call, data, 'builder', [await entry('hello.txt', 'the actual bytes')]);
  const body = await asJSON(response);
  assert.equal(response.status, 200);
  assert.equal(body.admitted, true);
  assert.deepEqual(body.landed, [{ path: 'hello.txt', revision: 1, contentHash: body.landed[0].contentHash }]);

  // The workspace serves what it admitted, not what the sender claimed.
  const content = await asJSON(await call('https://x/content?path=hello.txt'));
  assert.equal(Buffer.from(content.contentBase64, 'base64').toString('utf8'), 'the actual bytes');
  assert.equal(content.author, 'builder');
  assert.equal(content.revision, 1);
});

test('a commit whose declared hash does not match its bytes is refused', async () => {
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  const token = issueToken(data, 'p');
  const response = await post(call, '/internal/commit', {
    participantId: 'p',
    token,
    ...manifest('p', [{ path: 'x.mjs', contentBase64: b64('real bytes'), contentHash: 'a'.repeat(64) }]),
  });
  assert.equal(response.status, 400);
  assert.equal((await asJSON(response)).error, 'content_hash_mismatch');
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 0);
});

test('a stale commit is refused in full and stores nothing', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'human', []);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await read(call, 'builder', 'engine.mjs');

  const otherToken = issueToken(data, 'integrator');
  await commitWithLease(call, data, 'integrator', [await entry('engine.mjs', 'v2')]);

  const builderToken = issueToken(data, 'builder');
  const response = await commitWithLease(call, data, 'builder', [await entry('mine.mjs', 'my work'), await entry('also-mine.mjs', 'more work')]);

  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.admitted, false);
  assert.equal(body.reason, 'dependency_moved');
  assert.equal(body.staleDependencies ?? body.refusals[0].staleDependencies !== undefined, true);

  // Nothing landed. Not one of the two files.
  const state = await asJSON(await call('https://x/state'));
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].path, 'engine.mjs');
  assert.equal((await call('https://x/content?path=mine.mjs')).status, 404);
});

test('a stale base with disjoint edits is merged, not refused', async () => {
  // The case the fence used to discard: two participants edit different lines of one file.
  // The second commit declares the revision it built from; the base moved; the merge combines
  // them instead of throwing the second away.
  const { call, data } = mountDO();
  await join(call, 'alice', 'agent', []);
  await join(call, 'bob', 'agent', []);
  await bootstrap(call, [await entry('doc.mjs', 'one\ntwo\nthree\nfour\nfive\n')]);
  await read(call, 'alice', 'doc.mjs');

  await commitWithLease(call, data, 'bob', [await entry('doc.mjs', 'one\ntwo\nthree\nfour\nFIVE\n')]);

  const aliceEntry = { ...(await entry('doc.mjs', 'one\nTWO\nthree\nfour\nfive\n')), baseRevision: 1 };
  const response = await commitWithLease(call, data, 'alice', [aliceEntry]);
  const body = await asJSON(response);
  assert.equal(body.admitted, true, JSON.stringify(body));
  assert.equal(body.merged.length, 1, 'the outcome must record that a merge happened');
  assert.equal(body.merged[0].path, 'doc.mjs');

  const content = await asJSON(await call('https://x/content?path=doc.mjs'));
  assert.equal(
    Buffer.from(content.contentBase64, 'base64').toString('utf8'),
    'one\nTWO\nthree\nfour\nFIVE\n',
    'both edits must survive the merge',
  );
});

test('a stale base that conflicts is refused with the material to resolve it', async () => {
  const { call, data } = mountDO();
  await join(call, 'alice', 'agent', []);
  await join(call, 'bob', 'agent', []);
  await bootstrap(call, [await entry('doc.mjs', 'one\ntwo\nthree\n')]);
  await read(call, 'alice', 'doc.mjs');

  await commitWithLease(call, data, 'bob', [await entry('doc.mjs', 'one\nBOB\nthree\n')]);

  const aliceEntry = { ...(await entry('doc.mjs', 'one\nALICE\nthree\n')), baseRevision: 1 };
  const response = await commitWithLease(call, data, 'alice', [aliceEntry]);
  assert.equal(response.status, 409);
  const body = await asJSON(response);
  assert.equal(body.admitted, false);
  assert.equal(body.reason, 'merge_conflict');
  assert.equal(body.conflicts[0].path, 'doc.mjs');
  assert.equal(body.conflicts[0].currentRevision, 2);

  // Bob's revision stands; alice's conflicting edit did not land.
  const content = await asJSON(await call('https://x/content?path=doc.mjs'));
  assert.equal(Buffer.from(content.contentBase64, 'base64').toString('utf8'), 'one\nBOB\nthree\n');
});

test('a participant with no write lease lands by merging — the case the start refusal used to discard', async () => {
  // Alice never holds a write lease: at `/start` the path was held, so she ran without one.
  // Under the old rule her commit was refused with `lease_required` and her work was lost.
  // The clean merge against the revision that landed while she worked is what authorises it.
  const { call, data } = mountDO();
  await join(call, 'alice', 'agent', []);
  await join(call, 'bob', 'agent', []);
  await bootstrap(call, [await entry('doc.mjs', 'one\ntwo\nthree\n')]);
  await read(call, 'alice', 'doc.mjs');

  await commitWithLease(call, data, 'bob', [await entry('doc.mjs', 'one\ntwo\nTHREE\n')]);

  // No `/lease/checkout` for alice. The declared base and a per-file provenance are what she
  // sends instead, and the merge does the rest.
  const aliceEntry = { ...(await entry('doc.mjs', 'one\nTWO\nthree\n')), baseRevision: 1, builtFrom: [] };
  const response = await post(call, '/internal/commit', {
    participantId: 'alice', token: issueToken(data, 'alice'), ...manifest('alice', [aliceEntry]),
  });
  const body = await asJSON(response);
  assert.equal(body.admitted, true, `a clean merge must authorise the landing: ${JSON.stringify(body)}`);
  assert.equal(body.merged.length, 1);

  const content = await asJSON(await call('https://x/content?path=doc.mjs'));
  assert.equal(
    Buffer.from(content.contentBase64, 'base64').toString('utf8'),
    'one\nTWO\nTHREE\n',
    'both edits must survive, and neither writer needed a lease to produce its half',
  );
});

test('a refusal is retained as a receipt, because an audit trail of successes only is worthless', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'human', []);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await read(call, 'builder', 'engine.mjs');

  await commitWithLease(call, data, 'integrator', [await entry('engine.mjs', 'v2')]);
  await commitWithLease(call, data, 'builder', [await entry('mine.mjs', 'my work')]);

  const { receipts } = await asJSON(await call('https://x/receipts?participant=builder'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].admitted, false);
  assert.equal(receipts[0].reason, 'dependency_moved');
  assert.deepEqual(receipts[0].paths, ['mine.mjs']);
  assert.ok(receipts[0].refusals[0].staleDependencies, 'the receipt carries the evidence');
});

test('the participant exit code is retained, so a crashed participant is visible', async () => {
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  const token = issueToken(data, 'p');
  await post(call, '/lease/checkout', { participantId: 'p', paths: ['partial.txt'], mode: 'write' });
  const response = await post(call, '/internal/commit', {
    participantId: 'p',
    token,
    ...manifest('p', [await entry('partial.txt', 'work done before the crash')], 139),
  });
  const body = await asJSON(response);
  assert.equal(body.admitted, true, 'work completed before a crash is still real work');
  assert.equal(body.participantExit, 139, 'and the crash is reported rather than swallowed');
});

test('a manifest with the wrong version is refused rather than half-understood', async () => {
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  const token = issueToken(data, 'p');
  const response = await post(call, '/internal/commit', {
    participantId: 'p',
    token,
    manifestVersion: MANIFEST_VERSION + 99,
    files: [await entry('x.mjs', 'x')],
  });
  assert.equal(response.status, 422);
  assert.equal((await asJSON(response)).reason, 'manifest_version_mismatch');
  assert.equal((await asJSON(await call('https://x/state'))).files.length, 0);
});

// --- bootstrap ------------------------------------------------------------

test('bootstrap may only run once, so it cannot become an overwrite route', async () => {
  const { call, data } = mountDO();
  const first = await bootstrap(call, [await entry('a.txt', 'first tree')]);
  assert.equal(first.bootstrapped, 1);

  // With the owner's token, so this reaches the *ledger* rule rather than stopping at the
  // ownership check. Both refusals are correct; this test is about the overwrite route, and
  // the ledger rule is the one that blocks it.
  const second = await bootstrap(call, [await entry('a.txt', 'replaced')], 'creator', first.workspaceToken);
  assert.equal(second.error, 'bootstrap_closed');

  const content = await asJSON(await call('https://x/content?path=a.txt'));
  assert.equal(Buffer.from(content.contentBase64, 'base64').toString('utf8'), 'first tree');
});

// --- the client -----------------------------------------------------------

function clientFetchFor(base) {
  return async (url, init) => {
    const response = await base(url, init);
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('the client drives the workspace end to end', async () => {
  const { call, data } = mountDO();
  const fetchImpl = clientFetchFor(call);

  await join(call, 'builder', 'agent', ['engine.mjs']);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);

  const builder = new WorkspaceClient({
    baseUrl: 'https://workspace.invalid',
    participantId: 'builder',
    dependencies: ['engine.mjs'],
    fetch: fetchImpl,
  });

  const envelope = await builder.join();
  assert.equal(envelope.you.participantId, 'builder');

  await builder.declareIntent('building the interface');
  // A read lease, not an assertion: this is how a client obtains the content and the
  // workspace records the read in the same act.
  const grant = await builder.checkout({ paths: ['engine.mjs'], mode: 'read' });
  assert.equal(grant.granted, true);
  assert.equal(grant.files[0].revision, 1, 'the grant hands over the revision it served');
  assert.equal(WorkspaceClient.contentOf(grant, 'engine.mjs').toString('utf8'), 'v1',
    'the grant carries the real bytes, not a claim about them');

  // Let go, so a peer can move the file. A read lease is exclusive against a write, so
  // holding it forever would block every writer — which is what `release` is for.
  await builder.release({ leaseId: grant.leaseId });

  // A peer commits, which invalidates what the builder was working from. The client
  // sees it without being told, because the envelope is the workspace's account of the
  // world rather than a notification.
  await join(call, 'peer', 'human', []);
  await commitWithLease(call, data, 'peer', [await entry('engine.mjs', 'moved-on')]);

  const moved = await builder.join();
  const dependency = moved.dependencies.find(entry => entry.path === 'engine.mjs');
  assert.equal(dependency.stale, true, 'the client must be able to see that its basis moved');
  assert.equal(dependency.revision, 2);
  assert.equal(dependency.author, 'peer');
  assert.equal(dependency.yourReadRevision, 1, 'the read the workspace recorded is the one it handed over');

  const receipts = await builder.receipts();
  assert.ok(Array.isArray(receipts.receipts));
});

test('a commit refusal carries the evidence a caller can act on', async () => {
  // The refusal shape the client raises, exercised against the gate — the only path
  // that admits bytes now. This used to travel over `/write`, which is gone.
  const { call, data } = mountDO();
  await join(call, 'p', 'agent', ['dep.mjs']);
  await join(call, 'x', 'human', []);
  await bootstrap(call, [await entry('dep.mjs', 'v1')]);
  await read(call, 'p', 'dep.mjs');

  await commitWithLease(call, data, 'x', [await entry('dep.mjs', 'v2')]);

  // No lease, so the commit is refused before the fence is consulted — which is the
  // point of item 3's predecessor: holding a lease is what authorises a write.
  const response = await post(call, '/internal/commit', {
    participantId: 'p',
    token: issueToken(data, 'p'),
    manifestVersion: MANIFEST_VERSION,
    files: [await entry('out.mjs', 'content')],
  });
  const refused = await asJSON(response);
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, 'lease_required');
  assert.ok(Array.isArray(refused.unleasedPaths));
  assert.ok(typeof refused.hint === 'string', 'a refusal must tell the caller what to do next');
});

test('the refusal error class carries a receipt', async () => {
  // The class is what a caller catches. Asserted directly, because the method that
  // raised it was removed along with its route.
  const error = new WriteLeaseRefused({ reason: 'dependency_moved', staleDependencies: [{ path: 'a.mjs' }] });
  assert.equal(error.name, 'WriteLeaseRefused');
  assert.equal(error.reason, 'dependency_moved');
  assert.equal(error.receipt.staleDependencies.length, 1);
  assert.ok(error instanceof Error);
});

test('the demo participant shows the workspace account of its own read', async () => {
  const { call, data } = mountDO();
  const fetchImpl = clientFetchFor(call);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await join(call, 'other', 'human', []);

  await commitWithLease(call, data, 'other', [await entry('engine.mjs', 'v2')]);

  const result = await demoParticipant({
    baseUrl: 'https://workspace.invalid',
    participantId: 'latecomer',
    kind: 'agent',
    dependency: 'engine.mjs',
    fetch: fetchImpl,
  });
  // The demo no longer writes, so what it proves is that a stranger can arrive, declare
  // an intent, record a read, and see the workspace's own account of that read.
  //
  // `stale` is false here and that is the correct answer: the demo read the file after
  // the peer moved it, so its basis is current. An earlier draft asserted `stale === true`
  // and was wrong about the code rather than the code being wrong about the read.
  assert.equal(result.envelope.you.participantId, 'latecomer');
  assert.equal(result.read.path, 'engine.mjs');
  assert.equal(result.read.revision, 2, 'the envelope reports the revision on disk');
  assert.equal(result.read.stale, false, 'a read of the current revision is not stale');
  assert.equal(result.read.author, 'other', 'the envelope names who moved it');
  assert.equal(result.read.yourReadRevision, result.read.revision,
    'the workspace recorded the read it was told about, against the revision it served');
  assert.ok(result.fingerprint, 'the workspace must hand back a fingerprint of what it relied on');
  assert.ok(Array.isArray(result.state.files));
});

test('two humans in one workspace are fenced against each other too', async () => {
  const { instance, call } = mountDO();
  await join(call, 'alice', 'human', ['doc.md']);
  await join(call, 'bob', 'human', ['doc.md']);
  await bootstrap(call, [await entry('doc.md', 'v1')]);
  await read(call, 'alice', 'doc.md');
  await read(call, 'bob', 'doc.md');

  await admit(instance, { participantId: 'alice', path: 'doc.md', baseRevision: 1 });
  const bobsAttempt = await admit(instance, { participantId: 'bob', path: 'doc.md', baseRevision: 1 });

  assert.equal(bobsAttempt.admitted, false);
  assert.equal(bobsAttempt.reason, 'write_base_stale', 'a human edit invalidates a human peer just as it does an agent');
});
// --- the surface must not lie ---------------------------------------------

test('the unleased write path is gone', async () => {
  // `/write` called `ledger.admit` without consulting the lease table, so it admitted
  // writes the gate refuses with `lease_required`. It also admitted a revision for
  // content it never stored, leaving `/state` reporting a revision `/content` 404s for.
  const { instance, call, data } = mountDO();
  await join(call, 'p', 'agent', []);
  await bootstrap(call, [await entry('a.txt', 'v1')]);

  const response = await call('https://x/write', {
    method: 'POST',
    body: JSON.stringify({ participantId: 'p', path: 'b.txt' }),
  });
  assert.equal(response.status, 404, 'the unleased write path must not be routed');

  // And it is not merely unrouted: the fence cannot be reached over HTTP at all.
  const before = (await asJSON(await call('https://x/state'))).receipts;
  await admit(instance, { participantId: 'p', path: 'b.txt' });
  const after = (await asJSON(await call('https://x/state'))).receipts;
  assert.equal(after, before + 1, 'a direct admit records exactly one receipt');
});

test('no route admits a write without a lease check', async () => {
  // The plan's done-when for item 4, asserted rather than grepped. A route that reaches
  // `admit` outside the gate is the whole defect; this fails if one reappears.
  const workspace = readFileSync(new URL('../src/product/workspace-agent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    workspace,
    /ledger\.admit\(/,
    'the Durable Object must not call admit directly; the gate owns the write decision',
  );

  // The gate must consult the lease table before it decides.
  const commit = readFileSync(new URL('../src/product/handlers/commit.mjs', import.meta.url), 'utf8');
  const leasesAt = commit.indexOf('await ctx.leases()');
  const evaluateAt = commit.indexOf('evaluateCommit(');
  assert.ok(leasesAt > -1, 'the gate must read the lease table');
  assert.ok(leasesAt < evaluateAt, 'the lease check must run before the fence decides');
});

test('a read is recorded by the grant, not by the caller asserting it', async () => {
  // The claim item 5 exists to make true: `readBasis: 'verified'` must rest on the
  // workspace having handed the content over, not on the caller saying it read it.
  const { instance, call } = mountDO();
  await join(call, 'p', 'agent', ['dep.mjs']);
  await bootstrap(call, [await entry('dep.mjs', 'v1')]);

  // Nothing has been handed over, so the basis is unknown and a write is refused.
  const before = await instance.getLedger().then(l => l.decisionCut('p'));
  assert.equal(before.reads[0].readBasis, 'unknown', 'an un-handed-over dependency is not verified');

  // The grant is what changes it.
  await read(call, 'p', 'dep.mjs');
  const after = await instance.getLedger().then(l => l.decisionCut('p'));
  assert.equal(after.reads[0].readBasis, 'verified');
  assert.equal(after.reads[0].readRevision, 1);
  assert.equal(after.reads[0].currentRevision, 1);
});

test('no route exists by which a caller asserts its own read', async () => {
  // `/read` is gone, and `/observe` with it. Both are asserted unrouted, so a regression
  // that restores either fails here rather than in production.
  const { call } = mountDO();
  for (const route of ['/read', '/observe']) {
    const response = await call(`https://x${route}`, {
      method: 'POST',
      body: JSON.stringify({ participantId: 'p', path: 'x.mjs' }),
    });
    assert.equal(response.status, 404, `${route} must not be routed`);
  }
});

test('the client offers no way to assert a read', () => {
  const client = new WorkspaceClient({ baseUrl: 'https://x', participantId: 'p' });
  assert.equal(typeof client.read, 'undefined', 'the method must be gone, not deprecated');
  assert.equal('read' in WorkspaceClient, false);
});

test('a write lease also establishes the read', async () => {
  // Whoever holds a file for writing has been given its content too, so their basis is
  // known. Recording only for read grants would mean the holder of a file had no basis
  // for it, which is the opposite of the truth.
  const { instance, call } = mountDO();
  await join(call, 'p', 'agent', ['dep.mjs']);
  await bootstrap(call, [await entry('dep.mjs', 'v1')]);

  const lease = await post(call, '/lease/checkout', { participantId: 'p', paths: ['dep.mjs'], mode: 'write' });
  assert.equal(lease.status, 200);

  const cut = await instance.getLedger().then(l => l.decisionCut('p'));
  assert.equal(cut.reads[0].readBasis, 'verified', 'a write grant hands the content over too');
});

test('reading a path that does not exist yields an unknown basis, not a verified one', async () => {
  // You cannot have read a file nobody has written. The strict direction is preserved:
  // a declared dependency that does not exist yet cannot be a verified basis.
  const { instance, call } = mountDO();
  await join(call, 'p', 'agent', ['absent.mjs']);

  const lease = await post(call, '/lease/checkout', { participantId: 'p', paths: ['absent.mjs'], mode: 'read' });
  assert.equal(lease.status, 200, 'a grant for an absent path is legal; it just has no content');
  const granted = await asJSON(lease);
  assert.equal(granted.files[0].exists, false);
  assert.equal(granted.files[0].contentBase64, null);

  const cut = await instance.getLedger().then(l => l.decisionCut('p'));
  assert.equal(cut.reads[0].readBasis, 'unknown');
  assert.equal(cut.reads[0].readRevision, null);
});

test('the gate log is not readable from outside', async () => {
  const { call } = mountDO();
  const response = await call('https://x/gate-log');
  assert.equal(response.status, 404,
    'an unauthenticated route that exposes per-workspace participant ids must not exist');
});

test('the client offers no way to write', () => {
  // `write` and `tryWrite` are gone with the `/write` route they called. Same lesson as
  // `observe` below, learned once already: a client that advertises a method the server
  // does not serve names the capability at the front door and 404s every caller.
  const client = new WorkspaceClient({ baseUrl: 'https://x', participantId: 'p' });
  assert.equal(typeof client.write, 'undefined', 'the method must be gone, not deprecated');
  assert.equal(typeof client.tryWrite, 'undefined');
  assert.equal('write' in WorkspaceClient, false);
  assert.equal('tryWrite' in WorkspaceClient, false);
});

test('the client names no route the workspace does not serve', () => {
  // The route table and the client are checked against each other, so a route added to
  // one and not the other fails here rather than in production. Read from both sources
  // rather than hardcoded, because a hardcoded list is the thing that goes stale.
  const workspace = readFileSync(new URL('../src/product/workspace-agent.mjs', import.meta.url), 'utf8');
  const served = new Set(
    [...workspace.matchAll(/url\.pathname === '([^']+)'/g)].map(match => match[1]),
  );
  assert.ok(served.size > 8, `expected a real route table, found ${served.size}`);

  const client = readFileSync(new URL('../src/product/workspace-client.mjs', import.meta.url), 'utf8');
  const called = new Set(
    [...client.matchAll(/this\.request\(\s*[`'"]([^`'"?]+)/g)].map(match => match[1]),
  );
  for (const path of called) {
    assert.ok(
      served.has(path),
      `the client calls ${path}, which the workspace does not serve (${[...served].sort().join(', ')})`,
    );
  }
});

test('the client offers no way to report a write', () => {
  // There was a `WorkspaceClient.observe` that called `POST /observe` — a route
  // letting any caller describe any write by any author. It was removed from the
  // server and the client kept advertising it, so the front door of the product
  // named the exact vulnerability it had eliminated and every caller got a 404.
  const client = new WorkspaceClient({ baseUrl: 'https://x', participantId: 'p' });
  assert.equal(typeof client.observe, 'undefined', 'the method must be gone, not deprecated');
  assert.equal(typeof WorkspaceClient.observe, 'undefined');
  assert.equal('observe' in WorkspaceClient, false);
});

test('the client never names a route the workspace does not serve', async () => {
  // A cheap structural guard against the class of bug above: every route string
  // in the client must be one the Durable Object actually routes.
  const source = readFileSync(new URL('../src/product/workspace-client.mjs', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/request\(`(\/[^`$]*)/g)].map(match => match[1]);
  assert.ok(routes.length > 0, 'found some routes to check');

  const agent = new WorkspaceAgent(memoryStorage(new Map()));
  for (const route of routes) {
    const response = await makeCall(agent)(`https://x${route}`);
    assert.notEqual(response.status, 404, `the client calls ${route}, which the workspace does not serve`);
  }
});

// --- one revision of a path -------------------------------------------------

test('a revision can be asked for, and a trimmed one is distinguished from a missing one', async () => {
  // The whole point of content-per-revision is that an older base is retrievable. The
  // distinction this asserts is the one a merge depends on: "that revision was dropped" and
  // "that revision never existed" are different situations, and both being 404 would leave a
  // caller unable to say whether a merge is impossible or simply unnecessary.
  const { call, data } = mountDO();
  await bootstrap(call, [await entry('engine.mjs', 'one')]);

  // `asJSON`, because `call` answers a Response. Reading `.body.revision` off the Response
  // gives undefined and every comparison below would have failed for a reason that had nothing
  // to do with revisions.
  const currentResponse = await call('https://x/content?path=engine.mjs');
  const current = await asJSON(currentResponse);
  assert.equal(currentResponse.status, 200);
  assert.equal(current.revision, 1);
  assert.deepEqual(current.retained, [1]);
  assert.equal(current.trimmed, 0);
  assert.equal(Buffer.from(current.contentBase64, 'base64').toString(), 'one');

  const first = await asJSON(await call('https://x/content?path=engine.mjs&revision=1'));
  assert.equal(first.revision, 1);
  assert.equal(Buffer.from(first.contentBase64, 'base64').toString(), 'one');

  // A revision that was never written: the path is at 1, so 7 does not exist.
  const neverResponse = await call('https://x/content?path=engine.mjs&revision=7');
  assert.equal(neverResponse.status, 404);
  const never = await neverResponse.json();
  assert.equal(never.error, 'revision_not_retained');
  assert.deepEqual(never.retained, [1], 'and it says what *is* there');
  assert.equal(never.trimmed, 0);

  // A revision that was trimmed. Forced by rewriting the path past the retention window,
  // which is the only way to tell a trim from a non-existence.
  // Joined, because a lease checkout on an unregistered participant is refused with 400 --
  // which would leave every revision unmoved and the retention window never advancing.
  await join(call, 'w', 'agent', []);
  for (const text of ['two', 'three', 'four', 'five', 'six', 'seven']) {
    await rewrite(call, data, 'w', 'engine.mjs', text);
  }
  const after = await asJSON(await call('https://x/content?path=engine.mjs'));
  assert.equal(after.revision, 7);
  assert.ok(after.trimmed > 0, `expected history to be trimmed, trimmed is ${after.trimmed}`);
  assert.ok(!after.retained.includes(1), 'revision 1 must be gone at this point');

  const evictedResponse = await call('https://x/content?path=engine.mjs&revision=1');
  assert.equal(evictedResponse.status, 404);
  const evicted = await evictedResponse.json();
  assert.equal(evicted.error, 'revision_not_retained');
  assert.equal(evicted.trimmed, after.trimmed,
    'and it reports the drop count, so the caller can tell a trim from a non-existence');
});

test('a malformed revision is refused rather than coerced', async () => {
  // `Number('')` is 0 and `Number(' 2 ')` is 2, so a lenient parse would quietly serve a
  // different revision than the one asked for — and a merge base that is not the base.
  const { call } = mountDO();
  await bootstrap(call, [await entry('engine.mjs', 'one')]);

  // `1e2` is deliberately absent: `Number('1e2')` is 100, a legitimate parse, so asking for
  // revision 100 is a valid question with a "no such revision" answer. Refusing it as
  // malformed would be pedantry about notation rather than about safety.
  for (const revision of ['0', '-1', '1.5', 'two', '', '  ', 'NaN', 'Infinity', '1,000']) {
    const response = await call(`https://x/content?path=engine.mjs&revision=${encodeURIComponent(revision)}`);
    assert.equal(response.status, 400, `revision=${JSON.stringify(revision)} should be refused`);
    assert.equal((await response.json()).error, 'invalid_revision');
  }

  // Present but empty is the *current* revision's request, not a malformed one.
  const bare = await call('https://x/content?path=engine.mjs&revision=');
  assert.equal(bare.status, 400, 'an empty revision is malformed, not "the current one"');
});

test('the current content is still served when no revision is asked for', async () => {
  // The read path every existing caller depends on. The revisioned keys sit beside it and must
  // not shadow it — if they did, every agent would be seeded from a stale tree and the fence
  // would be silently judging every change against the wrong base.
  const { call, data } = mountDO();
  await bootstrap(call, [await entry('engine.mjs', 'one')]);
  await join(call, 'w', 'agent', []);
  await rewrite(call, data, 'w', 'engine.mjs', 'two');

  const response = await asJSON(await call('https://x/content?path=engine.mjs'));
  assert.equal(Buffer.from(response.contentBase64, 'base64').toString(), 'two',
    'no revision parameter means the latest admitted bytes');
  assert.equal(response.revision, 2);
  assert.deepEqual([...response.retained].sort(), [1, 2], 'and history is reported alongside it');
});

// --- the routing stays wired ----------------------------------------------

test('every routed path is reachable and none of them crash the object', async () => {
  // The concern handlers were split into separate modules, and the only thing
  // holding them together is the route table. A handler wired to the wrong
  // function, or a route that dispatches and then throws, would still pass every
  // behaviour test written against one concern.
  const { call } = mountDO();
  await join(call, 'p', 'agent', []);
  await bootstrap(call, [await entry('seed.txt', 'seeded')]);

  const probes = [
    ['GET', '/state'],
    ['GET', '/leases'],
    ['GET', '/content?path=seed.txt'],
    ['GET', '/receipts?participant=p'],
    ['POST', '/intent'],
    ['POST', '/lease/checkout'],
    ['POST', '/lease/heartbeat'],
    ['POST', '/lease/release'],
    ['POST', '/lease/retrieve'],
    ['POST', '/internal/commit'],
    ['POST', '/internal/seed'],
    ['POST', '/internal/gate-log'],
    ['POST', '/bootstrap'],
    ['POST', '/start'],
  ];

  for (const [method, path] of probes) {
    const response = await call(`https://x${path}`, {
      method,
      body: method === 'GET' ? undefined : JSON.stringify({ participantId: 'p', path: 'seed.txt', paths: [] }),
    });
    assert.notEqual(response.status, 404, `${method} ${path} is routed nowhere`);
    // 501 is the documented "no container binding" answer, not a crash.
    assert.ok(
      response.status < 500 || response.status === 501,
      `${method} ${path} returned ${response.status}, which means it threw`
    );
  }
});

test('the durable object holds no domain logic, only routing', async () => {
  // A structural guard against the file regrowing into what it just was: 699
  // lines carrying routing, tokens, containers, leases and commit decisions in one
  // place. Asserting on line count is brittle; asserting that the commit decision
  // and the lease table are not *defined* here is not.
  const source = readFileSync(new URL('../src/product/workspace-agent.mjs', import.meta.url), 'utf8');
  assert.equal(/function\s+evaluateCommit|\bapplyCommit\s*\(/.test(source), false,
    'the commit decision belongs in handlers/commit.mjs');
  assert.equal(/class\s+LeaseTable/.test(source), false,
    'the lease table belongs in lease.mjs');
  assert.equal(/snapshotContainer|container\.start\(/.test(source), false,
    'container lifecycle belongs in handlers/container.mjs');
});

test('the gate enforces its body bound by streaming, not by trusting a header', () => {
  // `CommitGate extends WorkerEntrypoint`, which cannot be constructed off-runtime,
  // so this is a structural guard rather than a behavioural one and says so.
  //
  // It exists because the previous version read `content-length`, which is absent
  // on a chunked request: the fallback was `0`, which passed, so the 12 MB limit was
  // advisory for exactly the clients that did not volunteer the header.
  const source = readFileSync(new URL('../src/product/gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /readJSON\(request, MAX_COMMIT_BODY\)/,
    'the gate must bound the body as it streams');
  assert.equal(/request\.json\(\)/.test(source), false,
    'request.json() is unbounded and would reintroduce the hole');
  assert.equal(/headers\.get\(['"]content-length['"]\)/.test(source), false,
    'the header is absent on chunked requests, so it cannot be the bound');
});
