/**
 * The build cache: artifacts that make the next start cheap.
 *
 * What this is for
 *
 * Every `/start` boots a cold container. Without this, an agent loop pays the full install
 * cost on every iteration -- `npm install`, `pip install`, a compiler's object cache -- and
 * a twenty-step task spends most of its budget re-establishing state it already had. That is
 * the measured shape of the loop, not a guess: the sandbox trial's second build re-installed
 * from the registry because nothing survived the first.
 *
 * What this deliberately is not
 *
 * It is not workspace content. It carries no revision, appears in no ledger, and the fence
 * never sees it. That distinction is the whole design:
 *
 *   - a cache is an optimisation, so losing it costs time and never correctness;
 *   - it is keyed by the caller (`cacheKey`), not by the fence's revision counter;
 *   - it is not gated by a write lease, because it is not a write to the workspace.
 *
 * Stored in R2 rather than Durable Object storage, because the value is a `node_modules`
 * and DO storage caps a value at 128 KiB. R2 takes the stream directly.
 *
 * The token check is the same one every gate route uses. A cache is per workspace, and a
 * participant may only touch the workspace whose container it was booted for.
 */

import { authenticateContainer, containerRefusal } from '../container-auth.mjs';

/** The largest cache this will store. Past it, the cache is skipped rather than truncated. */
export const MAX_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * The R2 key for one workspace's cache.
 *
 * The workspace name is the prefix, so a participant can only ever address its own. The
 * `cacheKey` is caller-chosen and validated to a safe charset: it becomes part of a storage
 * key, and a value with `/` or `..` in it would let one cache address another.
 */
export function cacheObjectKey(workspace, cacheKey) {
  return `cache/${workspace}/${cacheKey}`;
}

/**
 * Validate a caller-supplied cache key.
 *
 * Refused rather than sanitised. A key that is silently rewritten is a key that reads back
 * something the caller did not ask for, and the caller has no way to tell.
 */
export function validateCacheKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

/**
 * Store the body as this workspace's cache for `cacheKey`.
 *
 * Streamed straight into R2. The gate already streams it in, so nothing here buffers the
 * tarball, and a cache larger than memory is stored the same as a small one.
 */
export async function put(ctx, request) {
  const url = new URL(request.url);
  const participantId = request.headers.get('x-ingress-participant');
  const token = request.headers.get('x-ingress-token');
  const workspace = request.headers.get('x-ingress-workspace');

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) {
    return json(403, containerRefusal(identity, { cached: false }));
  }
  if (!workspace) return json(400, { error: 'refused', reason: 'unknown_workspace' });

  const cacheKey = validateCacheKey(url.searchParams.get('key') ?? 'default');
  if (!cacheKey) {
    return json(400, { error: 'refused', reason: 'invalid_cache_key' });
  }

  const cache = ctx.env?.CACHE;
  if (!cache) {
    // No binding is a deployment fact, not a refusal the participant caused. 501 matches
    // how `/start` answers a missing executor binding.
    return json(501, { error: 'no_cache', detail: 'the CACHE r2 binding is not configured' });
  }

  // `content-length` is a hint, not a guard: it is absent on a chunked body. This refuses a
  // body that *declares* itself over the cap, and the size is checked again after the write
  // so a lying header cannot store an unbounded object.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_CACHE_BYTES) {
    return json(413, { error: 'refused', reason: 'cache_too_large', limitBytes: MAX_CACHE_BYTES });
  }

  const key = cacheObjectKey(workspace, cacheKey);
  const body = request.body;
  if (!body) return json(400, { error: 'refused', reason: 'empty_cache_body' });

  await cache.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
  });

  // Read back the size rather than trusting the request. A stream that reported nothing
  // still lands, and this is what records what actually arrived.
  const head = await cache.head(key);
  const bytes = head?.size ?? null;
  if (bytes != null && bytes > MAX_CACHE_BYTES) {
    // Over the cap despite the header. Removed rather than kept: a cache that silently
    // stores 10 GB is a storage bill, and the next start would try to restore it.
    await cache.delete(key);
    return json(413, { error: 'refused', reason: 'cache_too_large', limitBytes: MAX_CACHE_BYTES, bytes });
  }

  return json(200, { cached: true, cacheKey, bytes });
}

/** Serve the cache for `cacheKey`, or 404 when there is none. */
export async function get(ctx, request) {
  const url = new URL(request.url);
  const participantId = request.headers.get('x-ingress-participant');
  const token = request.headers.get('x-ingress-token');
  const workspace = request.headers.get('x-ingress-workspace');

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) {
    return json(403, containerRefusal(identity, { cached: false }));
  }
  if (!workspace) return json(400, { error: 'refused', reason: 'unknown_workspace' });

  const cacheKey = validateCacheKey(url.searchParams.get('key') ?? 'default');
  if (!cacheKey) return json(400, { error: 'refused', reason: 'invalid_cache_key' });

  const cache = ctx.env?.CACHE;
  if (!cache) return json(501, { error: 'no_cache', detail: 'the CACHE r2 binding is not configured' });

  const key = cacheObjectKey(workspace, cacheKey);
  const object = await cache.get(key);
  // A miss is a normal state, not an error: the first start of a workspace has no cache,
  // and the launcher treats 404 as "nothing to restore" rather than failing the run.
  if (!object) return json(404, { error: 'no_cache_entry', cacheKey });

  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/gzip',
      'x-ingress-cache-bytes': String(object.size ?? ''),
    },
  });
}

/** A small JSON helper, local to keep this module free of the http import cycle. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}