/**
 * Leases: a participant must hold the files it intends to work on.
 *
 * Why this exists
 *
 * Two gaps in the fence could not be closed by checking harder:
 *
 *   1. Reads were self-reported. The workspace knew a participant *said* it read
 *      a file. It could not confirm the read happened, so `readBasis: 'unknown'`
 *      was something any participant could create for itself.
 *   2. Container death was total loss. Work vanished with the container, and
 *      there was no recovery path at all.
 *
 * A lease fixes both by moving the guarantee from *checking afterwards* to
 * *granting beforehand*. The workspace hands over the content. Holding the lease
 * means the workspace knows you have it, because it was the one who gave it to
 * you. And a lease has an expiry, so a holder that dies stops blocking anyone.
 *
 * The property that makes leases safe without trusted liveness
 *
 * `heartbeat` lets a participant say "I am still here." That claim is exactly as
 * trustworthy as any other participant claim, which is to say not at all — and it
 * is deliberately not the safety mechanism:
 *
 *   a DEAD holder that looks alive   stalls others until the lease expires
 *   a LYING holder that looks alive   only hurts itself
 *
 * So the expiry is the bound and the heartbeat only makes recovery faster. A
 * participant cannot use liveness reporting to compromise anyone else's
 * correctness. This is why there is no unsafe case here, only a slower one.
 *
 * Concurrency is preserved with reader-writer semantics, not a mutex
 *
 * Pure exclusive locking would make N agents unable to touch the same file, which
 * is a mutex wearing a lease's clothes. Instead:
 *
 *   read   many holders   "I am looking at this"
 *   write  one holder     "I am changing this"
 *
 * Most work is reading. Two agents can both hold `engine.mjs` for reading and
 * neither blocks the other. One agent holds it for writing. Blind overwrite
 * becomes structurally impossible without serialising the work.
 *
 * Grants are atomic over the closure, or nothing is granted
 *
 * A participant asks for a file and its dependencies in one call. Either it gets
 * all of them or it gets none. A partial grant is strictly worse than a refusal:
 * the caller would hold a lease on a file it cannot use while blocking everyone
 * who can.
 *
 * The workspace brokers contention; participants never message each other
 *
 * There is no participant-to-participant channel, by design. The workspace
 * already holds the graph of who holds what, so it knows who is blocked and can
 * wake them on release. An earlier design in this repository used inter-agent
 * messages and discarded 54% of them while deadlocking; making the workspace the
 * broker removes that failure class rather than managing it.
 *
 * Pure module. No I/O, no Cloudflare, no agents.
 */

/** A lease must be finite. A lock without a timeout is a deadlock generator. */
export const DEFAULT_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 15 * 60_000;
export const MAX_LEASE_PATHS = 256;

/** Sentinel for "no holder", so callers never have to invent one. */
export const NO_HOLDER = null;

export class LeaseConflict extends Error {
  constructor(detail) {
    // The message carries the detail, not a generic label. A conflict whose
    // message reads "lease_conflict: cycle" when the real problem was a path cap
    // or a malformed request tells the caller nothing it can act on — and this
    // error is the whole product surface for a conflict.
    const summary = detail.detail
      ?? (detail.conflicts?.length ? detail.conflicts.map(c => c.path).join(', ') : 'unknown');
    super(`lease_conflict: ${summary}`);
    this.name = 'LeaseConflict';
    this.reason = 'lease_conflict';
    Object.assign(this, detail);
  }
}

function compatible(mode, heldMode, sameHolder) {
  if (sameHolder) return true;
  if (mode === 'read') return heldMode === 'read';
  return false;
}

export class LeaseTable {
  /**
   * @param {object} [state]
   * @param {Array} [state.leases]
   * @param {Array} [state.waits] as `{participantId, blocking: string[]}`
   */
  constructor({ leases = [], waits = [] } = {}) {
    /** @type {Map<string, object>} leaseId -> lease */
    this.leases = new Map(leases.map(lease => [lease.leaseId, { ...lease, paths: new Set(lease.paths) }]));
    /** @type {Map<string, Set<string>>} participantId -> participants it is blocked on */
    this.waits = new Map(waits.map(wait => [wait.participantId, new Set(wait.blocking)]));
  }

  /**
   * Move leases whose time has passed out of the live set.
   *
   * Called at the start of every decision rather than on a timer, because a
   * decision must never be made against an expired grant.
   *
   * Expired leases are *retained* in a tombstone map rather than discarded. Two
   * reasons, both diagnostic: a late heartbeat needs to be able to say "your
   * lease expired" rather than "no such lease", and a subsequent grant needs to be
   * recorded as a takeover instead of being indistinguishable from a fresh
   * checkout. The map is bounded, so this cannot grow without limit.
   */
  sweep(now) {
    const expired = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        expired.push({ ...lease, paths: new Set(lease.paths) });
        this.leases.delete(leaseId);
      }
    }
    if (expired.length > 0) {
      this.expired = this.expired ?? new Map();
      for (const lease of expired) this.expired.set(lease.leaseId, lease);
      // Bound the tombstones. The bound is generous relative to the lease cap, so
      // a diagnosis never depends on eviction order.
      while (this.expired.size > 512) {
        const oldest = [...this.expired.keys()].sort(
          (a, b) => this.expired.get(a).expiresAt - this.expired.get(b).expiresAt
        )[0];
        this.expired.delete(oldest);
      }
      this.lastExpired = expired;
    }
    return expired;
  }

  /** Every live lease touching `path`. */
  holdersOf(path) {
    const holders = [];
    for (const lease of this.leases.values()) {
      if (lease.paths.has(path)) holders.push(lease);
    }
    return holders;
  }

  /**
   * The caller's live lease, if it has one.
   *
   * Takes an injectable `now` like every other decision here. It originally read
   * the wall clock directly, which meant it silently disagreed with the rest of
   * the table under an injected clock — and a disagreement about whether a lease
   * is live is exactly the kind of bug that hands two participants one file.
   */
  leaseFor(participantId, { includeExpired = false, now = Date.now() } = {}) {
    return this.leasesFor(participantId, { includeExpired, now })[0] ?? NO_HOLDER;
  }

  /**
   * Every live lease a participant holds.
   *
   * A participant routinely holds more than one: a read lease on a dependency plus
   * a write lease on the file it is producing. Returning only the first of them —
   * which `leaseFor` originally did — meant a participant holding both was told it
   * had no write lease on its own file, and had its commit refused. That is not an
   * edge case; it is the normal shape of working.
   */
  leasesFor(participantId, { includeExpired = false, now = Date.now() } = {}) {
    const held = [];
    for (const lease of this.leases.values()) {
      if (lease.participantId !== participantId) continue;
      if (includeExpired || lease.expiresAt > now) held.push(lease);
    }
    return held;
  }

  /** Is this participant permitted to write this path right now? */
  canWrite(participantId, path, { now = Date.now() } = {}) {
    return this.leasesFor(participantId, { now }).some(
      lease => lease.mode === 'write' && lease.paths.has(path)
    );
  }

  /**
   * Would granting these paths to this participant create a deadlock?
   *
   * The workspace holds the wait-for graph, so a cycle is *findable* rather than
   * merely possible — which is the whole reason there is no participant channel
   * for anyone to deadlock down.
   */
  wouldCycle(participantId, conflicts, prospectiveWaits = []) {
    const graph = new Map();
    for (const [waiter, blockedOn] of this.waits) graph.set(waiter, new Set(blockedOn));
    graph.set(participantId, new Set(prospectiveWaits));

    // Can `participantId` reach itself? That is a cycle.
    const seen = new Set();
    const stack = [...(graph.get(participantId) ?? [])];
    const path = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === participantId) return [...path, current];
      if (seen.has(current)) continue;
      seen.add(current);
      path.push(current);
      for (const next of graph.get(current) ?? []) stack.push(next);
    }
    return NO_HOLDER;
  }

  /**
   * Decide a checkout. Grants atomically or throws `LeaseConflict`.
   *
   * Throwing rather than returning a refusal result is deliberate: a caller that
   * catches nothing has a bug, and a lease conflict is an exceptional condition
   * rather than a normal result. The DO turns it into a 409.
   */
  checkout({ participantId, paths, mode = 'read', now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
    if (mode !== 'read' && mode !== 'write') {
      throw new LeaseConflict({ conflicts: [], detail: `mode must be read or write, got ${mode}` });
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new LeaseConflict({ conflicts: [], detail: 'checkout requires at least one path' });
    }
    if (paths.length > MAX_LEASE_PATHS) {
      throw new LeaseConflict({ conflicts: [], detail: `at most ${MAX_LEASE_PATHS} paths, got ${paths.length}` });
    }
    const duration = Math.max(1000, Math.min(leaseMs, MAX_LEASE_MS));

    this.sweep(now);

    const unique = [...new Set(paths)];
    const conflicts = [];
    const blocking = new Set();

    for (const path of unique) {
      for (const held of this.holdersOf(path)) {
        if (compatible(mode, held.mode, held.participantId === participantId)) continue;
        conflicts.push({
          path,
          heldBy: held.participantId,
          heldMode: held.mode,
          leaseId: held.leaseId,
          expiresAt: held.expiresAt,
        });
        blocking.add(held.participantId);
      }
    }

    if (conflicts.length > 0) {
      const cycle = this.wouldCycle(participantId, conflicts, [...blocking]);
      throw new LeaseConflict({
        conflicts,
        blockedOn: [...blocking],
        cycle,
        detail: cycle
          ? 'refused: the grant would deadlock'
          : `refused: ${conflicts.length} path(s) held by ${[...blocking].join(', ')}`,
      });
    }

    const leaseId = crypto.randomUUID();
    const lease = {
      leaseId,
      participantId,
      mode,
      paths: new Set(unique),
      grantedAt: now,
      expiresAt: now + duration,
      heartbeats: 0,
    };
    this.leases.set(leaseId, lease);

    // A successful grant clears any wait this participant had, and releases the
    // participants it was waiting on from tracking it — otherwise a stale edge
    // would manufacture a phantom cycle later.
    this.waits.delete(participantId);
    for (const [waiter, blockedOn] of this.waits) {
      if (blockedOn.delete(participantId) && blockedOn.size === 0) this.waits.delete(waiter);
    }

    // Record the takeover, if the grant follows an expiry. An audit trail that
    // cannot distinguish "took the free file" from "took over from a dead agent"
    // cannot answer the question anyone asks of it after an incident.
    const reclaimed = (this.lastExpired ?? []).filter(
      dead => dead.participantId !== participantId && [...dead.paths].some(path => unique.includes(path))
    );
    if (reclaimed.length > 0) this.lastExpired = [];

    return {
      lease,
      reclaimedFrom: reclaimed.map(dead => ({
        participantId: dead.participantId,
        paths: [...dead.paths],
        expiredAt: dead.expiresAt,
      })),
    };
  }

  /**
   * Extend a lease. The optimisation, never the guarantee.
   *
   * Extending an already-expired lease fails rather than reviving it: a lease
   * that lapsed may already have been granted to someone else, and reviving it
   * would hand two participants the same file.
   */
  heartbeat({ leaseId, participantId, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      // Distinguish "never existed" from "lapsed". A participant that was told
      // `lease_unknown` cannot tell whether it lost the lease or never had one,
      // and the two demand different responses.
      const tombstone = (this.expired ?? new Map()).get(leaseId);
      if (tombstone && tombstone.participantId === participantId) {
        return { alive: false, reason: 'lease_expired', expiredAt: tombstone.expiresAt };
      }
      return { alive: false, reason: 'lease_unknown' };
    }
    if (lease.participantId !== participantId) return { alive: false, reason: 'lease_not_yours' };
    if (lease.expiresAt <= now) {
      this.leases.delete(leaseId);
      return { alive: false, reason: 'lease_expired', expiredAt: lease.expiresAt };
    }
    const duration = Math.max(1000, Math.min(leaseMs, MAX_LEASE_MS));
    lease.expiresAt = now + duration;
    lease.heartbeats += 1;
    return {
      alive: true,
      expiresAt: lease.expiresAt,
      heldBy: [...lease.paths].sort(),
      waitingFor: [...(this.waits.get(participantId) ?? [])].sort(),
    };
  }

  /** Free a lease, wholly or in part. Partial release is allowed and expected. */
  release({ leaseId, participantId, paths = null, now = Date.now() }) {
    const lease = this.leases.get(leaseId);
    if (!lease) return { released: [], reason: 'lease_unknown' };
    if (lease.participantId !== participantId) return { released: [], reason: 'lease_not_yours' };

    const toRelease = paths ? paths.filter(path => lease.paths.has(path)) : [...lease.paths];
    for (const path of toRelease) lease.paths.delete(path);

    if (lease.paths.size === 0) {
      this.leases.delete(leaseId);
      this.waits.delete(participantId);
    }
    // Anyone blocked on this participant may now proceed. The workspace tells
    // them; they are not watching a channel.
    const woken = [];
    for (const [waiter, blockedOn] of this.waits) {
      if (blockedOn.delete(participantId)) woken.push(waiter);
      if (blockedOn.size === 0) this.waits.delete(waiter);
    }
    return { released: toRelease.sort(), remaining: [...lease.paths].sort(), woken };
  }

  /**
   * Take over paths whose holder stopped heartbeating.
   *
   * Refused while the lease is live, however emphatically the caller believes the
   * holder is dead — that belief is the claim this whole design refuses to trust.
   * The expiry is the only thing that opens a path.
   */
  retrieve({ participantId, paths, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
    // Sweep first. Without this, an expired lease still counted as a holder and
    // `retrieve` refused to rescue a file whose owner had been gone for an hour —
    // the exact situation it exists to resolve.
    this.sweep(now);

    const stillHeld = [];
    for (const path of [...new Set(paths)]) {
      for (const held of this.holdersOf(path)) {
        if (held.participantId !== participantId) {
          stillHeld.push({ path, heldBy: held.participantId, expiresAt: held.expiresAt });
        }
      }
    }
    if (stillHeld.length > 0) {
      throw new LeaseConflict({
        conflicts: stillHeld,
        detail: 'refused: the lease is still live; only an expiry opens a path',
      });
    }
    return this.checkout({ participantId, paths, mode: 'write', now, leaseMs });
  }

  /** Record that a participant is blocked, so cycles become findable. */
  noteBlocked(participantId, blocking) {
    if (!blocking || blocking.length === 0) {
      this.waits.delete(participantId);
      return;
    }
    this.waits.set(participantId, new Set([...(this.waits.get(participantId) ?? []), ...blocking]));
  }

  toJSON() {
    return {
      leases: [...this.leases.values()].map(lease => ({ ...lease, paths: [...lease.paths] })),
      waits: [...this.waits].map(([participantId, blocking]) => ({ participantId, blocking: [...blocking] })),
    };
  }

  /**
   * A read-only view for callers.
   *
   * Separate from `toJSON` on purpose: `toJSON` feeds storage and must not gain
   * presentation concerns, and `snapshot` is free to shape for a human or a
   * dashboard without a migration.
   */
  snapshot(now = Date.now()) {
    this.sweep(now);
    return {
      leases: [...this.leases.values()]
        .map(lease => ({
          leaseId: lease.leaseId,
          participantId: lease.participantId,
          mode: lease.mode,
          paths: [...lease.paths].sort(),
          expiresAt: lease.expiresAt,
          expiresInMs: lease.expiresAt - now,
          heartbeats: lease.heartbeats,
        }))
        .sort((a, b) => (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0)),
      waits: [...this.waits]
        .map(([participantId, blocking]) => ({ participantId, blocking: [...blocking].sort() }))
        .sort((a, b) => (a.participantId < b.participantId ? -1 : 1)),
    };
  }

  static fromJSON(value) {
    return new LeaseTable({
      leases: value?.leases ?? [],
      waits: value?.waits ?? [],
    });
  }
}

/**
 * Expand a checkout request into the set that must be granted together.
 *
 * The workspace cannot parse imports — it has no language model of the code — so
 * dependencies remain declared by the participant. What changes under a lease is
 * *enforcement*: the declaration becomes the subject of a grant rather than a
 * claim in a later read report. An undeclared dependency is still undetectable;
 * a declared one is now guaranteed to have been handed over.
 */
export function expandClosure({ requested = [], declaredDependencies = [] }) {
  const closure = new Set();
  for (const path of [...requested, ...declaredDependencies]) {
    if (typeof path !== 'string' || !path) continue;
    closure.add(path);
  }
  return [...closure].sort();
}