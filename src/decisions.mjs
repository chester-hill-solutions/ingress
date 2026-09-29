import { createHash, randomUUID } from 'node:crypto';

const ACTIONS = new Set(['no_action', 'notify', 'refresh_context', 'steer_current_task', 'ask_human']);
const MODES = new Set(['shadow', 'advisory', 'automatic']);
const MAX_CUT_BYTES = 64 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function identity(cut) {
  // Source counters/global reducer versions are explanatory metadata, not a new
  // relevant cause. Validate substantive fields independently of a supplied digest.
  const { evidenceVersion, digest, coverage, ...context } = cut;
  const relevant = { ...context, coverage: { complete: coverage?.complete, reason: coverage?.reason ?? null } };
  return createHash('sha256').update(JSON.stringify(canonical(relevant))).digest('hex');
}

function copyCut(cut) {
  const encoded = JSON.stringify(cut);
  if (!encoded || Buffer.byteLength(encoded) > MAX_CUT_BYTES) throw new RangeError('evidence_cut_limit');
  const copy = JSON.parse(encoded);
  if (!copy.epoch || !copy.participantID || !copy.task?.id || !copy.sessionID || copy.generation == null
      || copy.instructionRevision == null || copy.intentionRevision == null || !copy.digest) {
    throw new TypeError('incomplete_context_token');
  }
  return copy;
}

function decisionValue(value) {
  if (!value || !ACTIONS.has(value.action)) throw new TypeError('unsupported_action');
  const paths = value.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 100 || paths.some(path => typeof path !== 'string' || path.length > 1024)) {
    throw new TypeError('invalid_decision_paths');
  }
  return { action: value.action, paths: [...new Set(paths)], reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : 'unspecified' };
}

/** Observation-based relevance only: a refresh request is not stale-write prevention. */
export function deterministicDecision(cut) {
  if (!cut.coverage?.complete) return { action: 'ask_human', paths: [], reason: 'incomplete_coverage' };
  const dependencies = cut.dependencies ?? [];
  const relevant = dependencies.map(edge => typeof edge === 'string' ? edge : edge.producerPath);
  const files = new Map((cut.files ?? []).map(file => [file.path, file]));
  const reads = new Map((cut.reads ?? []).map(read => [read.path, read]));
  const changed = [];
  const unknown = [];
  for (const path of relevant) {
    const file = files.get(path);
    const read = reads.get(path);
    if (!file?.hash || !read?.hash || read.confidence === 'unknown') unknown.push(path);
    else if (file.hash !== read.hash || file.revision !== read.revision) changed.push(path);
    else if (read.confidence !== 'verified') unknown.push(path);
  }
  if (changed.length) return { action: 'refresh_context', paths: [...new Set(changed)], reason: 'observed_dependency_changed' };
  if (unknown.length) return { action: 'notify', paths: [...new Set(unknown)], reason: 'dependency_read_basis_unknown' };
  return { action: 'no_action', paths: [], reason: 'no_observed_dependency_change' };
}

/** Bounded in-memory RT-0 lane. Receipts are not a durable native control journal. */
export class DecisionLane {
  constructor({ decide = deterministicDecision, actuate, maxConcurrent = 2, timeoutMs = 1_000,
    maxTasks = 100, maxReceipts = 1_000 } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2
        || !Number.isFinite(timeoutMs) || timeoutMs <= 0
        || !Number.isInteger(maxTasks) || maxTasks < 1 || !Number.isInteger(maxReceipts) || maxReceipts < 1) {
      throw new RangeError('invalid_lane_bounds');
    }
    if (typeof decide !== 'function' || (actuate != null && typeof actuate !== 'function')) throw new TypeError('invalid_lane_callback');
    this.decide = decide;
    this.actuate = actuate;
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.maxTasks = maxTasks;
    this.maxReceipts = maxReceipts;
    this.tasks = new Map();
    this.receipts = new Map();
    this.running = 0;
    this.closed = false;
  }

  evaluate(input, { currentCut, mode = 'shadow' } = {}) {
    if (this.closed) return Promise.resolve({ status: 'closed' });
    if (!MODES.has(mode) || typeof currentCut !== 'function') throw new TypeError('invalid_evaluation_options');
    const cut = copyCut(input);
    const token = identity(cut);
    const key = JSON.stringify([cut.epoch, cut.participantID, cut.task.id]);
    const cacheKey = `${key}:${mode}:${token}`;
    const cached = this.receipts.get(cacheKey);
    if (cached) return cached;
    let task = this.tasks.get(key);
    if (!task && this.tasks.size >= this.maxTasks) return Promise.resolve({ status: 'backpressure', reason: 'task_limit' });
    if (!task) {
      task = { active: null, pending: null };
      this.tasks.set(key, task);
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const request = { cut, token, currentCut, mode, key, cacheKey, resolve, settled: false, commandID: randomUUID() };
    if (task.pending) this.finish(task.pending, { status: 'superseded', reason: 'newer_pending_cut' });
    task.pending = request;
    this.receipts.set(cacheKey, promise);
    this.trimReceipts();
    this.pump();
    return promise;
  }

  finish(request, result) {
    if (request.settled) return;
    request.settled = true;
    request.resolve({ commandID: request.commandID, participantID: request.cut.participantID,
      taskID: request.cut.task.id, evidenceDigest: request.cut.digest, semanticDigest: request.token,
      context: { epoch: request.cut.epoch, sessionID: request.cut.sessionID, generation: request.cut.generation,
        taskRevision: request.cut.task.revision, instructionRevision: request.cut.instructionRevision,
        intentionRevision: request.cut.intentionRevision }, mode: request.mode, ...result });
  }

  trimReceipts() {
    // In-flight identities remain deduplicated even if the bounded historical cache fills.
    const protectedKeys = new Set([...this.tasks.values()].flatMap(task => [task.active?.cacheKey, task.pending?.cacheKey]));
    for (const key of this.receipts.keys()) {
      if (this.receipts.size <= this.maxReceipts) break;
      if (!protectedKeys.has(key)) this.receipts.delete(key);
    }
  }

  pump() {
    if (this.closed) return;
    for (const [key, task] of this.tasks) {
      if (this.running >= this.maxConcurrent) break;
      if (task.active || !task.pending) continue;
      const request = task.pending;
      task.pending = null;
      task.active = request;
      this.running++;
      void this.run(request).finally(() => {
        task.active = null;
        this.running--;
        if (!task.pending) this.tasks.delete(key);
        this.trimReceipts();
        this.pump();
      });
    }
  }

  current(request) {
    const now = request.currentCut();
    // State admission is synchronous: an async currentCut would create a steer race.
    if (now?.then) throw new TypeError('currentCut_must_be_synchronous');
    const expiresAt = request.cut.intention?.expiresAt;
    const expiry = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    const settled = ['completed', 'failed', 'interrupted', 'stopped'].includes(now?.status);
    return now != null && !settled && !(Number.isFinite(expiry) && expiry <= Date.now()) && identity(now) === request.token;
  }

  async run(request) {
    const controller = new AbortController();
    request.controller = controller;
    let stage = 'decision';
    const timer = setTimeout(() => {
      controller.abort(new Error('decision_deadline'));
      this.finish(request, { status: stage === 'actuation' ? 'unknown' : 'timeout', reason: `${stage}_deadline` });
    }, this.timeoutMs);
    try {
      if (!this.current(request)) {
        this.finish(request, { status: 'superseded', reason: 'stale_context' });
        return;
      }
      const decision = decisionValue(await this.decide(request.cut, { signal: controller.signal }));
      if (request.settled) return;
      if (!this.current(request)) {
        this.finish(request, { status: 'superseded', reason: 'stale_context', decision });
        return;
      }
      if (request.mode === 'shadow' || decision.action === 'no_action') {
        this.finish(request, { status: request.mode === 'shadow' ? 'shadow-only' : 'no_action', decision });
        return;
      }
      if (request.mode === 'advisory' && decision.action === 'steer_current_task') {
        this.finish(request, { status: 'advisory-only', decision });
        return;
      }
      if (!this.actuate) {
        this.finish(request, { status: 'unavailable', reason: 'actuator_missing', decision });
        return;
      }
      stage = 'actuation';
      // No await between the context check above and invoking the actuator. The caller
      // must enforce task scope/native capability and journal/reconcile this commandID.
      const native = await this.actuate(decision, { cut: request.cut, commandID: request.commandID, signal: controller.signal });
      if (request.settled) return;
      const status = native?.status;
      const allowed = new Set(['accepted', 'delivered', 'settled', 'failed', 'unknown']);
      this.finish(request, { status: allowed.has(status) ? status : 'unknown', decision,
        staleAfterAdmission: !this.current(request), nativeReceiptID: typeof native?.id === 'string' ? native.id.slice(0, 256) : null });
    } catch (error) {
      this.finish(request, { status: stage === 'actuation' ? 'unknown' : 'failed', reason: error instanceof TypeError ? error.message : `${stage}_error` });
    } finally {
      clearTimeout(timer);
      // An uncooperative timed-out callback retains its slot until it actually settles;
      // freeing it on Promise.race would permit unlimited hidden classifier work.
    }
  }

  close() {
    this.closed = true;
    for (const task of this.tasks.values()) {
      if (task.pending) this.finish(task.pending, { status: 'closed' });
      if (task.active) {
        task.active.controller?.abort(new Error('lane_closed'));
        this.finish(task.active, { status: 'closed' });
      }
    }
  }
}
