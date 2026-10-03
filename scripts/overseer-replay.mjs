import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSyntheticOverseer, SUPPORTED_ARMS } from '../src/synthetic-overseer.mjs';
import { createOverseerControl, overseerEvidence } from '../src/overseer-control.mjs';

/**
 * Replay a recorded squad run through the synthetic overseer.
 *
 * The question this answers is narrow and worth stating precisely: at each
 * moment the automatic notification policy changed or suppressed something,
 * what else would an operator have had reason to look at?
 *
 * It is a replay, not a reproduction. It reads recorded evidence and asks what a
 * policy would have proposed given that evidence. No agent runs. The recorded
 * events are a bounded ring buffer, so the timeline is partial; see `limits`.
 */

const args = process.argv.slice(2);
/** Accept both `--key=value` and `--key value`, matching the other harnesses. */
const option = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  if (index !== -1 && index + 1 < args.length && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find(value => value.startsWith(`--${key}=`));
  return inline ? inline.slice(key.length + 3) : fallback;
};

const path = option('evidence', null);
const arm = option('arm', 'shadow');
if (!path) {
  console.error('Usage: node scripts/overseer-replay.mjs --evidence=<squad-evidence.json> [--arm=shadow|reactive|proactive|adversarial] [--seed=N]');
  process.exit(2);
}
if (!SUPPORTED_ARMS.includes(arm)) {
  console.error(`Unsupported arm: ${arm}. Choose from ${SUPPORTED_ARMS.join(', ')}`);
  process.exit(2);
}

const document = JSON.parse(await readFile(resolve(path), 'utf8'));
const result = document.result ?? document;
const actors = new Map((result.actors ?? []).map(actor => [actor.id, actor]));

/**
 * The recorded final state is the authoritative record of what each actor
 * depended on and what it actually read.
 *
 * An earlier version of this replay used `actor.affinityFiles` as a stand-in for
 * dependencies. That is wrong in a way that inflates results enormously:
 * `affinityFiles` is the actor's *own output*, so every actor appeared to depend
 * on the file it was writing, and every write looked like a stale read. It also
 * ignored `state.participants[].reads` entirely and reconstructed reads from
 * tool events, which the bounded ring buffer had already truncated. Use the
 * recorded state.
 */
const finalState = new Map((result.state?.participants ?? []).map(participant => [participant.id, participant]));

/**
 * Rebuild the observable view at one point in the run.
 *
 * Dependencies and reads come from the recorded final state. Revisions come from
 * `file.observed` events as the run progressed. This is a reconstruction from a
 * bounded event log, not the live observer state.
 */
function buildView({ elapsedMs, fileRevisions, liveActors, policyNotices }) {
  return {
    snapshot: {
      participants: [...liveActors].map(id => {
        const recorded = finalState.get(id) ?? {};
        return {
          id,
          status: liveActors.has(id) ? 'running' : 'completed',
          task: { id },
          dependencies: recorded.dependencies ?? [],
          lastLocation: recorded.lastLocation ?? null,
          // The recorded read revision, never the file's current revision.
          //
          // An earlier version mapped each read onto `fileRevisions.get(path)`,
          // which quietly replaced "read at r1" with "read at r11" and made every
          // staleness vanish by construction. It reported a clean 0 on a run that
          // held eleven ticks of genuine unflagged staleness. A read's revision is
          // when the reader saw the bytes; the file's revision is now. Comparing
          // them is the entire measurement.
          reads: (recorded.reads ?? [])
            .filter(read => Number.isSafeInteger(read.revision) && fileRevisions.has(read.path))
            .map(read => ({ path: read.path, revision: read.revision })),
        };
      }),
      files: [...fileRevisions].map(([filePath, revision]) => ({
        path: filePath,
        revision,
        hash: null,
        confidence: 'observed',
        attribution: 'unknown',
        missing: false,
      })),
      rooms: [],
      coverage: { complete: true, reason: null },
    },
    policyNotices,
    tick: elapsedMs,
  };
}

const policy = createSyntheticOverseer({ arm, seed: Number(option('seed', '104729')) });
const control = createOverseerControl({
  liveActors: () => [...new Set((result.actors ?? []).map(actor => actor.id))],
  actionBudget: 512,
});

// Walk the recorded timeline in order.
const events = [...(result.events ?? [])].sort((left, right) => left.elapsedMs - right.elapsedMs);
const fileRevisions = new Map();
const liveActors = new Set((result.actors ?? []).map(actor => actor.id));
const findings = [];
let ticks = 0;

for (const event of events) {
  if (event.type === 'file.observed' && typeof event.path === 'string') {
    fileRevisions.set(event.path, event.revision);
  }
  if (event.type === 'task.settled') {
    liveActors.delete(event.actor);
  }
  // Only ask the policy at the moments an operator would plausibly have been
  // looking: something changed on disk, or a notice was raised or suppressed.
  if (!['file.observed', 'notification.suppressed', 'awareness.notification'].includes(event.type)) continue;
  const policyNotices =
    event.type === 'awareness.notification'
      ? [{ actorId: event.actor, path: event.path }]
      : [];
  const view = buildView({ elapsedMs: event.elapsedMs, fileRevisions, liveActors, policyNotices });
  const decision = policy.decide(view);
  ticks++;
  for (const item of decision.attention) {
    findings.push({ atMs: event.elapsedMs, trigger: event.type, ...item });
  }
  // Refusals are recorded too, so the run shows what authority was withheld.
  control.considerAll(decision.proposals, { at: Date.now() });
}

// Findings repeat across ticks while a staleness persists. Report distinct
// actor/path pairs, because "the same file looked stale for forty consecutive
// ticks" is one thing an operator would act on, not forty.
const distinct = new Map();
for (const finding of findings) {
  const key = `${finding.actorId}:${finding.path}`;
  if (!distinct.has(key)) distinct.set(key, { ...finding, repeats: 0, lastAtMs: finding.atMs });
  const entry = distinct.get(key);
  entry.repeats++;
  entry.lastAtMs = finding.atMs;
}
const uniqueFindings = [...distinct.values()];

const evidence = overseerEvidence(control, policy);
const byActor = uniqueFindings.reduce((counts, finding) => {
  counts[finding.actorId] = (counts[finding.actorId] ?? 0) + 1;
  return counts;
}, {});
const byPath = uniqueFindings.reduce((counts, finding) => {
  counts[finding.path] = (counts[finding.path] ?? 0) + 1;
  return counts;
}, {});

console.log(`Replayed ${events.length} recorded events, asked the policy ${ticks} times.`);
console.log(`Arm: ${arm}`);
console.log(`Distinct (actor, path) stalenesses the automatic policy had not flagged: ${uniqueFindings.length}`);
if (uniqueFindings.length > 0) {
  console.log('\nBy actor:');
  for (const [id, count] of Object.entries(byActor).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id}: ${count}`);
  }
  console.log('\nBy path:');
  for (const [target, count] of Object.entries(byPath).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${target}: ${count}`);
  }
  console.log('\nDetail:');
  for (const finding of uniqueFindings) {
    console.log(
      `  ${finding.actorId} <- ${finding.path} (read at revision ${finding.readRevision}, now ${finding.fileRevision})` +
        `  first ${finding.atMs}ms, last ${finding.lastAtMs}ms, ${finding.repeats} ticks`
    );
  }
}
console.log('\nControl:');
console.log(`  accepted ${evidence.interventions.total}, refused ${evidence.control.refused}`);
console.log(`  ${JSON.stringify(evidence.interventions.byAction)}`);
// Was anything testable at all? A zero is only meaningful if the run contained
// dependency activity the policy could have flagged. Report the denominator so a
// zero cannot be mistaken for a clean bill of health.
const dependencyEdges = [...finalState.values()].reduce(
  (sum, participant) => sum + (participant.dependencies?.length ?? 0),
  0
);
const readsWithRevision = [...finalState.values()].reduce(
  (sum, participant) => sum + (participant.reads ?? []).filter(read => Number.isSafeInteger(read.revision)).length,
  0
);
const filesChangedDuringRun = fileRevisions.size;
const noticesRecorded = (result.notices ?? []).length;

console.log('\nDenominator, so a zero is readable:');
console.log(`  dependency edges declared: ${dependencyEdges}`);
console.log(`  participant reads with a revision: ${readsWithRevision}`);
console.log(`  files observed changing during the run: ${filesChangedDuringRun}`);
console.log(`  notices the automatic policy recorded: ${noticesRecorded}`);
console.log(
  dependencyEdges === 0 || readsWithRevision === 0
    ? '  WARNING: too little recorded activity for a zero to mean anything'
    : '  a zero here means the policy flagged what it saw, over the activity this log retains'
);

console.log('\nLimits:');
console.log(`  syntheticOverseer: ${evidence.limits.syntheticOverseer}`);
console.log(`  humanOversight: ${evidence.limits.humanOversight}`);
console.log(`  replay_not_reproduction: true`);
console.log(`  eventLogIsBoundedRingBuffer: ${(result.events ?? []).length >= 256}`);
console.log(`  finalStateReadsProjectedOntoHistoricalTicks: true`);
console.log(`  earlierStalenessMayHaveBeenResolvedBeforeTheLogRetainedIt: true`);
console.log(`  canSupport: ${evidence.limits.canSupport}`);
console.log(`  cannotSupport: ${evidence.limits.cannotSupport}`);