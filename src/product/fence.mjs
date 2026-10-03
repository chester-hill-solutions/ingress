/**
 * The write fence.
 *
 * Git models artifacts, never intent. When your change collides, git says
 * CONFLICT and stops — it cannot tell you *why*, or whether the other side
 * touched your intent or something adjacent.
 *
 * This is the layer above that: a participant declares what it depends on, the
 * workspace tracks what moved, and a write is admitted only if the participant's
 * understanding is still current. The refusal carries the evidence for the
 * refusal, so the answer to "why was my change rejected" is data rather than a
 * shrug.
 *
 * This module is pure. It decides; it does not move bytes, spawn agents, or talk
 * to Cloudflare. That is deliberate — the decision is the part that must be
 * correct, and correctness is testable without an account.
 */

/** Terminal states cannot receive new instructions or writes. */
const TERMINAL = new Set(['stopped', 'interrupted', 'completed', 'failed']);

/** Cap the work a single decision may do, so a large workspace cannot stall it. */
const MAX_FILES = 512;
const MAX_DEPENDENCIES = 64;
const MAX_PATH_BYTES = 512;

export class FenceRefusal extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = 'FenceRefusal';
    this.reason = reason;
    Object.assign(this, detail);
  }
}

export function validatePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    /[^\x20-\x7e]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new FenceRefusal('invalid_path', { path: value ?? null });
  }
  return value;
}

const declaredPath = validatePath;

/**
 * A stable, compact fingerprint of an evidence cut.
 *
 * Synchronous and dependency-free because `admit` must be a single decision in
 * one turn of the isolate — it cannot await, or two concurrent writes could both
 * decide against evidence the other had already invalidated. So this is a
 * canonical string form rather than a hash: still a fingerprint in the sense
 * that matters, which is that a reader can see exactly which facts were relied
 * on, and compare two receipts without re-deriving anything.
 *
 * If this ever needs to be an actual digest, the ledger has to move into an
 * async path first. Do not quietly add a hash here.
 */
function fingerprintOf({ epoch, participantId, kind, reads }) {
  const facts = reads
    .map(read => `${read.path}:${read.readRevision ?? '-'}>${read.currentRevision ?? '-'}`)
    .join('|');
  return `${epoch.slice(0, 8)}/${participantId}/${kind}@${facts}`;
}

/**
 * The workspace's knowledge, as a plain value object.
 *
 * Deliberately plain: this is the state a Durable Object holds, and the state a
 * test constructs by hand. No classes, no methods, no hidden invariants.
 */
export class WorkspaceLedger {
  constructor({ epoch, participants = [], files = [], intents = [] } = {}) {
    if (typeof epoch !== 'string' || !epoch) throw new FenceRefusal('invalid_epoch', {});
    this.epoch = epoch;
    /** @type {Map<string, object>} participantId -> participant */
    this.participants = new Map();
    /** @type {Map<string, object>} path -> { revision, contentHash } */
    this.files = new Map();
    /** @type {Map<string, object>} `${participantId}:${path}` -> read record */
    this.reads = new Map();
    this.intents = new Map();
    this.receipts = [];

    for (const participant of participants) this.register(participant);
    for (const file of files) this.recordWrite({ path: file.path, ...file, actorId: null, synthetic: true });
    for (const intent of intents) this.setIntent(intent.participantId, intent.text);
  }

  register({ participantId, kind = 'agent', dependencies = [], displayName }) {
    if (typeof participantId !== 'string' || !participantId) throw new FenceRefusal('invalid_participant', {});
    if (kind !== 'agent' && kind !== 'human') throw new FenceRefusal('invalid_participant_kind', { participantId });
    if (!Array.isArray(dependencies) || dependencies.length > MAX_DEPENDENCIES) {
      throw new FenceRefusal('too_many_dependencies', { participantId });
    }
    const prior = this.participants.get(participantId);
    if (prior) return prior;
    const participant = {
      participantId,
      kind,
      displayName: typeof displayName === 'string' ? displayName.slice(0, 128) : participantId,
      dependencies: new Set(dependencies.map(declaredPath)),
      status: 'active',
      joinedAtSequence: this.receipts.length,
    };
    this.participants.set(participantId, participant);
    return participant;
  }

  /**
   * Record that a path was written, and who wrote it.
   *
   * This is the only way the workspace learns that bytes moved. In a deployed
   * system it is fed by the container's snapshot diff; in tests it is called
   * directly. The distinction is recorded, because an unattributed write is a
   * real limitation and must not be presented as if it were not.
   */
  recordWrite({ path, revision, actorId = null, contentHash = null, synthetic = false }) {
    path = declaredPath(path);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new FenceRefusal('invalid_revision', { path });
    if (this.files.size >= MAX_FILES && !this.files.has(path)) {
      throw new FenceRefusal('workspace_file_cap', { path });
    }
    const prior = this.files.get(path);
    const record = {
      path,
      revision,
      contentHash,
      author: actorId,
      attribution: actorId ? 'observed' : 'unknown',
      synthetic,
      writtenAtSequence: this.receipts.length,
    };
    this.files.set(path, record);
    return record;
  }

  /** Record that a participant read a path at its current revision. */
  recordRead({ participantId, path }) {
    const participant = this.require(participantId);
    path = declaredPath(path);
    const file = this.files.get(path);
    this.reads.set(`${participant.participantId}:${path}`, {
      participantId: participant.participantId,
      path,
      revision: file?.revision ?? null,
      contentHash: file?.contentHash ?? null,
      atSequence: this.receipts.length,
    });
  }

  setIntent(participantId, text) {
    const participant = this.require(participantId);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024) {
      throw new FenceRefusal('invalid_intent', { participantId });
    }
    const intent = {
      participantId: participant.participantId,
      text,
      revision: (this.intents.get(participant.participantId)?.revision ?? 0) + 1,
    };
    this.intents.set(participant.participantId, intent);
    return intent;
  }

  require(participantId) {
    const participant = this.participants.get(participantId);
    if (!participant) throw new FenceRefusal('unknown_participant', { participantId });
    return participant;
  }

  isTerminal(participantId) {
    return TERMINAL.has(this.require(participantId).status);
  }

  /**
   * The evidence cut for one participant: what it declared it depends on, what it
   * has actually read, and the current state of both.
   *
   * This is what makes a refusal falsifiable. A refusal cites a cut; anyone can
   * recompute it from the ledger and check the claim.
   */
  decisionCut(participantId) {
    const participant = this.require(participantId);
    const dependencies = [...participant.dependencies].sort();
    const reads = dependencies.map(path => {
      const read = this.reads.get(`${participantId}:${path}`) ?? null;
      const file = this.files.get(path) ?? null;
      return {
        path,
        readRevision: read?.revision ?? null,
        readContentHash: read?.contentHash ?? null,
        currentRevision: file?.revision ?? null,
        currentContentHash: file?.contentHash ?? null,
        author: file?.author ?? null,
        // 'verified' means we have a read record with a hash. 'unknown' means we
        // never saw them read it. We never claim more than we have.
        readBasis: read?.revision == null ? 'unknown' : 'verified',
        stale: read == null ? null : file != null && read.revision < file.revision,
      };
    });
    const cut = { epoch: this.epoch, participantId, kind: participant.kind, reads };
    return { ...cut, fingerprint: fingerprintOf(cut) };
  }

  /**
   * Decide whether a write may proceed.
   *
   * Returns a receipt either way. A refusal is a first-class outcome with its
   * own evidence, not an exception thrown at the caller: the participant needs
   * to know what changed so it can adapt, and a bare rejection teaches it
   * nothing.
   */
  admit({ participantId, path, baseRevision = null, contentHash = null }) {
    path = declaredPath(path);
    const participant = this.require(participantId);
    const sequence = this.receipts.length;

    const refuse = (reason, detail) => {
      const receipt = {
        sequence,
        admitted: false,
        reason,
        participantId,
        kind: participant.kind,
        path,
        fingerprint: this.decisionCut(participantId).fingerprint,
        ...detail,
      };
      this.receipts.push(receipt);
      return receipt;
    };

    if (TERMINAL.has(participant.status)) {
      return refuse('participant_settled', { status: participant.status });
    }

    // The write must be based on the current content of the file being written.
    const target = this.files.get(path) ?? null;
    if (baseRevision != null) {
      if (target == null || target.revision !== baseRevision) {
        return refuse('write_base_stale', {
          claimedRevision: baseRevision,
          currentRevision: target?.revision ?? null,
          author: target?.author ?? null,
        });
      }
    }

    // The write must not rest on a dependency that has moved since it was read.
    const cut = this.decisionCut(participantId);
    const stale = cut.reads.filter(entry => entry.stale === true);
    if (stale.length > 0) {
      return refuse('dependency_moved', {
        staleDependencies: stale.map(entry => ({
          path: entry.path,
          readRevision: entry.readRevision,
          currentRevision: entry.currentRevision,
          author: entry.author,
        })),
        basis: cut.reads.map(entry => ({
          path: entry.path,
          readBasis: entry.readBasis,
        })),
      });
    }

    // Never claim a write was checked against dependencies nobody declared.
    const unverified = cut.reads.filter(entry => entry.readBasis === 'unknown');
    if (unverified.length > 0) {
      return refuse('dependency_read_unknown', {
        unknownDependencies: unverified.map(entry => entry.path),
      });
    }

    const nextRevision = (target?.revision ?? 0) + 1;
    const receipt = {
      sequence,
      admitted: true,
      reason: 'write_admitted',
      participantId,
      kind: participant.kind,
      path,
      baseRevision: baseRevision ?? target?.revision ?? null,
      nextRevision,
      contentHash,
      fingerprint: cut.fingerprint,
    };
    this.receipts.push(receipt);
    this.recordWrite({ path, revision: nextRevision, actorId: participantId, contentHash });
    return receipt;
  }

  /** The envelope a participant receives when it arrives. */
  joinEnvelope(participantId) {
    const participant = this.require(participantId);
    const cut = this.decisionCut(participantId);
    const others = [...this.participants.values()]
      .filter(other => other.participantId !== participantId)
      .map(other => ({
        participantId: other.participantId,
        kind: other.kind,
        displayName: other.displayName,
        status: other.status,
        intent: this.intents.get(other.participantId)?.text ?? null,
      }));
    const sharedPaths = [...new Set(participant.dependencies)].sort();
    return {
      epoch: this.epoch,
      you: { participantId, kind: participant.kind, dependencies: sharedPaths },
      participants: others,
      intent: this.intents.get(participantId)?.text ?? null,
      // Honest about what we know. A path nobody declared is not "available".
      dependencies: sharedPaths.map(path => {
        const file = this.files.get(path) ?? null;
        const read = this.reads.get(`${participantId}:${path}`) ?? null;
        return {
          path,
          revision: file?.revision ?? null,
          contentHash: file?.contentHash ?? null,
          author: file?.author ?? null,
          attribution: file?.attribution ?? 'unknown',
          yourReadRevision: read?.revision ?? null,
          stale: read != null && file != null && read.revision < file.revision,
        };
      }),
      fingerprint: cut.fingerprint,
    };
  }

  receiptsFor(participantId) {
    return this.receipts.filter(receipt => receipt.participantId === participantId);
  }

  /**
   * Serialized form.
   *
   * `admit` is the only method that mutates, and it is self-contained: it reads
   * state, decides, records a receipt, and updates one file revision. That is
   * what makes a round trip through storage safe, and why a Durable Object
   * holding this is a genuine serialization point rather than a cache.
   */
  toJSON() {
    return {
      epoch: this.epoch,
      participants: [...this.participants.values()].map(participant => ({
        ...participant,
        dependencies: [...participant.dependencies],
      })),
      files: [...this.files.values()].map(file => ({ ...file })),
      reads: [...this.reads.values()].map(read => ({ ...read })),
      intents: [...this.intents.values()].map(intent => ({ ...intent })),
      receipts: this.receipts.map(receipt => ({ ...receipt })),
    };
  }

  static fromJSON(value) {
    if (!value || typeof value !== 'object' || typeof value.epoch !== 'string') return null;
    const ledger = Object.create(WorkspaceLedger.prototype);
    ledger.epoch = value.epoch;
    ledger.participants = new Map((value.participants ?? []).map(p => [p.participantId, { ...p, dependencies: new Set(p.dependencies) }]));
    ledger.files = new Map((value.files ?? []).map(f => [f.path, { ...f }]));
    ledger.reads = new Map((value.reads ?? []).map(r => [`${r.participantId}:${r.path}`, { ...r }]));
    ledger.intents = new Map((value.intents ?? []).map(i => [i.participantId, { ...i }]));
    ledger.receipts = (value.receipts ?? []).map(r => ({ ...r }));
    return ledger;
  }

  snapshot() {
    return {
      epoch: this.epoch,
      participants: [...this.participants.values()].map(p => ({ ...p, dependencies: [...p.dependencies] })),
      files: [...this.files.values()].map(f => ({ ...f })),
      receipts: this.receipts.length,
    };
  }
}