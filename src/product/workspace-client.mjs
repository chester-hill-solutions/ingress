/**
 * The workspace client.
 *
 * One participant, one base URL. This is deliberately the least interesting file
 * in the product: if it needs to know what kind of participant it is talking to,
 * the abstraction has leaked.
 *
 * It is transport-agnostic on purpose. `fetch` is injectable so the same client
 * drives a deployed Durable Object, a local workerd instance, or a test double,
 * with no behavioural difference between them.
 */

/**
 * Errors the workspace refuses you with.
 *
 * A refusal is not a transport failure. The workspace answered correctly; the
 * answer is "not now". These carry the evidence so a caller can act on it
 * rather than retry blindly.
 *
 * `WriteLeaseRefused` is what a commit refusal looks like from a caller. It replaces
 * `WriteRefused`, which belonged to the removed `/write` route; the shape is the same,
 * because the evidence a refusal carries did not change when the route did.
 */
export class WriteLeaseRefused extends Error {
  constructor(receipt) {
    super(`workspace refused the write: ${receipt.reason}`);
    this.name = 'WriteLeaseRefused';
    this.reason = receipt.reason;
    this.receipt = receipt;
  }
}

export class WorkspaceClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} options.participantId
   * @param {string} [options.token] the deployment's workspace credential, sent as
   *   `x-ingress-workspace-token`. Required by any deployed worker; omitted only when
   *   driving an in-process object, where there is no router to authenticate to.
   *
   * The token is held here rather than passed per call so no caller can forget it on
   * one request. It is never logged and never placed in a query string, where it would
   * land in access logs.
   */
  constructor({ baseUrl, participantId, kind = 'agent', dependencies = [], token = null, fetch: fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new TypeError('workspace baseUrl required');
    if (!participantId) throw new TypeError('workspace participantId required');
    if (kind !== 'agent' && kind !== 'human') throw new TypeError('workspace kind must be agent or human');
    if (token != null && (typeof token !== 'string' || !token || /[\r\n\0]/.test(token))) {
      throw new TypeError('workspace token must be a non-empty string without newlines');
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.participantId = participantId;
    this.kind = kind;
    this.dependencies = [...dependencies];
    this.token = token;
    this.fetch = fetchImpl;
    this.joined = false;
    this.envelope = null;
  }

  async request(path, init = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-ingress-workspace-token': this.token } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`workspace returned unparseable JSON (status ${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(body?.error ?? `workspace request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  /**
   * Arrive. The envelope tells you who else is here and what your dependencies
   * currently hold, which is the thing git cannot tell you.
   */
  async join() {
    const query = new URLSearchParams({
      name: this.participantId,
      kind: this.kind,
      dependencies: this.dependencies.join(','),
    });
    this.envelope = await this.request(`/join?${query.toString()}`);
    this.joined = true;
    return this.envelope;
  }

  async declareIntent(text) {
    return this.request('/intent', {
      method: 'POST',
      body: JSON.stringify({ participantId: this.participantId, text }),
    });
  }

  /**
   * Take a lease, and receive the content it covers.
   *
   * This is how a read becomes a fact. There is no `read` method, and there is no route
   * to call: a participant's basis is recorded by the workspace handing it the bytes, at
   * the revision it holds. So the way to establish a read is to ask for the file.
   *
   * Declared dependencies join a *read* grant automatically, so a caller asking for what
   * it depends on gets its whole basis in one call — and the closure is granted whole or
   * refused whole, because a partial grant would leave the caller holding a lease on a
   * file it cannot use while blocking everyone who can.
   *
   * @param {object} options
   * @param {string[]} options.paths
   * @param {'read'|'write'} [options.mode] defaults to `read`
   * @param {number} [options.leaseMs] defaults to the workspace's 60s
   * @returns {Promise<object>} the grant, including `files` with base64 content
   */
  async checkout({ paths, mode = 'read', leaseMs } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TypeError('checkout requires at least one path');
    }
    return this.request('/lease/checkout', {
      method: 'POST',
      body: JSON.stringify({ participantId: this.participantId, paths, mode, leaseMs }),
    });
  }

  /**
   * Give a lease back, wholly or in part.
   *
   * Pairs with `checkout`. A grant that cannot be given back is a trap: a read lease is
   * exclusive against a write, so a caller that took one and did nothing else would
   * block every writer on those paths until it expired.
   *
   * @param {object} options
   * @param {string} options.leaseId from a `checkout` result
   * @param {string[]} [options.paths] release only these; omit to release the lot
   */
  async release({ leaseId, paths } = {}) {
    if (!leaseId) throw new TypeError('release requires a leaseId');
    return this.request('/lease/release', {
      method: 'POST',
      body: JSON.stringify({ leaseId, participantId: this.participantId, paths: paths ?? null }),
    });
  }

  /**
   * Decode one file from a grant.
   *
   * A convenience, not a protocol step: the grant carries base64 and this returns the
   * bytes a caller would otherwise `Buffer.from` by hand at every call site.
   */
  static contentOf(grant, path) {
    const entry = grant?.files?.find(file => file.path === path);
    if (!entry || entry.contentBase64 == null) return null;
    return Buffer.from(entry.contentBase64, 'base64');
  }

  // There is deliberately no `write` or `tryWrite` here.
  //
  // Both called `POST /write`, a second write path that went straight to
  // `ledger.admit` without consulting the lease table — so it admitted writes the gate
  // refuses with `lease_required`. The route is gone from the object.
  //
  // They are gone from the client too, rather than left to fail. This is the same
  // mistake as the `observe` method that was removed earlier and whose removal had to
  // be repeated on this side: a client that advertises a method the server does not
  // serve names the capability at the front door and 404s every caller.
  //
  // Bytes enter through the gate, authorised by a write lease. A caller that needs to
  // land work takes a lease, seeds, and lets its container commit.

  async receipts() {
    return this.request(`/receipts?participant=${encodeURIComponent(this.participantId)}`);
  }

  async state() {
    return this.request('/state');
  }

  // There is deliberately no `observe` method here.
  //
  // There was one, and it called `POST /observe` — a route that let any caller
  // describe any write by any author. It was the hole this whole layer exists to
  // close, and it was removed. The client kept advertising it, so the front door
  // of the product named the exact vulnerability it had eliminated, and every
  // caller got a 404.
  //
  // Bytes enter through `commit`, and only through the gate. If you find yourself
  // wanting to add a reporting method back, that is the signal to read this again.
}

/**
 * A participant's first two minutes, as a script.
 *
 * Exists because the product's promise is a stranger can run this. If arriving,
 * declaring and seeing the state of the workspace takes more than a screen, the product
 * is not usable and no amount of evidence behind it matters.
 *
 * It no longer writes, and that is not a reduction in what the product can do — it is
 * what the product now *is*. Landing bytes requires a write lease, a seed, a container
 * and the gate; a client with an HTTP method could not do it honestly, because the
 * method it needed was the unleased `/write` route this replaced.
 *
 * What it shows instead is the claim that survives: the envelope reports who else is
 * here and what your dependencies are currently at, the workspace records your read,
 * and the state you get back is the workspace's rather than a self-report. A participant
 * that wants to land work takes a lease and commits through the gate — see
 * `scripts/commit-e2e.mjs` for the whole path end to end.
 */
export async function demoParticipant({ baseUrl, participantId, kind, dependency, token = null, fetch: fetchImpl }) {
  const client = new WorkspaceClient({ baseUrl, participantId, kind, dependencies: [dependency], token, fetch: fetchImpl });
  await client.join();
  await client.declareIntent(`inspecting ${dependency}`);

  // Ask for the file. This is what records the read: the workspace hands the content
  // over, so the basis is a fact it established rather than a claim it accepted.
  const grant = await client.checkout({ paths: [dependency], mode: 'read' });
  const handedOver = WorkspaceClient.contentOf(grant, dependency);

  // Re-join *after* the grant, because the first envelope predates it: `join` is what
  // records the arrival, so an envelope fetched beforehand reports `yourReadRevision`
  // as null and cannot show the read the grant just created.
  const envelope = await client.join();
  const state = await client.state();

  return {
    client,
    envelope,
    grant,
    // The bytes, as the workspace served them. Null when the path does not exist yet,
    // which is a real answer rather than an empty file.
    content: handedOver === null ? null : handedOver.toString('utf8'),
    // What the workspace knows about the dependency this participant declared.
    read: envelope.dependencies.find(entry => entry.path === dependency) ?? null,
    state,
    // A compact record of the facts the workspace relied on, comparable between two
    // envelopes without re-deriving anything.
    fingerprint: envelope.fingerprint,
  };
}