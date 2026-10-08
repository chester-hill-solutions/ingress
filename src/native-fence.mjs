/**
 * A write fence for the native harness: one writer per path at a time.
 *
 * Why this exists
 *
 * The first Ontario Drive trial produced a real merge collision. Two agents appended a
 * `displayName` helper to the same `view.mjs`, the file would not parse, and the application
 * could not load. The harness let it happen because nothing arbitrated native writes:
 * `src/squad.mjs` says it plainly -- "observer awareness does not fence native writes" -- and
 * the benchmark plugin only recorded tool paths.
 *
 * The deployed product fences commits: a participant holds a lease, and the gate refuses a
 * commit for a file it does not hold. This is the same idea at the native layer, wired into
 * the permission evaluation the runtime runs before a write. It is deliberately the smallest
 * thing that can be correct: a lease is a path and a holder, refreshed on use, and another
 * agent is refused while it is live.
 *
 * What it is not
 *
 * It is not a merge. A refused write is blocked, not reconciled -- the earlier contention
 * trial measured that cost, with five of six disjoint same-file edits refused. This prevents
 * the collision; recovering the blocked work is the merge's job, and that is a separate
 * decision.
 *
 * Pure and clock-injected, so the policy is tested without OpenCode and without waiting.
 */

/** The tool actions that change bytes on disk. A read is never fenced. */
export const WRITE_ACTIONS = Object.freeze(['write', 'edit', 'patch', 'apply_patch']);

/**
 * The default lease lifetime.
 *
 * Long enough that an agent mid-file is not interrupted, short enough that a crashed or
 * silent holder does not block a path for the rest of the run. Refreshed on every write by
 * the holder, so an active writer keeps its lease and an idle one lets go.
 */
export const DEFAULT_LEASE_TTL_MS = 90_000;

/**
 * @param {{ ttlMs?: number }} [options]
 * @returns {{
 *   evaluate: (call: {sessionID: string, action: string, resources: string[]}, now?: number)
 *     => { decision: 'allow' | 'deny', path?: string, heldBy?: string },
 *   release: (sessionID: string) => void,
 *   snapshot: () => Record<string, string>,
 * }}
 */
export function createWriteFence({ ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('write_fence_requires_positive_ttl');
  const held = new Map();

  return {
    /**
     * Decide one write.
     *
     * Checked in two passes on purpose: a write to several paths is refused if **any** of
     * them is held by another agent, and no lease is granted unless the whole write is
     * allowed. Granting the first path and then refusing the second would leave a lease
     * behind for a write that never happened.
     */
    evaluate({ sessionID, action, resources }, now = Date.now()) {
      if (!WRITE_ACTIONS.includes(action)) return { decision: 'allow' };
      if (!Array.isArray(resources) || resources.length === 0) return { decision: 'allow' };
      if (typeof sessionID !== 'string' || sessionID.length === 0) return { decision: 'allow' };

      for (const path of resources) {
        const lease = held.get(path);
        const live = lease && now - lease.at < ttlMs;
        if (live && lease.sessionID !== sessionID) return { decision: 'deny', path, heldBy: lease.sessionID };
      }
      for (const path of resources) held.set(path, { sessionID, at: now });
      return { decision: 'allow' };
    },

    /** Drop every lease a session holds. Called when its execution ends. */
    release(sessionID) {
      for (const [path, lease] of held) if (lease.sessionID === sessionID) held.delete(path);
    },

    /** The current holders, for evidence. */
    snapshot() {
      return Object.fromEntries([...held].map(([path, lease]) => [path, lease.sessionID]));
    },
  };
}
