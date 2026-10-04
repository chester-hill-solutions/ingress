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
import { WorkspaceClient, WriteRefused, demoParticipant } from '../src/product/workspace-client.mjs';
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

const join = (base, participantId, kind, dependencies) =>
  base(`https://x/join?${new URLSearchParams({ name: participantId, kind, dependencies: dependencies.join(',') })}`);

const post = (base, path, body) => base(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) });

const asJSON = async response => JSON.parse(await response.text());

/** Establish a starting tree the legitimate way. */
async function bootstrap(base, files, author = 'creator') {
  return asJSON(await post(base, '/bootstrap', { author, files }));
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

  return post(base, '/internal/commit', {
    participantId,
    token: issueToken(data, participantId),
    ...manifest(participantId, files),
  });
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

test('the workspace fences a stale write over real HTTP', async () => {
  const { call, data } = mountDO();

  // Two participants arrive. The builder depends on the file; the human does
  // not declare it, because a human editing a file directly is not reasoning
  // from a read of it. Declaring a dependency you never read is refused by the
  // fence, which is the correct direction to fail.
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'human', []);

  // The file exists, and the builder has read it.
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });

  // Nothing has moved yet, so the builder's write is admitted.
  assert.equal((await asJSON(await post(call, '/write', { participantId: 'builder', path: 'ui.mjs' }))).admitted, true);

  // The human changes what the builder was working from.
  await commitWithLease(call, data, 'integrator', [await entry('engine.mjs', 'v2')]);

  const blocked = await asJSON(await post(call, '/write', { participantId: 'builder', path: 'other.mjs' }));
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'dependency_moved');
  assert.deepEqual(blocked.staleDependencies, [
    { path: 'engine.mjs', readRevision: 1, currentRevision: 2, author: 'integrator' },
  ]);
  assert.ok(blocked.fingerprint, 'a refusal must be fingerprintable');
});

test('a re-read clears the refusal and the same write is admitted', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'other', 'human', []);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });

  await commitWithLease(call, data, 'other', [await entry('engine.mjs', 'v2')]);

  assert.equal((await asJSON(await post(call, '/write', { participantId: 'builder', path: 'ui.mjs' }))).admitted, false);
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });
  assert.equal((await asJSON(await post(call, '/write', { participantId: 'builder', path: 'ui.mjs' }))).admitted, true,
    'the fence must be recoverable');
});

test('the workspace survives a reload of its stored state', async () => {
  const { call, data } = mountDO();
  await join(call, 'a', 'agent', ['x.mjs']);
  await join(call, 'someone', 'human', []);
  await bootstrap(call, [await entry('x.mjs', 'v1')]);
  await post(call, '/read', { participantId: 'a', path: 'x.mjs' });
  await commitWithLease(call, data, 'someone', [await entry('x.mjs', 'v2')]);

  // A cold instance over the *same* storage. This is what a DO eviction looks
  // like: the ledger is rebuilt from durable state, not carried in memory.
  const { call: revivedCall } = mountWithInstance(new WorkspaceAgent(memoryStorage(data)), data);

  const refused = await asJSON(await revivedCall('https://x/write', {
    method: 'POST',
    body: JSON.stringify({ participantId: 'a', path: 'y.mjs' }),
  }));
  assert.equal(refused.admitted, false, 'the fence must survive eviction');
  assert.equal(refused.reason, 'dependency_moved');
});

test('an unknown route is a 404 and an unknown participant never writes', async () => {
  const { call, data } = mountDO();
  assert.equal((await call('https://x/nope')).status, 404);

  const response = await call('https://x/write', {
    method: 'POST',
    body: JSON.stringify({ participantId: 'ghost', path: 'x.mjs' }),
  });
  assert.equal(response.status, 400);
  const body = await asJSON(response);
  assert.equal(body.error, 'unknown_participant');
  assert.equal(body.admitted, undefined, 'no admission and no receipt for a non-participant');
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
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });

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

test('a refusal is retained as a receipt, because an audit trail of successes only is worthless', async () => {
  const { call, data } = mountDO();
  await join(call, 'builder', 'agent', ['engine.mjs']);
  await join(call, 'integrator', 'human', []);
  await bootstrap(call, [await entry('engine.mjs', 'v1')]);
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });

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

  const second = await bootstrap(call, [await entry('a.txt', 'replaced')]);
  assert.equal(second.status ?? 409, 409);
  assert.equal((await asJSON(await post(call, '/bootstrap', { files: [await entry('a.txt', 'replaced')] }))).error,
    'bootstrap_closed');

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
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });

  const builder = new WorkspaceClient({
    baseUrl: 'https://workspace.invalid',
    participantId: 'builder',
    dependencies: ['engine.mjs'],
    fetch: fetchImpl,
  });

  const envelope = await builder.join();
  assert.equal(envelope.you.participantId, 'builder');

  assert.equal((await builder.tryWrite({ path: 'ui.mjs' })).admitted, true);

  // A peer commits, which invalidates what the builder was working from.
  await join(call, 'peer', 'human', []);
  await commitWithLease(call, data, 'peer', [await entry('engine.mjs', 'moved-on')]);

  assert.equal((await builder.tryWrite({ path: 'ui.mjs' })).admitted, false,
    'the builder is stale without re-reading');
  await post(call, '/read', { participantId: 'builder', path: 'engine.mjs' });
  assert.equal((await builder.tryWrite({ path: 'ui.mjs' })).admitted, true);
});

test('a refusal throws WriteRefused with the evidence attached', async () => {
  const { call, data } = mountDO();
  const fetchImpl = clientFetchFor(call);
  await join(call, 'p', 'agent', ['dep.mjs']);
  await join(call, 'x', 'human', []);
  await bootstrap(call, [await entry('dep.mjs', 'v1')]);
  await post(call, '/read', { participantId: 'p', path: 'dep.mjs' });

  const client = new WorkspaceClient({
    baseUrl: 'https://workspace.invalid',
    participantId: 'p',
    dependencies: ['dep.mjs'],
    fetch: fetchImpl,
  });

  await commitWithLease(call, data, 'x', [await entry('dep.mjs', 'v2')]);

  await assert.rejects(
    () => client.write({ path: 'out.mjs' }),
    error => {
      assert.ok(error instanceof WriteRefused);
      assert.equal(error.reason, 'dependency_moved');
      assert.ok(error.receipt.staleDependencies.length > 0);
      return true;
    }
  );
});

test('the demo participant recovers from a refusal without special-casing', async () => {
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
  assert.equal(result.outcome.admitted, true, 'a stranger can join, be refused, and recover');
});

test('two humans in one workspace are fenced against each other too', async () => {
  const { call, data } = mountDO();
  await join(call, 'alice', 'human', ['doc.md']);
  await join(call, 'bob', 'human', ['doc.md']);
  await bootstrap(call, [await entry('doc.md', 'v1')]);
  await post(call, '/read', { participantId: 'alice', path: 'doc.md' });
  await post(call, '/read', { participantId: 'bob', path: 'doc.md' });

  await post(call, '/write', { participantId: 'alice', path: 'doc.md', baseRevision: 1 });
  const bobsAttempt = await asJSON(await post(call, '/write', { participantId: 'bob', path: 'doc.md', baseRevision: 1 }));

  assert.equal(bobsAttempt.admitted, false);
  assert.equal(bobsAttempt.reason, 'write_base_stale', 'a human edit invalidates a human peer just as it does an agent');
});
// --- the surface must not lie ---------------------------------------------

test('the gate log is not readable from outside', async () => {
  const { call } = mountDO();
  const response = await call('https://x/gate-log');
  assert.equal(response.status, 404,
    'an unauthenticated route that exposes per-workspace participant ids must not exist');
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
