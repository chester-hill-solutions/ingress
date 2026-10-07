/**
 * Mutations against the build cache.
 *
 * The method this project uses: a guard is only worth having if a deliberately broken copy of
 * the code fails it. The cache is the one module here whose bugs are *visible as cost and
 * invisible as correctness* — nothing throws, every run still starts, and the only symptom of
 * a broken scope is one workspace's `node_modules` warming another's start. So the mutations
 * below break a guard each and assert something notices.
 *
 * In-process, importing the mutated module and running the assertions against it, the shape
 * `content-mutations.test.mjs` uses. Not a subprocess: `node --test` exits 0 even when tests
 * fail, so an exit-status harness reports every mutation as surviving.
 *
 * The three guards that matter, and why each is a mutation rather than a unit test:
 *
 *   - the workspace prefix. It is the cross-tenant boundary, and it lives in one function so
 *     that a handler cannot forget it. The mutation removes the prefix and the cross-read
 *     assertion must fail.
 *   - the key validator. A key becomes part of a storage path, so `/` and `..` are a way to
 *     address a cache the caller does not own. Refused, not sanitised.
 *   - the token check. The cache is reachable from the container and nothing else guards it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MODULE = fileURLToPath(new URL('../../src/product/handlers/cache.mjs', import.meta.url));
const original = readFileSync(MODULE, 'utf8');

/** Import a revision of the module fresh, bypassing the ESM cache. */
async function loadMutated(source) {
  const url = `${pathToFileURL(MODULE).href}?mutation=${Math.random()}`;
  const previous = readFileSync(MODULE, 'utf8');
  writeFileSync(MODULE, source);
  try {
    return await import(url);
  } finally {
    writeFileSync(MODULE, previous);
  }
}

/** An R2-shaped store over a Map, so the handler is exercised without an account. */
function r2({ reportedSize } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      const chunks = [];
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
      } else if (body) {
        chunks.push(Buffer.from(body));
      }
      objects.set(key, { bytes: Buffer.concat(chunks) });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.bytes.length,
        httpMetadata: { contentType: 'application/gzip' },
        body: new Response(found.bytes).body,
      };
    },
    async head(key) {
      const found = objects.get(key);
      if (!found) return null;
      // `reportedSize` lets an assertion claim the object landed over the cap without
      // allocating 256 MiB to do it.
      return { size: reportedSize ?? found.bytes.length };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** A workspace ctx with one issued token, and the R2 binding the handler expects. */
function ctxWith({ participantId = 'p', token = 'tok', cache = r2() } = {}) {
  const data = new Map();
  data.set('token:' + participantId, token);
  return {
    env: { CACHE: cache },
    state: {
      storage: {
        async get(key) {
          if (Array.isArray(key)) {
            const out = new Map();
            for (const one of key) out.set(one, data.get(one));
            return out;
          }
          return data.get(key);
        },
      },
    },
  };
}

const request = (method, { key, body, participantId = 'p', token = 'tok', workspace = 'w1' } = {}) =>
  new Request(`https://workspace.internal/cache${key ? `?key=${encodeURIComponent(key)}` : ''}`, {
    method,
    headers: {
      'x-ingress-participant': participantId,
      'x-ingress-token': token,
      ...(workspace == null ? {} : { 'x-ingress-workspace': workspace }),
      'content-type': 'application/gzip',
    },
    body: method === 'POST' ? body ?? new Uint8Array([1, 2, 3]) : undefined,
    duplex: 'half',
  });

/**
 * The properties that must hold after any mutation.
 *
 * Behavioural, not the test suite: `test()` calls register with the runner and cannot be
 * awaited as a function. Each is async because `put`/`get` are.
 */
const ASSERTIONS = [
  {
    name: 'a cache is stored under the workspace that wrote it, never a shared prefix',
    async run(cache) {
      const store = r2();
      await cache.put(ctxWith({ cache: store }), request('POST', { workspace: 'alpha' }));
      assert.deepEqual([...store.objects.keys()], ['cache/alpha/default']);
    },
  },
  {
    // The cross-tenant case, and the reason the mutation on `cacheObjectKey` exists. `alpha`
    // writes; `beta` asks for the same key. Correct misses, because the workspace is part of
    // the object key rather than a value inside it.
    name: 'one workspace cannot read another workspace cache',
    async run(cache) {
      const store = r2();
      await cache.put(ctxWith({ cache: store }), request('POST', { workspace: 'alpha' }));
      const response = await cache.get(ctxWith({ cache: store }), request('GET', { workspace: 'beta' }));
      assert.equal(response.status, 404, 'beta saw alpha cache');
    },
  },
  {
    name: 'a cache key cannot escape its workspace prefix',
    async run(cache) {
      for (const bad of ['../beta', 'a/b', '..', '.', 'a b', '', 'x'.repeat(129)]) {
        assert.equal(cache.validateCacheKey(bad), null, `${JSON.stringify(bad)} was accepted`);
      }
      assert.equal(cache.validateCacheKey('default'), 'default');
    },
  },
  {
    name: 'a refused key never reaches storage',
    async run(cache) {
      const store = r2();
      const response = await cache.put(ctxWith({ cache: store }), request('POST', { key: '../beta' }));
      assert.equal(response.status, 400);
      assert.equal(store.objects.size, 0, 'something was written under a refused key');
    },
  },
  {
    name: 'a cache write with no token is refused',
    async run(cache) {
      const store = r2();
      const response = await cache.put(ctxWith({ cache: store }), request('POST', { token: '' }));
      assert.equal(response.status, 403);
      assert.equal(store.objects.size, 0);
    },
  },
  {
    name: 'a cache read with the wrong token is refused',
    async run(cache) {
      const store = r2();
      await cache.put(ctxWith({ cache: store }), request('POST'));
      const response = await cache.get(ctxWith({ cache: store }), request('GET', { token: 'not-the-token' }));
      assert.equal(response.status, 403);
    },
  },
  {
    name: 'a request with no workspace is refused',
    async run(cache) {
      const store = r2();
      const response = await cache.put(ctxWith({ cache: store }), request('POST', { workspace: null }));
      assert.equal(response.status, 400);
      assert.equal(store.objects.size, 0);
    },
  },
  {
    name: 'a body that declares itself over the cap is refused before it is stored',
    async run(cache) {
      const store = r2();
      const oversized = new Request('https://workspace.internal/cache', {
        method: 'POST',
        headers: {
          'x-ingress-participant': 'p',
          'x-ingress-token': 'tok',
          'x-ingress-workspace': 'w1',
          'content-length': String(cache.MAX_CACHE_BYTES + 1),
        },
        body: new Uint8Array([1]),
        duplex: 'half',
      });
      const response = await cache.put(ctxWith({ cache: store }), oversized);
      assert.equal(response.status, 413);
      assert.equal(store.objects.size, 0);
    },
  },
  {
    name: 'an object that lands over the cap despite its header is deleted, not kept',
    async run(cache) {
      const store = r2({ reportedSize: cache.MAX_CACHE_BYTES + 1 });
      const response = await cache.put(ctxWith({ cache: store }), request('POST'));
      assert.equal(response.status, 413);
      assert.equal(store.objects.size, 0, 'an over-cap object was left in storage');
    },
  },
  {
    name: 'an empty body is refused rather than stored as nothing',
    async run(cache) {
      const store = r2();
      const response = await cache.put(
        ctxWith({ cache: store }),
        new Request('https://workspace.internal/cache', {
          method: 'POST',
          headers: {
            'x-ingress-participant': 'p',
            'x-ingress-token': 'tok',
            'x-ingress-workspace': 'w1',
          },
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(store.objects.size, 0);
    },
  },
  {
    name: 'a missing cache is a 404, not an error',
    async run(cache) {
      const response = await cache.get(ctxWith(), request('GET'));
      assert.equal(response.status, 404);
    },
  },
  {
    name: 'what is written is what is read back',
    async run(cache) {
      const store = r2();
      const bytes = Buffer.from('pretend this is a tarball');
      await cache.put(ctxWith({ cache: store }), request('POST', { body: bytes }));
      const response = await cache.get(ctxWith({ cache: store }), request('GET'));
      assert.equal(response.status, 200);
      assert.equal(Buffer.from(await response.arrayBuffer()).toString(), bytes.toString());
    },
  },
  {
    name: 'the object key is derived, so two workspaces never collide',
    async run(cache) {
      assert.equal(cache.cacheObjectKey('w1', 'default'), 'cache/w1/default');
      assert.notEqual(cache.cacheObjectKey('w1', 'k'), cache.cacheObjectKey('w2', 'k'));
    },
  },
];

/** Replace every occurrence, so a mutation cannot silently apply to only one of two sites. */
const everywhere = (source, needle, replacement) => source.split(needle).join(replacement);

const MUTATIONS = [
  {
    // The cross-tenant guard. Dropping the workspace from the key means every workspace reads
    // the same object, which is the bug this whole module is arranged to prevent.
    name: 'the cache key ignores the workspace, so every workspace shares one cache',
    transform: source => source.replace(
      'return `cache/${workspace}/${cacheKey}`;',
      'return `cache/shared/${cacheKey}`; // mutated',
    ),
  },
  {
    // Refused-because-it-becomes-a-path is the point of the validator. Accepting everything
    // makes `../beta` a key that can address another workspace's prefix.
    name: 'the key validator accepts anything, including path traversal',
    transform: source => source.replace(
      `  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;`,
      '  return value; // mutated: no validation',
    ),
  },
  {
    // Both sites, because the token check is the only thing guarding the route and a
    // mutation that fixed put while leaving get open would report a false pass.
    name: 'the token check is skipped on both cache routes',
    transform: source => everywhere(
      source,
      'if (!identity.ok) {\n    return json(403, containerRefusal(identity, { cached: false }));\n  }',
      'if (false) { // mutated: no token check\n    return json(403, containerRefusal(identity, { cached: false }));\n  }',
    ),
  },
  {
    name: 'the workspace is accepted as unknown rather than refused',
    transform: source => everywhere(
      source,
      "if (!workspace) return json(400, { error: 'refused', reason: 'unknown_workspace' });",
      '// mutated: no workspace required',
    ),
  },
  {
    name: 'a declared-over-cap body is stored anyway',
    transform: source => source.replace(
      'if (declared > MAX_CACHE_BYTES) {',
      'if (false) { // mutated: header cap ignored',
    ),
  },
  {
    name: 'the post-write size check is skipped, so an over-cap object stays',
    transform: source => source.replace(
      'if (bytes != null && bytes > MAX_CACHE_BYTES) {',
      'if (false) { // mutated: no post-write check',
    ),
  },
  {
    name: 'an empty body is accepted',
    transform: source => source.replace(
      "if (!body) return json(400, { error: 'refused', reason: 'empty_cache_body' });",
      '// mutated: no empty-body guard',
    ),
  },
];

test('the unmutated module satisfies every assertion', async t => {
  const cache = await import(pathToFileURL(MODULE).href);
  for (const assertion of ASSERTIONS) {
    await t.test(assertion.name, () => assertion.run(cache));
  }
});

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async () => {
    const mutated = mutation.transform(original);
    assert.notEqual(mutated, original, 'the mutation changed nothing, so it would pass for the wrong reason');

    const cache = await loadMutated(mutated);
    let caught = false;
    let firstFailure = null;
    for (const assertion of ASSERTIONS) {
      try {
        await assertion.run(cache);
      } catch (error) {
        caught = true;
        firstFailure ??= `${assertion.name}: ${error.message.split('\n')[0]}`;
      }
    }
    assert.ok(caught, `the mutation survived: ${mutation.name}`);
    // Reported, not asserted on: which assertion tripped first is diagnostic, and asserting
    // on it would make the harness brittle to reordering.
    if (process.env.INGRESS_MUTATION_VERBOSE) console.log(`    caught by ${firstFailure}`);
  });
}
