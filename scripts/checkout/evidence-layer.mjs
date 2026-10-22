// The publication-evidence layer: what the workspace records at each publication, and
// the notice it gives when a published output's input has moved.
//
// It sits above an arm and changes nothing about what that arm admits. It records the
// version of every path a published output was built from, and reports the outputs
// whose inputs have moved since. The arm underneath is untouched.
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
import { PublicationEvidence } from '../../src/prototypes/checkout/invalidation.mjs';

export function withPublicationEvidence(api, { clocks = null } = {}) {
  const evidence = new PublicationEvidence();
  const baseSubmit = api.submit;
  let pending = [], publications = 0;
  api.submit = async (grant, patch, tick, reads) => {
    const begin = performance.now();
    try {
      const result = await baseSubmit(grant, patch, tick, reads);
      if (!result.admitted) return result;
      publications++;
      const tree = (await api.snapshot()).files;
      const outputs = Object.keys(patch).map(path => ({
        path, hash: hashText(tree[path] ?? ''),
        // The version recorded is the one the participant actually built from: the
        // input as it was in the base it was handed.
        inputs: (reads ?? []).filter(read => typeof grant.files?.[read.path] === 'string')
          .map(read => ({ path: read.path, hash: hashText(grant.files[read.path]), source: read.source })),
      }));
      const published = evidence.publish({ revision: publications, outputs, tree });
      pending.push(...published.invalidated);
      return result;
    } finally { if (clocks) clocks.invalidationMs = (clocks.invalidationMs ?? 0) + performance.now() - begin; }
  };
  // The outputs invalidated since this call. A delta, not a standing set: the
  // schedule acts on the notice, and an output it has already acted on must not be
  // noticed again.
  api.takeInvalidated = () => { const list = pending; pending = []; return list; };
  api.invalidatedOutputs = () => evidence.invalidated().map(record => record.path);
  api.publicationEvidence = () => evidence;
  return api;
}
