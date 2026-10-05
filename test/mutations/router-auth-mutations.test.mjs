/**
 * Every mutation of the router's credential check, run against the check meant to
 * catch it.
 *
 * The pattern this repository already uses is a behavioural guard, and a guard that
 * has never been observed failing is not known to work. `docs/container-commit-report.md`
 * records the rule: a check that cannot fail is not verified, only present.
 *
 * This file mutates a *copy* of `router.mjs` in a temp directory, rewrites one line,
 * and re-runs the real assertions against it. It never modifies the source file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Two levels up: this file lives in `test/mutations/`.
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ROUTER = join(REPO, 'src/product/router.mjs');
const KEYS = join(REPO, 'src/product/keys.mjs');
const SECRET = 'workspace-secret-for-tests';
const HEADER = 'x-ingress-workspace-token';

const original = await readFile(ROUTER, 'utf8');

/**
 * Load a mutated copy of the router.
 *
 * The copy goes in a temp directory with a copy of `keys.mjs` beside it, so its
 * relative import still resolves and the real module is exercised. Rewriting the
 * import to point at the repo instead would mean no longer testing the module graph as
 * it ships.
 */
async function loadMutated(transform, name) {
  const dir = await mkdtemp(join(tmpdir(), 'ingress-router-mutation-'));
  const mutated = transform(original);
  assert.notEqual(mutated, original, `mutation ${name} changed nothing, so it proves nothing`);
  const file = join(dir, 'router.mjs');
  await writeFile(join(dir, 'keys.mjs'), await readFile(KEYS, 'utf8'));
  await writeFile(file, mutated);
  const module = await import(pathToFileURL(file).href);
  return { module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const at = (path, headers = {}) =>
  new Request(new URL(path, 'https://ingress.invalid'), { headers });

/**
 * Build an env, defaulting to a configured deployment.
 *
 * Takes an object rather than a bare value on purpose: a `token = SECRET` default
 * parameter would silently replace `undefined` with the secret, which is precisely the
 * case the fail-closed assertion is testing.
 */
const env = (overrides = {}) => ({ WORKSPACE_TOKEN: SECRET, ...overrides });

/** The assertions the real suite makes. If a mutation survives these, the suite is weak. */
const REAL_ASSERTIONS = [
  {
    name: 'no credential is refused',
    async run(router) {
      const decision = await router.decide(at('/w/demo/state'), env());
      assert.equal(decision.action, 'refuse');
      assert.equal(decision.status, 401);
    },
  },
  {
    name: 'wrong credential is refused',
    async run(router) {
      const decision = await router.decide(at('/w/demo/state', { [HEADER]: 'wrong' }), env());
      assert.equal(decision.action, 'refuse');
      assert.equal(decision.status, 403);
    },
  },
  {
    name: 'the correct credential is forwarded',
    async run(router) {
      const decision = await router.decide(at('/w/demo/state', { [HEADER]: SECRET }), env());
      assert.equal(decision.action, 'forward');
    },
  },
  {
    name: 'an unconfigured deployment is refused, not served',
    async run(router) {
      for (const value of [undefined, '', 0, null, {}]) {
        const decision = await router.decide(
          at('/w/demo/state', { [HEADER]: SECRET }),
          env({ WORKSPACE_TOKEN: value }),
        );
        assert.equal(decision.action, 'refuse', `a ${typeof value} secret was accepted`);
        assert.equal(decision.status, 503);
      }
    },
  },
  {
    name: 'the credential does not reach the Durable Object',
    async run(router) {
      const decision = await router.decide(at('/w/demo/state', { [HEADER]: SECRET }), env());
      assert.equal(decision.headers.get(HEADER), null);
    },
  },
  {
    // A prefix comparison is the weakening `tokensMatch` exists to prevent: a caller
    // who learns the first character of the secret would satisfy a `startsWith`.
    name: 'a prefix of the secret is refused',
    async run(router) {
      for (const presented of [SECRET.slice(0, -1), SECRET.slice(0, 1), '']) {
        const decision = await router.decide(at('/w/demo/state', { [HEADER]: presented }), env());
        assert.equal(decision.action, 'refuse', `"${presented}" was accepted`);
      }
    },
  },
  {
    // Identity must enter at the router. If a caller's own header wins, a caller can
    // choose which workspace it writes into, which is the property the stamp exists for.
    name: "the caller's workspace header cannot override the stamped name",
    async run(router) {
      const decision = await router.decide(
        at('/w/demo/state', { [HEADER]: SECRET, 'x-ingress-workspace': 'someone-elses' }),
        env(),
      );
      assert.equal(decision.workspace, 'demo');
      assert.equal(decision.headers.get('x-ingress-workspace'), 'demo');
    },
  },
  {
    // The item 2 guard. Without it, anyone holding the workspace token could post to
    // `/internal/commit` from the internet and land bytes without the gate, the lease
    // handshake, or the gate log.
    name: 'no /internal route is forwarded, even with a valid credential',
    async run(router) {
      for (const path of ['/internal/commit', '/internal/seed', '/internal/gate-log', '/internal/x']) {
        const decision = await router.decide(
          at(`/w/demo${path}`, { method: 'POST', [HEADER]: SECRET }),
          env(),
        );
        assert.equal(decision.action, 'refuse', `${path} was forwarded`);
        assert.equal(decision.status, 404, `${path} answered ${decision.status}, not 404`);
      }
    },
  },
  {
    // A substring match refuses strictly more than a segment prefix, and the paths it
    // refuses beyond `/internal/` are ones a future route might legitimately want: a
    // nested or suffixed path like `/state/internal-summary`. The object 404s those
    // today, so the difference is not currently exploitable — it is latent fragility
    // that would silently break a later route from the router rather than from the
    // routing table. This asserts the router does not pre-empt the object's own answer.
    name: '"internal" outside the leading segment does not refuse the request',
    async run(router) {
      for (const path of [
        '/content/internal',            // 'internal' as a later segment
        '/state/internal-summary',      // a suffixed route that may be added later
        '/lease/checkout/internal',
      ]) {
        const decision = await router.decide(
          at(`/w/demo${path}`, { method: 'POST', [HEADER]: SECRET }),
          env(),
        );
        assert.equal(decision.action, 'forward', `${path} was refused by the router`);
        assert.equal(decision.path, path);
      }

      // A workspace whose *name* contains it is untouched: the name is not the path.
      const workspace = await router.decide(at('/w/internal-demo/state', { [HEADER]: SECRET }), env());
      assert.equal(workspace.action, 'forward');
      assert.equal(workspace.workspace, 'internal-demo');

      // And a query value naming an internal path is untouched.
      const query = await router.decide(at('/w/demo/content?path=internal/commit', { [HEADER]: SECRET }), env());
      assert.equal(query.action, 'forward');
      assert.equal(query.path, '/content');
    },
  },
];

test('the unmutated router satisfies every assertion', async t => {
  const router = await import(pathToFileURL(ROUTER).href);
  for (const assertion of REAL_ASSERTIONS) {
    await t.test(assertion.name, () => assertion.run(router));
  }
});

const MUTATIONS = [
  {
    name: 'the credential check is removed entirely',
    transform: source => source.replace(
      /const verdict = await credentialVerdict\(presented, env\?\.\[WORKSPACE_TOKEN_VAR\]\);/,
      'const verdict = { status: 200, reason: "ok" };',
    ),
    mustFail: ['no credential is refused', 'wrong credential is refused'],
  },
  {
    name: 'the comparison accepts any non-empty credential',
    transform: source => source.replace(
      'if (!(await tokensMatch(expected, presented))) {',
      'if (false) {',
    ),
    mustFail: ['wrong credential is refused'],
  },
  {
    name: 'the comparison becomes a prefix match',
    transform: source => source.replace(
      'if (!(await tokensMatch(expected, presented))) {',
      'if (presented !== expected && !expected.startsWith(presented)) {',
    ),
    mustFail: ['a prefix of the secret is refused'],
  },
  {
    name: 'a missing credential is treated as valid',
    transform: source => source.replace(
      /if \(typeof presented !== 'string' \|\| presented\.length === 0\) \{\n    return \{ status: 401, reason: 'missing_workspace_token' \};\n  \}/,
      "if (false) {\n    return { status: 401, reason: 'missing_workspace_token' };\n  }",
    ),
    mustFail: ['no credential is refused'],
  },
  {
    name: 'an unconfigured deployment is served instead of refused',
    transform: source => source.replace(
      /if \(typeof expected !== 'string' \|\| expected\.length === 0\) \{\n    return \{ status: 503, reason: 'workspace_token_not_configured' \};\n  \}/,
      "if (false) {\n    return { status: 503, reason: 'workspace_token_not_configured' };\n  }",
    ),
    mustFail: ['an unconfigured deployment is refused, not served'],
  },
  {
    name: 'the credential is forwarded to the Durable Object',
    transform: source => source.replace(
      'headers.delete(WORKSPACE_TOKEN_HEADER);',
      '',
    ),
    mustFail: ['the credential does not reach the Durable Object'],
  },
  {
    name: "the workspace name is taken from the caller's header",
    transform: source => source.replace(
      "headers.set('x-ingress-workspace', workspace);",
      "headers.set('x-ingress-workspace', headers.get('x-ingress-workspace') ?? workspace);",
    ),
    mustFail: ["the caller's workspace header cannot override the stamped name"],
  },
  {
    // Reverts item 2: the /internal/ guard removed. This is the exact state the
    // deployment was in before this change, and the mutation must be caught.
    name: 'the /internal guard is removed',
    transform: source => source.replace(
      /if \(path === '\/internal' \|\| path\.startsWith\(INTERNAL_PREFIX\)\) \{[\s\S]*?\n  \}\n\n/,
      '',
    ),
    mustFail: ['no /internal route is forwarded, even with a valid credential'],
  },
  {
    // The obvious wrong implementation of a prefix guard: a substring match refuses a
    // workspace named `internal-demo` and a legitimate `?path=internal/…` query.
    name: 'the /internal guard becomes a substring match',
    transform: source => source.replace(
      "if (path === '/internal' || path.startsWith(INTERNAL_PREFIX)) {",
      "if (path.includes('internal')) {",
    ),
    mustFail: ['"internal" outside the leading segment does not refuse the request'],
  },
  {
    // A 403 confirms the route exists. The assertion that catches this compares the
    // body rather than only the status, so a prober learns nothing from the difference.
    name: 'the /internal refusal becomes a 403',
    transform: source => source.replace(
      /action: 'refuse',\n      status: 404,\n      \/\/ 404, not 403[\s\S]*?body: \{ error: 'not_found', routes: \['\/health', 'w\/:workspace\/\*'\] \},\n    \};\n  \}\n\n  const headers/,
      "action: 'refuse',\n      status: 403,\n      body: { error: 'refused', reason: 'internal_route' },\n    };\n  }\n\n  const headers",
    ),
    mustFail: ['no /internal route is forwarded, even with a valid credential'],
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async t => {
    const { module, cleanup } = await loadMutated(mutation.transform, mutation.name);
    t.after(cleanup);

    const failures = [];
    for (const assertion of REAL_ASSERTIONS) {
      try {
        await assertion.run(module);
      } catch {
        failures.push(assertion.name);
      }
    }

    // Every mutation must name the assertion that catches it. An earlier draft
    // allowed `mustFail: []` with a comment about semantic equivalence, which
    // asserted that the mutation's *name* contained a word rather than proving
    // anything. Both surviving mutations were real weakenings, and both are now
    // caught. A new mutation with no named assertion fails here.
    assert.ok(
      mutation.mustFail.length > 0,
      `${mutation.name} names no assertion that should catch it`,
    );

    for (const expected of mutation.mustFail) {
      assert.ok(
        failures.includes(expected),
        `${mutation.name} survived the assertion "${expected}" — the suite does not catch this`,
      );
    }
  });
}