/** EXPERIMENT: scope arbitration, not a deployed route or native filesystem sandbox. */
import { randomUUID } from 'node:crypto';
import { validatePath } from '../../product/fence.mjs';
import { mergeText } from '../../product/merge.mjs';
import { covered, changes, intersects, lines, touches } from './regions.mjs';
import { createCatalog, dependencyScope, hashText } from './impact.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_GRANTS = 32;
const MAX_LEASE_MS = 15 * 60_000;
const copy = value => structuredClone(value);
const refusal = (reason, detail = {}) => ({ granted: false, admitted: false, reason, ...detail });
const samePaths = (a, b) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(path => Object.hasOwn(b, path));
const sameTree = (a, b) => samePaths(a, b)
  && Object.entries(a).every(([path, text]) => b[path] === text);

function scopeConflicts(writes, reads, held) {
  const conflicts = [];
  for (const [wanted, owned, kind] of [
    [writes, held.writes, 'modification_overlap'],
    [writes, held.reads, 'dependency_protected'],
    [reads, held.writes, 'dependency_under_modification'],
  ]) for (const a of wanted) for (const b of owned) {
    if (a.path !== b.path) continue;
    if (a.fileHash !== b.fileHash || intersects(a, b)) conflicts.push({
      checkoutId: held.checkoutId, participantId: held.participantId, path: a.path,
      reason: a.fileHash !== b.fileHash ? 'coordinate_basis_moved' : kind,
      requested: { startLine: a.start + 1, endLine: a.end },
      held: { startLine: b.start + 1, endLine: b.end },
    });
  }
  return conflicts;
}

export class CheckoutArbiter {
  #files; #catalog; #grants = new Map(); #revision = 1;

  constructor({ files, blocks, edges = [] }) {
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 64) {
      throw new TypeError('invalid_prototype_tree');
    }
    let size = 0;
    for (const [path, text] of Object.entries(files)) {
      validatePath(path); lines(text); size += Buffer.byteLength(text);
    }
    if (size > MAX_BYTES) throw new RangeError('prototype_byte_limit');
    this.#files = copy(files);
    this.#catalog = createCatalog(files, blocks, edges);
  }

  get catalog() { return copy(this.#catalog); }

  #live(checkoutId, participantId, now) {
    this.#sweep(now);
    const grant = this.#grants.get(checkoutId);
    if (!grant || grant.participantId !== participantId) return null;
    return grant;
  }

  #sweep(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('invalid_clock');
    for (const [id, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(id);
  }

  checkout({ participantId, writes, intent = '', candidates = [], candidatePolicy = 'suggest', leaseMs = 60_000 }, now = Date.now()) {
    this.#sweep(now);
    if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > 128
      || !Array.isArray(writes) || !writes.length || writes.length > 256
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS
      || !['suggest', 'protect'].includes(candidatePolicy) || typeof intent !== 'string'
      || intent.length > 8192 || !Array.isArray(candidates) || candidates.length > 256) {
      return refusal('invalid_checkout');
    }
    if (this.#grants.size >= MAX_GRANTS) return refusal('checkout_capacity');
    const writeScopes = [];
    for (const write of writes) {
      if (!write || typeof write !== 'object') return refusal('invalid_modification_scope');
      const block = this.#catalog.blocks.get(write.blockId);
      if (!block) return refusal('unknown_block', { blockId: write.blockId });
      if (hashText(this.#files[block.path]) !== block.fileHash) return refusal('catalog_stale', { path: block.path });
      const startLine = write.startLine ?? block.startLine, endLine = write.endLine ?? block.endLine;
      if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
        || startLine < block.startLine || endLine > block.endLine || startLine > endLine) {
        return refusal('invalid_modification_scope');
      }
      writeScopes.push({ blockId: block.id, path: block.path, start: startLine - 1, end: endLine, fileHash: block.fileHash });
    }
    const ids = [...new Set(writeScopes.map(scope => scope.blockId))];
    const reads = dependencyScope(this.#catalog, ids);
    const suggestions = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') return refusal('invalid_candidate');
      const block = this.#catalog.blocks.get(candidate.blockId);
      if (!block || candidate.fileHash !== block.fileHash || !Number.isFinite(candidate.score)
        || candidate.score < -1.000001 || candidate.score > 1.000001) return refusal('invalid_candidate');
      suggestions.push({ blockId: block.id, score: candidate.score, source: 'embedding', status: 'candidate', direction: 'unknown' });
      if (candidatePolicy === 'protect' && !ids.includes(block.id) && !reads.some(read => read.id === block.id)) {
        reads.push({ ...block, reasons: [{ source: 'embedding', direction: 'unknown', score: candidate.score }] });
      }
    }
    for (const scope of reads) {
      if (hashText(this.#files[scope.path]) !== scope.fileHash) return refusal('catalog_stale', { path: scope.path });
    }
    const conflicts = [];
    for (const held of this.#grants.values()) {
      // Even the same participant must not receive mutually conflicting checkouts.
      conflicts.push(...scopeConflicts(writeScopes, reads, held));
    }
    if (conflicts.length) return refusal('checkout_conflict', { conflicts, candidates: suggestions });
    const checkoutId = randomUUID();
    const grant = { checkoutId, participantId, revision: this.#revision, expiresAt: now + leaseMs,
      writes: writeScopes, reads, candidates: suggestions, candidatePolicy, intent,
      base: copy(this.#files), dependencyCoverage: this.#catalog.coverage };
    this.#grants.set(checkoutId, grant);
    return { granted: true, ...this.#publicGrant(grant), files: copy(grant.base) };
  }

  renew({ checkoutId, participantId, leaseMs = 60_000 }, now = Date.now()) {
    const grant = this.#live(checkoutId, participantId, now);
    if (!grant) return refusal('checkout_not_live');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) return refusal('invalid_lease');
    grant.expiresAt = now + leaseMs;
    return { renewed: true, expiresAt: grant.expiresAt };
  }

  release({ checkoutId, participantId }, now = Date.now()) {
    const grant = this.#live(checkoutId, participantId, now);
    if (!grant) return refusal('checkout_not_live');
    this.#grants.delete(checkoutId);
    return { released: true };
  }

  // Trusted catalog evidence comes from the same operator boundary as reindex().
  // Expansion authorizes only this exact candidate; it never publishes it.
  expand({ checkoutId, participantId, candidate, blocks, edges = [], writes }, now = Date.now()) {
    const grant = this.#live(checkoutId, participantId, now);
    if (!grant) return refusal('checkout_not_live');
    if (!sameTree(grant.base, this.#files)) return refusal('expansion_base_moved');
    if (!Array.isArray(writes) || !writes.length || writes.length > 256) return refusal('invalid_expansion');
    if (writes.some(write => write?.startLine !== undefined || write?.endLine !== undefined)) return refusal('expansion_subranges_unsupported');
    const oldWrites = grant.expansion?.originalWrites ?? grant.writes;
    for (const scope of oldWrites) {
      const block = this.#catalog.blocks.get(scope.blockId);
      if (!block || scope.start !== block.start || scope.end !== block.end) return refusal('expansion_subranges_unsupported');
      if (!writes.some(write => write?.blockId === scope.blockId)) return refusal('expansion_cannot_drop_writes');
    }
    let proposed;
    try {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !samePaths(this.#files, candidate)) return refusal('unknown_submission_path');
      const trial = new CheckoutArbiter({ files: candidate, blocks, edges });
      proposed = trial.checkout({ participantId, writes, leaseMs: grant.expiresAt - now }, now);
      if (!proposed.granted) return proposed;
      // Existing whole blocks may be explicitly added; new blocks have no deleted
      // base lines. Check removed and inserted lines separately in their own bases.
      const baseScopes = [...oldWrites];
      for (const write of writes) {
        const block = this.#catalog.blocks.get(write.blockId);
        if (block) baseScopes.push(block);
      }
      for (const [path, text] of Object.entries(candidate)) {
        const baseLines = lines(grant.base[path]), nextLines = lines(text);
        for (const change of changes(grant.base[path], text)) {
          if (change.start !== change.end && !covered(change, baseScopes.filter(s => s.path === path), baseLines.length)) {
            return refusal('outside_modification_scope', { path });
          }
        }
        for (const change of changes(text, grant.base[path])) {
          if (change.start === change.end) continue;
          const scopes = proposed.writes.filter(s => s.path === path);
          const introduced = scopes.filter(s => !this.#catalog.blocks.has(s.blockId));
          for (let line = change.start; line < change.end; line++) {
            if (covered({ start: line, end: line + 1 }, scopes, nextLines.length)) continue;
            // A blank line inside an unrelated template literal can change data.
            // Only allow whitespace gaps touching a newly authorized block.
            if (!nextLines[line].trim()) {
              let before = line - 1, after = line + 1;
              while (before >= 0 && !nextLines[before].trim()) before--;
              while (after < nextLines.length && !nextLines[after].trim()) after++;
              if ([before, after].some(neighbor => neighbor >= 0 && neighbor < nextLines.length
                && covered({ start: neighbor, end: neighbor + 1 }, introduced, nextLines.length))) continue;
            }
            return refusal('outside_modification_scope', { path });
          }
        }
      }
      const conflicts = [...this.#grants.values()].filter(held => held !== grant)
        .flatMap(held => scopeConflicts(proposed.writes, proposed.reads, held));
      if (conflicts.length) return refusal('checkout_conflict', { conflicts });
      const replacement = { ...grant,
        writes: [...oldWrites, ...proposed.writes], reads: [...(grant.expansion?.originalReads ?? grant.reads), ...proposed.reads],
        expansion: { candidate: copy(candidate), originalWrites: copy(oldWrites), originalReads: copy(grant.expansion?.originalReads ?? grant.reads) } };
      this.#grants.set(checkoutId, replacement);
      return { granted: true, expanded: true, ...this.#publicGrant(replacement) };
    } catch (error) { return refusal('invalid_expansion', { detail: error.message }); }
  }

  submit({ checkoutId, participantId, files, validate }, now = Date.now()) {
    const grant = this.#live(checkoutId, participantId, now);
    if (!grant) return refusal('checkout_not_live');
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length
      || Object.keys(files).length > 64) return refusal('invalid_submission');
    const candidate = copy(this.#files), merged = [], scopeViolations = [];
    let submittedBytes = 0;
    try {
      for (const [path, text] of Object.entries(files)) {
        validatePath(path); lines(text); submittedBytes += Buffer.byteLength(text);
        if (!Object.hasOwn(grant.base, path)) return refusal('unknown_submission_path', { path });
        const scopes = grant.writes.filter(scope => scope.path === path);
        for (const change of grant.expansion ? [] : changes(grant.base[path], text)) {
          if (!covered(change, scopes, lines(grant.base[path]).length)) scopeViolations.push({ path, startLine: change.start + 1, endLine: change.end });
        }
      }
      if (submittedBytes > MAX_BYTES) return refusal('prototype_byte_limit');
      if (scopeViolations.length) return refusal('outside_modification_scope', { scopeViolations });
      for (const read of grant.expansion?.originalReads ?? grant.reads) {
        if (changes(grant.base[read.path], this.#files[read.path]).some(change => touches(change, read, lines(grant.base[read.path]).length))) {
          return refusal('dependency_moved', { path: read.path, blockId: read.id });
        }
      }
      for (const [path, text] of Object.entries(files)) {
        const result = mergeText(grant.base[path], text, this.#files[path]);
        if (!result.clean) return refusal(result.refused ? 'merge_limit' : 'merge_conflict', { path, conflicts: result.conflicts });
        candidate[path] = result.text;
        if (this.#files[path] !== grant.base[path] && text !== grant.base[path]) merged.push(path);
      }
      // Global memory bound applies to the resulting tree, not just the submitted paths.
      let candidateBytes = 0;
      for (const text of Object.values(candidate)) { lines(text); candidateBytes += Buffer.byteLength(text); }
      if (candidateBytes > MAX_BYTES) return refusal('prototype_byte_limit');
      if (grant.expansion && !sameTree(candidate, grant.expansion.candidate)) return refusal('expansion_candidate_moved');
    } catch (error) { return refusal('invalid_submission', { detail: error.message }); }
    if (typeof validate !== 'function') return refusal('validation_required');
    const cut = this.#revision;
    // Validation receives a copy. Async validation needs a durable publication transaction;
    // this synchronous prototype refuses it rather than silently accepting a Promise.
    let valid;
    try { valid = validate(copy(candidate)); }
    catch (error) { return refusal('validation_failed', { detail: error.message }); }
    if (valid !== true) return refusal('validation_failed');
    if (cut !== this.#revision || this.#grants.get(checkoutId) !== grant) return refusal('publication_moved');
    if (Object.entries(candidate).every(([path, text]) => text === this.#files[path])) {
      this.#grants.delete(checkoutId);
      return { admitted: true, unchanged: true, revision: this.#revision, merged: [] };
    }
    this.#files = candidate;
    this.#revision++;
    this.#grants.delete(checkoutId);
    return { admitted: true, revision: this.#revision, merged };
  }

  // After publication the operator must re-index boundaries/evidence before new grants.
  // Existing checkouts keep their original bases and can still merge their submissions.
  reindex({ blocks, edges = [] }) {
    this.#catalog = createCatalog(this.#files, blocks, edges);
    return { indexed: true, revision: this.#revision };
  }

  #publicGrant({ base, reads, expansion, ...grant }) {
    return copy({ ...grant, reads: reads.map(({ text, ...read }) => read),
      ...(expansion ? { expanded: true, proposalHash: hashText(JSON.stringify(expansion.candidate)) } : {}) });
  }

  snapshot(now = Date.now()) {
    this.#sweep(now);
    return { revision: this.#revision, files: copy(this.#files),
      grants: [...this.#grants.values()].map(grant => this.#publicGrant(grant)),
      dependencyCoverage: this.#catalog.coverage, persistence: 'memory only', enforcement: 'checkout and submission only' };
  }
}
