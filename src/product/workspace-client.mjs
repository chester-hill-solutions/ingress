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
 */
export class WriteRefused extends Error {
  constructor(receipt) {
    super(`workspace refused the write: ${receipt.reason}`);
    this.name = 'WriteRefused';
    this.reason = receipt.reason;
    this.receipt = receipt;
  }
}

export class WorkspaceClient {
  constructor({ baseUrl, participantId, kind = 'agent', dependencies = [], fetch: fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new TypeError('workspace baseUrl required');
    if (!participantId) throw new TypeError('workspace participantId required');
    if (kind !== 'agent' && kind !== 'human') throw new TypeError('workspace kind must be agent or human');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.participantId = participantId;
    this.kind = kind;
    this.dependencies = [...dependencies];
    this.fetch = fetchImpl;
    this.joined = false;
    this.envelope = null;
  }

  async request(path, init = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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
   * Read a path through the workspace, and record that you did.
   *
   * Recording matters: the fence can only protect a dependency you told it you
   * were relying on. A read the workspace never heard about is a read it cannot
   * defend.
   */
  async read(path) {
    const result = await this.request('/read', {
      method: 'POST',
      body: JSON.stringify({ participantId: this.participantId, path }),
    });
    return result;
  }

  /**
   * Ask to write.
   *
   * Returns `{ admitted: true, receipt }` or throws `WriteRefused`. Callers that
   * want to inspect rather than branch should use `tryWrite`.
   */
  async write({ path, contentHash = null, baseRevision = null }) {
    const receipt = await this.request('/write', {
      method: 'POST',
      body: JSON.stringify({ participantId: this.participantId, path, contentHash, baseRevision }),
    });
    if (!receipt.admitted) throw new WriteRefused(receipt);
    return { admitted: true, receipt };
  }

  /** The refusal as a value rather than an exception, for callers that branch on it. */
  async tryWrite(options) {
    try {
      return await this.write(options);
    } catch (error) {
      if (error instanceof WriteRefused) return { admitted: false, receipt: error.receipt };
      throw error;
    }
  }

  async receipts() {
    return this.request(`/receipts?participant=${encodeURIComponent(this.participantId)}`);
  }

  async state() {
    return this.request('/state');
  }

  /**
   * Report bytes that moved outside this client — a container diff, a teammate's
   * editor, a git hook.
   *
   * `actorId` is what the workspace can actually establish. Leave it null when
   * you do not know; the workspace will record the write as unattributed rather
   * than guess, and downstream decisions will show that honestly.
   */
  static async observe(baseUrl, writes, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
    if (!response.ok) throw new Error(`observe failed with status ${response.status}`);
    return response.json();
  }
}

/**
 * The two minutes of a participant's life, as a script.
 *
 * Exists because the product's promise is a stranger can run this. If joining,
 * declaring, reading and fenced-writing takes more than a screen, the product is
 * not usable and no amount of evidence behind it matters.
 */
export async function demoParticipant({ baseUrl, participantId, kind, dependency, watchFor = 1, pollMs = 500, fetch: fetchImpl }) {
  const client = new WorkspaceClient({ baseUrl, participantId, kind, dependencies: [dependency], fetch: fetchImpl });
  const envelope = await client.join();
  await client.declareIntent(`inspecting ${dependency}`);
  await client.read(dependency);

  const outcome = await client.tryWrite({ path: `${participantId}.note`, contentHash: `${participantId}-draft` });
  if (outcome.admitted) return { client, envelope, outcome };

  // The fence refused. Re-read, then try once more, because a fence that cannot
  // be recovered from is a wall rather than a guard.
  await client.read(dependency);
  const retry = await client.tryWrite({ path: `${participantId}.note`, contentHash: `${participantId}-draft` });
  return { client, envelope, outcome: retry };
}