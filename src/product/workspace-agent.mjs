/**
 * The workspace: a Durable Object that fences commits.
 *
 * A DO is chosen for one reason: it is single-threaded per instance. That is
 * what lets this refuse a commit. A read-modify-write against shared state from
 * anywhere else has a race; here, the check and the decision happen in one turn
 * of the isolate, so bytes can never be admitted against evidence that has
 * already changed.
 *
 * Two surfaces, and the split between them is the design:
 *
 *   Public  /join /intent /read /receipts /content /state /bootstrap /start
 *           What a participant may ask. Apart from `/bootstrap` — which is
 *           restricted to an empty ledger — none of these move file state.
 *
 *   Gate    /internal/commit
 *           The only route that admits bytes. Reached exclusively from the
 *           WorkerEntrypoint the container's egress is intercepted into, and
 *           authenticated by a token this DO issued when it started that
 *           container.
 *
 * There is deliberately no public way to report a write. An earlier version had
 * `POST /observe` and it was the hole this whole layer exists to close: any caller
 * could describe any write by any author, so the fence enforced the consistency
 * of a ledger that callers controlled.
 */

import { WorkspaceLedger } from './fence.mjs';
import { verifyCommit, evaluateCommit, applyCommit } from './commit.mjs';
import { parseManifest, summariseManifest, MANIFEST_VERSION } from './manifest.mjs';
import { launcherScript } from './launcher.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_COMMIT_BODY = 12 * 1024 * 1024;

const contentKey = path => `content:${path}`;
const tokenKey = participantId => `token:${participantId}`;
const commitKey = participantId => `commit:${participantId}`;

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
   * The result is that the fence is plain JavaScript with no Cloudflare imports
   * at all, and the only Cloudflare-specific line in the product is the adapter.
   */
  constructor(state, env, container = undefined) {
    this.state = state;
    this.env = env;
    this.container = container;
    this.ledger = null;
  }

  async load() {
    const stored = await this.state.storage.get('ledger');
    this.ledger = WorkspaceLedger.fromJSON(stored) ?? new WorkspaceLedger({ epoch: crypto.randomUUID() });
    return this.ledger;
  }

  async save() {
    await this.state.storage.put('ledger', this.ledger.toJSON());
  }

  async fetch(request) {
    // A malformed request is a 4xx/5xx, never an unhandled throw. A DO that
    // throws out of fetch produces a runtime error page instead of an answer,
    // and a client cannot tell a refusal from a crash.
    try {
      return await this.route(request);
    } catch (error) {
      const status = error?.name === 'FenceRefusal' ? 400 : 500;
      return json(status, { error: error?.reason ?? error?.message ?? 'request_failed' });
    }
  }

  async route(request) {
    const ledger = this.ledger ?? (await this.load());
    const url = new URL(request.url);

    if (url.pathname === '/internal/commit' && request.method === 'POST') {
      return this.handleCommit(request, ledger);
    }
    if (url.pathname === '/internal/gate-log' && request.method === 'POST') {
      const entry = await readJSON(request);
      const existing = ((await this.state.storage.get('gate-log')) ?? []);
      await this.state.storage.put('gate-log', [...existing, entry].slice(-100));
      return json(200, { logged: true, count: existing.length + 1 });
    }
    if (url.pathname === '/gate-log' && request.method === 'GET') {
      return json(200, { entries: (await this.state.storage.get('gate-log')) ?? [] });
    }
    if (url.pathname === '/bootstrap' && request.method === 'POST') {
      return this.handleBootstrap(request, ledger);
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      return this.handleStart(request, ledger, request.headers.get('x-ingress-workspace'));
    }

    if (url.pathname === '/write' && request.method === 'POST') {
      const body = await readJSON(request);
      const receipt = ledger.admit({
        participantId: body.participantId,
        path: body.path,
        baseRevision: body.baseRevision ?? null,
        contentHash: body.contentHash ?? null,
      });
      await this.save();
      // A refusal is a successful HTTP exchange: the workspace answered
      // correctly. Only a malformed request is a 4xx.
      return json(200, receipt);
    }

    if (url.pathname === '/join' && request.method === 'GET') {
      const participantId = url.searchParams.get('name');
      const kind = url.searchParams.get('kind') === 'human' ? 'human' : 'agent';
      const dependencies = (url.searchParams.get('dependencies') ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      ledger.register({ participantId, kind, dependencies });
      await this.save();
      return json(200, ledger.joinEnvelope(participantId));
    }

    if (url.pathname === '/intent' && request.method === 'POST') {
      const body = await readJSON(request);
      const intent = ledger.setIntent(body.participantId, body.text);
      await this.save();
      return json(200, intent);
    }

    if (url.pathname === '/read' && request.method === 'POST') {
      const body = await readJSON(request);
      ledger.recordRead({ participantId: body.participantId, path: body.path });
      await this.save();
      const cut = ledger.decisionCut(body.participantId);
      return json(200, {
        path: body.path,
        revision: cut.reads.find(r => r.path === body.path)?.currentRevision ?? null,
      });
    }

    if (url.pathname === '/receipts' && request.method === 'GET') {
      const participantId = url.searchParams.get('participant');
      return json(200, {
        receipts: participantId ? ledger.receiptsFor(participantId) : ledger.receipts,
      });
    }

    if (url.pathname === '/content' && request.method === 'GET') {
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

    if (url.pathname === '/state' && request.method === 'GET') {
      return json(200, ledger.snapshot());
    }

    return json(404, { error: 'route_not_found' });
  }

  /**
   * Establish the starting tree. Only legal on an empty ledger.
   *
   * Someone has to be able to say what a workspace begins as. That is not a
   * self-report about *changes*, it is authorship of the initial state. The
   * restriction to an empty ledger is what stops it being a back door: call it
   * twice and the second call is refused, so it cannot be used to overwrite.
   */
  async handleBootstrap(request, ledger) {
    if (ledger.files.size > 0) {
      return json(409, {
        error: 'bootstrap_closed',
        reason: 'the ledger already holds files; bootstrap may only run on an empty workspace',
        files: ledger.files.size,
      });
    }
    const body = await readJSON(request, MAX_COMMIT_BODY);
    const verified = await verifyCommit({
      participantId: '__bootstrap__',
      files: body.files ?? [],
    });
    ledger.register({ participantId: '__bootstrap__', kind: 'human', displayName: body.author ?? 'bootstrap' });

    const written = [];
    for (const file of verified.files) {
      const record = ledger.recordWrite({
        path: file.path,
        revision: 1,
        actorId: body.author ?? 'bootstrap',
        contentHash: file.contentHash,
      });
      await this.state.storage.put(contentKey(file.path), {
        contentBase64: encodeBase64(file.bytes),
        contentHash: file.contentHash,
      });
      written.push(record);
    }
    await this.save();
    return json(200, { bootstrapped: written.length, files: written.map(f => f.path) });
  }

  /**
   * Start a container for a participant and issue it a token.
   *
   * The token is the identity binding. It is minted here, handed to exactly one
   * container, and checked on every commit — so a participant can act as itself
   * and cannot act as anyone else, even though it holds the token in its own
   * environment and is free to read it.
   */
  async handleStart(request, ledger, workspaceName) {
    const body = await readJSON(request);
    const { participantId, participantCommand } = body;
    const workDir = body.workDir ?? '/workspace';

    ledger.register({ participantId, kind: body.kind === 'human' ? 'human' : 'agent' });
    const token = crypto.randomUUID();
    await this.state.storage.put(tokenKey(participantId), token);
    await this.save();

    const container = this.container;
    if (!container) {
      return json(501, {
        error: 'no_container',
        detail: 'this deployment has no container binding; commits cannot be admitted',
      });
    }
    if (!workspaceName) {
      return json(400, { error: 'unknown_workspace', detail: 'x-ingress-workspace header required' });
    }

    // Interception first. There must be no moment in which the container is
    // running and unmediated.
    await container.interceptAllOutboundHttp(this.env.GATE);
    container.start({
      entrypoint: ['/bin/sh', '-c', launcherScript({ participantCommand, workDir })],
      enableInternet: false,
      env: {
        INGRESS_WORKSPACE: workspaceName,
        INGRESS_PARTICIPANT: participantId,
        INGRESS_TOKEN: token,
        INGRESS_PARTICIPANT_COMMAND: participantCommand ?? 'true',
        INGRESS_WORK_DIR: workDir,
        INGRESS_MANIFEST_VERSION: String(MANIFEST_VERSION),
      },
    });

    await container.monitor();

    // `monitor()` has resolved, which means the container exited, which means any
    // commit it made has already been through the gate and decided. Surfacing
    // that verdict here is the difference between a participant that can react
    // to a refusal and one that has to go and ask.
    const verdict = (await this.state.storage.get(`commit:${participantId}`)) ?? null;

    return json(200, {
      participantId,
      started: true,
      participantExit: containerExitFrom(await this.state.storage.get('manifests')),
      commit: verdict,
    });
  }

  /** The gate's only route. Everything that admits bytes arrives here. */
  async handleCommit(request, ledger) {
    const body = await readJSON(request, MAX_COMMIT_BODY);
    const { participantId, token } = body;

    const expected = await this.state.storage.get(tokenKey(participantId));
    if (!expected || expected !== token) {
      return json(403, {
        admitted: false,
        error: 'refused',
        reason: expected ? 'token_mismatch' : 'no_token_issued',
        participantId: participantId ?? null,
      });
    }

    const manifest = parseManifest(body);
    if (!manifest.ok) {
      const refusal = { admitted: false, reason: manifest.reason, detail: manifest.detail ?? null };
      await this.state.storage.put(commitKey(participantId), refusal);
      return json(422, { ...refusal, error: 'refused' });
    }

    const manifests = ((await this.state.storage.get('manifests')) ?? []);
    const exitCode = manifest.participantExit;
    await this.state.storage.put('manifests', [
      ...manifests,
      {
        participantId,
        exitCode,
        files: manifest.files.length,
        bytes: summariseManifest(manifest).totalBytes,
        reason: manifest.reason,
      },
    ].slice(-20));

    if (manifest.files.length === 0) {
      const outcome = {
        admitted: true,
        reason: 'commit_empty',
        participantExit: exitCode,
        landed: [],
        summary: summariseManifest(manifest),
      };
      await this.state.storage.put(commitKey(participantId), outcome);
      return json(200, { ...outcome, participantId });
    }

    const verified = await verifyCommit({ participantId, files: manifest.files });
    const decision = evaluateCommit(ledger, verified);

    if (!decision.admitted) {
      // Nothing is stored. A refused commit leaves no bytes behind and no partial
      // state to reason about later — but it does leave a *receipt*, because an
      // audit trail that only records successes cannot answer the only question
      // anyone asks of it: what was turned down, and why.
      const refusalReceipt = {
        sequence: ledger.receipts.length,
        admitted: false,
        reason: decision.refusals[0]?.reason ?? 'commit_refused',
        participantId,
        kind: ledger.require(participantId).kind,
        paths: decision.files.map(f => f.path),
        refusals: decision.refusals,
        participantExit: exitCode,
        fingerprint: decision.fingerprint,
      };
      ledger.receipts.push(refusalReceipt);
      await this.save();

      const refusal = {
        admitted: false,
        reason: decision.refusals[0]?.reason ?? 'commit_refused',
        participantExit: exitCode,
        refusals: decision.refusals,
        fingerprint: decision.fingerprint,
        unchanged: decision.unchanged,
      };
      await this.state.storage.put(commitKey(participantId), refusal);
      return json(409, { ...refusal, participantId });
    }

    const { summary, files } = applyCommit(ledger, decision);
    for (const file of files) {
      const source = verified.files.find(f => f.path === file.path);
      await this.state.storage.put(contentKey(file.path), {
        contentBase64: encodeBase64(source.bytes),
        contentHash: file.contentHash,
      });
    }
    await this.save();

    const outcome = {
      admitted: true,
      reason: 'commit_admitted',
      participantExit: exitCode,
      landed: files.map(f => ({ path: f.path, revision: f.nextRevision, contentHash: f.contentHash })),
      unchanged: decision.unchanged,
      fingerprint: decision.fingerprint,
      receipt: summary,
      summary: summariseManifest(manifest),
    };
    await this.state.storage.put(commitKey(participantId), outcome);
    return json(200, { ...outcome, participantId });
  }
}

function containerExitFrom(manifests) {
  return manifests?.length ? manifests[manifests.length - 1].exitCode : null;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function readJSON(request, maxBytes = MAX_BODY_BYTES) {
  // workerd makes the Request itself async-iterable; undici exposes the body as
  // a ReadableStream. Supporting both keeps the class runnable in the runtime it
  // ships in and testable off-runtime, which is where a fence bug would otherwise
  // hide.
  const source = typeof request[Symbol.asyncIterator] === 'function' ? request : request.body;
  let size = 0;
  const chunks = [];
  if (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('body_bounds');
      chunks.push(chunk);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('invalid_json');
  }
}