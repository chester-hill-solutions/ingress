/**
 * The workspace: a Durable Object that fences commits.
 *
 * A DO is chosen for one reason: it is single-threaded per instance. That is what
 * lets this refuse a commit. A read-modify-write against shared state from
 * anywhere else has a race; here, the check and the decision happen in one turn of
 * the isolate, so bytes can never be admitted against evidence that has already
 * changed.
 *
 * This file is routing and wiring only. The concerns it dispatches to live in
 * `handlers/`, one concern per file:
 *
 *   handlers/commit.mjs     the only route that admits bytes
 *   handlers/leases.mjs     checkout, heartbeat, release, retrieve
 *   handlers/container.mjs  starting a participant and issuing its token
 *   handlers/bootstrap.mjs  establishing what a workspace starts as
 *
 * Two surfaces, and the split between them is the design:
 *
 *   Public  /join /intent /read /receipts /content /state /bootstrap /start
 *           /lease/* /leases
 *           What a participant may ask. Apart from `/bootstrap` — restricted to an
 *           empty ledger — none of these move file state.
 *
 *   Gate    /internal/commit /internal/seed /internal/lease/*
 *           Reached exclusively from the WorkerEntrypoint the container's egress is
 *           intercepted into, and authenticated by a token this object issued when
 *           it started that container. Only `/internal/commit` admits bytes; the others
 *           hand over content and keep a lease alive, which is not the same power.
 *
 * There is deliberately no public way to report a write. An earlier version had
 * `POST /observe` and it was the hole this whole layer exists to close: any caller
 * could describe any write by any author, so the fence enforced the consistency of
 * a ledger that callers controlled.
 */

import { WorkspaceLedger } from './fence.mjs';
import { LeaseTable } from './lease.mjs';
import { json, readJSON, MAX_BODY_BYTES } from './http.mjs';
import { contentKey, ledgerKey, leasesKey, gateLogKey, GATE_LOG_HISTORY } from './keys.mjs';
import * as commitHandler from './handlers/commit.mjs';
import * as leaseHandler from './handlers/leases.mjs';
import * as containerHandler from './handlers/container.mjs';
import * as bootstrapHandler from './handlers/bootstrap.mjs';

export class WorkspaceAgent {
  /**
   * @param {object} state  DurableObjectState
   * @param {object} env
   * @param {object} [container] ctx.container, supplied by the platform adapter
   *
   * Not extended from `DurableObject` on purpose. The platform adapter in
   * `src/worker.js` does that, because `ctx.container` is only reachable from a
   * class the runtime recognises as a Durable Object — and importing
   * `cloudflare:workers` here would make this module unloadable under Node, which
   * is where every test of the fence actually runs.
   *
   * The result is that the fence is plain JavaScript with no Cloudflare imports at
   * all, and the only Cloudflare-specific line in the product is the adapter.
   */
  constructor(state, env, container = undefined) {
    this.state = state;
    this.env = env;
    this.container = container;
    this.ledger = null;
    this.leaseTable = null;

    // Handlers receive this rather than the object itself, so they depend on the
    // handful of things they use instead of on whatever the class happens to carry.
    this.ctx = {
      state,
      env,
      container,
      getLedger: () => this.getLedger(),
      saveLedger: () => this.saveLedger(),
      leases: () => this.getLeases(),
      saveLeases: () => this.saveLeases(),
    };
  }

  async getLedger() {
    if (this.ledger) return this.ledger;
    const stored = await this.state.storage.get(ledgerKey);
    this.ledger = WorkspaceLedger.fromJSON(stored) ?? new WorkspaceLedger({ epoch: crypto.randomUUID() });
    return this.ledger;
  }

  async saveLedger() {
    await this.state.storage.put(ledgerKey, this.ledger.toJSON());
  }

  /**
   * The lease table, kept beside the ledger.
   *
   * Same Durable Object, same turn. That is not tidiness: a lease grant and the
   * commit decision it authorises must not be separated by anything, or a file
   * could be granted to one participant and written by another.
   */
  async getLeases() {
    const stored = await this.state.storage.get(leasesKey);
    this.leaseTable = LeaseTable.fromJSON(stored);
    return this.leaseTable;
  }

  async saveLeases() {
    await this.state.storage.put(leasesKey, this.leaseTable.toJSON());
  }

  async fetch(request) {
    // A malformed request is a 4xx/5xx, never an unhandled throw. A DO that throws
    // out of fetch produces a runtime error page instead of an answer, and a client
    // cannot tell a refusal from a crash.
    try {
      return await this.route(request);
    } catch (error) {
      const status = error?.name === 'FenceRefusal' ? 400 : 500;
      return json(status, { error: error?.reason ?? error?.message ?? 'request_failed' });
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const method = request.method;

    // --- the gate: the only routes that reach a participant ---
    if (url.pathname === '/internal/commit' && method === 'POST') {
      return commitHandler.commit(this.ctx, request);
    }
    if (url.pathname === '/internal/seed' && method === 'POST') {
      return commitHandler.seed(this.ctx, request);
    }
    if (url.pathname === '/internal/gate-log' && method === 'POST') {
      return this.recordGateLog(request);
    }
    // The container's lease surface. Reachable only from the gate, which forwards the
    // participant's token and nothing else; each route re-checks it. Present because
    // `/start` hands the write lease to the container, and a container's only exit is the
    // gate — see `handlers/leases.mjs`.
    if (url.pathname === '/internal/lease/heartbeat' && method === 'POST') {
      return leaseHandler.containerHeartbeat(this.ctx, request);
    }
    if (url.pathname === '/internal/lease/release' && method === 'POST') {
      return leaseHandler.containerRelease(this.ctx, request);
    }
    if (url.pathname === '/gate-log') {
      // Was public. Removed: an unauthenticated route on a public worker that
      // exposes per-workspace participant ids and traffic. The gate writes the log;
      // nothing outside needs to read it.
      return json(404, { error: 'route_not_found' });
    }

    // --- leases ---
    if (url.pathname === '/lease/checkout' && method === 'POST') {
      return leaseHandler.checkout(this.ctx, request);
    }
    if (url.pathname === '/lease/heartbeat' && method === 'POST') {
      return leaseHandler.heartbeat(this.ctx, request);
    }
    if (url.pathname === '/lease/release' && method === 'POST') {
      return leaseHandler.release(this.ctx, request);
    }
    if (url.pathname === '/lease/retrieve' && method === 'POST') {
      return leaseHandler.retrieve(this.ctx, request);
    }
    if (url.pathname === '/leases' && method === 'GET') {
      return leaseHandler.list(this.ctx);
    }

    // --- lifecycle ---
    if (url.pathname === '/bootstrap' && method === 'POST') {
      return bootstrapHandler.bootstrap(this.ctx, request);
    }
    if (url.pathname === '/start' && method === 'POST') {
      return containerHandler.start(this.ctx, request, request.headers.get('x-ingress-workspace'));
    }

    // --- the ledger's own read surface ---
    //
    // There is deliberately no `/write` here. It was a second write path that called
    // `ledger.admit` directly, and `admit` takes no lease and never reads the lease
    // table — so it admitted writes the gate would have refused with `lease_required`.
    // It also admitted a revision for content it never stored, leaving `/state`
    // reporting a revision that `/content` answered 404 for.
    //
    // Bytes enter through the gate: `/internal/commit`, authorised by a write lease,
    // hashed on arrival. See `handlers/commit.mjs`. The fence's decision is still
    // reachable and still tested — `WorkspaceLedger.admit` is called directly in
    // `test/product-fence.test.mjs`, without HTTP in the way.

    if (url.pathname === '/join' && method === 'GET') {
      const ledger = await this.getLedger();
      const participantId = url.searchParams.get('name');
      const kind = url.searchParams.get('kind') === 'human' ? 'human' : 'agent';
      const dependencies = (url.searchParams.get('dependencies') ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      ledger.register({ participantId, kind, dependencies });
      await this.saveLedger();
      return json(200, ledger.joinEnvelope(participantId));
    }

    if (url.pathname === '/intent' && method === 'POST') {
      const ledger = await this.getLedger();
      const body = await readJSON(request);
      const intent = ledger.setIntent(body.participantId, body.text);
      await this.saveLedger();
      return json(200, intent);
    }

    // There is deliberately no `/read` here either.
    //
    // It recorded a read the caller *asserted*, and `readBasis: 'verified'` in the
    // fence's decision cut rested entirely on that assertion — so the property the whole
    // product is built on, that a participant's basis is current, was self-reported.
    //
    // A read is now recorded where it can be known: by `handlers/leases.mjs`, at the
    // moment a lease grant hands the content over. The workspace decided to give those
    // bytes to that participant at those revisions, so the read is a consequence of a
    // fact rather than a claim about one.

    if (url.pathname === '/receipts' && method === 'GET') {
      const ledger = await this.getLedger();
      const participantId = url.searchParams.get('participant');
      return json(200, {
        receipts: participantId ? ledger.receiptsFor(participantId) : ledger.receipts,
      });
    }

    if (url.pathname === '/content' && method === 'GET') {
      const ledger = await this.getLedger();
      // Content is served from admitted state only, never from whatever a
      // participant most recently claimed.
      const path = url.searchParams.get('path');
      const stored = await this.state.storage.get(contentKey(path));
      if (!stored) return json(404, { error: 'no_such_path', path });
      const record = ledger.files.get(path);
      return json(200, {
        path,
        revision: record?.revision ?? null,
        author: record?.author ?? null,
        contentBase64: stored.contentBase64,
        contentHash: stored.contentHash,
      });
    }

    if (url.pathname === '/state' && method === 'GET') {
      return json(200, (await this.getLedger()).snapshot());
    }

    return json(404, { error: 'route_not_found' });
  }

  async recordGateLog(request) {
    const entry = await readJSON(request, MAX_BODY_BYTES);
    const existing = ((await this.state.storage.get(gateLogKey)) ?? []);
    await this.state.storage.put(gateLogKey, [...existing, entry].slice(-GATE_LOG_HISTORY));
    return json(200, { logged: true, count: existing.length + 1 });
  }
}