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
import { contentKey, ledgerKey, leasesKey, gateLogKey, usageKey, GATE_LOG_HISTORY } from './keys.mjs';
import { usageFrom, usageSnapshot, ceilingFromEnv, applyDelta } from './usage.mjs';
import { executorName } from './slots.mjs';
import { readIndex, readRevision } from './content-store.mjs';
import * as commitHandler from './handlers/commit.mjs';
import * as leaseHandler from './handlers/leases.mjs';
import * as cacheHandler from './handlers/cache.mjs';
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
      usage: () => this.getUsage(),
      addUsage: delta => this.addUsage(delta),
      ceiling: () => this.ceiling(),
      // How to reach an executor. A function rather than a stub, because which executor a
      // start uses is decided per start (the slot) — so the arbiter asks for one by number
      // and the naming lives in `slots.mjs`, where the mapping is defined and tested.
      executor: (workspaceName, slot) => this.executor(workspaceName, slot),
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

  /**
   * What this workspace has consumed, and the ceiling it is held to.
   *
   * Cached on the instance like the ledger and the lease table, for the same reason: a
   * Durable Object can be evicted between requests, so anything held only in memory would
   * reset to zero — and a usage counter that resets to zero on eviction is a cost ceiling
   * that does not hold.
   */
  async getUsage() {
    if (this.usage) return this.usage;
    this.usage = usageFrom(await this.state.storage.get(usageKey));
    return this.usage;
  }

  /**
   * Add to the counters, atomically.
   *
   * `saveUsage(recordX(await usage()))` — which is what every call site used to do, and which was a
   * **lost update** the moment anything runs concurrently, and it fails silently. The usage
   * helpers return a new object built from the cached one, so two interleaved starts both
   * read revision 0, both compute revision 1, and one increment disappears. That is not a
   * theoretical concern: it was found by the first live concurrent run, where five starts
   * were counted as four.
   *
   * It is worth being precise about why the other state does not have this bug, because the
   * contrast is the reason this one was easy to miss. The ledger and the lease table are
   * mutated **in place** on a shared instance, so two interleaved callers accumulate on one
   * object and the last save writes the union. Usage was written as immutable transforms,
   * which is tidier and is exactly what made it unsafe.
   *
   * The whole read-modify-write therefore has to happen inside a storage transaction. Doing
   * it in two awaits outside one is the same bug with more steps.
   */
  async addUsage(delta) {
    const storage = this.state.storage;
    const apply = async () => {
      const current = usageFrom(await storage.get(usageKey));
      const next = applyDelta(current, delta);
      await storage.put(usageKey, next);
      return next;
    };

    // The cache is refreshed from what was written, so a later `getUsage()` in the same
    // request sees the increment rather than the value it read before.
    this.usage = storage.transaction ? await storage.transaction(apply) : await apply();
    return this.usage;
  }

  /** The bounds, read from the environment on every use so a change needs no redeploy state. */
  ceiling() {
    return ceilingFromEnv(this.env ?? {});
  }

  /**
   * The executor object for one slot, wrapped so a handler asks for a slot and gets a
   * `run()`, rather than assembling an object name and a request at a call site.
   */
  executor(workspaceName, slot) {
    const name = executorName(workspaceName, slot);
    const stub = this.env.EXECUTOR.get(this.env.EXECUTOR.idFromName(name));
    return {
      name,
      run: run => stub.fetch('https://executor.internal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(run),
      }).then(async response => ({ status: response.status, outcome: await response.json() })),
    };
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
    // The build cache. Not workspace content, so not fenced: a cache miss costs time, not
    // correctness. See `handlers/cache.mjs`.
    if (url.pathname === '/internal/cache' && method === 'GET') {
      return cacheHandler.get(this.ctx, request);
    }
    if (url.pathname === '/internal/cache' && method === 'POST') {
      return cacheHandler.put(this.ctx, request);
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

    // --- usage ---
    //
    // Authenticated like every other workspace route, and reachable by whoever holds the
    // workspace credential. That is the same audience that can boot containers, so it is
    // the audience that needs to know what it has used.
    //
    // It exposes the ceiling as well as the counters, deliberately. A limit a caller can
    // only discover by hitting is a limit they cannot plan around, and the counters without
    // the bound they are measured against are just numbers.
    if (url.pathname === '/usage' && method === 'GET') {
      return json(200, usageSnapshot(await this.getUsage(), this.ceiling()));
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

      // What this path retains, so history is observable rather than a claim.
      //
      // A caller asking "was this there before, and can it still be merged against?" needs an
      // answer. Reporting `retained` without `trimmed` would make an evicted base
      // indistinguishable from one that never existed, and a merge would be attempted against
      // whatever happened to be left.
      const index = await readIndex(this.state.storage, path);

      // `?revision=N` serves that revision. Absent, it serves the current one — the behaviour
      // every existing caller relies on, unchanged.
      const wanted = url.searchParams.get('revision');
      if (wanted !== null) {
        const revision = Number(wanted);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          return json(400, { error: 'invalid_revision', revision: wanted ?? null });
        }
        const stored = await readRevision(this.state.storage, path, revision);
        if (!stored) {
          // Distinguishes the two cases a caller has to tell apart: this revision was trimmed,
          // or it never existed. Without `trimmed` those are the same 404.
          const held = index.entries.some(entry => entry.revision === revision);
          return json(404, {
            error: held ? 'revision_missing' : 'revision_not_retained',
            path,
            revision,
            trimmed: index.trimmed,
            retained: index.entries.map(entry => entry.revision),
          });
        }
        return json(200, {
          path,
          revision,
          author: stored.author ?? null,
          contentBase64: stored.contentBase64,
          contentHash: stored.contentHash,
          retained: index.entries.map(entry => entry.revision),
          trimmed: index.trimmed,
        });
      }

      const record = ledger.files.get(path);
      const stored = await this.state.storage.get(contentKey(path));
      if (!stored) return json(404, { error: 'no_such_path', path, retained: [], trimmed: 0 });

      return json(200, {
        path,
        revision: record?.revision ?? null,
        author: record?.author ?? null,
        contentBase64: stored.contentBase64,
        contentHash: stored.contentHash,
        retained: index.entries.map(entry => entry.revision),
        trimmed: index.trimmed,
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