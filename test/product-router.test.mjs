/**
 * The router's decision: who reaches a Durable Object.
 *
 * `src/worker.js` imports `cloudflare:workers` and cannot be loaded under Node, which
 * is why the gate's own guarantees are asserted by reading its source text
 * (`test/product-workspace.test.mjs:603`). This file exists because an authentication
 * check asserted only by reading its source is not a check.
 *
 * So the decision under test is `product/router.mjs`, which is pure. What is *not*
 * covered here, and is stated rather than implied: the adapter's own `stub.fetch`
 * call, its `idFromName` wiring, and the Durable Object stub itself. Those need an
 * account. Everything that decides who gets in is here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, WORKSPACE_TOKEN_HEADER, WORKSPACE_TOKEN_VAR } from '../src/product/router.mjs';

const SECRET = 'workspace-secret-for-tests';

/** A request shaped like the ones the router actually receives. */
const at = (path, { method = 'GET', headers = {} } = {}) =>
  new Request(new URL(path, 'https://ingress.invalid'), { method, headers });

const authed = (path, init = {}) =>
  at(path, { ...init, headers: { ...init.headers, [WORKSPACE_TOKEN_HEADER]: SECRET } });

const env = (overrides = {}) => ({ [WORKSPACE_TOKEN_VAR]: SECRET, ...overrides });

// --- the workspace routes require the credential ------------------------------

test('a workspace route refuses a caller with no credential', async () => {
  const decision = await decide(at('/w/demo/state'), env());
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.status, 401);
  assert.equal(decision.body.reason, 'missing_workspace_token');
});

test('a workspace route refuses a caller with the wrong credential', async () => {
  const decision = await decide(
    at('/w/demo/state', { headers: { [WORKSPACE_TOKEN_HEADER]: 'not-the-secret' } }),
    env(),
  );
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.status, 403);
  assert.equal(decision.body.reason, 'workspace_token_mismatch');
});

test('a credential that is a prefix of the secret is refused', async () => {
  // The failure mode a prefix comparison would admit. `===` rejects it too, so this
  // does not distinguish the implementations — it pins the behaviour either way.
  const decision = await decide(
    at('/w/demo/state', { headers: { [WORKSPACE_TOKEN_HEADER]: SECRET.slice(0, -1) } }),
    env(),
  );
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.status, 403);
});

test('an empty credential is treated as absent, not as a guess', async () => {
  const decision = await decide(at('/w/demo/state', { headers: { [WORKSPACE_TOKEN_HEADER]: '' } }), env());
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.status, 401);
});

// --- every workspace route is behind the same check ---------------------------

test('no /internal route reaches the Durable Object, even with the credential', async () => {
  // The exclusivity claim in `product/gate.mjs`'s header: a participant cannot publish a
  // byte except through the gate. It failed in one direction — anyone holding the
  // workspace token could reach `/internal/commit` from the internet, skipping the
  // container, the lease handshake and the gate log.
  //
  // A container is unaffected because its egress is intercepted to the
  // `CommitGate` WorkerEntrypoint, which resolves the stub itself
  // (`product/gate.mjs`, the `PERMITTED` table and the forwarding below it). The public
  // router is not in that path. Line numbers were removed from these references because
  // every edit to `gate.mjs` moved them, and a stale one reads as a live citation.
  for (const path of [
    '/internal/commit',
    '/internal/seed',
    '/internal/gate-log',
    // The container's lease surface, added with `/start` handing the write lease to the
    // container. It renews and releases the caller's *own* lease and admits no bytes, but
    // it is still a gate-only route and must be unreachable from the internet like the
    // rest — which is only true if it is listed here.
    '/internal/lease/heartbeat',
    '/internal/lease/release',
    '/internal',
    '/internal/',
    '/internal/anything-new',
  ]) {
    const decision = await decide(authed(`/w/demo${path}`, { method: 'POST' }), env());
    assert.equal(decision.action, 'refuse', `${path} was forwarded to the Durable Object`);
    // 404 rather than 403, so the refusal does not confirm the route exists.
    assert.equal(decision.status, 404, `${path} answered ${decision.status}, not 404`);
  }
});

test('the /internal refusal is indistinguishable from an unknown path', async () => {
  // A 403 would tell a prober that `/internal/commit` is real and merely gated. Both
  // the status and the body must match a path that never existed.
  //
  // Compared on the *body* of a refusal rather than on the whole decision: an unknown
  // path is refused before authentication, so it carries a credential reason while a
  // known-but-internal path carries the 404. Same answer, different order of checks.
  const internal = await decide(authed('/w/demo/internal/commit', { method: 'POST' }), env());
  const unknown = await decide(authed('/w/demo/no-such-route', { method: 'POST' }), env());
  assert.equal(internal.status, 404);
  assert.deepEqual(internal.body, {
    error: 'not_found',
    routes: ['/health', 'w/:workspace/*'],
  });

  // An unknown path under /w/ is forwarded and 404s inside the object, whereas
  // /internal/ is refused here. Same visible answer to a caller, different mechanism —
  // which is the point: the 404 does not disclose that /internal/ is special.
  assert.equal(unknown.action, 'forward');
  assert.equal(unknown.path, '/no-such-route');
});

test('an /internal route is refused before a request is built for forwarding', async () => {
  // The refusal must not leak the workspace name onward. If it forwarded a header
  // before checking, the stamp would already have been applied.
  const decision = await decide(
    authed('/w/demo/internal/commit', { method: 'POST', headers: { 'x-ingress-workspace': 'spoofed' } }),
    env(),
  );
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.headers, undefined, 'a refused request must carry no forwarded headers');
});

test('"internal" outside the leading segment does not refuse the request', async () => {
  // The guard is a prefix match on a leading path segment, not a substring match on the
  // whole URL. Three cases that a naive `path.includes('internal')` would break:
  //
  //   /state/internal-summary  a suffixed route a later change might add
  //   /content/internal       'internal' as a later segment
  //   ?path=internal/commit   a query value naming an internal path
  //
  // The first is the reason. The object 404s these today, so nothing is currently
  // exploitable — but a substring guard would refuse them from the router instead of
  // letting the routing table answer, which is how a later route breaks silently.
  for (const path of ['/content/internal', '/state/internal-summary', '/lease/checkout/internal']) {
    const decision = await decide(authed(`/w/demo${path}`, { method: 'POST' }), env());
    assert.equal(decision.action, 'forward', `${path} was refused`);
    assert.equal(decision.path, path);
  }

  const query = await decide(authed('/w/demo/content?path=internal/commit'), env());
  assert.equal(query.action, 'forward');
  assert.equal(query.path, '/content');

  // The workspace name is not the path, so a workspace may be called anything.
  const workspace = await decide(authed('/w/internal-demo/state'), env());
  assert.equal(workspace.action, 'forward');
  assert.equal(workspace.workspace, 'internal-demo');
});

test('no workspace route is reachable without the credential', async () => {
  // Every sub-path the Durable Object serves, plus `/start`, the gate routes, and two
  // routes that were deliberately removed. The list must track
  // `product/workspace-agent.mjs`; if a route is added there and not asserted here,
  // this test stops meaning anything. The removed ones are listed on purpose: a caller
  // must not be able to reach them by guessing the old name.
  const paths = [
    '/join?name=a',
    '/intent',
    '/read',
    '/receipts?participant=a',
    '/content?path=a',
    '/state',
    '/leases',
    '/lease/checkout',
    '/lease/heartbeat',
    '/lease/release',
    '/lease/retrieve',
    '/bootstrap',
    '/start',
    '/internal/commit',
    '/internal/seed',
    '/internal/gate-log',
    // Gate-only, added with `/start` issuing the write lease. Asserted here so the
    // statement "every sub-path the Durable Object serves" stays true.
    '/internal/lease/heartbeat',
    '/internal/lease/release',
    '/gate-log',
    // Removed routes, asserted still unreachable by name. `/write` admitted without a
    // lease check and is gone; `/observe` let any caller describe any write by any
    // author and was removed earlier. Both are listed so a regression that restores
    // either fails here rather than in production.
    '/write',
    '/observe',
  ];

  for (const path of paths) {
    for (const method of ['GET', 'POST']) {
      const decision = await decide(at(`/w/demo${path}`, { method }), env());
      assert.equal(decision.action, 'refuse', `${method} ${path} was reachable without a credential`);
      // 401 even for `/internal/*`: the credential is checked first, so an unauthenticated
      // prober cannot use the status code to enumerate which paths exist.
      assert.equal(decision.status, 401, `${method} ${path} answered ${decision.status}, not 401`);
    }
  }
});

// --- forwarding preserves what the object's own routing needs -----------------

test('an authenticated caller is forwarded with its sub-path and query intact', async () => {
  const decision = await decide(authed('/w/demo/join?name=alice&kind=human'), env());
  assert.equal(decision.action, 'forward');
  assert.equal(decision.workspace, 'demo');
  assert.equal(decision.path, '/join');
  // The object's own routing reads `?name=...`. Losing it would make every join
  // anonymous, which is a quieter failure than a 404.
  assert.equal(decision.search, '?name=alice&kind=human');
});

test('a bare workspace path defaults to /state rather than the root', async () => {
  const decision = await decide(authed('/w/demo'), env());
  assert.equal(decision.path, '/state');
});

// --- workspace identity is stamped, and the credential is not forwarded --------

test('the workspace name is stamped by the router, not taken from the caller', async () => {
  const decision = await decide(
    authed('/w/demo/state', { headers: { 'x-ingress-workspace': 'someone-elses' } }),
    env(),
  );
  assert.equal(decision.headers.get('x-ingress-workspace'), 'demo');
});

test('the credential is stripped before the request reaches the Durable Object', async () => {
  // It has done its job at the router. A secret that travels further than it must is
  // one more place it can be logged or echoed.
  const decision = await decide(authed('/w/demo/state'), env());
  assert.equal(decision.headers.get(WORKSPACE_TOKEN_HEADER), null);
});

test('a percent-encoded workspace name is decoded once', async () => {
  const decision = await decide(authed('/w/team%20one/state'), env());
  assert.equal(decision.workspace, 'team one');
  assert.equal(decision.headers.get('x-ingress-workspace'), 'team one');
});

// --- fail closed ---------------------------------------------------------------

test('an unconfigured deployment refuses every workspace route', async () => {
  // The case that matters most and is easiest to get wrong. A deployment that forgot
  // its secret must be visibly broken, not quietly open.
  for (const value of [undefined, '', 0, null, {}, 42]) {
    const decision = await decide(authed('/w/demo/state'), env({ [WORKSPACE_TOKEN_VAR]: value }));
    assert.equal(decision.action, 'refuse', `a ${typeof value} secret was accepted`);
    assert.equal(decision.status, 503);
    assert.equal(decision.body.reason, 'workspace_token_not_configured');
  }
});

test('a refused response never carries the expected secret', async () => {
  for (const [presented, expected] of [[null, SECRET], ['wrong', SECRET], [SECRET, undefined]]) {
    const headers = presented === null ? {} : { [WORKSPACE_TOKEN_HEADER]: presented };
    const decision = await decide(at('/w/demo/state', { headers }), env({ [WORKSPACE_TOKEN_VAR]: expected }));
    assert.equal(decision.action, 'refuse');
    assert.equal(
      JSON.stringify(decision.body).includes(SECRET),
      false,
      `a refusal leaked the secret: ${JSON.stringify(decision.body)}`,
    );
  }
});

// --- what stays reachable ------------------------------------------------------

test('/health needs no credential, because a load balancer cannot hold one', async () => {
  // Liveness that requires a secret is liveness that reports a false outage to
  // anything that is not holding it.
  for (const value of [SECRET, undefined]) {
    const decision = await decide(at('/health'), env({ [WORKSPACE_TOKEN_VAR]: value }));
    assert.equal(decision.action, 'health');
  }
});

test('/health does not report whether a secret is configured', async () => {
  // An earlier draft answered `workspaceAuth: 'required' | 'absent'`, which made the
  // one unauthenticated route a way for any stranger to learn that a deployment forgot
  // its credential. The operator learns it from the 503; a stranger learns only that
  // the service exists.
  //
  // Asserted over the whole adapter rather than a sliced health branch: the adapter
  // should not know how the credential is configured at all, so the strong form of the
  // guard is that it never reads the variable.
  // Comments are stripped first: this file explains the withdrawn behaviour, and the
  // explanation must not read as the behaviour still existing.
  const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /workspaceAuth/, '/health must not disclose credential state');
  assert.doesNotMatch(
    source,
    new RegExp(WORKSPACE_TOKEN_VAR),
    `the adapter must not read ${WORKSPACE_TOKEN_VAR}; the router owns that decision`,
  );
});

test('an unknown path is still a 404 that names the routes', async () => {
  const decision = await decide(authed('/nope'), env());
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.status, 404);
  assert.deepEqual(decision.body.routes, ['/health', 'w/:workspace/*']);
});

// --- structural guards ---------------------------------------------------------

test('the adapter delegates its routing decision and does not decide it', async () => {
  // The split is the reason the tests above exist. If the decision moves back into
  // `src/worker.js` it becomes untestable under Node again, and these tests would
  // keep passing while covering nothing.
  const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(source, /decide\(request, env\)/, 'the adapter must ask the pure router');
  assert.doesNotMatch(source, /idFromName\(match\[1\]\)/, 'the adapter must not re-derive the workspace');
  assert.doesNotMatch(
    source,
    new RegExp(`headers\\.get\\(['"]${WORKSPACE_TOKEN_HEADER}['"]\\)`),
    'the credential check belongs in router.mjs, where it is tested',
  );
});

test('the gate is still reachable by a container, so the check is not on it', async () => {
  // A container's egress is intercepted to the `CommitGate` WorkerEntrypoint, which
  // never passes through this router (`product/gate.mjs:29-32`). Adding a workspace
  // credential check to the public worker must therefore not require the in-container
  // reporter to learn a new header — it would break the seed and commit path.
  const reporter = readFileSync(new URL('../src/product/launcher.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    reporter,
    new RegExp(WORKSPACE_TOKEN_HEADER),
    'the in-container reporter must not need the workspace credential',
  );
});

test('refusing /internal/ cannot break the container, because the container never arrives here', async () => {
  // The structural half of the argument, and the reason this is a refusal rather than a
  // marker scheme. If a container's egress ever started arriving at the public router,
  // this guard would break every commit — so the interception is asserted, not assumed.
  //
  // Asserted in the **executor**, which is where the container is now started. It used to be
  // read out of `handlers/container.mjs`, and when execution split into its own object the
  // assertion failed — correctly, because the interception moved with the container. A
  // structural test that fails for the wrong reason is worse than none: it reads like a
  // regression in the guard when the guard never moved.
  const executor = readFileSync(
    new URL('../src/product/executor.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    executor,
    /interceptAllOutboundHttp\(gate\)/,
    'container egress must be intercepted to the gate entrypoint, not left to the public router',
  );
  assert.match(
    executor,
    /enableInternet: false/,
    'and the container must have no other way out',
  );

  // And the gate must resolve the Durable Object itself, rather than looping back
  // through the worker.
  const gate = readFileSync(new URL('../src/product/gate.mjs', import.meta.url), 'utf8');
  assert.match(
    gate,
    /idFromName\(workspace\)/,
    'the gate must address the object directly, not via /w/:name/internal/…',
  );
  assert.doesNotMatch(
    gate,
    /\/w\/\$\{|\/w\/\$\{/,
    'the gate must not construct a public worker URL',
  );
});