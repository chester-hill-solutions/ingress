import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { WorkspaceState } from './workspace-state.mjs';
import { OpenCodeClient } from './opencode.mjs';
import { NotificationPolicy } from './squad.mjs';
import { assembleAgentContext, renderAgentContext } from './context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const pathFor = index => `topics/topic-${index}.mjs`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { count: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: sorted.at(-1) ?? null };
}

/** Real observer/adapter/compiler/policy code with deterministic actors, not models. */
export async function runScale({ participants = 32, eventCount = 2_000, batchSize = 100 } = {}) {
  if (!Number.isSafeInteger(participants) || participants < 8 || participants > 32
      || !Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > 10_000
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new RangeError('invalid_scale_bounds');
  const started = performance.now();
  const state = new WorkspaceState({ epoch: 'deterministic-scale-epoch' });
  const actors = [], reverseIndex = new Map(), policies = [], changedAt = new Map();
  const dispatchTimes = [], compileTimes = [], updateToContextTimes = [], joinTimes = [];
  const activeCount = participants - 4;
  let fileSeq = 0, routeAttempts = 0, contexts = 0, bytesTotal = 0, maxBytes = 0, maxPending = 0, maxDirtyPaths = 0;
  const fileEvent = (path, revision, label = '') => ({ id: `file-${++fileSeq}`, epoch: state.epoch,
    source: 'file-watcher', sourceSeq: fileSeq, type: 'file.observed', time: new Date().toISOString(),
    data: { path, hash: hash(`${path}:${revision}:${label}`), revision } });
  for (let index = 0; index < participants; index++) state.ingest(fileEvent(pathFor(index), 1));
  const firstJoins = [];
  for (let index = 0; index < participants; index++) {
    const id = `actor-${index}`, sessionID = `session-${index}`;
    const dependencies = index < activeCount ? [index, (index + 1) % activeCount].map(producer => ({ producerPath: pathFor(producer), consumerPath: pathFor(index) })) : [];
    state.register({ id, sessionID, generation: 1, task: { id: `task-${index}`, revision: 1,
      text: `Inspect the assigned topic ${index}; preserve the existing outcome and declared dependency contracts.` }, dependencies });
    state.setIntention(id, `Assigned deterministic topic ${index}`);
    state.ingest({ id: `running-${index}`, epoch: state.epoch, source: 'native', sourceSeq: 1,
      participantID: id, sessionID, generation: 1, type: 'agent.status', data: { status: 'running' } });
    state.ingest({ id: `cursor-${index}`, epoch: state.epoch, source: 'native', sourceSeq: 2,
      participantID: id, sessionID, generation: 1, type: 'activity.observed',
      data: { path: pathFor(0), kind: 'cursor', location: { line: index + 1, column: 0 } } });
    const joinStart = performance.now();
    const join = state.joinFile(id, pathFor(0));
    joinTimes.push(performance.now() - joinStart);
    firstJoins.push({ id, priorParticipants: join.participants.length, selfExcluded: join.participants.every(peer => peer.id !== id),
      positionsPreserved: join.participants.every(peer => peer.lastLocation?.location?.line === Number(peer.id.split('-')[1]) + 1) });
    if (index) state.joinFile(id, pathFor(index));
    const actor = { id, sessionID, dependencies, join, contexts: 0, latest: [], first: [], policies: null };
    actors.push(actor);
    for (const edge of dependencies) {
      if (!reverseIndex.has(edge.producerPath)) reverseIndex.set(edge.producerPath, new Set());
      reverseIndex.get(edge.producerPath).add(actor);
    }
  }

  // Use the actual v2 normalizer, SSE decoder and tool correlation with mock network
  // bytes. These are generated metadata frames; no provider or native process runs.
  const decodeStarted = performance.now();
  let decoded = 0, correlatedReads = 0;
  for (let index = 0; index < actors.length; index++) {
    const actor = actors[index], toolID = `tool-${index}`;
    const native = (seq, type, data) => ({ id: `evt_scale_${index}_${seq}`, type, created: 1_000 + seq,
      durable: { seq, version: 1, aggregateID: actor.sessionID }, data: { sessionID: actor.sessionID, ...data } });
    const frames = [native(0, 'session.tool.input.started', { id: toolID, name: 'read' }),
      native(1, 'session.tool.called', { id: toolID, input: { path: pathFor(index), offset: index, limit: 3 } }),
      native(2, 'session.tool.success', { id: toolID })].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const encoded = new TextEncoder().encode(frames);
    const client = new OpenCodeClient({ endpoint: 'http://127.0.0.1:1', password: 'synthetic-fixture-only',
      directory: '/deterministic-scale', model: { providerID: 'fixture', id: 'no-model' },
      fetchImpl: async () => new Response(new ReadableStream({ start(stream) {
        // Split frames across chunk boundaries to exercise actual stream decoding.
        stream.enqueue(encoded.subarray(0, 37)); stream.enqueue(encoded.subarray(37)); stream.close();
      } }), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      for await (const event of client.events(actor.sessionID, { transport: 'live' })) {
        decoded++;
        const read = event.type === 'session.tool.success' && event.data.toolName === 'read';
        if (read) correlatedReads++;
        state.ingest({ id: event.id, source: 'opencode', sourceSeq: event.seq, epoch: state.epoch,
          participantID: actor.id, sessionID: actor.sessionID, generation: 1,
          type: read ? 'activity.observed' : 'coverage.changed', time: event.time,
          data: read ? { path: event.data.input.path, kind: 'read', location: { offset: event.data.input.offset, limit: event.data.input.limit } }
            : { complete: true, historicalComplete: false, reason: null } });
      }
    } finally { client.close(); }
  }
  const decodeMs = performance.now() - decodeStarted;
  const suppressions = {};
  const sampleBounds = () => {
    for (const policy of policies) { maxPending = Math.max(maxPending, policy.pendingID ? 1 : 0); maxDirtyPaths = Math.max(maxDirtyPaths, policy.dirty.size); }
  };
  for (const actor of actors) {
    const policy = new NotificationPolicy({ cut: () => state.decisionCut(actor.id), affinityFiles: [pathFor(Number(actor.id.split('-')[1]))],
      active: () => true, quietMs: 0, maxNotices: 3,
      onSuppression: event => { suppressions[event.reason] = (suppressions[event.reason] ?? 0) + 1; },
      deliver: async ({ id, paths }) => {
        const compileStart = performance.now();
        const context = assembleAgentContext({ state, participantID: actor.id, join: actor.join,
          cause: { id, type: 'workspace.changed', path: paths[0], paths, revision: state.files.get(paths[0])?.revision ?? null } });
        const rendered = renderAgentContext(context);
        const size = Buffer.byteLength(rendered);
        if (size > 32 * 1024) throw new Error('scale_context_bound');
        const finished = performance.now();
        compileTimes.push(finished - compileStart);
        const times = paths.map(path => changedAt.get(path)).filter(Number.isFinite);
        if (times.length) updateToContextTimes.push(finished - Math.min(...times));
        contexts++; actor.contexts++; bytesTotal += size; maxBytes = Math.max(maxBytes, size);
        actor.latest = paths.map(path => ({ path, revision: state.files.get(path).revision }));
        if (!actor.first.length) actor.first = structuredClone(actor.latest);
        sampleBounds();
      } });
    actor.policy = policy; policies.push(policy);
  }
  async function flushReady() {
    const deadline = performance.now() + 2_000;
    while (policies.some(policy => policy.sending || (!policy.pendingID && policy.dirty.size))) {
      if (performance.now() > deadline) throw new Error('scale_policy_flush_deadline');
      await wait(2);
    }
    sampleBounds();
  }
  try {
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
      const path = pathFor(eventIndex % activeCount);
      const start = performance.now();
      changedAt.set(path, start);
      const event = fileEvent(path, state.files.get(path).revision + 1);
      const admitted = state.ingest(event);
      if (!admitted.accepted) throw new Error('scale_change_not_admitted');
      // One prebuilt reverse index: never inspect all participant cuts per change.
      for (const actor of reverseIndex.get(path) ?? []) { actor.policy.observe(path); routeAttempts++; }
      dispatchTimes.push(performance.now() - start);
      sampleBounds();
      if ((eventIndex + 1) % batchSize === 0) await flushReady();
    }
    await flushReady();
    const pendingBeforeAck = policies.filter(policy => policy.pendingID).length;
    const dirtyBeforeAck = policies.filter(policy => policy.dirty.size).length;
    const pendingIdentities = policies.map(policy => policy.pendingID);
    const dirtyIdentities = policies.map(policy => [...policy.dirty].sort().join(','));
    const stalePendingAckPreserved = policies.every((policy, index) =>
      policy.delivered('obsolete-native-input') === false && policy.pendingID === pendingIdentities[index]);
    for (const actor of actors) for (const edge of actor.dependencies) actor.policy.observe(edge.producerPath);
    const duplicatePolicyPreserved = policies.every((policy, index) =>
      policy.pendingID === pendingIdentities[index] && [...policy.dirty].sort().join(',') === dirtyIdentities[index]);
    for (const policy of policies) if (policy.pendingID) policy.delivered(policy.pendingID);
    await flushReady();
    const recipients = actors.map(actor => ({ id: actor.id, dependencies: actor.dependencies.map(edge => edge.producerPath), contexts: actor.contexts,
      pending: actor.policy.pendingID != null, firstRevisions: actor.first, latestRevisions: actor.latest }));
    const finalRevisions = Object.fromEntries([...state.files.values()].map(file => [file.path, file.revision]));
    const latestCoalesced = recipients.every(actor => actor.latestRevisions.every(file => file.revision === finalRevisions[file.path]));
    const reads = state.snapshot().participants.flatMap(actor => actor.reads);

    // Verify rejection/uncertainty on the actual reducer after the measured workload.
    const gap = fileEvent(pathFor(0), state.files.get(pathFor(0)).revision + 1, 'gap');
    gap.sourceSeq++; fileSeq++;
    state.ingest(gap);
    const afterGap = JSON.stringify(state.snapshot());
    const duplicate = state.ingest(gap);
    const reordered = state.ingest({ ...gap, id: 'reordered-gap', sourceSeq: gap.sourceSeq - 1, data: { ...gap.data, revision: gap.data.revision - 1 } });
    const preserved = JSON.stringify(state.snapshot()) === afterGap;
    const staleEpoch = state.ingest({ ...gap, id: 'old-epoch', epoch: 'retired-epoch' });
    const actor = actors[0];
    const control = (seq, type, commandID, instructionRevision, generation = 1) => ({ id: `control-${seq}`, epoch: state.epoch,
      source: 'control', sourceSeq: seq, participantID: actor.id, sessionID: actor.sessionID, generation, type, data: { commandID, instructionRevision } });
    state.ingest(control(1, 'control.accepted', 'human-new-direction', 2));
    const staleControl = state.ingest(control(2, 'control.accepted', 'old-direction', 1));
    const staleDelivery = state.ingest(control(2, 'control.delivered', 'old-direction', 1));
    const staleGeneration = state.ingest(control(2, 'control.accepted', 'old-generation', 3, 0));
    const agent = state.agents.get(actor.id);
    return { kind: 'deterministic-scale-apparatus', participantCount: participants, fileCount: participants, events: eventCount,
      environment: { node: process.version, platform: process.platform, arch: process.arch,
        cpu: cpus()[0]?.model ?? 'unknown', logicalCPUs: cpus().length },
      elapsed_ms: performance.now() - started,
      dispatch_latency: { scope: 'change-hash-and-ingest-through-indexed-policy-routing; excludes model/context compilation', ...stats(dispatchTimes) },
      presence_latency: { scope: 'first file.joined snapshot; excludes model/context compilation', ...stats(joinTimes) },
      context_compile_latency: stats(compileTimes),
      update_to_context_latency: { basis: 'oldest latest-path observation in emitted coalesced bundle; synthetic delivery with quietMs=0', ...stats(updateToContextTimes) },
      context_size: { limit_bytes: 32 * 1024, total_bytes: bytesTotal, max_bytes: maxBytes, bounded: maxBytes <= 32 * 1024 },
      routing: { indexEntries: reverseIndex.size, dependencyEdges: actors.flatMap(actor => actor.dependencies).length,
        recipientAttempts: routeAttempts, recipients: recipients.filter(actor => actor.contexts).length, contexts,
        amplification: contexts / eventCount, unrelatedParticipants: recipients.filter(actor => !actor.dependencies.length).length,
        unrelatedContexts: recipients.filter(actor => !actor.dependencies.length).reduce((sum, actor) => sum + actor.contexts, 0) },
      coalescing: { peak_pending_per_actor: maxPending, peak_dirty_paths_per_actor: maxDirtyPaths,
        pending_before_ack: pendingBeforeAck, dirty_before_ack: dirtyBeforeAck, latest_revisions_preserved: latestCoalesced },
      native_sse: { mock: true, sessions: participants, frames: decoded, correlatedReads, decode_and_ingest_ms: decodeMs },
      read_bases: { unverified: reads.filter(read => read.confidence !== 'verified').length,
        unknown: reads.filter(read => read.confidence === 'unknown').length,
        temporal: reads.filter(read => read.confidence === 'temporal').length,
        verified: reads.filter(read => read.confidence === 'verified').length },
      first_joins: firstJoins, recipients, finalRevisions, suppressions,
      adverse_checks: { gap_marks_incomplete: !state.snapshot().coverage.complete, duplicate_rejected: duplicate.reason === 'duplicate',
        stale_pending_ack_preserved: stalePendingAckPreserved, duplicate_policy_revision_preserved: duplicatePolicyPreserved,
        reordered_rejected: reordered.reason === 'reordered', content_state_not_regressed: preserved,
        old_epoch_rejected: staleEpoch.reason === 'stale_epoch', old_instruction_rejected: staleControl.reason === 'old_instruction_revision',
        old_delivery_rejected: staleDelivery.reason === 'stale_control_delivery', old_generation_rejected: staleGeneration.reason === 'stale_execution',
        human_direction_preserved: agent.instructionRevision === 2 && agent.instructionCommandID === 'human-new-direction' && agent.deliveredInstructionRevision === 0 },
      limits: { simulatedParticipants: true, liveModelBuilders: 0, modelCalls: 0, productBenefitEstablished: false,
        nativeWritesFenced: false, filesystemWatchTimingMeasured: false, controlDeliveryVerified: false,
        notificationQuietMs: 0, maxNoticesPerActor: 3, productionQuietMs: 2_000,
        supportedTopology: 'two declared producers per relevant participant; four unrelated participants; synthetic native read metadata' } };
  } finally { for (const policy of policies) policy.close(); }
}
