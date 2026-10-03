import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Loopback control channel for an overseer.
 *
 * Security posture is copied from `blind-review.mjs`, which is the in-repo
 * precedent for a loopback service that accepts influence from outside a run:
 * bound to `127.0.0.1` only, `Host` header pinned to the bound port, `Origin`
 * required and matched on every mutation, `application/json` required, body
 * bounded, CSP with a per-server nonce, no-store and `nosniff` on every
 * response.
 *
 * Why it exists at all: it is the only way an overseer can be genuinely
 * *external* to the run. A policy invoked in-process cannot drift from the thing
 * it observes; going over a socket means the overseer is subject to the same
 * latency and visibility constraints a person would be, which is the whole
 * point of measuring one.
 *
 * The same endpoints serve a synthetic policy and a real person, so a run can be
 * handed from one to the other mid-flight without changing the harness. That is
 * also why `humanOversight` is never set here: the server relays, it does not
 * know who is on the other end, and cannot honestly claim either.
 */

const MAX_BODY_BYTES = 8192;

function shorten(value, max) {
  return typeof value === 'string' && Buffer.byteLength(value) <= max ? value : null;
}

/**
 * Start the control server.
 *
 * `onAction` receives each accepted proposal and performs it. Its return value is
 * recorded as the delivery result, so a caller can tell the difference between
 * "the overseer asked" and "the harness did it".
 */
export async function startOverseerServer({
  control,
  onAction = () => ({ status: 'accepted' }),
  describeState = () => ({ roster: [], coverage: { complete: false } }),
  port = 0,
} = {}) {
  if (!control || typeof control.consider !== 'function') {
    throw new TypeError('overseer_control_required');
  }
  const nonce = randomUUID();
  let mutation = Promise.resolve();

  const server = createServer(async (request, response) => {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const send = (status, value, type = 'application/json') => {
      response.writeHead(status, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
          `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      if (
        request.headers.host !== `127.0.0.1:${address.port}` ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        return send(403, { error: 'loopback_origin_required' });
      }
      const url = new URL(request.url, origin);

      if (request.method === 'GET' && url.pathname === '/overseer/state') {
        return send(200, describeState());
      }
      if (request.method === 'GET' && url.pathname === '/overseer/limits') {
        return send(200, control.limits);
      }

      if (request.method !== 'POST' || url.pathname !== '/overseer/propose') {
        return send(404, { error: 'route_not_found' });
      }
      if (
        request.headers.origin !== origin ||
        !request.headers['content-type']?.startsWith('application/json')
      ) {
        return send(403, { error: 'origin_and_content_type_required' });
      }

      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(413, { error: 'body_bounds' });
        chunks.push(chunk);
      }

      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const proposals = Array.isArray(input?.proposals) ? input.proposals.slice(0, 128) : [input];

      // Serialized so two concurrent overseers cannot interleave decisions
      // against a shared budget.
      const operation = mutation
        .catch(() => {})
        .then(async () => {
          const results = [];
          for (const proposal of proposals) {
            const entry = control.consider(proposal);
            let delivery = null;
            if (entry.status === 'accepted') {
              try {
                delivery = await onAction(entry, proposal);
              } catch (error) {
                delivery = { status: 'failed', reason: error instanceof Error ? error.message : 'action_failed' };
              }
            }
            results.push({ ...entry, delivery });
          }
          return results;
        });
      mutation = operation;
      send(200, { results: await operation });
    } catch {
      send(400, { error: 'invalid_request_or_state' });
    }
  });

  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });

  const boundPort = server.address().port;
  return {
    port: boundPort,
    origin: `http://127.0.0.1:${boundPort}`,
    nonce,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Client for the control channel.
 *
 * `propose` sends a tick's proposals and returns what the harness did with them.
 * Deliberately thin: it validates nothing, because the server is the authority.
 */
export function createOverseerClient({ origin, fetch: fetchImpl = globalThis.fetch }) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)) {
    throw new TypeError('overseer_client_loopback_only');
  }
  const endpoint = `${base.origin}/overseer/propose`;
  const stateEndpoint = `${base.origin}/overseer/state`;

  async function post(path, body) {
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base.origin },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`overseer_client_${response.status}`), { status: response.status });
    return response.json();
  }

  return {
    async propose(proposals) {
      const list = Array.isArray(proposals) ? proposals : [proposals];
      const { results } = await post(endpoint, { proposals: list });
      return results;
    },
    async state() {
      const response = await fetchImpl(stateEndpoint, { headers: { origin: base.origin } });
      if (!response.ok) throw Object.assign(new Error(`overseer_client_${response.status}`), { status: response.status });
      return response.json();
    },
    limits: async () => (await fetchImpl(`${base.origin}/overseer/limits`, { headers: { origin: base.origin } })).json(),
  };
}

/** Trim an action record down to what is safe to print on a console. */
export function describeInterventions(entries) {
  return entries.map(entry => ({
    at: entry.at,
    action: entry.action,
    status: entry.status,
    actorId: entry.actorId,
    reason: entry.reason,
    delivery: entry.delivery?.status ?? null,
    note: entry.action === 'steer' && entry.text ? shorten(entry.text, 80) : undefined,
  }));
}