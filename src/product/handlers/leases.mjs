/**
 * Leases: checkout, heartbeat, release, retrieve.
 *
 * Split out of the Durable Object because leases are a self-contained concern.
 * They share storage and the ledger with the commit path, and nothing else — the
 * only reason they live in the same object is that a grant and the commit it
 * authorises must not be separated by anything. That constraint is stated once,
 * here, instead of being implied by file layout.
 *
 * Handlers receive `ctx`, an explicit context rather than the Durable Object
 * itself, so they depend on the four things they use rather than on whatever
 * `this` happens to carry.
 */

import { LeaseConflict, expandClosure, DEFAULT_LEASE_MS } from '../lease.mjs';
import { json, readJSON } from '../http.mjs';
import { readContentMap } from '../keys.mjs';

/**
 * Grant a lease, and hand over the content.
 *
 * Returning the content is the entire point. It is what makes a read verifiable:
 * the workspace is the one giving the file over, so "this participant has read
 * `engine.mjs`" stops being a claim it made about itself.
 */
export async function checkout(ctx, request) {
  const body = await readJSON(request);
  const { participantId, mode = 'read' } = body;
  const ledger = await ctx.getLedger();
  const participant = ledger.require(participantId);

  const requested = Array.isArray(body.paths) ? body.paths : [];
  const table = await ctx.leases();
  const now = Date.now();

  // Dependencies join a *read* grant, never a write grant.
  //
  // Reading a dependency and writing your own file are different claims. Folding
  // declared dependencies into a write request means you cannot touch your own new
  // file while anyone holds a dependency exclusively — which is the common case,
  // and it serialises the workspace into a queue. The dependency check that
  // matters at write time is the fence's own `dependency_moved`, which compares
  // the revision you read against the revision now there.
  const declared = mode === 'read' ? [...(participant.dependencies ?? [])] : [];
  const closure = expandClosure({ requested, declaredDependencies: declared });

  let granted;
  try {
    granted = table.checkout({
      participantId,
      paths: closure,
      mode,
      now,
      leaseMs: body.leaseMs ?? DEFAULT_LEASE_MS,
    });
  } catch (error) {
    if (!(error instanceof LeaseConflict)) throw error;
    // The wait edge is recorded even on refusal. That is what makes a cycle
    // findable on the *next* attempt instead of only after the second party has
    // already committed to waiting.
    table.noteBlocked(participantId, error.blockedOn);
    await ctx.saveLeases();
    return json(409, {
      granted: false,
      reason: 'lease_conflict',
      conflicts: error.conflicts,
      blockedOn: error.blockedOn,
      cycle: error.cycle ?? null,
      detail: error.detail,
    });
  }

  await ctx.saveLeases();

  // One batched read, not one per file. A 40-path dependency closure was 40
  // sequential storage round-trips inside a single request.
  const content = await readContentMap(ctx.state.storage, closure);

  const files = closure.map(path => {
    const record = ledger.files.get(path) ?? null;
    const entry = content.get(path);
    return {
      path,
      // A path nobody has written has no content and no revision. It is reported
      // as absent rather than as an empty file, so a caller can tell "does not
      // exist" from "exists and is empty".
      exists: record != null,
      revision: record?.revision ?? null,
      author: record?.author ?? null,
      contentBase64: entry?.contentBase64 ?? null,
      contentHash: record?.contentHash ?? null,
    };
  });

  return json(200, {
    granted: true,
    leaseId: granted.lease.leaseId,
    participantId,
    mode,
    expiresAt: granted.lease.expiresAt,
    requested,
    includedDependencies: closure.filter(path => !requested.includes(path)),
    reclaimedFrom: granted.reclaimedFrom,
    files,
    fingerprint: ledger.decisionCut(participantId).fingerprint,
  });
}

export async function heartbeat(ctx, request) {
  const body = await readJSON(request);
  const table = await ctx.leases();
  const result = table.heartbeat({
    leaseId: body.leaseId,
    participantId: body.participantId,
    now: Date.now(),
    leaseMs: body.leaseMs ?? DEFAULT_LEASE_MS,
  });
  await ctx.saveLeases();
  return json(result.alive ? 200 : 409, result);
}

export async function release(ctx, request) {
  const body = await readJSON(request);
  const table = await ctx.leases();
  const result = table.release({
    leaseId: body.leaseId,
    participantId: body.participantId,
    paths: body.paths ?? null,
    now: Date.now(),
  });
  await ctx.saveLeases();
  return json(200, result);
}

/**
 * Take over paths whose holder stopped heartbeating.
 *
 * The same guard as checkout, expressed separately because the audit question
 * afterwards is different: "why did you take this?" rather than "why was this
 * refused?".
 */
export async function retrieve(ctx, request) {
  const body = await readJSON(request);
  const { participantId } = body;
  const ledger = await ctx.getLedger();
  ledger.require(participantId);

  const table = await ctx.leases();
  let granted;
  try {
    granted = table.retrieve({
      participantId,
      paths: Array.isArray(body.paths) ? body.paths : [],
      now: Date.now(),
      leaseMs: body.leaseMs ?? DEFAULT_LEASE_MS,
    });
  } catch (error) {
    if (!(error instanceof LeaseConflict)) throw error;
    return json(409, {
      retrieved: false,
      reason: 'lease_conflict',
      conflicts: error.conflicts,
      detail: error.detail,
    });
  }
  await ctx.saveLeases();

  // The taker gets the last admitted content, so the work is recoverable rather
  // than merely unlocked.
  const paths = [...granted.lease.paths];
  const content = await readContentMap(ctx.state.storage, paths);
  const files = paths.map(path => ({ path, contentBase64: content.get(path)?.contentBase64 ?? null }));

  return json(200, {
    retrieved: true,
    leaseId: granted.lease.leaseId,
    participantId,
    expiresAt: granted.lease.expiresAt,
    reclaimedFrom: granted.reclaimedFrom,
    files,
  });
}

export async function list(ctx) {
  // The snapshot is already `{leases, waits}`; wrapping it again produced
  // `{leases: {leases: [...]}}`, which is the kind of shape nobody reading the
  // response would guess.
  return json(200, (await ctx.leases()).snapshot());
}