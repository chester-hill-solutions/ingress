/**
 * Leases: checkout, heartbeat, release, retrieve, and the seed they authorise.
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

import { LeaseConflict, expandClosure, DEFAULT_LEASE_MS, MAX_LEASE_PATHS } from '../lease.mjs';
import { json, readJSON } from '../http.mjs';
import { readContentMap } from '../keys.mjs';

/**
 * Byte budget for a seed response.
 *
 * The per-path and per-file caps are each defensible alone and catastrophic
 * together: 256 leased paths x 512 KiB is ~171 MB of base64 in a single JSON
 * response, which the worker has to serialise and the container has to parse.
 *
 * The budget is spent over the *encoded* length, because that is what actually
 * crosses the wire and what actually occupies memory in the reader.
 */
export const MAX_SEED_BYTES = 4 * 1024 * 1024;

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

  // The closure is what gets granted, so the closure is what the cap applies to.
  // Checked here rather than inside `checkout` so the refusal can name the cause: a
  // participant at the path cap refused with "at most 256 paths" is pointed at the
  // wrong number when their own request was small and their declared dependencies
  // were what pushed it over.
  if (closure.length > MAX_LEASE_PATHS) {
    return json(409, {
      granted: false,
      reason: 'closure_too_large',
      requestedPaths: requested.length,
      declaredDependencies: declared.length,
      closurePaths: closure.length,
      cap: MAX_LEASE_PATHS,
      detail: requested.length + declared.length > MAX_LEASE_PATHS
        ? `asked for ${requested.length} path(s) and declared ${declared.length} dependency(ies); together they exceed the ${MAX_LEASE_PATHS}-path grant`
        : `the grant would cover ${closure.length} paths, over the ${MAX_LEASE_PATHS}-path cap`,
      hint: 'release a dependency, or check out fewer paths at a time',
    });
  }

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

/**
 * The tree a participant is entitled to start from.
 *
 * The union of every path it currently holds a live lease on, at the revision the
 * workspace admitted. Deliberately *not* the whole workspace:
 *
 *   - Least privilege. A participant gets what it checked out and nothing else,
 *     so the seed cannot become a read channel around the lease layer.
 *   - The seed and the lease agree. If a lease is what authorises a write, the
 *     files handed over must be exactly the ones it authorises, or the two
 *     disagree about what the participant is working on.
 *
 * A declared dependency the participant holds a read lease on is included, because
 * that is what makes its reads verifiable rather than asserted.
 */
export async function seed(ctx, participantId) {
  const ledger = await ctx.getLedger();
  const table = await ctx.leases();
  const now = Date.now();
  table.sweep(now);

  const paths = [...new Set(
    table.leasesFor(participantId, { now }).flatMap(lease => [...lease.paths])
  )].sort();

  if (paths.length === 0) {
    return { refused: false, participantId, files: [], revisions: {}, fingerprint: null, leasedPaths: [] };
  }

  const content = await readContentMap(ctx.state.storage, paths);

  const files = [];
  let bytes = 0;
  const oversized = [];

  for (const path of paths) {
    const record = ledger.files.get(path) ?? null;
    const entry = content.get(path);
    const encoded = entry?.contentBase64 ?? null;
    bytes += encoded ? encoded.length : 0;
    if (bytes > MAX_SEED_BYTES) oversized.push(path);
    files.push({
      path,
      // Absent is reported as absent. A participant must be able to tell "does not
      // exist" from "exists and is empty", or it will write over a file it never saw.
      exists: record != null,
      revision: record?.revision ?? null,
      author: record?.author ?? null,
      contentBase64: encoded,
      contentHash: record?.contentHash ?? null,
    });
  }

  // Refuse rather than truncate. A truncated seed is worse than none: the
  // participant would believe it holds files it only partly has, and commit against
  // a base it never really saw. Failing loudly leaves it working on what it does
  // hold, which is true.
  if (oversized.length > 0) {
    return {
      refused: true,
      reason: 'seed_too_large',
      participantId,
      budgetBytes: MAX_SEED_BYTES,
      requestedPaths: paths.length,
      exceedingPaths: oversized.slice(0, 32),
      detail: `the leased tree needs more than ${MAX_SEED_BYTES} bytes; release some paths and check them out again`,
    };
  }

  return {
    refused: false,
    participantId,
    files,
    bytes,
    // The revision the participant starts from, per path. The reporter attaches
    // these to the commit, which is what makes the base-revision check live: it
    // compares what the participant started from against what is there now.
    revisions: Object.fromEntries(files.map(file => [file.path, file.revision])),
    fingerprint: ledger.decisionCut(participantId).fingerprint,
    leasedPaths: paths,
  };
}