/**
 * Versioned publication evidence and dependent-output invalidation.
 *
 * What this is
 * ------------
 * The fence decides whether a *write* is admissible. It says nothing about whether an
 * output that was already published is still correct after somebody else changed the
 * file it was built from. That is the failure the varied native study reproduced: a
 * consumer finished, published, and was admitted; a provider changed afterwards; the
 * consumer's published bytes were now wrong and nothing in the workspace said so.
 *
 * A publication-time read check cannot catch that. At the moment the consumer
 * published, nothing had moved. The check has to run against what is *already
 * published*, which means the workspace has to remember what each published output was
 * built from.
 *
 * The rule
 * --------
 * 1. At publication, record for each output the version (content hash) of every input
 *    it was built from, together with the source of that evidence.
 * 2. When an input advances to a different version, every output that recorded the
 *    older version loses its approved status. It becomes `invalidated`. It is not
 *    approved, and it is not silently re-approved.
 * 3. An invalidated output must be revalidated (the checks run again against the
 *    current tree) or regenerated (published again from a current base). Both are
 *    recorded, so the trail shows that an output was invalidated and how it recovered.
 *
 * What it is not
 * --------------
 * - **Not semantic impact analysis.** A provider change invalidates every recorded
 *   dependent, including the ones the change could not have affected. That is
 *   over-invalidation, and its cost is measured rather than assumed.
 * - **Not a proof of correctness.** `revalidate` restores the status the checks give.
 *   It does not establish that the output means what it should; the checks are the
 *   checks.
 * - **Not durable.** This is an in-memory experiment record. The durable form belongs
 *   to the product's publication transaction (hardening queue item 14, slice 4), and
 *   this module is written to be lifted there rather than to be the product's copy.
 *
 * The version of an input is its content hash. A revision number would be equivalent
 * inside one workspace and meaningless across two, and a hash is the same thing the
 * workspace already stores for content (`src/product/keys.mjs`).
 */

import { createHash } from 'node:crypto';

export const APPROVED = 'approved';
export const INVALIDATED = 'invalidated';

export const hashOf = text => createHash('sha256').update(text).digest('hex');

const MAX_OUTPUTS = 512;
const MAX_INPUTS = 64;
const MAX_HISTORY = 32;
const MAX_EVENTS = 4096;

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function validInputs(inputs) {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return null;
  const seen = new Set();
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (typeof input.path !== 'string' || !input.path || input.path.length > 512) return null;
    if (!isHash(input.hash)) return null;
    if (typeof input.source !== 'string' || !input.source || input.source.length > 64) return null;
    if (seen.has(input.path)) return null;
    seen.add(input.path);
  }
  return inputs.map(input => ({ path: input.path, hash: input.hash, source: input.source }));
}

/**
 * The workspace's record of what every published output was built from.
 *
 * Each output carries its own versioned evidence: the inputs it was built from, and
 * at which version. An output with no inputs carries `coverage: 'none'` — it was
 * validated, but nothing is known about what it depends on, so no invalidation could
 * ever apply to it. That is reported rather than hidden, because "no evidence" and
 * "no stale input" are different facts and only one of them is a reason to trust the
 * output.
 */
export class PublicationEvidence {
  #outputs = new Map();
  #events = [];
  #sequence = 0;

  /**
   * Record a publication.
   *
   * @param {object} request
   * @param {number} request.revision   the workspace revision this publication produced
   * @param {Array}  request.outputs    [{ path, hash, inputs }] -- the files published
   * @param {object} request.tree       path -> text, the workspace tree after publication
   * @param {boolean} request.validated whether the workspace's validation passed
   * @returns {{approved: string[], invalidated: string[], unknown: string[]}}
   */
  publish({ revision, outputs, tree, validated = true }) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid_revision');
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > MAX_OUTPUTS) throw new TypeError('invalid_outputs');
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) throw new TypeError('invalid_tree');
    const published = [];
    for (const output of outputs) {
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('invalid_output');
      if (typeof output.path !== 'string' || !output.path) throw new TypeError('invalid_output_path');
      if (!isHash(output.hash)) throw new TypeError('invalid_output_hash');
      const inputs = validInputs(output.inputs);
      if (!inputs) throw new TypeError('invalid_output_inputs');
      published.push({ path: output.path, hash: output.hash, inputs });
    }
    for (const output of published) {
      const previous = this.#outputs.get(output.path);
      const record = {
        path: output.path, revision, hash: output.hash, inputs: output.inputs,
        coverage: output.inputs.length ? 'declared' : 'none',
        // The status is the validation status. A publication whose validation did not
        // pass is not an approved output, and it says so for the same reason an
        // invalidated one does: nobody may treat it as good work.
        status: validated ? APPROVED : INVALIDATED,
        validated,
        invalidReason: validated ? null : 'validation_failed',
        invalidatedBy: null,
        publishedAt: this.#sequence++,
        history: previous ? [...previous.history, { event: 'published', revision }] : [{ event: 'published', revision }],
      };
      this.#outputs.set(output.path, record);
    }
    // The publication may itself have moved a provider under an output published
    // earlier, and it may have published an output that was built against a provider
    // version that has already moved. Both are the same comparison.
    const invalidated = this.#invalidateStale(tree);
    this.#event({ event: 'published', revision, outputs: published.map(output => output.path), invalidated });
    return { approved: this.#pathsWithStatus(APPROVED), invalidated, unknown: this.#pathsWithoutEvidence() };
  }

  /**
   * Compare every recorded input against the current tree and invalidate the outputs
   * whose input version has moved.
   */
  #invalidateStale(tree) {
    const invalidated = [];
    for (const record of this.#outputs.values()) {
      // An output that is already invalidated stays invalidated; it is not counted
      // twice, because a second invalidation is not new information.
      if (record.status === INVALIDATED) continue;
      const stale = record.inputs.filter(input => {
        const current = tree[input.path];
        const currentHash = typeof current === 'string' ? hashOf(current) : null;
        // An input that is absent now has still moved: the evidence recorded a version
        // for it, so its absence is a change and the conservative reading is the safe
        // one.
        return currentHash !== input.hash;
      });
      if (!stale.length) continue;
      record.status = INVALIDATED;
      record.invalidReason = 'input_moved';
      record.invalidatedBy = stale.map(input => ({
        path: input.path, recordedHash: input.hash,
        currentHash: typeof tree[input.path] === 'string' ? hashOf(tree[input.path]) : null,
      }));
      record.history = [...record.history, { event: 'invalidated', revision: record.revision, inputs: record.invalidatedBy.map(input => input.path) }].slice(-MAX_HISTORY);
      invalidated.push(record.path);
    }
    return invalidated;
  }

  /**
   * Re-run the workspace's checks against the current tree for one invalidated output.
   *
   * Passing restores the status the checks give and refreshes the recorded input
   * versions to the ones validated. Failing leaves the output invalidated. Neither is
   * silent: both are recorded on the output's history.
   */
  revalidate({ path, tree, validate, revision = null }) {
    const record = this.#outputs.get(path);
    if (!record) return { path, approved: false, reason: 'unknown_output' };
    if (typeof validate !== 'function') throw new TypeError('validator_required');
    let passed;
    try { passed = validate(tree) === true; }
    catch (error) { return { path, approved: false, reason: 'validation_failed', detail: error.message }; }
    if (!passed) {
      record.invalidReason = 'validation_failed';
      record.history = [...record.history, { event: 'revalidation_failed', revision }].slice(-MAX_HISTORY);
      this.#event({ event: 'revalidation_failed', revision, outputs: [path] });
      return { path, approved: false, reason: 'validation_failed' };
    }
    record.status = APPROVED;
    record.validated = true;
    record.invalidReason = null;
    record.invalidatedBy = null;
    record.inputs = record.inputs.map(input => {
      const current = tree[input.path];
      return typeof current === 'string' ? { ...input, hash: hashOf(current) } : input;
    });
    record.revalidatedAt = revision;
    record.history = [...record.history, { event: 'revalidated', revision }].slice(-MAX_HISTORY);
    this.#event({ event: 'revalidated', revision, outputs: [path] });
    return { path, approved: true, reason: 'revalidated' };
  }

  status(path) {
    const record = this.#outputs.get(path);
    if (!record) return { path, status: null, coverage: 'none' };
    return {
      path, status: record.status, coverage: record.coverage, revision: record.revision,
      validated: record.validated, invalidReason: record.invalidReason ?? null,
      invalidatedBy: record.invalidatedBy, revalidatedAt: record.revalidatedAt ?? null,
      inputs: record.inputs.map(input => ({ ...input })), history: [...record.history],
    };
  }

  /** Every output the workspace currently knows to be invalidated. */
  invalidated() {
    return [...this.#outputs.values()].filter(record => record.status === INVALIDATED).map(record => this.status(record.path));
  }

  /** Outputs that were invalidated and later recovered, by revalidation. */
  recoveredByRevalidation() {
    return [...this.#outputs.values()]
      .filter(record => record.history.some(entry => entry.event === 'invalidated') && record.status === APPROVED)
      .map(record => record.path);
  }

  report() {
    const counts = { approved: 0, invalidated: 0, withoutEvidence: 0 };
    for (const record of this.#outputs.values()) {
      if (record.status === INVALIDATED) counts.invalidated++;
      else counts.approved++;
      if (record.coverage === 'none') counts.withoutEvidence++;
    }
    return {
      counts,
      outputs: [...this.#outputs.values()].map(record => ({
        path: record.path, status: record.status, coverage: record.coverage, revision: record.revision,
        validated: record.validated, invalidReason: record.invalidReason ?? null,
        invalidatedBy: record.invalidatedBy, inputs: record.inputs.map(input => ({ ...input })),
        invalidatedCount: record.history.filter(entry => entry.event === 'invalidated').length,
        revalidatedCount: record.history.filter(entry => entry.event === 'revalidated').length,
      })),
      events: this.#events.slice(-MAX_EVENTS),
    };
  }

  #pathsWithStatus(status) {
    return [...this.#outputs.values()].filter(record => record.status === status).map(record => record.path);
  }

  #pathsWithoutEvidence() {
    return [...this.#outputs.values()].filter(record => record.coverage === 'none').map(record => record.path);
  }

  #event(event) {
    this.#events.push({ sequence: this.#sequence++, ...event });
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }
}
