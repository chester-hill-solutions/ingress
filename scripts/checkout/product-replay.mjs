// Local adapter around current product commit/lease code; no Cloudflare deployment.
import { WorkspaceAgent } from '../../src/product/workspace-agent.mjs';
import { MANIFEST_VERSION } from '../../src/product/manifest.mjs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
import { mergeText } from '../../src/product/merge.mjs';
import { contentKey } from '../../src/product/keys.mjs';

export class ProductReplay {
  #data = new Map(); #agent; #issued = new Map(); #validate;
  constructor(validate) {
    const data = this.#data;
    const storage = {
      async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, structuredClone(data.get(k))])) : structuredClone(data.get(key)); },
      async put(key, value) {
        for (const [k, v] of typeof key === 'object' ? Object.entries(key) : [[key, value]]) data.set(k, structuredClone(v));
      },
      async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    };
    this.#agent = new WorkspaceAgent({ storage }, { INGRESS_MAX_REVISIONS_PER_PATH: '32' });
    this.#validate = validate;
  }
  async #post(path, body) {
    const response = await this.#agent.fetch(new Request(`https://replay.invalid${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const result = await response.json();
    if (response.status >= 500) throw new Error(JSON.stringify(result));
    return result;
  }
  async seed(files) {
    const result = await this.#post('/bootstrap', { author: 'corpus', files: Object.entries(files).map(([path, text]) =>
      ({ path, contentBase64: Buffer.from(text).toString('base64'), contentHash: hashText(text) })) });
    if (result.error) throw new Error(JSON.stringify(result));
  }
  async snapshot() {
    const ledger = await this.#agent.getLedger();
    return { files: Object.fromEntries([...ledger.files.keys()].map(path => [path,
      Buffer.from(this.#data.get(contentKey(path)).contentBase64, 'base64').toString('utf8')])) };
  }
  async checkout({ participantId, paths }) {
    const ledger = await this.#agent.getLedger(), table = await this.#agent.getLeases();
    ledger.register({ participantId, dependencies: [] });
    // Mirrors /start's partial free-path grant and contended admission. Do not turn
    // this into strict file locking: current /start lets contended workers begin.
    const free = paths.filter(path => !table.holdersOf(path).some(held => held.participantId !== participantId));
    if (free.length) table.checkout({ participantId, paths: free, mode: 'write', leaseMs: 900_000 });
    for (const path of paths) ledger.recordRead({ participantId, path });
    await this.#agent.saveLeases(); await this.#agent.saveLedger();
    const base = (await this.snapshot()).files;
    const revisions = Object.fromEntries([...ledger.files].map(([path, record]) => [path, record.revision]));
    const checkoutId = crypto.randomUUID();
    this.#issued.set(checkoutId, { participantId, base, revisions });
    // Test identity fixtures never leave this adapter or enter retained results.
    this.#data.set(`token:${participantId}`, `local-replay-${participantId}`);
    return { granted: true, checkoutId, participantId, files: structuredClone(base), contendedPaths: paths.filter(path => !free.includes(path)) };
  }
  async submit({ checkoutId, participantId, files }) {
    const issued = this.#issued.get(checkoutId);
    if (!issued || issued.participantId !== participantId) return { admitted: false, reason: 'checkout_not_live' };
    const candidate = (await this.snapshot()).files;
    for (const [path, text] of Object.entries(files)) {
      const result = mergeText(issued.base[path], text, candidate[path]);
      if (!result.clean) return { admitted: false, reason: 'merge_conflict' };
      candidate[path] = result.text;
    }
    // Identical external validation for all arms; this is stronger than the current
    // route alone, so report this matching control explicitly.
    if (!this.#validate(candidate)) return { admitted: false, reason: 'validation_failed' };
    const result = await this.#post('/internal/commit', { manifestVersion: MANIFEST_VERSION, participantExit: 0,
      participantId, token: `local-replay-${participantId}`, files: Object.entries(files).map(([path, text]) => ({ path,
        contentBase64: Buffer.from(text).toString('base64'), contentHash: hashText(text), baseRevision: issued.revisions[path] })) });
    if (result.admitted) await this.release({ checkoutId, participantId });
    return result;
  }
  async release({ checkoutId, participantId }) {
    this.#issued.delete(checkoutId);
    const table = await this.#agent.getLeases();
    for (const lease of table.leasesFor(participantId)) table.release({ leaseId: lease.leaseId, participantId });
    await this.#agent.saveLeases();
  }
}
