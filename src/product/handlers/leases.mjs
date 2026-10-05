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

import {
  LeaseConflict,
  expandClosure,
  DEFAULT_LEASE_MS,
  RENEW_INTERVAL_MS,
  MAX_LEASE_PATHS,
} from '../lease.mjs';
import { json, readJSON } from '../http.mjs';
import { readContentMap } from '../keys.mjs';
import { authenticateContainer, containerRefusal } from '../container-auth.mjs';

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

  // The read is recorded here, by the party that handed the content over.
  //
  // This replaces a public `/read` route that recorded a read the caller *asserted*,
  // which made `readBasis: 'verified'` in the fence's decision cut a self-report — the
  // weakest remaining link in the product's central claim. A grant is better evidence
  // than a claim: the workspace decided to hand these bytes to this participant, at these
  // revisions, and the read is a side effect of that fact rather than a statement about
  // it.
  //
  // Recorded for both modes, because a write lease is also a handover: whoever holds
  // the file has been given its current content. Recording only for `read` would mean a
  // participant holding the file for writing had no basis for it, which is the opposite
  // of the truth.
  //
  // A path that does not exist yields no revision, so `readRecord` stores null and the
  // cut reports `readBasis: 'unknown'` — you cannot have read a file nobody has written.
  // That is the correct direction to fail, and it is unchanged by this.
  for (const path of closure) {
    ledger.recordRead({ participantId, path });
  }
  await ctx.saveLedger();

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

/**
 * Grant a write lease from inside the workspace, without an HTTP round trip.
 *
 * Used by `/start`, which issues the lease the container will hold for the length of its
 * run. The alternative was leaving it to the caller, which is what the product did before:
 * a harness had to check out at 300,000 ms to survive a one-minute default, so any task
 * over 60 s had its commit refused and the cause was nowhere in the request. See
 * `docs/product-hardening-plan.md` item 7.
 *
 * Two things it deliberately does not do:
 *
 *   - No closure expansion. A write grant covers exactly what was asked for. Declared
 *     dependencies join a *read* grant and never a write one, for the reason spelled out
 *     in `checkout` above.
 *   - No content read. The caller did not ask to read anything; `/start` hands the
 *     participant no bytes, and its container picks up its tree from `/seed`, which reads
 *     the same lease table and serves whatever it finds there.
 *
 * It does record the reads, because a write lease is a handover and the argument for that
 * is the one in `checkout`: the workspace decided to give these paths to this participant,
 * so the read follows from a fact rather than a claim. `/start` is the party making the
 * decision, so `/start` is where it is recorded.
 *
 * It registers the participant, which is a change of responsibility and the reason this is
 * not a three-line helper. `recordRead` calls `ledger.require`, which throws for someone
 * who has not joined — so `/start` used to register *before* granting, and a
 * `lease_conflict` therefore left a participant behind in the ledger with no token, no
 * container and no lease. The fix was to move the registration in here rather than to
 * reorder two statements and hope: the handover is the decision, and the decision is
 * about who is working as well as what they are working on.
 *
 * Throws `LeaseConflict`, which the caller turns into a 409 having created nothing.
 */
export async function grantWrite(ctx, {
  participantId,
  paths,
  leaseMs = DEFAULT_LEASE_MS,
  kind = 'agent',
}) {
  const table = await ctx.leases();
  const now = Date.now();

  const granted = table.checkout({ participantId, paths, mode: 'write', now, leaseMs });

  const ledger = await ctx.getLedger();
  ledger.register({ participantId, kind });
  for (const path of granted.lease.paths) {
    ledger.recordRead({ participantId, path });
  }

  // Ledger and leases saved together rather than as two writes. They authorise the same
  // fact, and a grant that was stored without the read it implies would leave the fence
  // judging this participant against a basis it never recorded.
  await ctx.saveLeases();
  await ctx.saveLedger();

  return {
    leaseId: granted.lease.leaseId,
    participantId,
    mode: 'write',
    paths: [...granted.lease.paths].sort(),
    // The duration, not the expiry. The caller hands this to the launcher so its
    // heartbeats re-apply the same length; derived from `expiresAt` instead, it would
    // come back a few milliseconds short and shorten the lease on its first renewal.
    leaseMs: granted.lease.expiresAt - granted.lease.grantedAt,
    expiresAt: granted.lease.expiresAt,
    renewIntervalMs: RENEW_INTERVAL_MS,
    reclaimedFrom: granted.reclaimedFrom,
  };
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

// --- the gate's lease surface ---------------------------------------------------
//
// These two exist only because `/start` now hands the write lease to the container
// rather than to the calling harness, and the container's only exit is the gate.
//
// That is a real widening of the gate, from one mutating route to three, so it is worth
// being exact about what was added and what was not:
//
//   - Both are token-checked by the same `authenticateContainer` the commit path uses, so
//     neither accepts an identity it did not mint. `leaseId` is additionally checked
//     against `participantId` inside the table, so a container cannot renew or release a
//     lease belonging to someone else.
//   - Neither can admit a byte. The commit path is still the only route that does, and
//     these two change nothing about what it accepts.
//   - The public `/lease/*` routes above are unchanged. A caller outside a container
//     still checks out its own leases the way it did before.
//
// What this buys: the container becomes the lease holder, which is what a lease is for —
// the workspace can now tell a participant that stopped working from one that is merely
// slow, and can free a file the moment a participant finishes rather than at the expiry.

/**
 * Renew the lease this container holds, from inside the container.
 *
 * The renewal interval is fixed by the workspace when it issues the lease and travels to
 * the launcher in the environment. It is deliberately not a body parameter the caller
 * chooses: a caller that sent a shorter interval than its lease would shorten its own
 * expiry on the first heartbeat and lose the lease mid-run, which is a trap rather than a
 * feature. `leaseMs` is honoured only when the caller sends one, and the launcher always
 * sends back exactly what it was granted.
 */
export async function containerHeartbeat(ctx, request) {
  const body = await readJSON(request);
  const { participantId, token } = body;

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) return json(403, containerRefusal(identity));

  const table = await ctx.leases();
  const result = table.heartbeat({
    leaseId: body.leaseId,
    participantId,
    now: Date.now(),
    leaseMs: body.leaseMs ?? DEFAULT_LEASE_MS,
  });
  await ctx.saveLeases();
  return json(result.alive ? 200 : 409, result);
}

/**
 * Release the lease this container holds, from inside the container.
 *
 * Idempotent in the only sense that matters: a lease that is already gone answers
 * `lease_unknown` with a 200, because the launcher calls this on its way out whether or
 * not the participant ran at all, and a release that fails because there was nothing to
 * release is not a failure worth stopping for.
 */
export async function containerRelease(ctx, request) {
  const body = await readJSON(request);
  const { participantId, token } = body;

  const identity = await authenticateContainer(ctx, participantId, token);
  if (!identity.ok) return json(403, containerRefusal(identity));

  const table = await ctx.leases();
  const result = table.release({
    leaseId: body.leaseId,
    participantId,
    paths: body.paths ?? null,
    now: Date.now(),
  });
  await ctx.saveLeases();
  return json(200, result);
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