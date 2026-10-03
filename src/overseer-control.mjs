import { createHash, randomUUID } from 'node:crypto';

/**
 * Overseer control surface.
 *
 * The synthetic policy proposes; this decides. Nothing a policy proposes is
 * applied by the policy. Every proposal lands here, is checked against what the
 * harness can actually do, and is recorded with what was done about it.
 *
 * The boundary is the interesting part:
 *
 *   - No proposal can rewrite an actor outcome. Outcomes are facts about what
 *     ran; a steer changes what happens next, never what already happened.
 *   - No proposal can alter a verification verdict. The checks run in a child
 *     process and their results are not writable through this surface.
 *   - Every accepted action carries a hash of the exact bytes sent, so what was
 *     delivered can be checked later against what was decided.
 *   - Rejections are first-class records. A policy that is refused often is
 *     finding out about its own authority limits, and that is worth keeping.
 *
 * `automaticChangeMessages: 0` is the property repair-game.mjs established for a
 * human-directed repair run. This surface preserves it: it schedules no
 * follow-up work and starts no agent on its own.
 */

const ACTIONS = new Set(['note', 'admit', 'defer', 'steer', 'cancel', 'induce']);
const REJECTIONS = new Map([
  ['unknown_action', 'The proposed action is not one this surface implements.'],
  ['unknown_actor', 'The proposal names an actor this run does not have.'],
  ['actor_not_live', 'The actor has already settled, so no new instruction can reach it.'],
  ['empty_text', 'A steer with no text would be a no-op presented as an intervention.'],
  ['fault_not_supported', 'The harness has no mechanism to induce the requested fault.'],
  ['budget_exhausted', 'The run budget for synthetic interventions is spent.'],
]);

const MAX_ACTIONS = 512;
const MAX_TEXT_BYTES = 4000;
const MAX_JOURNAL = 8192;

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Create the control surface.
 *
 * `capabilities` is what the harness says it can actually do. Anything not
 * listed is refused, which is how a synthetic overseer stays honest: it cannot
 * claim an authority the run never granted it.
 */
export function createOverseerControl({
  capabilities = {},
  liveActors = () => [],
  actionBudget = 64,
  induceFault = null,
} = {}) {
  if (!Number.isSafeInteger(actionBudget) || actionBudget < 0) {
    throw new RangeError('overseer_control_action_budget');
  }
  const journal = [];
  let spent = 0;

  function record(entry) {
    journal.push(entry);
    if (journal.length > MAX_JOURNAL) journal.shift();
    return entry;
  }

  /**
   * Adjudicate one proposal.
   *
   * Returns the recorded entry. Never throws on a bad proposal: a policy that
   * proposes nonsense should produce a recorded refusal, not a crashed run.
   */
  function consider(proposal, { at = Date.now() } = {}) {
    const kind = proposal?.kind;
    const refuse = reason => record({
      at,
      commandID: randomUUID(),
      status: 'refused',
      reason,
      detail: REJECTIONS.get(reason) ?? null,
      action: kind ?? null,
      actorId: proposal?.actorId ?? null,
      proposalDigest: digestOf(proposal ?? null),
      syntheticOverseer: proposal?.syntheticOverseer === true,
      humanOversight: false,
    });

    if (!ACTIONS.has(kind)) return refuse('unknown_action');
    if (spent >= actionBudget) return refuse('budget_exhausted');

    const live = new Set(liveActors() ?? []);
    // `note` annotates the run and `induce` asks the harness for a run-level
    // condition. Neither addresses one actor, so neither may be refused for
    // omitting an actorId.
    const needsActor = kind !== 'note' && kind !== 'induce';
    if (needsActor) {
      const actorId = proposal.actorId;
      if (typeof actorId !== 'string' || actorId.length === 0) return refuse('unknown_actor');
      if (!live.has(actorId)) return refuse('actor_not_live');
    }
    if (kind === 'steer') {
      if (typeof proposal.text !== 'string' || Buffer.byteLength(proposal.text) === 0) {
        return refuse('empty_text');
      }
      if (Buffer.byteLength(proposal.text) > MAX_TEXT_BYTES) return refuse('unknown_action');
    }
    if (kind === 'induce' && typeof induceFault !== 'function') {
      return refuse('fault_not_supported');
    }
    if (kind === 'induce' && !capabilities.induceFault) return refuse('fault_not_supported');

    spent++;
    const entry = record({
      at,
      commandID: randomUUID(),
      status: 'accepted',
      reason: proposal.reason ?? null,
      action: kind,
      actorId: proposal.actorId ?? null,
      path: proposal.path ?? null,
      fault: proposal.fault ?? null,
      basisDigest: proposal.basisDigest ?? null,
      proposalDigest: digestOf(proposal),
      textDigest: typeof proposal.text === 'string' ? digestOf(proposal.text) : null,
      // The exact bytes, so a later reader can verify what was sent rather than
      // trusting that the recorded digest was computed from the right thing.
      text: typeof proposal.text === 'string' ? proposal.text : null,
      arm: proposal.arm ?? null,
      syntheticOverseer: proposal.syntheticOverseer === true,
      humanOversight: false,
    });
    return entry;
  }

  return {
    /** Adjudicate one proposal. Exposed so a transport can offer single actions. */
    consider,

    /**
     * Adjudicate a tick's worth of proposals in order.
     *
     * A refusal does not stop the tick. A policy that gets one thing refused
     * should still get its other proposals considered, or a single over-reach
     * silences an entire tick.
     */
    considerAll(proposals, options = {}) {
      return (Array.isArray(proposals) ? proposals : []).slice(0, 128).map(proposal => consider(proposal, options));
    },
    journal: () => journal.slice(),
    summary: () => ({
      actionsSpent: spent,
      actionBudget,
      accepted: journal.filter(entry => entry.status === 'accepted').length,
      refused: journal.filter(entry => entry.status === 'refused').length,
      maxActions: MAX_ACTIONS,
      automaticChangeMessages: 0,
      syntheticOverseer: true,
      humanOversight: false,
      capabilities: Object.keys(capabilities).sort(),
    }),
    limits: {
      canPropose: [...ACTIONS].sort(),
      cannotRewriteOutcomes: true,
      cannotAlterVerification: true,
      // The repair-game invariant: an overseer-influenced run never schedules
      // its own follow-up work, so the influence stays attributable to a person
      // or a policy rather than to the harness acting on its own.
      automaticChangeMessages: 0,
      schedulesNoFollowUpWork: true,
      startsNoAgent: true,
      syntheticOverseer: true,
      humanOversight: false,
    },
    remainingBudget: () => actionBudget - spent,
    induceFault,
  };
}

/**
 * Fold a tick's journal into the shape an evidence file expects.
 *
 * Kept separate from the live journal so a report can be produced without
 * exposing the full proposal stream.
 */
export function overseerEvidence(control, policy) {
  const journal = control.journal();
  const accepted = journal.filter(entry => entry.status === 'accepted');
  const refused = journal.filter(entry => entry.status === 'refused');
  return {
    control: control.summary(),
    policy: policy.summary(),
    limits: { ...control.limits, ...policy.limits },
    interventions: {
      total: accepted.length,
      byAction: accepted.reduce((counts, entry) => {
        counts[entry.action] = (counts[entry.action] ?? 0) + 1;
        return counts;
      }, {}),
      refusalsByReason: refused.reduce((counts, entry) => {
        counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
        return counts;
      }, {}),
    },
  };
}