/**
 * A flight's numbers, small enough to commit.
 *
 * A flight writes megabytes of evidence into `artifacts/`, which is gitignored -- and one flight's
 * directory turned out to be gone a few hours after it settled, taking its retained trace and its
 * re-grade with it (the cause was never established; `docs/state-of-play.md` §4a). Retention into an
 * ignored, unbacked directory is not retention.
 *
 * So the durable form of a flight is this: every figure that a later reader would want, in a few
 * kilobytes, written where a commit can keep it. The bytes stay a working copy that may not survive
 * the week; the summary is what survives regardless, and it is enough to cite, to compare and to
 * re-grade against a fixture whose seed hash it records.
 *
 * Pure on purpose: what a summary contains is a decision about what matters, and decisions are worth
 * testing without a flight to run.
 */

const count = (list, predicate) => list.filter(predicate).length;

/**
 * @param {object} evidence a flight's `evidence-private.json`
 * @param {object} [source] the harness's own fingerprints for the run, kept as a digest
 */
export function flightSummary(evidence, { source } = {}) {
  if (!evidence || typeof evidence !== 'object' || !Array.isArray(evidence.results)) throw Error('invalid_flight_evidence');
  const cohorts = evidence.results.map(result => {
    const actors = result.actors ?? [];
    const checks = result.verification?.checks ?? [];
    const instructions = result.verification?.instructionChecks ?? [];
    const usage = actors.reduce((total, actor) => ({
      input: total.input + (Number(actor.usage?.input) || 0),
      output: total.output + (Number(actor.usage?.output) || 0),
      cost: total.cost + (Number(actor.usage?.cost) || 0),
    }), { input: 0, output: 0, cost: 0 });
    return {
      id: result.id,
      fixture: result.fixtureID ?? null,
      config: result.configID ?? null,
      model: result.actorModels?.[0]?.id ?? null,
      outcome: result.outcome ?? 'unknown',
      correct: result.correct === true,
      elapsedMs: result.elapsedMs ?? null,
      // The seed hash is what makes a re-grade meaningful later: if the fixture moved, the
      // artifacts in this flight cannot be graded by it any more.
      seedSHA256: result.seedSHA256 ?? null,
      tokens: { input: usage.input, output: usage.output, total: usage.input + usage.output },
      cost: Number(usage.cost.toFixed(6)),
      checks: { passed: count(checks, check => check.passed), total: checks.length, failed: checks.filter(check => !check.passed).map(check => check.name) },
      protected: { passed: count(instructions, check => check.passed), total: instructions.length, failed: instructions.filter(check => !check.passed).map(check => check.name) },
      bands: (result.snapshots ?? []).map(snapshot => ({ atMs: snapshot.targetMs ?? null, passed: count(snapshot.verification?.checks ?? [], check => check.passed), total: (snapshot.verification?.checks ?? []).length })),
      actors: { total: actors.length, succeeded: count(actors, actor => actor.outcome === 'succeeded'), failed: count(actors, actor => ['failed', 'deadline', 'not-run'].includes(actor.outcome)) },
      errors: (result.errors ?? []).map(error => error.code ?? String(error)),
    };
  });

  const models = [...new Set(cohorts.map(cohort => cohort.model).filter(Boolean))];
  return {
    flight: evidence.flight ?? null,
    created: evidence.created ?? null,
    ended: evidence.ended ?? null,
    status: evidence.status ?? 'unknown',
    mode: evidence.mode ?? null,
    models,
    catalogPrices: evidence.catalogPrices ?? {},
    cohorts,
    totals: {
      cohorts: cohorts.length,
      correct: count(cohorts, cohort => cohort.correct),
      tokens: cohorts.reduce((total, cohort) => total + cohort.tokens.total, 0),
      cost: Number(cohorts.reduce((total, cohort) => total + cohort.cost, 0).toFixed(6)),
      actors: cohorts.reduce((total, cohort) => total + cohort.actors.total, 0),
      actorFailures: cohorts.reduce((total, cohort) => total + cohort.actors.failed, 0),
    },
    // Whether the code that ran still exists is one question; this is the short answer.
    sourceDigest: source === undefined ? null : digestOf(source),
    errors: (evidence.errors ?? []).map(error => error.code ?? String(error)),
    note: 'The durable form of a flight. Artifacts, traces and the re-grade live in the flight directory and may not survive; these figures are committed and are what a later reader should cite.',
  };
}

/** A stable digest of the harness's own fingerprints, so a summary says which code produced it. */
function digestOf(source) {
  const text = JSON.stringify(source);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return { files: Object.keys(source).length, digest: hash.toString(16) };
}
