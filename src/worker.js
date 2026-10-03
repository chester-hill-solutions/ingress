/**
 * Worker entry point.
 *
 * Three routes and nothing else:
 *   /health              -> liveness, checkable without a workspace
 *   /w/:workspace/*      -> that workspace's Durable Object
 *   /internal/gate/*     -> not reachable from outside; the container's egress is
 *                           intercepted into the CommitGate entrypoint directly,
 *                           so this worker only forwards to it for the record
 *
 * The forwarding deliberately preserves the sub-path and query, and stamps the
 * workspace name onto the request. The Durable Object cannot reverse its own id
 * into a name, so this is where identity enters the system — and because it is
 * stamped by the router rather than by the caller, a caller cannot choose which
 * workspace it is writing into by putting a name in a body.
 */

import { DurableObject } from 'cloudflare:workers';
import { WorkspaceAgent as WorkspaceCore } from './product/workspace-agent.mjs';
import { CommitGate } from './product/gate.mjs';

/**
 * The platform adapter — the only Cloudflare-specific code in the product.
 *
 * Two things force this split. A Durable Object's container lives on `ctx`, which
 * is only populated for a class the runtime recognises as a Durable Object, so
 * something here has to extend `DurableObject`. And importing
 * `cloudflare:workers` makes a module unloadable under Node, so it must not
 * happen in the file that holds the fence.
 *
 * The result: `product/workspace-agent.mjs` stays pure JavaScript with zero
 * Cloudflare imports, so the fence can be tested exhaustively without an account,
 * while the deployed class is a four-line shim.
 */
export class WorkspaceAgent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // `ctx` here *is* the DurableObjectState — it carries `storage`, `id` and
    // `container` directly, and has no `.state` property. Confirmed against a
    // deployed instance rather than inferred from the types.
    this.core = new WorkspaceCore(ctx, env, ctx.container);
  }

  fetch(request) {
    return this.core.fetch(request);
  }
}

export { CommitGate };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json(200, { ok: true, service: 'ingress-workspace' });
    }

    const match = /^\/w\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
      // Forward the sub-path *and* the query, so the DO's own routing sees
      // /join?name=... rather than a bare /join.
      const target = new URL(`https://workspace.internal${match[2] ?? '/state'}`);
      target.search = url.search;

      const headers = new Headers(request.headers);
      headers.set('x-ingress-workspace', name);

      return stub.fetch(target.toString(), {
        method: request.method,
        headers,
        body: request.body,
        ...(request.body ? { duplex: 'half' } : {}),
      });
    }

    return json(404, { error: 'not_found', routes: ['/health', '/w/:workspace/*'] });
  },
};

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}