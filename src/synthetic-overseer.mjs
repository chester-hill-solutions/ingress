import { createHash } from 'node:crypto';

/**
 * A synthetic human overseer.
 *
 * This is NOT a human. It is a deterministic policy standing in for one, so the
 * overseer arm of a test campaign can run without a person present and so runs
 * are reproducible. Every record it produces says so, in a field a consumer
 * cannot miss:
 *
 *   syntheticOverseer: true, humanOversight: false
 *
 * That is the whole point. A harness that can quietly pass its own simulated
 * operator off as a real one would make every number it produces worthless. If
 * you are reading evidence and see `humanOversight: false`, the run says a
 * policy acted, not a person.
 *
 * The policy emits *proposals*. It cannot write files, stop agents, or alter an
 * outcome. The control surface decides which proposals are within its authority
 * and records what it did with each one. A synthetic human with no authority
 * boundary is just an automation layer wearing a human label.
 */

const ARMS = new Set(['shadow', 'reactive', 'proactive', 'adversarial']);
const PROPOSAL_KINDS = new Set(['note', 'admit', 'defer', 'steer', 'cancel', 'induce']);

const TERMINAL_STATUSES = new Set(['stopped', 'interrupted', 'completed', 'failed']);

const MAX_NOTE_BYTES = 4000;
const MAX_PROPOSALS_PER_TICK = 64;
const MAX_JOURNAL = 4096;

function boundedText(value, limit, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) {
    throw new RangeError(`synthetic_overseer_${label}_bounds`);
  }
  return value;
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Deterministic PRNG so a seeded arm replays identically. */
function seededRandom(seed) {
  let state = Number.isSafeInteger(seed) && seed >= 0 ? seed % 2147483647 : 1;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * Normalize a harness view into the narrow shape the policy reasons over.
 *
 * Deliberately narrow: the policy reads participants, declared dependencies,
 * observed file revisions, the rooms people share, and whatever the automatic
 * notification policy has already fired. It does not read model prose, native
 * transcripts, or verification verdicts, because a synthetic operator that
 * reasons over those starts grading its own homework.
 */
function readView(view) {
  if (!view || typeof view !== 'object') throw new TypeError('synthetic_overseer_view_required');
  const snapshot = view.snapshot;
  if (!snapshot || !Array.isArray(snapshot.participants) || !Array.isArray(snapshot.files)) {
    throw new TypeError('synthetic_overseer_snapshot_required');
  }
  const files = new Map();
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string') continue;
    files.set(file.path, { path: file.path, revision: file.revision ?? null, hash: file.hash ?? null });
  }
  const participants = snapshot.participants.map(agent => ({
    id: agent.id,
    status: agent.status,
    taskID: agent.task?.id ?? null,
    dependencies: (agent.dependencies ?? []).map(dep => dep?.producerPath).filter(path => typeof path === 'string'),
    lastLocationPath: agent.lastLocation?.path ?? null,
    lastLocationStale: agent.lastLocation?.stale === true,
    reads: (agent.reads ?? []).map(read => ({ path: read.path, revision: read.revision ?? null })),
    terminal: TERMINAL_STATUSES.has(agent.status),
  }));
  const rooms = new Map((snapshot.rooms ?? []).map(room => [room.path, room.participants ?? []]));
  return {
    participants,
    files,
    rooms,
    coverage: snapshot.coverage ?? { complete: false, reason: 'no coverage recorded' },
    policyNotices: Array.isArray(view.policyNotices) ? view.policyNotices : [],
    tick: Number.isSafeInteger(view.tick) && view.tick >= 0 ? view.tick : 0,
  };
}

/**
 * What the policy notices that the automatic notification policy did not.
 *
 * This is the measurement the shadow arm exists to produce. If a person would
 * have looked at something the policy never flagged, the policy has a gap; if
 * the policy already covers everything, the human adds nothing on these runs.
 * Either answer is worth having, and neither is available without a shadow arm.
 */
function unattendedNotices(model) {
  const flagged = new Set(
    model.policyNotices.map(notice => `${notice.actorId ?? ''}:${notice.path ?? ''}`)
  );
  const attention = [];
  for (const agent of model.participants) {
    if (agent.terminal) continue;
    for (const dependency of agent.dependencies) {
      const file = model.files.get(dependency);
      const read = agent.reads.find(candidate => candidate.path === dependency);
      if (!file || file.revision === null) continue;
      const stale = !read || read.revision === null || read.revision < file.revision;
      if (!stale) continue;
      if (flagged.has(`${agent.id}:${dependency}`)) continue;
      attention.push({
        actorId: agent.id,
        path: dependency,
        kind: 'dependency_changed_after_read',
        fileRevision: file.revision,
        readRevision: read?.revision ?? null,
      });
    }
  }
  return attention;
}

/** Shared files with more than one live participant: where a conflict can start. */
function contestedRooms(model) {
  const contested = [];
  for (const [path, members] of model.rooms) {
    const live = model.participants.filter(agent => members.includes(agent.id) && !agent.terminal);
    if (live.length > 1) contested.push({ path, actors: live.map(agent => agent.id) });
  }
  return contested.sort((left, right) => left.path.localeCompare(right.path));
}

function propose(tick, arm, kind, reason, basis, extra = {}) {
  return {
    kind,
    arm,
    tick,
    reason: boundedText(reason, 256, 'reason'),
    basisDigest: digestOf(basis),
    syntheticOverseer: true,
    humanOversight: false,
    ...extra,
  };
}

/**
 * Create a synthetic overseer policy.
 *
 * `arm` selects what it is allowed to want:
 *   shadow      records attention, proposes nothing that changes the run
 *   reactive    acts only where the automatic policy already fired
 *   proactive   acts ahead of it, from the dependency graph and revisions
 *   adversarial asks the harness to induce a named fault, then recover
 */
export function createSyntheticOverseer({
  arm = 'shadow',
  seed = 104729,
  attentionBudget = 32,
  inducedFault = null,
} = {}) {
  if (!ARMS.has(arm)) throw new TypeError('synthetic_overseer_unsupported_arm');
  if (!Number.isSafeInteger(attentionBudget) || attentionBudget < 0 || attentionBudget > MAX_PROPOSALS_PER_TICK) {
    throw new RangeError('synthetic_overseer_attention_budget');
  }
  const random = seededRandom(seed);
  let attentionUsed = 0;
  let ticks = 0;
  const journal = [];

  function record(entry) {
    journal.push(entry);
    if (journal.length > MAX_JOURNAL) journal.shift();
  }

  /**
   * Consider one view and return the proposals it wants to make.
   *
   * Pure with respect to the view: the same view, arm and seed produce the same
   * proposals, which is what makes a run reproducible and a bug in the policy
   * findable. Only the tick counter and the attention budget advance.
   */
  function decide(view) {
    const model = readView(view);
    ticks++;
    attentionUsed = 0;

    const attention = unattendedNotices(model);
    const contested = contestedRooms(model);
    const pending = model.participants.filter(agent => !agent.terminal);
    const proposals = [];

    // Every arm records what it saw, including the ones that change nothing.
    record({
      at: model.tick,
      arm,
      syntheticOverseer: true,
      humanOversight: false,
      observed: {
        participants: model.participants.length,
        live: pending.length,
        files: model.files.size,
        coverageComplete: model.coverage.complete === true,
        unattended: attention.length,
        contestedRooms: contested.length,
        policyNotices: model.policyNotices.length,
      },
    });

    const spend = () => attentionUsed < attentionBudget;
    const note = (reason, extra) => {
      if (!spend()) return;
      attentionUsed++;
      proposals.push(propose(model.tick, arm, 'note', reason, { attention, contested }, extra));
    };

    if (arm === 'shadow') {
      // The measurement arm: notice everything, ask for nothing.
      for (const item of attention.slice(0, attentionBudget)) {
        proposals.push(propose(model.tick, arm, 'note', 'shadow_observed_unattended_change', item, {
          actorId: item.actorId,
          path: item.path,
        }));
      }
      return { arm, tick: model.tick, proposals, attention, contested };
    }

    if (arm === 'reactive') {
      // Only where the automatic policy already spoke. Does confirming or
      // deferring on an existing signal change anything?
      for (const notice of model.policyNotices.slice(0, attentionBudget)) {
        const actorId = notice.actorId ?? null;
        if (actorId && !pending.some(agent => agent.id === actorId)) continue;
        proposals.push(propose(model.tick, arm, 'steer', 'reactive_confirm_policy_notice', notice, {
          actorId,
          text: boundedText(
            `Confirm the coordinator's change to ${notice.path ?? 'a shared file'}. Re-read it before relying on earlier content.`,
            MAX_NOTE_BYTES,
            'text'
          ),
        }));
      }
      note('reactive_policy_notices_reviewed');
      return { arm, tick: model.tick, proposals, attention, contested };
    }

    if (arm === 'proactive') {
      // Ahead of the policy: a dependency moved under someone who already read
      // it and nobody has been told.
      for (const item of attention) {
        if (!spend()) break;
        attentionUsed++;
        proposals.push(propose(model.tick, arm, 'steer', 'proactive_stale_dependency', item, {
          actorId: item.actorId,
          path: item.path,
          text: boundedText(
            `${item.path} changed at revision ${item.fileRevision} after you read it at ${item.readRevision ?? 'unknown'}. Re-read it before acting on earlier content.`,
            MAX_NOTE_BYTES,
            'text'
          ),
        }));
      }
      for (const room of contested) {
        if (!spend()) break;
        attentionUsed++;
        proposals.push(propose(model.tick, arm, 'note', 'proactive_contested_room', room, {
          path: room.path,
        }));
      }
      if (model.coverage.complete !== true) {
        note('proactive_evidence_incomplete');
      }
      return { arm, tick: model.tick, proposals, attention, contested };
    }

    // adversarial: ask the harness to create a condition, then recover from it.
    const fault = typeof inducedFault === 'string' ? boundedText(inducedFault, 128, 'fault') : 'stale_dependency';
    proposals.push(propose(model.tick, arm, 'induce', 'adversarial_request_fault', { fault, contested }, { fault }));
    for (const item of attention) {
      if (!spend()) break;
      attentionUsed++;
      proposals.push(propose(model.tick, arm, 'steer', 'adversarial_recover_stale_read', item, {
        actorId: item.actorId,
        path: item.path,
        recovery: true,
        text: boundedText(
          `Recovery: ${item.path} moved to revision ${item.fileRevision}. Treat your earlier read as stale.`,
          MAX_NOTE_BYTES,
          'text'
        ),
      }));
    }
    return { arm, tick: model.tick, proposals, attention, contested };
  }

  return {
    arm,
    decide,
    /** Everything the policy has seen, for evidence. */
    journal: () => journal.slice(),
    summary: () => ({
      arm,
      seed,
      ticks,
      attentionBudget,
      journalEntries: journal.length,
      syntheticOverseer: true,
      humanOversight: false,
    }),
    /**
     * What this run can and cannot support, in words, so it travels with the
     * evidence instead of living only in the author's head.
     */
    limits: {
      syntheticOverseer: true,
      humanOversight: false,
      singlePolicyInstance: true,
      independentJudge: false,
      canSupport: 'whether a proposed intervention changed an outcome under this policy',
      cannotSupport: 'whether a human overseer would notice, choose, or recover the same way',
      provenanceNote:
        'A synthetic overseer is a reproducible stand-in. It is evidence about the harness, never about human attention or judgement.',
    },
    random,
  };
}

export const SUPPORTED_ARMS = [...ARMS];
export const SUPPORTED_PROPOSAL_KINDS = [...PROPOSAL_KINDS];