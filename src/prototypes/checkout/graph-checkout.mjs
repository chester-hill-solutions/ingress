/** Memory-only graph-backed checkout experiment. Trusted operator supplies producer
 * and independent synchronous validation; identities and time are not authenticated.
 */
import { CheckoutArbiter } from './arbiter.mjs';
import { sourceRevision, scopeFor } from './graph-index.mjs';
import { mergeText } from '../../product/merge.mjs';

const refuse = (reason, detail = {}) => ({ granted: false, admitted: false, reason, ...detail });
export class GraphCheckout {
  #arbiter; #index; #build; #validate; #issued = new Map();
  constructor({ files, buildIndex, validate }) {
    if (typeof buildIndex !== 'function' || typeof validate !== 'function') throw new TypeError('trusted_producer_and_validator_required');
    this.#build = buildIndex; this.#validate = validate;
    this.#arbiter = new CheckoutArbiter({ files, blocks: [], edges: [] });
    this.#index = this.#fresh(files);
    this.#arbiter.reindex({ blocks: this.#index.blocks, edges: this.#index.edges });
  }
  #fresh(files) {
    const index = this.#build(structuredClone(files));
    if (index?.revision !== sourceRevision(files)) throw new Error('index_revision_mismatch');
    return index;
  }
  checkout({ participantId, writes, leaseMs }, now = Date.now()) {
    this.snapshot(now);
    let scope;
    try { scope = scopeFor(this.#index, writes.map(write => write.blockId)); }
    catch (error) { return refuse(error.message); }
    const grant = this.#arbiter.checkout({ participantId, writes, ...(leaseMs === undefined ? {} : { leaseMs }) }, now);
    if (!grant.granted) return { ...grant, graphRevision: this.#index.revision };
    if (scope.unknown.length) {
      this.#arbiter.release({ checkoutId: grant.checkoutId, participantId }, now);
      return refuse('unresolved_dependency', { unknown: scope.unknown, graphRevision: this.#index.revision });
    }
    this.#issued.set(grant.checkoutId, { participantId, scope: scope.ids, writes: structuredClone(writes), base: structuredClone(grant.files) });
    return { ...grant, dependencyCoverage: this.#index.coverage, graphRevision: this.#index.revision };
  }
  submit({ checkoutId, participantId, files }, now = Date.now()) {
    const state = this.#arbiter.snapshot(now);
    const live = state.grants.find(grant => grant.checkoutId === checkoutId && grant.participantId === participantId);
    const issued = this.#issued.get(checkoutId);
    if (!live || !issued || issued.participantId !== participantId) return refuse('checkout_not_live');
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length || Object.keys(files).length > 64) return refuse('invalid_submission');
    let submittedBytes = 0;
    for (const text of Object.values(files)) {
      if (typeof text !== 'string') return refuse('invalid_submission');
      submittedBytes += Buffer.byteLength(text);
    }
    if (submittedBytes > 1024 * 1024) return refuse('prototype_byte_limit');
    let nextIndex;
    // Preflight the same three-way candidate as the admission core, before returning
    // any scope result. This detects added imports even when outside the old grant.
    try {
      const candidate = structuredClone(state.files);
      for (const [path, text] of Object.entries(files)) {
        if (!Object.hasOwn(issued.base, path) || typeof text !== 'string') return refuse('invalid_submission');
        const result = mergeText(issued.base[path], text, state.files[path]);
        if (!result.clean) return refuse(result.refused ? 'merge_limit' : 'merge_conflict');
        candidate[path] = result.text;
      }
      nextIndex = this.#fresh(candidate);
      const scope = scopeFor(nextIndex, issued.writes.map(write => write.blockId));
      if (scope.unknown.length) return refuse('unresolved_dependency', { unknown: scope.unknown });
      const added = scope.ids.filter(id => !issued.scope.includes(id));
      if (added.length) return refuse('scope_expansion_required', { additionalBlocks: added });
    } catch (error) { return refuse('validation_failed', { detail: error.message }); }
    const result = this.#arbiter.submit({ checkoutId, participantId, files, validate: candidate => {
      if (sourceRevision(candidate) !== nextIndex.revision) return false;
      return this.#validate(candidate);
    } }, now);
    if (result.admitted) {
      this.#issued.delete(checkoutId);
      this.#index = nextIndex;
      this.#arbiter.reindex({ blocks: nextIndex.blocks, edges: nextIndex.edges });
    }
    return { ...result, graphRevision: this.#index.revision };
  }
  expand({ checkoutId, participantId, files, additionalWrites = [] }, now = Date.now()) {
    const state = this.snapshot(now), issued = this.#issued.get(checkoutId);
    if (!issued || issued.participantId !== participantId) return refuse('checkout_not_live');
    if (sourceRevision(issued.base) !== sourceRevision(state.files)) return refuse('expansion_base_moved');
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length
      || Object.keys(files).length > 64 || !Array.isArray(additionalWrites) || additionalWrites.length > 256) return refuse('invalid_expansion');
    try {
      const candidate = structuredClone(state.files);
      for (const [path, text] of Object.entries(files)) {
        if (!Object.hasOwn(candidate, path) || typeof text !== 'string') return refuse('invalid_submission');
        candidate[path] = text;
      }
      if (Object.values(candidate).reduce((size, text) => size + Buffer.byteLength(text), 0) > 1024 * 1024) return refuse('prototype_byte_limit');
      const nextIndex = this.#fresh(candidate);
      const writes = [...issued.writes, ...additionalWrites.filter(write => !issued.writes.some(old => old.blockId === write?.blockId))];
      const scope = scopeFor(nextIndex, writes.map(write => write.blockId));
      if (scope.unknown.length) return refuse('unresolved_dependency', { unknown: scope.unknown });
      const result = this.#arbiter.expand({ checkoutId, participantId, candidate,
        blocks: nextIndex.blocks, edges: nextIndex.edges, writes }, now);
      if (result.expanded) {
        issued.writes = structuredClone(writes);
        issued.scope = [...new Set([...issued.scope, ...scope.ids])];
      }
      return { ...result, graphRevision: this.#index.revision, proposalRevision: nextIndex.revision };
    } catch (error) { return refuse('invalid_expansion', { detail: error.message }); }
  }
  release(request, now = Date.now()) {
    const result = this.#arbiter.release(request, now);
    if (result.released) this.#issued.delete(request.checkoutId);
    return result;
  }
  renew(request, now = Date.now()) { return this.#arbiter.renew(request, now); }
  snapshot(now = Date.now()) {
    const state = this.#arbiter.snapshot(now);
    const live = new Set(state.grants.map(grant => grant.checkoutId));
    for (const id of this.#issued.keys()) if (!live.has(id)) this.#issued.delete(id);
    return { ...state, graphRevision: this.#index.revision, dependencyCoverage: this.#index.coverage,
      unknown: structuredClone(this.#index.unknown), rawDecisions: structuredClone(this.#index.rawDecisions) };
  }
}
