import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeGraph, scopeFor, sourceRevision } from '../src/prototypes/checkout/graph-index.mjs';
import { GraphCheckout } from '../src/prototypes/checkout/graph-checkout.mjs';
import { hashText } from '../src/prototypes/checkout/impact.mjs';

// Frozen AST evidence is hashed against source. No Python, Graphify, model, or Stow.
const root = new URL('../fixtures/checkout-lab/', import.meta.url);
const files = Object.fromEntries(readdirSync(new URL('src/', root)).filter(path => path.endsWith('.mjs'))
  .map(path => [`src/${path}`, readFileSync(new URL(`src/${path}`, root), 'utf8')]));
const ast = JSON.parse(readFileSync(new URL('../fixtures/checkout-graph/bindings.json', import.meta.url)));
const contracts = JSON.parse(readFileSync(new URL('contracts.json', root)));
const oracle = JSON.parse(readFileSync(new URL('test/checkout-cases.json', root)));
const index = () => normalizeGraph({ files, ast, contracts });
const req = (symbol, actor = 'a') => ({ participantId: actor, writes: [{ blockId: `${symbol.path}#${symbol.symbol}` }] });

for (const scenario of oracle.cases.filter(row => !row.mutation)) test(`graph admission: ${scenario.id}`, () => {
  const graph = index(), system = new GraphCheckout({ files, buildIndex: () => graph, validate: () => true });
  const a = system.checkout(req(scenario.a), 0);
  const b = system.checkout(req(scenario.b, 'b'), 0);
  if (scenario.expected === 'allow') assert.equal(a.granted && b.granted, true);
  if (scenario.expected === 'block') { assert.equal(a.granted, true); assert.equal(b.reason, 'checkout_conflict'); }
  if (scenario.expected === 'unknown') assert.ok([a, b].some(result => result.reason === 'unresolved_dependency'));
  if (scenario.forbiddenEdge) assert.ok(!graph.edges.some(edge => edge.from === scenario.forbiddenEdge.from && edge.to === scenario.forbiddenEdge.to));
});

test('stale bytes, omitted files, duplicate coverage, syntax failures and wrong producer refuse', () => {
  assert.throws(() => normalizeGraph({ files: { ...files, 'src/money.mjs': files['src/money.mjs'] + '// moved\n' }, ast }), /source_hash_mismatch/);
  for (const mutate of [
    x => { x.files.pop(); },
    x => { x.files[1] = x.files[0]; },
    x => { x.files[0].hasError = true; },
    x => { x.files[0].runtimeSyntaxValid = false; },
    x => { x.producer.version = 2; },
    x => { x.blocks[0].endLine--; },
    x => { x.edges[0].evidence.fileHash = 'forged'; },
    x => { x.edges[0].relation = 'similarity'; },
    x => { x.edges[0].resolution = 'guess'; },
  ]) {
    const altered = structuredClone(ast); mutate(altered);
    assert.throws(() => normalizeGraph({ files, ast: altered, contracts }));
  }
});

test('bounded traversal refuses rather than dropping dependencies', () => {
  assert.throws(() => scopeFor(index(), ['src/checkout.mjs#checkout'], 2), /dependency_scope_limit/);
  assert.throws(() => scopeFor(index(), ['missing']), /invalid_graph_scope/);
});

test('contract assertions require existing symbols and explicit evidence', () => {
  const altered = structuredClone(contracts); altered.contracts[0].evidence = '';
  assert.throws(() => normalizeGraph({ files, ast, contracts: altered }), /invalid_contract/);
  altered.contracts[0].evidence = 'operator assertion'; altered.contracts[0].producer.symbol = 'missing';
  assert.throws(() => normalizeGraph({ files, ast, contracts: altered }), /contract_symbol_missing/);
  const graph = index();
  assert.ok(graph.edges.some(edge => edge.from === 'src/refunds.mjs#issueRefund'
    && edge.to === 'src/orders.mjs#createOrder' && edge.evidence.includes('stored-order-money-v1')));
});

test('Graphify confidence and legacy direction cannot invent a shadowed import edge', () => {
  const find = id => ast.blocks.find(b => b.id === id);
  const node = id => { const b = find(id); return { id, label: b.name + '()', source_file: b.path, source_location: `L${b.startLine}` }; };
  const from = 'src/notifier.mjs#sendCustomReceipt', to = 'src/notifications.mjs#notify';
  const safe = 'src/notifier.mjs#sendDefaultReceipt';
  const raw = { producer: { name: 'graphifyy', version: '0.9.62', schema: 'raw-extraction' }, sourceRevision: sourceRevision(files),
    graph: { nodes: [node(from), node(to), node(safe)], edges: [
      { source: from, target: to, relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/notifier.mjs', source_location: 'L8' },
      { source: to, target: safe, _src: safe, _tgt: to, relation: 'calls', source_file: 'src/notifier.mjs', source_location: 'L4' },
    ] } };
  const graph = normalizeGraph({ files, ast, contracts, raw });
  assert.equal(graph.rawDecisions[0].eligible, false);
  assert.equal(graph.rawDecisions[1].eligible, true);
  assert.equal(graph.rawDecisions[1].from, safe);
  assert.ok(!graph.edges.some(edge => edge.from === from && edge.to === to));
  assert.throws(() => normalizeGraph({ files, ast, raw: { ...raw, sourceRevision: 'stale' } }), /graphify_source_mismatch/);
});

test('unknown callees propagate to callers and never leave partial grants behind', () => {
  const system = new GraphCheckout({ files, buildIndex: index, validate: () => true });
  assert.equal(system.checkout(req({ path: 'src/orders.mjs', symbol: 'createPromotionalOrder' }), 0).reason, 'unresolved_dependency');
  assert.equal(system.snapshot(0).grants.length, 0);
});

test('edited returned checkout bytes do not replace the arbiter-owned base', () => {
  const system = new GraphCheckout({ files, buildIndex: index, validate: () => true });
  const a = system.checkout(req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }), 0);
  a.files['src/pricing.mjs'] = 'forged base';
  const denied = system.submit({ checkoutId: a.checkoutId, participantId: 'a', files: { 'src/pricing.mjs': 'forged base' } }, 1);
  assert.equal(denied.admitted, false);
  assert.equal(system.snapshot(1).graphRevision, sourceRevision(files));
});

test('expired or wrong-owner submissions cannot invoke a candidate producer', () => {
  let builds = 0;
  const system = new GraphCheckout({ files, buildIndex: () => { builds++; return index(); }, validate: () => true });
  const a = system.checkout({ ...req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }), leaseMs: 1 }, 0);
  assert.equal(system.submit({ checkoutId: a.checkoutId, participantId: 'b', files: a.files }, 0).reason, 'checkout_not_live');
  assert.equal(system.submit({ checkoutId: a.checkoutId, participantId: 'a', files: a.files }, 1).reason, 'checkout_not_live');
  assert.equal(builds, 1);
});

test('candidate graph freshness is checked before synchronous behavior validation', () => {
  let validations = 0;
  const system = new GraphCheckout({ files, buildIndex: index, validate: () => { validations++; return true; } });
  const a = system.checkout(req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }), 0);
  const denied = system.submit({ checkoutId: a.checkoutId, participantId: 'a', files: {
    'src/pricing.mjs': files['src/pricing.mjs'].replace('  return Math.round', '  // moved\n  return Math.round') } }, 1);
  assert.equal(denied.reason, 'validation_failed');
  assert.equal(denied.detail, 'index_revision_mismatch');
  assert.equal(validations, 0);
});

test('new dependency is refused even if valid and all edits are in an owned body', () => {
  const changed = { ...files, 'src/pricing.mjs': files['src/pricing.mjs'].replace('  assertCents(subtotalCents);', '  shippingFee(subtotalCents);') };
  const evidence = structuredClone(ast);
  const digest = hashText(changed['src/pricing.mjs']);
  evidence.files.find(f => f.path === 'src/pricing.mjs').fileHash = digest;
  for (const block of evidence.blocks.filter(b => b.path === 'src/pricing.mjs')) block.fileHash = digest;
  for (const edge of evidence.edges.filter(e => e.evidence.path === 'src/pricing.mjs')) edge.evidence.fileHash = digest;
  evidence.edges.push({ from: 'src/pricing.mjs#discountSubtotal', to: 'src/pricing.mjs#shippingFee', relation: 'call', resolution: 'lexical',
    evidence: { path: 'src/pricing.mjs', line: 5, startByte: 200, endByte: 210, fileHash: digest } });
  // This test is for admission using trusted producer facts; extractor qualification
  // separately verifies real source-derived facts. Adjust physical byte spans for edit.
  for (const block of evidence.blocks.filter(b => b.path === 'src/pricing.mjs')) {
    if (block.startByte > changed['src/pricing.mjs'].indexOf('shippingFee(subtotalCents)')) block.startByte++;
    block.endByte++;
  }
  const system = new GraphCheckout({ files, buildIndex: candidate => sourceRevision(candidate) === sourceRevision(files)
    ? index() : normalizeGraph({ files: candidate, ast: evidence, contracts }), validate: () => true });
  const a = system.checkout(req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }), 0);
  const result = system.submit({ checkoutId: a.checkoutId, participantId: 'a', files: { 'src/pricing.mjs': changed['src/pricing.mjs'] } }, 1);
  assert.equal(result.reason, 'scope_expansion_required');
  assert.ok(result.additionalBlocks.includes('src/pricing.mjs#shippingFee'));
});

const frozenBindings = JSON.parse(readFileSync(new URL('../fixtures/checkout-graph/counterexamples.json', import.meta.url)));
const { bindingCases, checkBindingCase } = await import('../scripts/checkout/binding-cases.mjs');
for (const scenario of bindingCases) test(`binding counterexample: ${scenario.id}`, () => {
  const input = { files: scenario.files, ast: frozenBindings[scenario.id] };
  if (scenario.refusal) assert.throws(() => normalizeGraph(input), new RegExp(scenario.refusal));
  else assert.equal(checkBindingCase(scenario, normalizeGraph(input)), true);
});

test('frozen producer evidence identifies the current adapter bytes', () => {
  assert.equal(ast.producer.sourceHash, hashText(readFileSync(new URL('../scripts/checkout/bindings.py', import.meta.url))));
  assert.equal(ast.runtimeAdapterHash, hashText(readFileSync(new URL('../scripts/checkout/binding-producer.mjs', import.meta.url))));
});
