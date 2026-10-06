/**
 * The build cache: what makes the second start cheap.
 *
 * Two things are worth testing here and the rest is transport. First, that a cache is
 * scoped to the workspace that wrote it -- a key that could address another workspace's
 * cache is a cross-tenant read. Second, that the token check is the same one every gate
 * route uses, because the cache is reachable from the container and nothing else guards it.
 *
 * No account and no container: R2 is a Map behind the same interface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { put, get, cacheObjectKey, validateCacheKey, MAX_CACHE_BYTES } from '../src/product/handlers/cache.mjs';

/** An R2-shaped store over a Map, so the handler is exercised without an account. */
function r2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      // A ReadableStream is what the gate forwards; read it the way R2 would.
      const chunks = [];
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } else if (body) {
        chunks.push(new Uint8Array(body));
      }
      const bytes = Buffer.concat(chunks.map(c => Buffer.from(c)));
      objects.set(key, { bytes, httpMetadata: { contentType: 'application/gzip' } });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.bytes.length,
        httpMetadata: found.httpMetadata,
        body: new Response(found.bytes).body,
      };
    },
    async head(key) {
      const found = objects.get(key);
      return found ? { size: found.bytes.length } : null;
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
    cache,
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
      'x-ingress-workspace': workspace,
      'content-type': 'application/gzip',
    },
    body: method === 'POST' ? body ?? new Uint8Array([1, 2, 3]) : undefined,
    duplex: 'half',
  });

// --- scoping ------------------------------------------------------------------

test('a cache is stored under the workspace that wrote it', async () => {
  const cache = r2();
  const ctx = ctxWith({ cache });
  await put(ctx, request('POST', { workspace: 'alpha', body: new Uint8Array([1, 2, 3]) }));

  assert.deepEqual([...cache.objects.keys()], ['cache/alpha/default']);
});

test('one workspace cannot read another workspace cache', async () => {
  // The cross-tenant case. `alpha` writes; `beta` asks for the same key and must miss,
  // because the workspace is part of the object key rather than a value inside it.
  const cache = r2();
  await put(ctxWith({ cache }), request('POST', { workspace: 'alpha' }));

  const response = await get(ctxWith({ cache }), request('GET', { workspace: 'beta' }));
  assert.equal(response.status, 404, 'beta must not see alpha cache');
});

test('a cache key cannot escape its workspace prefix', async () => {
  // A key is part of a storage path. `../beta` or a slash would let one workspace address
  // another; refused rather than sanitised, because a rewritten key reads back something
  // the caller did not ask for and cannot detect.
  for (const bad of ['../beta', 'a/b', '..', '.', 'a b', 'a\u0000b', '', 'x'.repeat(129)]) {
    assert.equal(validateCacheKey(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ['default', 'lock-abc123', 'a_b.c', 'A-B']) {
    assert.equal(validateCacheKey(good), good);
  }
});

test('a refused key never reaches storage', async () => {
  const cache = r2();
  const response = await put(ctxWith({ cache }), request('POST', { key: '../beta' }));
  assert.equal(response.status, 400);
  assert.equal(cache.objects.size, 0, 'nothing was written under any key');
});

// --- identity -----------------------------------------------------------------

test('a cache write with no token is refused', async () => {
  const cache = r2();
  const response = await put(ctxWith({ cache }), request('POST', { token: '' }));
  assert.equal(response.status, 403);
  assert.equal(cache.objects.size, 0);
});

test('a cache write with the wrong token is refused', async () => {
  const cache = r2();
  const response = await put(ctxWith({ cache }), request('POST', { token: 'not-the-token' }));
  assert.equal(response.status, 403);
  assert.equal(cache.objects.size, 0);
});

test('a cache read with no token is refused', async () => {
  const response = await get(ctxWith(), request('GET', { token: '' }));
  assert.equal(response.status, 403);
});

// --- round trip ---------------------------------------------------------------

test('what is written is what is read back', async () => {
  const cache = r2();
  const bytes = Buffer.from('pretend this is a tarball');
  await put(ctxWith({ cache }), request('POST', { body: bytes }));

  const response = await get(ctxWith({ cache }), request('GET'));
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), bytes.toString());
});

test('a missing cache is a 404, not an error', async () => {
  // The first start of a workspace has no cache. A launcher treats 404 as "nothing to
  // restore" and proceeds; anything else would fail a run for a missing optimisation.
  const response = await get(ctxWith(), request('GET'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'no_cache_entry');
});

test('no R2 binding answers 501, naming the binding', async () => {
  const ctx = ctxWith();
  delete ctx.env.CACHE;
  const response = await put(ctx, request('POST'));
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, 'no_cache');
});

// --- size ---------------------------------------------------------------------

test('a body that declares itself over the cap is refused before it is stored', async () => {
  const cache = r2();
  const oversized = new Request('https://workspace.internal/cache', {
    method: 'POST',
    headers: {
      'x-ingress-participant': 'p',
      'x-ingress-token': 'tok',
      'x-ingress-workspace': 'w1',
      'content-length': String(MAX_CACHE_BYTES + 1),
    },
    body: new Uint8Array([1]),
    duplex: 'half',
  });
  const response = await put(ctxWith({ cache }), oversized);
  assert.equal(response.status, 413);
  assert.equal(cache.objects.size, 0);
});

test('the object key is derived, never assembled at a call site', () => {
  // The workspace prefix is the cross-tenant guard. It lives here so a handler cannot
  // forget it, which is the shape of every prefix bug.
  assert.equal(cacheObjectKey('w1', 'default'), 'cache/w1/default');
  assert.notEqual(cacheObjectKey('w1', 'k'), cacheObjectKey('w2', 'k'));
});