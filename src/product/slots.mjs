/**
 * Which executor slot, if any, may this start use.
 *
 * Why this exists at all
 *
 * `ctx.container` is one container per Durable Object. So while one object both *decided*
 * about a commit and *ran* the participant that produced it, a workspace could never host
 * two participants at once — and the product's own scenario, an agent building while a human
 * edits the dependency it reads, was unreachable on this runtime no matter what the
 * interface allowed.
 *
 * The tension is real rather than incidental. The fence needs one object, because the whole
 * safety argument is that the check and the decision happen in a single turn against current
 * state. The container needs exclusive use of an object. Buying both from one object means
 * buying serialisation and safety with the same coin — and serialisation is the thing that
 * stops a swarm from being a swarm.
 *
 * So the two roles are separated. The **workspace** object is the arbiter: it holds the
 * ledger, the leases, the tokens and the usage counters, and it makes every decision. An
 * **executor** object owns exactly one container and makes none — it is handed a token that
 * the arbiter minted and a lease the arbiter granted, and it cannot widen either.
 *
 * The gate resolves a workspace by name from a header, so a container started from any
 * executor still reports to the one arbiter that holds the ledger. That is what makes the
 * split safe rather than merely convenient: after the split there is still exactly one place
 * where a commit is decided.
 *
 * Pure module. The allocation is the security-relevant part — two starts in one slot means
 * two containers on one object, which is the platform error this whole design exists to
 * avoid — so it is decided here, tested without an account, and nowhere in a handler.
 */

/**
 * Executors one workspace may run at once.
 *
 * Four, not the two originally guessed and not the one the platform forced. Four is chosen
 * because it is enough that a swarm is a swarm and small enough that the concurrency is
 * visible in the cost ceiling — a workspace at four containers is four containers' worth of
 * time, and `usage.mjs`'s start ceiling bounds how many times that can happen.
 *
 * The value is overridable, because it is a cost decision rather than a safety one:
 * `INGRESS_MAX_CONCURRENT_STARTS`.
 */
export const DEFAULT_MAX_CONCURRENT_STARTS = 4;

/** Read the cap from the environment, falling back to the default. */
export function maxConcurrentStarts(env = {}) {
  const raw = env.INGRESS_MAX_CONCURRENT_STARTS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_CONCURRENT_STARTS;
  const parsed = Number(raw);
  // A ceiling that falls back must fall back to something that *bounds*. Infinity, or the
  // value silently passed through unchecked, would put the platform's one-container-per-object
  // error back in front of a caller with no explanation.
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT_STARTS;
  return Math.floor(parsed);
}

/**
 * The name of the executor object for a workspace and a slot.
 *
 * Derived here rather than assembled at call sites, because the mapping must be stable: an
 * executor's identity is what guarantees it holds at most one container, so a caller that
 * built this name differently would get a different object and quietly break that guarantee.
 */
export const executorName = (workspace, slot) => `${workspace}/executor-${slot}`;

/**
 * Choose a free slot, or refuse.
 *
 * Entries are `{slot, expiresAt}`. Anything else in the array is an **expired legacy
 * entry** — the format was a bare array of timestamps before slots existed — and it is
 * pruned rather than interpreted. Interpreting it would mean guessing a slot number, and two
 * callers guessing the same one is exactly the collision this must not have.
 *
 * Abandoned entries are pruned first: a Durable Object can be evicted while a start is
 * running, and the next instance must not inherit a full quota from a process that no longer
 * exists.
 *
 * @returns {{slot: number, expiresAt: number, active: object[]}}
 * @throws {SlotRefusal} when every slot is taken
 */
export function allocateSlot(entries = [], cap = DEFAULT_MAX_CONCURRENT_STARTS, now = Date.now()) {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_CONCURRENT_STARTS;

  const live = (Array.isArray(entries) ? entries : [])
    // The shape check *is* the legacy handling. An entry without a numeric `slot` is from
    // before slots existed; it is dropped, because the alternative is inventing a slot number
    // and hoping two callers did not invent the same one.
    .filter(entry => entry && Number.isInteger(entry.slot) && Number.isFinite(entry.expiresAt))
    .filter(entry => entry.expiresAt > now);

  if (live.length >= limit) {
    throw new SlotRefusal({
      running: live.length,
      cap: limit,
      detail: `${live.length} participant(s) are already running in this workspace`,
    });
  }

  const taken = new Set(live.map(entry => entry.slot));
  // Lowest free index rather than `live.length`. Using the length would hand out a slot that
  // was still in use whenever the lowest had been freed and a higher one was not — and the
  // symptom would be a platform "already running" error attributed to no cause at all.
  for (let slot = 0; slot < limit; slot++) {
    if (!taken.has(slot)) return { slot, expiresAt: now + SLOT_TTL_MS, active: live };
  }

  // Unreachable while `live.length < limit`, but a function that returns on a loop must not
  // be able to fall off the end of it.
  throw new SlotRefusal({ running: live.length, cap: limit, detail: 'no free slot' });
}

/**
 * How long a slot may be held before it is assumed abandoned.
 *
 * Slightly longer than the maximum run, so a container that runs to its ceiling still owns
 * its slot while it is alive. If it were shorter, a long-but-legitimate run would free its
 * slot while its container was still running, and the next start would collide with it.
 */
export const SLOT_TTL_MS = 16 * 60_000;

export class SlotRefusal extends Error {
  constructor(detail) {
    super(`slot_refused: ${detail.detail ?? 'no slot free'}`);
    this.name = 'SlotRefusal';
    this.reason = 'too_many_concurrent_starts';
    Object.assign(this, detail);
  }
}