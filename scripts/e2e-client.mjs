/**
 * The client every e2e script shares.
 *
 * Four scripts each grew their own `post`/`get` pair, and each of them inherited undici's
 * 10-second connect timeout — which is shorter than a cold Cloudflare edge takes to answer.
 * The first `/health` probe in a session measured 22 seconds here, with the next three at
 * 0.13s. So the scripts died on their second request with `ConnectTimeoutError` and
 * reported it as a product failure.
 *
 * This lives in one place rather than in four because the alternative is the fourth copy
 * being the one with the bug, and because the retry has to be here rather than in `src/`:
 * retrying a `/start` inside the product would boot a second container.
 *
 * What is retried, and why only that
 *
 * Only a *transport* failure, which is a request that provably reached nobody. A 4xx or 5xx
 * is returned as-is, because re-sending it would either repeat a refusal the caller needs
 * to see or — for `/start` — boot a second container. A connect timeout cannot have done
 * that: no TCP session was established.
 */

/** The worker's workspace credential. Refused rather than sent as nothing. */
const TOKEN = process.env.INGRESS_WORKSPACE_TOKEN;
if (!TOKEN) {
  console.error('INGRESS_WORKSPACE_TOKEN is required: every /w/:workspace route is authenticated.');
  process.exit(2);
}

const auth = { 'x-ingress-workspace-token': TOKEN };

const BASE = (process.env.INGRESS_BASE_URL ?? 'https://ingress-workspace.narfin.workers.dev')
  .replace(/\/+$/, '');

/** Long enough for a cold edge, and short enough that a real hang still fails. */
const REQUEST_TIMEOUT_MS = 90_000;
const CONNECT_ATTEMPTS = 3;

const isTransport = error =>
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_/i.test(String(error?.message ?? error));

/**
 * `fetch`, retrying only what provably never arrived.
 *
 * @param {string} target absolute URL
 * @param {RequestInit} [init]
 */
export async function request(target, init = {}, attempts = CONNECT_ATTEMPTS) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(target, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (attempt >= attempts || !isTransport(error)) throw error;
      console.log(`  (connect attempt ${attempt} failed — ${error?.cause?.code ?? error.message}; retrying)`);
    }
  }
}

/**
 * A client bound to one workspace.
 *
 * @param {string} workspace
 * @param {string} [name] used in the generated default when no workspace is given
 */
export function client(workspace, name = 'e2e') {
  const url = suffix => `${BASE}/w/${workspace}${suffix}`;

  return {
    workspace,
    url,

    async post(suffix, body) {
      const response = await request(url(suffix), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },

    async get(suffix) {
      const response = await request(url(suffix), { headers: auth });
      return { status: response.status, body: await response.json() };
    },
  };
}

/** A workspace name unique to this run, so two runs cannot collide on shared state. */
export const freshWorkspace = prefix => `${prefix}-${Date.now()}`;

/** `PASS`/`FAIL` line, and the boolean, so a caller can both print and accumulate. */
export function check(label, passed) {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
  return Boolean(passed);
}

/** A heading. */
export const step = message => console.log(`\n--- ${message}`);

/** Exit non-zero unless every check passed, with a one-line verdict either way. */
export function finish(results, verdict) {
  const failed = results.filter(passed => !passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`VERDICT: ${verdict(false)}`);
    process.exit(1);
  }
  console.log(`VERDICT: ${verdict(true)}`);
}