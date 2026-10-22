/**
 * The recovery half of the publication record: who has to redo what, and what that cost.
 *
 * The invalidation increment says *which* published outputs the workspace no longer
 * approves. It deliberately stops there — restoring correctness is work, and the
 * mechanism that flags an output cannot be the mechanism that redoes it, or a status
 * becomes a promise. This module is the part that decides who is asked to redo their
 * output, how many times it is worth asking, and what the asking cost.
 *
 * Why the cost is a first-class result
 *
 * The deterministic campaign measured the price of the mechanism as well as the benefit:
 * 12 invalidations produced 12 regenerations and only 6 of them changed the bytes. The
 * other half were outputs that genuinely depended on what moved and whose own content did
 * not need to change. A mechanism whose cost is unmeasured is a mechanism that gets turned
 * off the first time it is expensive, so the tax is computed here from the same evidence
 * the benefit is: the content hashes before and after each regeneration.
 *
 * What the tax is measured in depends on who regenerates. A container participant costs
 * container time and bytes; a model-driven participant costs tokens and money. The shape is
 * the same and the units are not, so the totals are kept separate and nothing is summed
 * across them. Reporting "cost" as one number would be the kind of arithmetic that makes a
 * cheap model look free.
 *
 * Pure module. No I/O, no Cloudflare, no model. Every input is a value the caller read from
 * somewhere else, so the policy is testable without an account and without spending anything.
 */

/**
 * What the workspace reports, in the mission's own terms.
 *
 * The product answers with `{invalidated: [...], counts, uncovered}`. This keeps the parts a
 * recovery decision needs and drops nothing silently: an invalidated path nobody owns is
 * reported as `unowned` rather than ignored, because "the workspace says this output is
 * stale and no task claims it" is exactly the case a harness must not quietly skip.
 */
export function recoveryPlan({ invalidated = [], outputs = [], attempts = {}, ceiling = 2 } = {}) {
  if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error('invalid_recovery_ceiling');

  const ownerOf = new Map();
  for (const output of outputs) {
    if (!output?.path || !output?.task) throw new Error('invalid_mission_output');
    ownerOf.set(output.path, output.task);
  }

  const regenerate = [];
  const exhausted = [];
  const unowned = [];
  const seen = new Set();

  // Sorted by depth so a direct contradiction is asked for before something two hops out.
  // Order is not correctness here, but it is the order a reader expects, and it makes two
  // runs of the same mission comparable.
  const ordered = [...invalidated].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of ordered) {
    if (!entry?.path) throw new Error('invalid_invalidation_entry');
    const task = ownerOf.get(entry.path) ?? null;
    if (task === null) {
      unowned.push({ path: entry.path, depth: entry.depth ?? 0, staleInputs: entry.staleInputs ?? [] });
      continue;
    }
    if (seen.has(task)) continue;
    seen.add(task);
    const used = attempts[task] ?? 0;
    if (!Number.isInteger(used) || used < 0) throw new Error('invalid_recovery_attempts');
    if (used >= ceiling) {
      // A ceiling rather than a retry loop. The failure this guards is a participant whose
      // output depends on a file that keeps moving: asking forever converts a stale output
      // into an unbounded bill, and the honest outcome is a recorded stop.
      exhausted.push({ task, path: entry.path, attempts: used, depth: entry.depth ?? 0 });
      continue;
    }
    regenerate.push({ task, path: entry.path, attempt: used + 1, depth: entry.depth ?? 0, staleInputs: entry.staleInputs ?? [] });
  }

  return {
    regenerate,
    exhausted,
    unowned,
    // A plan that asks for nothing is a valid plan, and the caller has to be able to tell it
    // from a plan that could not be built.
    empty: regenerate.length === 0 && exhausted.length === 0 && unowned.length === 0,
  };
}

/**
 * The tax: what the recovery cost, and how much of it changed nothing.
 *
 * `publishes` and `regenerations` are the same shape on purpose — one entry per container
 * start or model turn — so the two waves are comparable:
 *
 *   { task, path, contentHash, byteLength, containerMs, modelCost, modelTokens }
 *
 * A regeneration may also carry `before`: the content hash this output held immediately
 * before that regeneration. It takes precedence over the publication map, because a mission
 * with more than one round of invalidation has more than one "before" per path and a map
 * that keeps only the latest would attribute round two's waste to round one's bytes.
 *
 * `contentHash` is what makes over-invalidation measurable rather than a matter of opinion.
 * A regeneration whose output hashes the same as the publication it replaced did not need to
 * happen: the output depended on the input that moved, and the change could not affect it.
 * The mechanism cannot tell those apart, and the campaign measured them at half of all
 * invalidations.
 */
export function taxOf({ publishes = [], regenerations = [] } = {}) {
  const published = new Map();
  for (const entry of publishes) {
    if (!entry?.path) throw new Error('invalid_tax_entry');
    published.set(entry.path, entry.contentHash ?? null);
  }

  const changed = [];
  const unchanged = [];
  const unknown = [];

  for (const entry of regenerations) {
    if (!entry?.path) throw new Error('invalid_tax_entry');
    const before = entry.before ?? published.get(entry.path) ?? null;
    if (before == null || entry.contentHash == null) {
      // Counted, not assumed. A regeneration whose before-hash is unknown cannot be called
      // wasted, and it cannot be called useful either.
      unknown.push({ path: entry.path, task: entry.task ?? null });
      continue;
    }
    (before === entry.contentHash ? unchanged : changed).push({
      path: entry.path,
      task: entry.task ?? null,
      before,
      after: entry.contentHash,
    });
  }

  const sum = (entries, key) => entries.reduce((total, entry) => total + (Number.isFinite(entry[key]) ? entry[key] : 0), 0);
  const count = entries => entries.reduce((total, entry) => total + (Number.isFinite(entry.modelTokens) ? entry.modelTokens : 0), 0);

  return {
    regenerations: regenerations.length,
    changedOutputs: changed,
    unchangedOutputs: unchanged,
    unknownOutputs: unknown,
    // Named for what it is: the share of regenerations that produced the bytes already there.
    // A rate is only meaningful over the ones that could be judged.
    overInvalidationRate: changed.length + unchanged.length === 0
      ? null
      : unchanged.length / (changed.length + unchanged.length),
    totals: {
      starts: publishes.length + regenerations.length,
      containerMs: sum(publishes, 'containerMs') + sum(regenerations, 'containerMs'),
      regenerationContainerMs: sum(regenerations, 'containerMs'),
      bytes: sum(publishes, 'byteLength') + sum(regenerations, 'byteLength'),
      // Model cost is reported in the units it was reported in. Nothing here converts a
      // token into a dollar or adds the two, because a harness that does that can make any
      // mechanism look affordable.
      modelCost: sum(publishes, 'modelCost') + sum(regenerations, 'modelCost'),
      regenerationModelCost: sum(regenerations, 'modelCost'),
      modelTokens: count(publishes) + count(regenerations),
      regenerationModelTokens: count(regenerations),
    },
  };
}

/**
 * Did the mission come back to a state anybody would call correct?
 *
 * Two separate questions, deliberately not collapsed:
 *
 *   coherent    nothing the workspace knows about is invalidated. This is what the
 *               mechanism is for, and it is not the same as correct: a participant that
 *               republishes the same wrong bytes with a fresh declaration is coherent.
 *   correct     every expected output holds the value the mission asked for. This is
 *               checked against the caller's expectations, not against the workspace's
 *               opinion of itself.
 *
 * The gap between them is the whole reason both are reported. A run that reaches coherent
 * without correct has laundered the failure, and a run that is correct but not coherent has
 * a stale output nobody has noticed yet.
 */
export function recoveryVerdict({ after = { invalidated: [] }, expected = {} } = {}) {
  const invalidated = (after.invalidated ?? []).map(entry => entry.path);
  const mismatched = [];
  const missing = [];

  for (const [path, want] of Object.entries(expected)) {
    const got = Object.prototype.hasOwnProperty.call(after.content ?? {}, path) ? after.content[path] : null;
    if (got == null) missing.push(path);
    else if (got !== want) mismatched.push({ path, want, got });
  }

  return {
    coherent: invalidated.length === 0,
    invalidated,
    correct: mismatched.length === 0 && missing.length === 0,
    mismatched,
    missing,
  };
}
