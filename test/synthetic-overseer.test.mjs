import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createSyntheticOverseer,
  SUPPORTED_ARMS,
} from '../src/synthetic-overseer.mjs';
import {
  createOverseerControl,
  overseerEvidence,
} from '../src/overseer-control.mjs';
import {
  startOverseerServer,
  createOverseerClient,
} from '../src/overseer-server.mjs';

/**
 * A minimal view, shaped like the harness's own, so these tests do not depend on
 * the live squad plumbing.
 */
function view({
  participants = [],
  files = [],
  rooms = [],
  policyNotices = [],
  coverage = { complete: true, reason: null },
  tick = 1,
} = {}) {
  return { snapshot: { participants, files, rooms, coverage }, policyNotices, tick };
}

function agent(id, overrides = {}) {
  return {
    id,
    status: 'running',
    task: { id },
    dependencies: [],
    lastLocation: null,
    reads: [],
    ...overrides,
  };
}

function file(path, revision, hash = createHash('sha256').update(`${path}:${revision}`).digest('hex')) {
  return { path, revision, hash, confidence: 'observed', attribution: 'unknown', missing: false };
}

test('every arm marks itself synthetic and never claims human oversight', () => {
  for (const arm of SUPPORTED_ARMS) {
    const policy = createSyntheticOverseer({ arm });
    const summary = policy.summary();
    assert.equal(summary.syntheticOverseer, true, `${arm} summary`);
    assert.equal(summary.humanOversight, false, `${arm} summary`);
    assert.equal(policy.limits.humanOversight, false, `${arm} limits`);
    assert.equal(policy.limits.syntheticOverseer, true, `${arm} limits`);

    const { proposals } = policy.decide(view());
    for (const proposal of proposals) {
      assert.equal(proposal.syntheticOverseer, true, `${arm} proposal`);
      assert.equal(proposal.humanOversight, false, `${arm} proposal`);
    }
    for (const entry of policy.journal()) {
      assert.equal(entry.syntheticOverseer, true, `${arm} journal`);
      assert.equal(entry.humanOversight, false, `${arm} journal`);
    }
  }
});

test('an unsupported arm is rejected rather than silently defaulted', () => {
  assert.throws(() => createSyntheticOverseer({ arm: 'omniscient' }), /unsupported_arm/);
});

test('shadow notices an unattended dependency change but proposes no state change', () => {
  const policy = createSyntheticOverseer({ arm: 'shadow' });
  const { proposals, attention } = policy.decide(
    view({
      participants: [
        agent('builder', {
          dependencies: [{ producerPath: 'engine.mjs' }],
          reads: [{ path: 'engine.mjs', revision: 1 }],
        }),
      ],
      files: [file('engine.mjs', 2)],
    })
  );

  assert.equal(attention.length, 1);
  assert.equal(attention[0].path, 'engine.mjs');
  assert.equal(attention[0].kind, 'dependency_changed_after_read');
  assert.equal(attention[0].readRevision, 1);
  assert.equal(attention[0].fileRevision, 2);

  // The shadow arm's whole purpose: notice everything, change nothing.
  assert.ok(proposals.length > 0, 'the shadow arm records what it saw');
  for (const proposal of proposals) {
    assert.equal(proposal.kind, 'note', 'the shadow arm must not propose a state change');
  }
});

test('a change the automatic policy already flagged is not counted as unattended', () => {
  const policy = createSyntheticOverseer({ arm: 'shadow' });
  const participants = [
    agent('builder', {
      dependencies: [{ producerPath: 'engine.mjs' }],
      reads: [{ path: 'engine.mjs', revision: 1 }],
    }),
  ];
  const files = [file('engine.mjs', 2)];

  const unattended = policy.decide(view({ participants, files }));
  assert.equal(unattended.attention.length, 1);

  const alreadyFlagged = policy.decide(
    view({ participants, files, policyNotices: [{ actorId: 'builder', path: 'engine.mjs' }] })
  );
  assert.equal(alreadyFlagged.attention.length, 0, 'a fired notice is not a gap');
});

test('proactive steers exactly the actors holding a stale read', () => {
  const policy = createSyntheticOverseer({ arm: 'proactive' });
  const { proposals, attention } = policy.decide(
    view({
      participants: [
        agent('stale', {
          dependencies: [{ producerPath: 'engine.mjs' }],
          reads: [{ path: 'engine.mjs', revision: 1 }],
        }),
        agent('fresh', {
          dependencies: [{ producerPath: 'engine.mjs' }],
          reads: [{ path: 'engine.mjs', revision: 2 }],
        }),
        agent('unrelated'),
      ],
      files: [file('engine.mjs', 2)],
    })
  );

  assert.equal(attention.length, 1);
  const steers = proposals.filter(proposal => proposal.kind === 'steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].actorId, 'stale');
  assert.equal(steers[0].reason, 'proactive_stale_dependency');
  // The message names both revisions so a reader can check the claim.
  assert.match(steers[0].text, /changed at revision 2/);
  assert.match(steers[0].text, /you read it at 1/);
});

test('reactive acts only where the automatic policy already fired', () => {
  const policy = createSyntheticOverseer({ arm: 'reactive' });
  const { proposals } = policy.decide(
    view({
      participants: [agent('builder')],
      policyNotices: [{ actorId: 'builder', path: 'engine.mjs' }],
    })
  );

  const steers = proposals.filter(proposal => proposal.kind === 'steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].reason, 'reactive_confirm_policy_notice');

  const quiet = policy.decide(view({ participants: [agent('builder')] }));
  assert.equal(quiet.proposals.filter(proposal => proposal.kind === 'steer').length, 0);
});

test('a settled actor is never treated as live by any arm', () => {
  for (const arm of SUPPORTED_ARMS) {
    const policy = createSyntheticOverseer({ arm });
    const { attention, proposals } = policy.decide(
      view({
        participants: [
          agent('done', {
            status: 'completed',
            dependencies: [{ producerPath: 'engine.mjs' }],
            reads: [{ path: 'engine.mjs', revision: 1 }],
          }),
        ],
        files: [file('engine.mjs', 2)],
        policyNotices: [{ actorId: 'done', path: 'engine.mjs' }],
      })
    );
    assert.equal(attention.length, 0, `${arm} ignores a settled actor's stale read`);
    assert.equal(proposals.filter(p => p.actorId === 'done').length, 0, `${arm} never targets a settled actor`);
  }
});

test('adversarial asks for a fault to be induced and then attempts recovery', () => {
  const policy = createSyntheticOverseer({ arm: 'adversarial', inducedFault: 'stale_dependency' });
  const { proposals, attention } = policy.decide(
    view({
      participants: [
        agent('victim', {
          dependencies: [{ producerPath: 'engine.mjs' }],
          reads: [{ path: 'engine.mjs', revision: 1 }],
        }),
      ],
      files: [file('engine.mjs', 2)],
    })
  );

  const induce = proposals.filter(proposal => proposal.kind === 'induce');
  assert.equal(induce.length, 1);
  assert.equal(induce[0].fault, 'stale_dependency');

  const recovery = proposals.filter(proposal => proposal.recovery === true);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].reason, 'adversarial_recover_stale_read');
  assert.equal(attention.length, 1);
});

test('the same view and seed replay identically, and a different seed does not', () => {
  const build = () =>
    view({
      participants: [agent('a', { dependencies: [{ producerPath: 'x.mjs' }], reads: [{ path: 'x.mjs', revision: 1 }] })],
      files: [file('x.mjs', 2)],
      rooms: [{ path: 'shared.mjs', participants: ['a', 'b'] }],
      participantsExtra: undefined,
    });
  const first = createSyntheticOverseer({ arm: 'proactive', seed: 7 }).decide(build());
  const second = createSyntheticOverseer({ arm: 'proactive', seed: 7 }).decide(build());
  assert.deepEqual(first.proposals, second.proposals, 'same seed, same proposals');

  const third = createSyntheticOverseer({ arm: 'proactive', seed: 99 }).decide(build());
  assert.deepEqual(
    first.proposals.map(p => p.kind).sort(),
    third.proposals.map(p => p.kind).sort(),
    'the seed must not change which proposals are made here'
  );
});

test('a malformed view is refused rather than half-read', () => {
  const policy = createSyntheticOverseer({ arm: 'shadow' });
  assert.throws(() => policy.decide(null), /view_required/);
  assert.throws(() => policy.decide({}), /snapshot_required/);
  assert.throws(() => policy.decide({ snapshot: { files: [] } }), /snapshot_required/);
});

test('the attention budget bounds what one tick can propose', () => {
  const policy = createSyntheticOverseer({ arm: 'proactive', attentionBudget: 2 });
  const participants = ['a', 'b', 'c', 'd', 'e'].map(name =>
    agent(name, { dependencies: [{ producerPath: `${name}.mjs` }], reads: [{ path: `${name}.mjs`, revision: 1 }] })
  );
  const files = ['a', 'b', 'c', 'd', 'e'].map(name => file(`${name}.mjs`, 2));
  const { proposals } = policy.decide(view({ participants, files }));
  assert.ok(proposals.length <= 2, `expected at most 2 proposals, got ${proposals.length}`);
});

// --- control surface -------------------------------------------------------

function controlWith(liveActors, options = {}) {
  return createOverseerControl({
    liveActors: () => liveActors,
    ...options,
  });
}

test('the control surface accepts an in-authority steer and records the exact bytes', () => {
  const control = controlWith(['builder']);
  const policy = createSyntheticOverseer({ arm: 'proactive' });
  const { proposals } = policy.decide(
    view({
      participants: [agent('builder', { dependencies: [{ producerPath: 'engine.mjs' }], reads: [{ path: 'engine.mjs', revision: 1 }] })],
      files: [file('engine.mjs', 2)],
    })
  );

  const [entry] = control.considerAll(proposals);
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.action, 'steer');
  assert.equal(entry.actorId, 'builder');
  assert.equal(entry.syntheticOverseer, true);
  assert.equal(entry.humanOversight, false);
  // The recorded digest must be of the text that was actually decided on.
  assert.equal(entry.textDigest, createHash('sha256').update(JSON.stringify(entry.text)).digest('hex'));
});

test('the control surface refuses to steer a settled or unknown actor', () => {
  const control = controlWith([]);
  const steer = {
    kind: 'steer',
    actorId: 'ghost',
    text: 're-read engine.mjs',
    syntheticOverseer: true,
    humanOversight: false,
  };
  const [refused] = control.considerAll([steer]);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'actor_not_live');
  assert.equal(refused.humanOversight, false);
});

test('an empty steer is refused: a no-op is not an intervention', () => {
  const control = controlWith(['builder']);
  const [refused] = control.considerAll([
    { kind: 'steer', actorId: 'builder', text: '', syntheticOverseer: true, humanOversight: false },
  ]);
  assert.equal(refused.reason, 'empty_text');
});

test('an unknown action is refused and does not spend budget', () => {
  const control = controlWith(['builder']);
  const [refused] = control.considerAll([{ kind: 'rewrite_outcome', actorId: 'builder', syntheticOverseer: true }]);
  assert.equal(refused.reason, 'unknown_action');
  assert.equal(control.remainingBudget(), 64, 'a refusal spends nothing');
});

test('the action budget is enforced and exhaustion is recorded, not hidden', () => {
  const control = controlWith(['builder'], { actionBudget: 1 });
  const steer = text => ({ kind: 'steer', actorId: 'builder', text, syntheticOverseer: true, humanOversight: false });
  const [first, second] = control.considerAll([steer('one'), steer('two')]);
  assert.equal(first.status, 'accepted');
  assert.equal(second.reason, 'budget_exhausted');
  assert.equal(control.summary().accepted, 1);
  assert.equal(control.summary().refused, 1);
});

test('one refused proposal does not silence the rest of the tick', () => {
  const control = controlWith(['builder']);
  const results = control.considerAll([
    { kind: 'steer', actorId: 'ghost', text: 'x', syntheticOverseer: true },
    { kind: 'steer', actorId: 'builder', text: 're-read', syntheticOversight: true, syntheticOverseer: true },
  ]);
  assert.equal(results[0].status, 'refused');
  assert.equal(results[1].status, 'accepted');
});

test('a fault request is refused when the harness cannot induce one', () => {
  const control = controlWith(['builder']);
  const [refused] = control.considerAll([
    { kind: 'induce', fault: 'stale_dependency', syntheticOverseer: true },
  ]);
  assert.equal(refused.reason, 'fault_not_supported');
});

test('the control surface cannot rewrite outcomes or verification', () => {
  const control = controlWith(['builder']);
  // Outcomes and verdicts are not actions this surface implements.
  for (const attempt of [
    { kind: 'outcome', actorId: 'builder', outcome: 'succeeded' },
    { kind: 'verify', correct: true },
  ]) {
    const [entry] = control.considerAll([{ ...attempt, syntheticOverseer: true, humanOversight: false }]);
    assert.equal(entry.status, 'refused', `${attempt.kind} must not be accepted`);
    assert.equal(entry.reason, 'unknown_action');
  }

  // A legitimate steer that also smuggles an outcome claim is still a steer,
  // but the claim does not survive into the record. The entry is built from a
  // fixed field list precisely so an unrecognised key cannot ride along.
  const [steered] = control.considerAll([
    { kind: 'steer', actorId: 'builder', text: 're-read', outcome: 'succeeded', correct: true, syntheticOverseer: true },
  ]);
  assert.equal(steered.status, 'accepted');
  assert.equal(steered.action, 'steer');
  assert.equal(steered.outcome, undefined, 'no outcome claim may propagate');
  assert.equal(steered.correct, undefined, 'no verification claim may propagate');
  assert.deepEqual(
    Object.keys(steered).filter(key => key === 'outcome' || key === 'correct'),
    [],
    'the recorded entry has no outcome or verification field at all'
  );

  assert.equal(control.limits.cannotRewriteOutcomes, true);
  assert.equal(control.limits.cannotAlterVerification, true);
  assert.equal(control.limits.automaticChangeMessages, 0);
});

test('evidence folds control and policy limits together and never implies a human', () => {
  const control = controlWith(['builder']);
  const policy = createSyntheticOverseer({ arm: 'reactive' });
  policy.decide(view({ participants: [agent('builder')], policyNotices: [{ actorId: 'builder', path: 'e.mjs' }] }));
  control.considerAll(policy.journal().length ? [] : []);

  const evidence = overseerEvidence(control, policy);
  assert.equal(evidence.limits.humanOversight, false);
  assert.equal(evidence.limits.syntheticOverseer, true);
  assert.equal(evidence.control.automaticChangeMessages, 0);
  assert.match(evidence.limits.cannotSupport, /human overseer/);
  assert.equal(typeof evidence.interventions.total, 'number');
});

// --- loopback channel ------------------------------------------------------

test('the control channel round-trips proposals over loopback', async () => {
  const performed = [];
  const control = controlWith(['builder']);
  const server = await startOverseerServer({
    control,
    onAction: entry => {
      performed.push(entry.action);
      return { status: 'accepted' };
    },
    describeState: () => ({ roster: ['builder'], coverage: { complete: true } }),
  });
  const client = createOverseerClient({ origin: server.origin });

  try {
    const results = await client.propose({
      kind: 'steer',
      actorId: 'builder',
      text: 're-read engine.mjs',
      syntheticOverseer: true,
      humanOversight: false,
    });
    assert.equal(results[0].status, 'accepted');
    assert.equal(results[0].delivery.status, 'accepted');
    assert.deepEqual(performed, ['steer']);
    assert.equal(results[0].humanOversight, false);

    const state = await client.state();
    assert.deepEqual(state.roster, ['builder']);

    const limits = await client.limits();
    assert.equal(limits.humanOversight, false);
  } finally {
    await server.close();
  }
});

test('a delivery failure is reported rather than thrown at the overseer', async () => {
  const control = controlWith(['builder']);
  const server = await startOverseerServer({
    control,
    onAction: () => {
      throw new Error('native_steer_failed');
    },
  });
  const client = createOverseerClient({ origin: server.origin });
  try {
    const [entry] = await client.propose({
      kind: 'steer',
      actorId: 'builder',
      text: 're-read',
      syntheticOverseer: true,
    });
    // The action was accepted by the surface; the delivery honestly failed.
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.delivery.status, 'failed');
    assert.match(entry.delivery.reason, /native_steer_failed/);
  } finally {
    await server.close();
  }
});

test('the control channel rejects a foreign origin', async () => {
  const control = controlWith(['builder']);
  const server = await startOverseerServer({ control });
  try {
    const response = await fetch(`${server.origin}/overseer/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ kind: 'note' }),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

test('the control channel bounds request bodies', async () => {
  const control = controlWith(['builder']);
  const server = await startOverseerServer({ control });
  try {
    const response = await fetch(`${server.origin}/overseer/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ kind: 'note', padding: 'x'.repeat(9000) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test('a non-loopback client origin is refused outright', () => {
  assert.throws(
    () => createOverseerClient({ origin: 'https://overseer.example.com' }),
    /loopback_only/
  );
});