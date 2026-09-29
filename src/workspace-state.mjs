import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const terminals = new Set(['stopped', 'interrupted', 'completed', 'failed']);
const nativeSources = new Set(['native', 'opencode', 'room', 'control']);
export function declaredPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid declared relative file path');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error('invalid identity');
  return value;
}
function boundedText(value, limit = 1024) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('invalid bounded text');
  return value;
}
function dependencies(values) {
  if (!Array.isArray(values) || values.length > 64) throw new Error('too many dependencies');
  return values.map(value => typeof value === 'string' ? { producerPath: declaredPath(value), consumerPath: null } : { producerPath: declaredPath(value.producerPath), consumerPath: value.consumerPath ? declaredPath(value.consumerPath) : null });
}

/** Current observer state only: no filesystem write admission or guarded read claims. */
export class WorkspaceState {
  constructor({ epoch }) {
    this.epoch = id(epoch);
    this.agents = new Map();
    this.files = new Map();
    this.members = new Map();
    this.sources = new Map();
    this.seen = new Set();
    this.version = 0;
    this.liveSequence = 0;
  }

  register({ id: participantID, task, sessionID, generation, dependencies: deps = [] }) {
    id(participantID); id(sessionID);
    if (!(Number.isSafeInteger(generation) && generation >= 0) && typeof generation !== 'string') throw new Error('invalid generation');
    const prior = this.agents.get(participantID);
    if (!prior && this.agents.size >= 64) throw new Error('participant cap exceeded');
    if (prior && typeof generation === 'number' && typeof prior.generation === 'number' && generation < prior.generation) throw new Error('old generation registration');
    const normalizedTask = typeof task === 'string' ? { id: participantID, revision: 1, text: boundedText(task, 4096) } : { id: id(task.id), revision: task.revision ?? 1, text: boundedText(task.text ?? '', 4096) };
    if (!Number.isSafeInteger(normalizedTask.revision) || normalizedTask.revision < 1) throw new Error('invalid task revision');
    if (prior && prior.sessionID === sessionID && prior.generation === generation) {
      if (normalizedTask.revision < prior.task.revision) throw new Error('old task revision');
      if (normalizedTask.revision === prior.task.revision && JSON.stringify(normalizedTask) !== JSON.stringify(prior.task)) throw new Error('task payload changed without revision');
      prior.task = normalizedTask;
      prior.dependencies = dependencies(deps);
      this.version++;
      return clone(prior);
    }
    if (prior) for (const joined of this.members.values()) joined.delete(participantID);
    const agent = { id: participantID, task: normalizedTask, sessionID, generation, status: 'idle', instructionRevision: 0, deliveredInstructionRevision: 0, instructionCommandID: null, intentionRevision: (prior?.intentionRevision ?? 0) + 1, intention: null, dependencies: dependencies(deps), lastLocation: null, reads: [] };
    this.agents.set(participantID, agent);
    this.version++;
    return clone(agent);
  }

  _agent(participantID) {
    const agent = this.agents.get(participantID);
    if (!agent) throw new Error('unknown participant');
    return agent;
  }

  setIntention(participantID, text) {
    const agent = this._agent(participantID);
    if (terminals.has(agent.status)) throw new Error('settled execution cannot revive its intention');
    agent.intentionRevision++;
    agent.intention = { text: boundedText(text), revision: agent.intentionRevision, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    this.version++;
    return clone(agent.intention);
  }

  joinFile(participantID, path) {
    const agent = this._agent(participantID);
    path = declaredPath(path);
    if (terminals.has(agent.status)) throw new Error('settled participant cannot join');
    if (!this.members.has(path)) {
      if (this.members.size >= 128) throw new Error('file room cap exceeded');
      this.members.set(path, new Set());
    }
    const members = this.members.get(path);
    const participants = [...members].filter(other => other !== participantID).map(other => this._presence(this.agents.get(other), path));
    const event = { type: 'file.joined', epoch: this.epoch, throughSequence: ++this.liveSequence, path, documentRevision: this.files.get(path)?.revision ?? null, participants, self: this._presence(agent, path), coverage: this._coverage() };
    members.add(participantID);
    this.version++;
    return clone(event);
  }

  _presence(agent, path) {
    const current = agent.intention && Date.parse(agent.intention.expiresAt) > Date.now() && !terminals.has(agent.status);
    const location = agent.lastLocation?.path === path ? agent.lastLocation : null;
    const stale = !!location && (terminals.has(agent.status) || location.revision !== this.files.get(path)?.revision);
    return { id: agent.id, participantID: agent.id, sessionID: agent.sessionID, generation: agent.generation, status: agent.status, task: clone(agent.task), intention: current ? clone(agent.intention) : null, lastLocation: location ? { ...clone(location), stale } : null };
  }

  ingest(observation) {
    if (!observation || JSON.stringify(observation).length > 16 * 1024) throw new Error('observation exceeds bounded metadata size');
    if (observation.epoch !== this.epoch) return { accepted: false, reason: 'stale_epoch' };
    id(observation.id); id(observation.source);
    const agent = observation.participantID ? this.agents.get(observation.participantID) : null;
    if (observation.participantID && (!agent || observation.sessionID !== agent.sessionID || observation.generation !== agent.generation)) return { accepted: false, reason: 'stale_execution' };
    const key = `${observation.source}:${observation.participantID ?? 'workspace'}:${observation.sessionID ?? '-'}:${observation.generation ?? '-'}`;
    const eventID = `${key}:${observation.id}`;
    if (this.seen.has(eventID)) return { accepted: false, reason: 'duplicate' };
    if (!this.sources.has(key) && this.sources.size >= 128) throw new Error('source stream cap exceeded');
    const previous = this.sources.get(key) ?? { source: observation.source, lastSequence: null, complete: true, historicalComplete: null, scope: 'current_observed_state', reason: null };
    const sequenced = Number.isSafeInteger(observation.sourceSeq) && observation.sourceSeq >= 0;
    if (sequenced && previous.lastSequence !== null && observation.sourceSeq <= previous.lastSequence) return { accepted: false, reason: 'reordered' };
    const source = { ...previous };
    if (!sequenced) { source.complete = false; source.reason = 'source sequence unavailable'; }
    else {
      if (source.lastSequence !== null && observation.sourceSeq > source.lastSequence + 1) { source.complete = false; source.historicalComplete = false; source.reason = 'source sequence gap'; }
      source.lastSequence = observation.sourceSeq;
    }
    const data = observation.data ?? {};
    const native = nativeSources.has(observation.source);
    switch (observation.type) {
      case 'file.observed': {
        if (observation.source !== 'file-watcher' && observation.source !== 'file-observer') return { accepted: false, reason: 'non_content_source' };
        const path = declaredPath(data.path);
        if (data.hash !== null && !/^[a-f0-9]{64}$/.test(data.hash ?? '')) throw new Error('invalid content hash');
        if (!Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('invalid observed revision');
        const prior = this.files.get(path);
        if (prior && data.revision <= prior.revision) return { accepted: false, reason: 'old_file_revision' };
        if (!prior && this.files.size >= 128) throw new Error('observed file cap exceeded');
        this.files.set(path, { path, hash: data.hash, revision: data.revision, observedAt: observation.time ?? null, attribution: 'unknown', confidence: 'observed', missing: data.hash === null });
        break;
      }
      case 'activity.observed': {
        if (!agent) return { accepted: false, reason: 'unknown_participant' };
        if (terminals.has(agent.status)) return { accepted: false, reason: 'settled_execution' };
        const path = declaredPath(data.path);
        const observed = this.files.get(path);
        if (!native) {
          agent.activityEvidence = { path, kind: boundedText(data.kind ?? 'unknown', 64), location: null, confidence: 'unknown', observedAt: observation.time ?? null, source: observation.source };
          break;
        }
        const verified = native && data.verified === true && /^[a-f0-9]{64}$/.test(data.hash ?? '') && Number.isSafeInteger(data.revision);
        agent.lastLocation = { path, kind: boundedText(data.kind ?? 'unknown', 64), location: native ? clone(data.location ?? null) : null, revision: verified ? data.revision : null, observedAt: observation.time ?? null, confidence: verified ? 'verified' : 'unknown' };
        if (native && data.kind === 'read') {
          const read = { path, hash: verified ? data.hash : (observed?.hash ?? null), revision: verified ? data.revision : (observed?.revision ?? null), observedAt: observation.time ?? null, confidence: verified ? 'verified' : observed ? 'temporal' : 'unknown' };
          agent.reads = [...agent.reads.filter(item => item.path !== path), read].slice(-32);
        }
        break;
      }
      case 'agent.status': {
        if (!agent || !native) return { accepted: false, reason: 'non_lifecycle_source' };
        if (!['idle', 'running', 'steering', 'stopping', ...terminals].includes(data.status)) throw new Error('invalid status');
        if (terminals.has(agent.status) && data.status !== agent.status) return { accepted: false, reason: 'settled_execution' };
        if (agent.status === 'stopping' && !terminals.has(data.status) && data.status !== 'stopping') return { accepted: false, reason: 'stop_regression' };
        agent.status = data.status;
        if (terminals.has(data.status)) { agent.intention = null; agent.intentionRevision++; }
        break;
      }
      case 'coverage.changed':
        if (typeof data.complete !== 'boolean') throw new Error('invalid source coverage');
        source.complete = data.complete;
        if (data.historicalComplete === false) source.historicalComplete = false;
        if (data.scope) source.scope = boundedText(data.scope, 64);
        source.reason = data.complete ? null : boundedText(data.reason ?? 'unknown source gap');
        break;
      case 'control.accepted':
      case 'control.delivered': {
        if (!agent || !native) return { accepted: false, reason: 'non_control_source' };
        id(data.commandID);
        if (!Number.isSafeInteger(data.instructionRevision) || data.instructionRevision <= 0) throw new Error('invalid instruction revision');
        if (observation.type === 'control.accepted') {
          if (data.instructionRevision <= agent.instructionRevision) return { accepted: false, reason: 'old_instruction_revision' };
          agent.instructionRevision = data.instructionRevision;
          agent.instructionCommandID = data.commandID;
        } else {
          if (data.commandID !== agent.instructionCommandID || data.instructionRevision !== agent.instructionRevision || data.instructionRevision <= agent.deliveredInstructionRevision) return { accepted: false, reason: 'stale_control_delivery' };
          agent.deliveredInstructionRevision = data.instructionRevision;
        }
        break;
      }
      default: return { accepted: false, reason: 'unsupported_observation' };
    }
    this.sources.set(key, source);
    this.seen.add(eventID);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    this.version++;
    this.liveSequence++;
    return { accepted: true, evidenceVersion: this.version };
  }

  _coverage() {
    const sources = [...this.sources.values()];
    const incomplete = sources.filter(source => !source.complete);
    return { complete: sources.length > 0 && incomplete.length === 0, scope: 'current_observed_state', historicalComplete: sources.length && sources.every(source => source.historicalComplete === true) ? true : false, reason: !sources.length ? 'no observed sources' : incomplete.map(source => `${source.source}: ${source.reason}`).join('; ') || null, sources: clone(sources) };
  }

  snapshot() {
    return clone({ epoch: this.epoch, evidenceVersion: this.version, participants: [...this.agents.values()], files: [...this.files.values()], rooms: [...this.members].map(([path, members]) => ({ path, participants: [...members] })), coverage: this._coverage() });
  }

  decisionCut(participantID) {
    const agent = this._agent(participantID);
    const relevant = new Set([...agent.dependencies.flatMap(dep => [dep.producerPath, dep.consumerPath].filter(Boolean)), ...agent.reads.map(read => read.path), ...[...this.members].filter(([, members]) => members.has(participantID)).map(([path]) => path)]);
    const cut = { epoch: this.epoch, participantID, task: clone(agent.task), sessionID: agent.sessionID, generation: agent.generation, instructionRevision: agent.instructionRevision, deliveredInstructionRevision: agent.deliveredInstructionRevision, intentionRevision: agent.intentionRevision, intention: clone(agent.intention), status: agent.status, files: [...relevant].sort().map(path => clone(this.files.get(path) ?? { path, hash: null, revision: null, attribution: 'unknown', confidence: 'unknown' })), reads: clone(agent.reads), dependencies: clone(agent.dependencies), coverage: this._coverage() };
    if (cut.intention && Date.parse(cut.intention.expiresAt) <= Date.now()) cut.intention = null;
    const digestBasis = { ...cut, coverage: { complete: cut.coverage.complete, reason: cut.coverage.reason, scope: cut.coverage.scope, historicalComplete: cut.coverage.historicalComplete } };
    const digest = createHash('sha256').update(JSON.stringify(digestBasis)).digest('hex');
    return { ...cut, evidenceVersion: this.version, digest };
  }
}
