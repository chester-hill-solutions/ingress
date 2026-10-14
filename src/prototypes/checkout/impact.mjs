import { createHash } from 'node:crypto';
import { lines } from './regions.mjs';

export const hashText = text => createHash('sha256').update(text).digest('hex');

// The operator supplies block boundaries and evidenced edges. No parser completeness claim.
export function createCatalog(files, blocks, edges = []) {
  if (!Array.isArray(blocks) || blocks.length > 256) throw new RangeError('prototype_block_limit');
  const byId = new Map();
  for (const entry of blocks) {
    const text = files[entry.path];
    const count = lines(text).length;
    if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)
      || !Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine)
      || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > count) {
      throw new TypeError('invalid_or_duplicate_block');
    }
    byId.set(entry.id, Object.freeze({ ...entry, start: entry.startLine - 1, end: entry.endLine,
      fileHash: hashText(text), text: lines(text).slice(entry.startLine - 1, entry.endLine).join('') }));
  }
  if (!Array.isArray(edges) || edges.length > 4096) throw new RangeError('prototype_edge_limit');
  const confirmed = edges.map(edge => {
    if (!byId.has(edge.from) || !byId.has(edge.to) || typeof edge.evidence !== 'string' || !edge.evidence.trim()) {
      throw new TypeError('dependency_requires_known_blocks_and_evidence');
    }
    return Object.freeze({ from: edge.from, to: edge.to, evidence: edge.evidence, source: 'declared' });
  });
  return Object.freeze({ blocks: byId, edges: confirmed, coverage: 'operator-declared; completeness unknown' });
}

// Walk impacting and impacted dependencies separately. An undirected walk would lock
// every sibling caller of a shared utility, even when their edits are independent.
export function dependencyScope(catalog, ids) {
  const protections = new Map();
  for (const direction of ['impacting', 'impacted']) {
    const visited = new Set(ids), queue = [...ids];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const edge of catalog.edges) {
        const source = direction === 'impacting' ? edge.from : edge.to;
        const target = direction === 'impacting' ? edge.to : edge.from;
        if (source !== id || visited.has(target)) continue;
        visited.add(target); queue.push(target);
        if (!ids.includes(target)) {
          const block = catalog.blocks.get(target);
          const record = protections.get(target) ?? { ...block, reasons: [] };
          record.reasons.push({ direction, ...edge });
          protections.set(target, record);
        }
      }
    }
  }
  return [...protections.values()];
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length
    || a.some(x => !Number.isFinite(x)) || b.some(x => !Number.isFinite(x))) throw new TypeError('invalid_embedding');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  if (!aa || !bb) throw new TypeError('zero_embedding');
  return dot / Math.sqrt(aa * bb);
}

export async function indexCatalog(catalog, embed) {
  const blocks = [...catalog.blocks.values()];
  const vectors = await embed(blocks.map(block => `title: ${block.path}#${block.id} | text: ${block.text}`), 'Document');
  if (!Array.isArray(vectors) || vectors.length !== blocks.length) throw new TypeError('embedding_count_mismatch');
  vectors.forEach(vector => cosine(vector, vector));
  return { blocks, vectors };
}

export async function discoverCandidates(index, request, embed, { topK = 3, minimumScore = -1 } = {}) {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 20 || !Number.isFinite(minimumScore)
    || minimumScore < -1 || minimumScore > 1 || typeof request.intent !== 'string' || !request.intent.trim()) {
    throw new TypeError('invalid_discovery_request');
  }
  const selected = new Set(request.writes.map(write => write.blockId));
  const query = `${request.intent}\n${index.blocks.filter(block => selected.has(block.id)).map(block => block.text).join('\n')}`;
  const vectors = await embed([query], 'CodeRetrieval');
  if (!Array.isArray(vectors) || vectors.length !== 1) throw new TypeError('embedding_count_mismatch');
  return index.blocks.map((block, i) => ({ blockId: block.id, fileHash: block.fileHash,
    score: cosine(vectors[0], index.vectors[i]), source: 'embedding', status: 'candidate', direction: 'unknown' }))
    .filter(candidate => !selected.has(candidate.blockId) && candidate.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.blockId.localeCompare(b.blockId)).slice(0, topK);
}
