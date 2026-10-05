/**
 * Worker entry point.
 *
 * Three routes and nothing else:
 *   /health              -> liveness, checkable without a credential
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
 *
 * Which requests are allowed at all is decided in `product/router.mjs`, not here.
 * That file is pure and loads under Node; this one imports `cloudflare:workers` and
 * does not. The authentication check is the reason for the split: written here it
 * would be a security boundary with no test over it.
 */

import { DurableObject } from 'cloudflare:workers';
import { WorkspaceAgent as WorkspaceCore } from './product/workspace-agent.mjs';
import { runOne } from './product/executor.mjs';
import { CommitGate } from './product/gate.mjs';
import { decide } from './product/router.mjs';
import { json } from './product/http.mjs';

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

/**
 * The executor: one Durable Object, one container, no decisions.
 *
 * A second class rather than a mode of the workspace object, because `ctx.container` is one
 * container per object. Holding a container on the same object that holds the ledger caps a
 * workspace at one participant, and the fence's entire safety argument is that it decides in
 * a single turn against current state — which is why the ledger stays here and the container
 * goes elsewhere.
 *
 * The split is asymmetric on purpose. This class cannot admit a commit, mint a token or grant
 * a lease: it is handed all three by the workspace object and only ever reports what happened.
 * After the split there is still exactly one place where a commit is decided.
 */
export class Executor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'POST') {
      return json(404, { error: 'route_not_found' });
    }
    let run = null;
    try {
      run = await request.json();
      // A malformed request is a 4xx, never an unhandled throw: an object that throws out of
      // fetch produces a runtime error page instead of an answer, and the arbiter cannot tell
      // a refusal from a crash.
      const outcome = await runOne(containerOf(this.ctx), this.env.GATE, run);
      return json(200, outcome);
    } catch (error) {
      // A 409 rather than a throw, and it carries the keys it actually received. The arbiter
      // turns this into `container_busy` and releases the slot — but only if it is *told*. An
      // executor that returned 200 on failure would leave the arbiter waiting out the whole
      // deadline for a container that never started.
      //
      // `received` is here because of a bug this shape made invisible: the command was
      // arriving empty, and the only symptom was `launcherScript requires a
      // participantCommand` from three objects away. The key list says whether the field was
      // never sent or was stripped in transit.
      return json(409, {
        error: 'executor_refused',
        reason: String(error?.message ?? error),
        received: run ? Object.keys(run) : null,
        hasCommand: Boolean(run?.command),
        commandBytes: typeof run?.command === 'string' ? run.command.length : -1,
      });
    }
  }
}

/** `ctx.container`, named so the fetch body above reads as prose. */
function containerOf(ctx) {
  if (!ctx.container) {
    throw new Error('this executor object has no container binding');
  }
  return ctx.container;
}

export { CommitGate };

export default {
  async fetch(request, env) {
    const decision = await decide(request, env);

    if (decision.action === 'health') {
      // Deliberately the same body whether or not a secret is configured.
      //
      // An earlier draft reported `workspaceAuth: 'absent'` here, which turned the one
      // unauthenticated route into a way for anyone to learn that a deployment forgot
      // its credential. The operator learns it from the 503 every workspace route then
      // returns; a stranger learns only that the service exists.
      return json(200, { ok: true, service: 'ingress-workspace' });
    }

    if (decision.action === 'refuse') {
      // `WWW-Authenticate` on the 401 so the failure is legible to a standard client
      // rather than only to someone who read the router.
      //
      // The scheme is a registered token type, not `Bearer`. The credential travels in
      // `x-ingress-workspace-token`, and RFC 6750 `Bearer` specifically means the
      // `Authorization` header — a generic client honouring this header would send
      // `Authorization: Bearer …` and be refused forever.
      const headers = decision.status === 401 ? { 'www-authenticate': 'Token realm="ingress-workspace"' } : undefined;
      return json(decision.status, decision.body, headers);
    }

    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(decision.workspace));
    const target = new URL(`https://workspace.internal${decision.path}`);
    target.search = decision.search;

    return stub.fetch(target.toString(), {
      method: request.method,
      headers: decision.headers,
      body: request.body,
      ...(request.body ? { duplex: 'half' } : {}),
    });
  },
};