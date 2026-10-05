/**
 * The router's decision: which requests may reach a Durable Object, and which may not.
 *
 * Why this file exists
 *
 * `src/worker.js` imports `cloudflare:workers`, so it cannot be loaded under Node.
 * Any behaviour written there is untestable without an account, and an untestable
 * authentication check is not a check — it is a comment. So the decision lives here,
 * in a pure module with no Cloudflare import, and the adapter asks it.
 *
 * This is the same split the workspace already uses: `product/workspace-agent.mjs`
 * stays plain JavaScript so the fence is testable, and `src/worker.js` is the
 * adapter that reaches `ctx.container`. The routing decision joins the fence on the
 * pure side, because it is the other decision that must be correct.
 *
 * What it decides
 *
 *   /health        liveness, reachable without a credential. It reveals a service
 *                  name and nothing else, and a load balancer cannot hold a secret.
 *   /w/:name/*     a workspace. Requires the deployment's workspace token.
 *   anything else  404, as before.
 *
 * Fail closed
 *
 * If `WORKSPACE_TOKEN` is not configured, every workspace route is refused with
 * 503 rather than served. A deployment that forgot its secret must be visibly
 * broken, not quietly open: the alternative is the exact failure this product
 * exists to prevent, arrived at by omission.
 *
 * The `/internal/` prefix
 *
 * A container's egress never arrives here. `container.interceptAllOutboundHttp` sends
 * all of it to the `CommitGate` WorkerEntrypoint, which resolves the Durable Object
 * stub itself and calls the gate's `/internal/*` routes on the object directly
 * (`product/gate.mjs`). The public router is not in that path, so forwarding
 * `/internal/*` served nobody — it only let anyone holding the workspace credential
 * reach the gate's routes from the internet, which is the exclusivity claim at
 * the exclusivity claim in `product/gate.mjs`'s header failing in the one direction that
 * matters.
 *
 * So this refuses the prefix outright rather than looking for a marker the platform
 * cannot add. No legitimate caller is broken, because there is no legitimate caller:
 * the gate holds its own tokens, and `/internal/gate-log` was unauthenticated.
 *
 * The gate's surface is now four routes, not one: `/commit`, `/seed`, and the two lease
 * routes `/start` needs so the container can hold and renew its own lease. All four are
 * covered by matching the prefix, which is why that is the rule rather than an
 * enumeration — see `docs/product-hardening-plan.md` item 7.
 */

import { tokensMatch } from './keys.mjs';

/**
 * Paths that exist only between the gate and the Durable Object.
 *
 * Refused here for a caller, not for a container: a container does not come through
 * this router. Matching on the prefix rather than an enumerated list means a new
 * internal route is covered by default instead of by remembering to add it.
 */
export const INTERNAL_PREFIX = '/internal/';

/** The credential a caller must present on every workspace route. */
export const WORKSPACE_TOKEN_HEADER = 'x-ingress-workspace-token';

/**
 * The env var holding the expected token.
 *
 * A secret, not a var: `wrangler secret put WORKSPACE_TOKEN`. It is never written
 * to `wrangler.jsonc`, and no code path logs it.
 */
export const WORKSPACE_TOKEN_VAR = 'WORKSPACE_TOKEN';

/**
 * Decide what to do with a request.
 *
 * Returns a plain value and performs no I/O, so it is testable as a function of
 * path, headers and env. The caller turns a `forward` into a `stub.fetch` and
 * anything else into a `Response`.
 *
 * @returns {Promise<
 *   | { action: 'health' }
 *   | { action: 'forward', workspace: string, path: string, search: string, headers: Headers }
 *   | { action: 'refuse', status: number, body: object }
 * >}
 */
export async function decide(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return { action: 'health' };
  }

  const match = /^\/w\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    return {
      action: 'refuse',
      status: 404,
      body: { error: 'not_found', routes: ['/health', 'w/:workspace/*'] },
    };
  }

  const presented = request.headers.get(WORKSPACE_TOKEN_HEADER);
  const verdict = await credentialVerdict(presented, env?.[WORKSPACE_TOKEN_VAR]);
  if (verdict.status !== 200) {
    return {
      action: 'refuse',
      status: verdict.status,
      // The reason names the cause and never the expected value. An operator needs
      // to tell "I never set the secret" from "the caller sent the wrong one", and a
      // caller learns nothing from either.
      body: { error: 'refused', reason: verdict.reason },
    };
  }

  const workspace = decodeURIComponent(match[1]);
  const path = match[2] ?? '/state';

  // Checked after the credential and before anything is built for forwarding, so a
  // refused internal route costs a string compare and never reaches the object.
  if (path === '/internal' || path.startsWith(INTERNAL_PREFIX)) {
    return {
      action: 'refuse',
      status: 404,
      // 404, not 403: these paths are not part of the public surface at all, and
      // saying "forbidden" would confirm they exist. A caller learns nothing about
      // what is behind them.
      body: { error: 'not_found', routes: ['/health', 'w/:workspace/*'] },
    };
  }

  const headers = new Headers(request.headers);

  // Strip our own credential before forwarding. It has done its job at this point,
  // and the Durable Object has no use for it. A credential that reaches further than
  // it must is one more place it can be logged.
  headers.delete(WORKSPACE_TOKEN_HEADER);

  // Stamped by the router rather than by the caller. This is where workspace
  // identity enters the system: the Durable Object cannot reverse its own id into
  // a name, so a caller must not be able to choose the name it writes into by
  // putting one in a body or a header.
  headers.set('x-ingress-workspace', workspace);

  return {
    action: 'forward',
    workspace,
    // The sub-path and query are preserved so the object's own routing sees
    // `/join?name=...` rather than a bare `/join`.
    path,
    search: url.search,
    headers,
  };
}

/**
 * Is this caller allowed in?
 *
 * Three outcomes, and the third is the one that matters: an unconfigured
 * deployment is refused rather than served.
 *
 * The comparison reuses `tokensMatch`, which compares fixed-length digests rather
 * than short-circuiting on the first differing character. `===` on a route with no
 * authentication in front of it is a timing channel, and this is exactly such a
 * route.
 */
async function credentialVerdict(presented, expected) {
  if (typeof expected !== 'string' || expected.length === 0) {
    return { status: 503, reason: 'workspace_token_not_configured' };
  }
  if (typeof presented !== 'string' || presented.length === 0) {
    return { status: 401, reason: 'missing_workspace_token' };
  }
  if (!(await tokensMatch(expected, presented))) {
    return { status: 403, reason: 'workspace_token_mismatch' };
  }
  return { status: 200, reason: 'ok' };
}