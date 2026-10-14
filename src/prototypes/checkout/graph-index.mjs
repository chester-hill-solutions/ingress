/** Bounded experimental adapter. Only trusted, locally produced AST facts may enter.
 * Graphify confidence never authorizes an edge. No general JS completeness claim.
 */
import { createCatalog, dependencyScope, hashText } from './impact.mjs';
import { validatePath } from '../../product/fence.mjs';

export const sourceRevision = files => hashText(JSON.stringify(Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => [path, hashText(text)])));
const fail = reason => { throw new Error(reason); };
const idFor = symbol => `${symbol.path}#${symbol.symbol}`;

export function normalizeGraph({ files, ast, contracts = { schema: 1, contracts: [] }, raw = null }) {
  if (ast?.schema !== 1 || ast.producer?.name !== 'ingress-bounded-mjs-bindings'
    || ast.producer.version !== 1 || ast.producer.treeSitter !== '0.25.2'
    || ast.producer.javascriptGrammar !== '0.25.0') fail('unsupported_ast_producer');
  if (!Array.isArray(ast.blocks) || ast.blocks.length > 256 || !Array.isArray(ast.edges) || ast.edges.length > 4096
    || !Array.isArray(ast.files) || !Array.isArray(ast.unknown) || !Array.isArray(ast.calls)) fail('graph_record_limit');
  const paths = Object.keys(files).sort();
  if (paths.length > 64 || paths.length !== ast.files.length || new Set(ast.files.map(f => f.path)).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify(ast.files.map(f => f.path).sort())) fail('source_coverage_mismatch');
  let bytes = 0;
  for (const file of ast.files) {
    validatePath(file.path);
    if (typeof files[file.path] !== 'string') fail('invalid_source');
    bytes += Buffer.byteLength(files[file.path]);
    if (file.fileHash !== hashText(files[file.path])) fail('source_hash_mismatch');
    if (file.hasError !== false || file.errors.length || file.runtimeSyntaxValid !== true
      || ast.runtimeParser !== 'node-module-syntax-check') fail('parse_error');
  }
  if (bytes > 1024 * 1024) fail('source_byte_limit');
  if (ast.unknown.length > 4096 || ast.calls.length > 4096) fail('coverage_record_limit');
  for (const block of ast.blocks) {
    const data = Buffer.from(files[block.path] ?? '');
    if (block.fileHash !== hashText(data) || !Number.isSafeInteger(block.startByte)
      || !Number.isSafeInteger(block.endByte) || block.startByte < 0 || block.endByte <= block.startByte
      || block.endByte > data.length) fail('invalid_symbol_span');
    const start = data.subarray(0, block.startByte).toString('utf8').split('\n').length;
    const last = data[block.endByte - 1] === 10 ? block.endByte - 1 : block.endByte;
    const end = data.subarray(0, last).toString('utf8').split('\n').length;
    if (start !== block.startLine || end !== block.endLine) fail('symbol_line_mismatch');
  }
  const edges = ast.edges.map(edge => {
    const evidence = edge.evidence;
    if (!['call', 'reference', 'binding'].includes(edge.relation) || edge.resolution !== 'lexical'
      || !evidence || evidence.fileHash !== hashText(files[evidence.path] ?? '')
      || !Number.isSafeInteger(evidence.line) || evidence.line < 1
      || !Number.isSafeInteger(evidence.startByte) || !Number.isSafeInteger(evidence.endByte)
      || evidence.startByte < 0 || evidence.endByte <= evidence.startByte
      || evidence.endByte > Buffer.byteLength(files[evidence.path] ?? '')) fail('invalid_relation_evidence');
    return { from: edge.from, to: edge.to, evidence: JSON.stringify({ producer: ast.producer.name, ...edge }) };
  });
  if (contracts.schema !== 1 || !Array.isArray(contracts.contracts) || contracts.contracts.length > 64) fail('invalid_contracts');
  const ids = new Set(ast.blocks.map(block => block.id)), contractIds = new Set();
  for (const contract of contracts.contracts) {
    if (typeof contract.id !== 'string' || !contract.id || contractIds.has(contract.id)
      || typeof contract.evidence !== 'string' || !contract.evidence.trim()
      || !Array.isArray(contract.consumers) || !contract.consumers.length || contract.consumers.length > 256) fail('invalid_contract');
    contractIds.add(contract.id);
    const producer = idFor(contract.producer);
    for (const consumer of contract.consumers) {
      const from = idFor(consumer);
      if (!ids.has(from) || !ids.has(producer)) fail('contract_symbol_missing');
      edges.push({ from, to: producer, evidence: JSON.stringify({ contractId: contract.id,
        contractsHash: hashText(JSON.stringify(contracts)), evidence: contract.evidence,
        producerHash: hashText(files[contract.producer.path]), consumerHash: hashText(files[consumer.path]),
        authority: 'operator-declared contract; behavior validation required for changed evidence' }) });
    }
  }
  const catalog = createCatalog(files, ast.blocks, edges);
  const unknown = structuredClone(ast.unknown);
  for (const item of unknown) if (!ids.has(item.blockId) && !item.blockId.startsWith('@module:')) fail('unknown_coverage_symbol');
  // Unsupported module syntax could introduce relations anywhere in that module.
  if (unknown.some(item => item.blockId.startsWith('@module:'))) fail('unsupported_module_syntax');
  const rawDecisions = [];
  if (raw) {
    if (raw.producer?.name !== 'graphifyy' || raw.producer.version !== '0.9.62'
      || raw.producer.schema !== 'raw-extraction' || !Array.isArray(raw.graph?.nodes)
      || !Array.isArray(raw.graph.edges) || raw.graph.nodes.length > 4096 || raw.graph.edges.length > 16384) fail('unsupported_graphify_envelope');
    if (sourceRevision(files) !== raw.sourceRevision) fail('graphify_source_mismatch');
    const nodes = new Map(raw.graph.nodes.map(node => [node.id, node]));
    if (nodes.size !== raw.graph.nodes.length) fail('duplicate_graphify_node');
    const symbol = node => node && ast.blocks.find(b => b.path === node.source_file
      && b.name === node.label.replace(/\(\)$/, '') && `L${b.startLine}` === node.source_location)?.id;
    for (const edge of raw.graph.edges) {
      const from = symbol(nodes.get(edge._src ?? edge.source));
      const to = symbol(nodes.get(edge._tgt ?? edge.target));
      const verified = edge.relation === 'calls' && from && to && ast.calls.some(call =>
        call.blockId === from && call.target === to && call.path === edge.source_file && `L${call.line}` === edge.source_location);
      rawDecisions.push({ from: from ?? null, to: to ?? null, relation: edge.relation,
        eligible: !!verified, reason: verified ? 'independently_verified_lexical_call' : 'not_verified_as_lexical_call' });
    }
  }
  return { schema: 1, revision: sourceRevision(files), contractsHash: hashText(JSON.stringify(contracts)),
    blocks: structuredClone(ast.blocks), edges, unknown, rawDecisions, catalog,
    coverage: ast.coverage, producer: structuredClone(ast.producer) };
}

export function scopeFor(index, blockIds, limit = 256) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !blockIds.length
    || blockIds.some(id => !index.catalog.blocks.has(id))) fail('invalid_graph_scope');
  const dependencies = dependencyScope(index.catalog, blockIds);
  if (dependencies.length + new Set(blockIds).size > limit) fail('dependency_scope_limit');
  // Unknown outgoing calls propagate to their static callers. Reverse traversal alone
  // does not imply the requested block executes its callers' unresolved calls.
  const forward = new Set(blockIds), queue = [...blockIds];
  for (let i = 0; i < queue.length; i++) for (const edge of index.edges) {
    if (edge.from === queue[i] && !forward.has(edge.to)) { forward.add(edge.to); queue.push(edge.to); }
  }
  return { ids: [...new Set([...blockIds, ...dependencies.map(block => block.id)])],
    unknown: index.unknown.filter(item => forward.has(item.blockId)) };
}
