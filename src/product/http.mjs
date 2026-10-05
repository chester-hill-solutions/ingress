/**
 * HTTP helpers shared by every handler.
 *
 * Extracted so the body-reading contract lives in one place. That contract is
 * subtle: workerd makes the Request itself async-iterable, while undici exposes
 * the body as a `ReadableStream`. Getting it wrong means the class runs in
 * production and cannot be exercised in the test suite — which is precisely where
 * a fence bug would otherwise hide.
 */

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_COMMIT_BODY = 12 * 1024 * 1024;

/**
 * A JSON response.
 *
 * Shared rather than redeclared per module, because the security-relevant part is
 * the same everywhere: `cache-control: no-store` on a refusal is what stops a token
 * check or an evidence payload being retained by a shared cache. `extraHeaders` exists
 * for the one case that varies — `WWW-Authenticate` on a 401.
 */
export function json(status, value, extraHeaders = undefined) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

export async function readJSON(request, maxBytes = MAX_BODY_BYTES) {
  const source = typeof request[Symbol.asyncIterator] === 'function' ? request : request.body;
  let size = 0;
  const chunks = [];
  if (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('body_bounds');
      chunks.push(chunk);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('invalid_json');
  }
}