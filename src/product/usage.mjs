/**
 * Usage: what this workspace has consumed, and when it must stop.
 *
 * Why this exists
 *
 * `POST /start` boots a container and holds it for as long as the command runs. Nothing
 * counted those. The gate log records individual requests, bounded to 100 entries, and it
 * is written by a route no one reads since the read side was removed — so it is a forensic
 * record of the last hundred events and nothing else. There was no answer to "how many
 * workspaces exist", "how much has this one used", or "what will this cost".
 *
 * Two things are built here, in this order, because one is worthless without the other:
 *
 *   a counter     what was consumed
 *   a ceiling     when to refuse
 *
 * Billing is deliberately absent. It is worthless until the deployment is safe to sell, and
 * the numbers below are not derived from a price — they are a starting bound, set in one
 * place, with the reasoning recorded where someone changing them will read it.
 *
 * What the ceiling actually bounds
 *
 * Container starts and the run time requested for them, because those are the two things
 * that cost money. Commits and lease conflicts are counted but do not gate: a workspace
 * that is being refused a thousand times a second is a workspace whose *clients* are
 * confused, and cutting it off at that point would hide the confusion rather than fix it.
 *
 * Pure module. No I/O, no Cloudflare — the storage lives in the Durable Object, and every
 * decision here is a function of the record.
 */

/** Counters, and the defaults for the two that gate. */
export const USAGE_FIELDS = [
  'starts',
  'runSecondsRequested',
  'commitsAdmitted',
  'commitsRefused',
  'commitsEmpty',
  'leaseConflicts',
  'bytesAdmitted',
];

/**
 * How many container starts a workspace may have.
 *
 * A placeholder, and honestly labelled as one. The reasoning that *is* solid: each start
 * is a container, a container bills for as long as it runs, and the default lease plus the
 * 15-minute run ceiling mean a single start can cost a quarter of an hour of container
 * time. 500 starts is chosen to be generous enough that no legitimate exploration hits it
 * and small enough that a runaway loop is bounded.
 *
 * Change it here, not at a call site.
 */
export const DEFAULT_MAX_STARTS = 500;

/**
 * Cumulative requested run time, in seconds.
 *
 * 100,000 seconds is about 28 hours of container time. Chosen for the same reason and with
 * the same caveat: it bounds the *cumulative* cost of a workspace that never trips the
 * start count because its starts are few and long.
 */
export const DEFAULT_MAX_RUN_SECONDS = 100_000;

/**
 * Read the ceiling from the environment, falling back to the defaults.
 *
 * A bad number falls back rather than throwing. A deployment that set `MAX_STARTS=0` by
 * mistake should be bounded, not refusing every start with a configuration error — and a
 * ceiling that fails *open* is worse than one that is merely wrong, so the fallback is the
 * restrictive default rather than infinity.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN, both of which are handled here rather than
 * at each use.
 */
export function ceilingFromEnv(env = {}) {
  return {
    maxStarts: positiveInt(env.INGRESS_MAX_STARTS_PER_WORKSPACE, DEFAULT_MAX_STARTS),
    maxRunSeconds: positiveInt(env.INGRESS_MAX_RUN_SECONDS, DEFAULT_MAX_RUN_SECONDS),
  };
}

function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** A zeroed record, stamped with the first time the workspace was touched. */
export function emptyUsage(now = Date.now()) {
  return Object.fromEntries([
    ...USAGE_FIELDS.map(field => [field, 0]),
    ['firstSeenAt', new Date(now).toISOString()],
    ['lastSeenAt', new Date(now).toISOString()],
  ]);
}

/**
 * Fold a stored record into defaults.
 *
 * `fromJSON` and not a spread, so a record written by an older version — missing a counter
 * added since — reads as zero rather than as `undefined`, and `undefined` in a sum is NaN,
 * which compares false against every ceiling. A usage counter that silently stops counting
 * because a field was added later is worse than no counter.
 */
export function usageFrom(stored, now = Date.now()) {
  const base = emptyUsage(now);
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...Object.fromEntries(USAGE_FIELDS.map(field => [field, Number(stored[field]) || 0])),
    firstSeenAt: typeof stored.firstSeenAt === 'string' ? stored.firstSeenAt : base.firstSeenAt,
    lastSeenAt: typeof stored.lastSeenAt === 'string' ? stored.lastSeenAt : base.lastSeenAt,
  };
}

/**
 * Would this start be over the ceiling?
 *
 * Decided **before** the start, and counted **after** it succeeds — so a refused start does
 * not consume the quota it was refused for. That is the difference between a ceiling and a
 * counter: a counter that increments on refusal lets a caller lock themselves out by
 * retrying, and a caller who cannot start anything cannot spend anything either, but they
 * also cannot tell whether the ceiling was hit or whether they are being throttled.
 *
 * Returns `null` when there is room, and otherwise the reason with both numbers, so the
 * refusal says which bound was reached and by how much.
 */
export function startRefusal(usage, ceiling, { runMs = 0 } = {}) {
  const current = usageFrom(usage);
  const runSeconds = Math.ceil(runMs / 1000);

  if (current.starts >= ceiling.maxStarts) {
    return {
      reason: 'cost_ceiling',
      limit: 'starts',
      used: current.starts,
      allowed: ceiling.maxStarts,
      detail: `this workspace has started ${current.starts} container(s), at the ceiling of ${ceiling.maxStarts}`,
    };
  }
  if (current.runSecondsRequested + runSeconds > ceiling.maxRunSeconds) {
    return {
      reason: 'cost_ceiling',
      limit: 'runSeconds',
      used: current.runSecondsRequested,
      // What is left, not what was asked for. A caller asking for more than remains is told
      // how much room there is, which is the one number that lets them do something about
      // it rather than retry the same oversized request.
      allowed: Math.max(0, ceiling.maxRunSeconds - current.runSecondsRequested),
      requested: runSeconds,
      detail: `this workspace has requested ${current.runSecondsRequested}s of container time; `
        + `${Math.max(0, ceiling.maxRunSeconds - current.runSecondsRequested)}s remain of ${ceiling.maxRunSeconds}`,
    };
  }
  return null;
}

/**
 * Fold one start into the record.
 *
 * `runSeconds` is what was *requested*, not what was used, because the request is the thing
 * that decides the cost — `waitBounded` returns as soon as the command exits, and measuring
 * the difference would need a second clock in a place that has no reason to have one.
 */
export function recordStart(usage, { runMs = 0, now = Date.now() } = {}) {
  const next = usageFrom(usage, now);
  next.starts += 1;
  next.runSecondsRequested += Math.ceil(runMs / 1000);
  next.lastSeenAt = new Date(now).toISOString();
  return next;
}

/** Fold one commit verdict into the record. `admitted: null` means there was no verdict. */
export function recordCommit(usage, { admitted = null, bytes = 0, now = Date.now() } = {}) {
  const next = usageFrom(usage, now);
  if (admitted === true) {
    next.commitsAdmitted += 1;
    next.bytesAdmitted += Number(bytes) || 0;
  } else if (admitted === false) {
    next.commitsRefused += 1;
  } else if (admitted === null) {
    // A container that produced nothing to commit. Counted, because a workspace whose
    // participants all exit without writing is a usage signal in itself — and lumped
    // separately from a refusal so the two are not confused for each other.
    next.commitsEmpty += 1;
  }
  next.lastSeenAt = new Date(now).toISOString();
  return next;
}

/** Fold one refused lease grant into the record. */
export function recordLeaseConflict(usage, { now = Date.now() } = {}) {
  const next = usageFrom(usage, now);
  next.leaseConflicts += 1;
  next.lastSeenAt = new Date(now).toISOString();
  return next;
}

/**
 * The record as something to serve.
 *
 * `remaining` is included because a ceiling that can only be discovered by hitting it is a
 * ceiling a caller has to guess about. It is derived rather than stored, so it cannot drift
 * from the counters it is computed from.
 */
export function usageSnapshot(usage, ceiling, now = Date.now()) {
  const current = usageFrom(usage, now);
  return {
    ...current,
    ceiling: { maxStarts: ceiling.maxStarts, maxRunSeconds: ceiling.maxRunSeconds },
    remaining: {
      starts: Math.max(0, ceiling.maxStarts - current.starts),
      runSeconds: Math.max(0, ceiling.maxRunSeconds - current.runSecondsRequested),
    },
    exhausted: startRefusal(current, ceiling, { runMs: 0 }) !== null,
  };
}