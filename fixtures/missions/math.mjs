import assert from 'node:assert/strict';
import { verifyMission } from '../../src/mission-verifier.mjs';

const manifest = JSON.stringify({ name: 'exact-mathematics-mission', version: '1.0.0', type: 'module', private: true }, null, 2) + '\n';
const seed = name => `export function ${name}(cases) { throw new Error('Implement the protected mathematical contract'); }\n`;
const networkExports = {
  'validate.mjs': 'validateNetworks', 'cost.mjs': 'costFlows', 'residual.mjs': 'residualNetworks', 'solver.mjs': 'solveNetworks',
  'audit.mjs': 'auditNetworks', 'sensitivity.mjs': 'analyzeCapacity', 'decompose.mjs': 'decomposeFlows', 'report.mjs': 'reportNetworks',
};
const graphExports = {
  'validate.mjs': 'validateGraphs', 'components.mjs': 'componentGraphs', 'trees.mjs': 'treeGraphs', 'reliability.mjs': 'reliabilityGraphs',
  'structure.mjs': 'structureGraphs', 'transform.mjs': 'transformGraphs', 'witness.mjs': 'witnessGraphs', 'report.mjs': 'reportGraphs',
};

const networkContract = `# Exact capacitated circulation laboratory

All exports accept an array of 1..32 cases and return an array in matching order; the entire malformed batch throws TypeError. No packages, subprocesses or floating-point money. Use decimal strings and BigInt for every cost, objective, potential and dual. Do not mutate caller objects. Decimal strings are canonical base ten (0 or -?[1-9][0-9]*), never -0.

Network N={n,balances,edges}; 1<=n<=12, 0<=edges.length<=36. balances has n integers in [-24,24], sum zero, total positive balance<=24. Positive balance means required outgoing minus incoming flow. Each edge {id,u,v,capacity,cost}: unique nonempty ASCII id <=32 characters, vertices 0..n-1, integer capacity 0..8, canonical signed cost string with absolute value <=10^18. Loops, parallel edges, negative costs and zero balances are allowed. Feasibility is not guaranteed. An input flow is an integer array in edge order, 0<=f<=capacity; for cost/residual it need not conserve balances.

validate.mjs validateNetworks([N]) => canonical deep copies, preserving array order and exactly the declared fields.
cost.mjs costFlows([{network:N,flow:f}]) => exact decimal strings sum(cost[e]*f[e]); invalid flow bounds/type throw TypeError.
residual.mjs residualNetworks([{network:N,flow:f}]) => arrays of {edgeID,u,v,capacity,cost,direction}. Visit original edges in order, forward then backward; emit forward only if capacity-f>0 (cost unchanged), backward only if f>0 (negated cost), direction 'forward'/'backward'.
solver.mjs solveNetworks([N]) => solution objects:
  optimal: {status:'optimal',flow:[integers],objective:string,potentials:[n decimal strings],dualObjective:string}.
  infeasible: {status:'infeasible',cut:{vertices:[distinct sorted vertices],deficit:positive integer}}.
An optimal flow conserves balances. For each edge define r=cost+p[u]-p[v]. If f<capacity require r>=0; if f>0 require r<=0. objective=sum cost*f. dualObjective=-sum p[v]*balances[v]+sum capacity[e]*min(0,r[e]); both must agree exactly. These independently checked residual conditions certify optimality, including negative circulations even when all balances are zero. Potentials may have any common offset. An infeasible cut must have sum balances[S]-sum capacity[S->outside]>0, exactly equal to deficit. No infeasibility prose is a certificate.
audit.mjs auditNetworks([{network:N,solution:s}]) => {valid:boolean} objects. Validate optimal and infeasible certificates independently; malformed/forged solution returns valid:false, malformed N throws TypeError. Do not trust status/objective/dual strings.
sensitivity.mjs analyzeCapacity([N]) => arrays in edge order of {edgeID,minus,plus}; each non-null result is {status:'optimal',objective:string} or {status:'infeasible',objective:null}. minus solves with this capacity lowered by one (null at capacity zero); plus raises by one (null at capacity eight). Preserve other bytes and solve the perturbed network, including originally infeasible cases.
decompose.mjs decomposeFlows([{network:N,flow:f}]) => {paths,cycles}. Require feasible conserving f or throw TypeError. Each item {vertices,edgeIDs,amount} has positive integer amount; path vertices are distinct and start at a positive-balance vertex and end at a negative-balance vertex; cycles are simple except final vertex repeats the first (a loop is [v,v]). edgeIDs follow directed original edges, vertices.length=edgeIDs.length+1. Summed path/cycle amounts reconstruct every edge flow exactly. Path start/end amounts also reconstruct each positive/negative balance; zero flow gives empty lists. Any valid decomposition is accepted.
report.mjs reportNetworks([N]) => {solution,audit,sensitivity,decomposition}; compose the other public modules. audit must certify valid:true, sensitivity follows its contract, decomposition is null for infeasible networks and otherwise follows decomposeFlows. No speculative theorem/proof text is graded.

Samples are illustrative inputs only. Implement arbitrary supported instances efficiently; private deterministic held-out cases include zero-capacity, disconnected, negative-cycle, precision and sensitivity cases. File focus is not exclusive ownership; preserve peer exports and integrate through these module contracts.
`;

const graphContract = `# Exact graph reliability observatory

All exports accept arrays of 1..32 cases and return arrays in matching order; the entire malformed batch throws TypeError. No packages or subprocesses. Counts and rational numerators/denominators are canonical nonnegative decimal strings, with positive denominators; reduced fractions have gcd=1 (zero is 0/1). Never approximate rational arithmetic with Number. Do not mutate caller objects.

Graph G={n,edges,p}; 1<=n<=10, 0<=edges.length<=18. Each edge {id,u,v} has unique nonempty ASCII id <=32 characters and integer endpoints 0..n-1. Undirected loops and parallel edges are allowed. p={numerator,denominator} is a canonical nonnegative fraction, 0<=numerator<=denominator, denominator<=10^18; input need not be reduced. Every edge independently works with the same probability p. A single-vertex graph is connected. Components and vertex lists are ascending, components ordered by smallest vertex. Edge-result arrays retain original edge order.

validate.mjs validateGraphs([G]) => exact canonical deep copies preserving the declared fields/order and original unreduced input fraction.
components.mjs componentGraphs([{graph:G,activeEdgeIDs:[unique known IDs]}]) => {components:[[vertices]],connected:boolean}; include isolated vertices, ignore loops for connectivity. Invalid active IDs throw TypeError.
trees.mjs treeGraphs([G]) => {count:string,edgeCounts:[{id,count:string}]}; count spanning trees and the number containing each original edge. Distinct parallel edges are distinct choices; loops never occur in a tree. Single vertex has one empty tree. Disconnected graph has zero trees. Sum edgeCounts=(n-1)*count is a required invariant.
reliability.mjs reliabilityGraphs([G]) => {connectedBySize:[m+1 count strings],probability:{numerator,denominator},influence:[{id,numerator,denominator}]}. connectedBySize[k] counts connected spanning subgraphs with exactly k retained original edges. Probability=sum C[k]*a^k*(b-a)^(m-k)/b^m, reduced. Edge influence is P(connected | this edge forced working)-P(connected | it forced failed), with all other edges still independently at p; reduced nonnegative fraction, including endpoints p=0/1. Loops have zero influence. Sum C[k]<=2^m. Give exact combinatorics, not simulation.
structure.mjs structureGraphs([G]) => {bridges:[{id,components}],articulations:[{vertex,components}]}. A bridge deletion increases the original component count; articulation vertex deletion increases that original count. Witness components use original remaining vertex labels. Include all and only such edges/vertices, in edge order / ascending vertex order. This definition also covers disconnected graphs.
transform.mjs transformGraphs([G]) => {deletions:[{id,graph}],contractions:[{id,graph}]}. Delete the indicated edge. For contraction of nonloop (u,v), merge max(u,v) into min(u,v), then renumber remaining representatives in ascending order to 0..n-2; remove only the contracted edge, preserve all other IDs/order and loops/multiple edges, and preserve p. Loop contraction is just deletion with unchanged n. These transformed graphs stay within the contract.
witness.mjs witnessGraphs([G]) => {treeEdgeIDs:[IDs]|null,disconnectedComponents:[[vertices]]|null}. Connected: supply any n-1 distinct edges making a spanning tree, disconnectedComponents:null. Disconnected: treeEdgeIDs:null and supply exact components. A single vertex has [].
report.mjs reportGraphs([G]) => {components,trees,reliability,structure,transforms,witness}; compose the other modules with all original edges active for components. The grader checks exact counts, cut witnesses, deletion/contraction identities and rational precision; prose is not accepted as a formal proof.

Implement arbitrary supported inputs with deterministic exact algorithms. Private held-outs include loops, parallel edges, disconnected graphs, vertex cuts, K4, and a larger edge set with large-denominator probabilities. File focus is not exclusive ownership; preserve peer exports.
`;

const networkSample = { n: 3, balances: [2, 0, -2], edges: [
  { id: 'route-a', u: 0, v: 1, capacity: 2, cost: '100000000000000003' },
  { id: 'route-b', u: 1, v: 2, capacity: 2, cost: '-100000000000000001' },
  { id: 'direct', u: 0, v: 2, capacity: 1, cost: '7' },
] };
const graphSample = { n: 4, edges: [{ id: 'a', u: 0, v: 1 }, { id: 'b', u: 1, v: 2 }, { id: 'c', u: 2, v: 0 }, { id: 'd', u: 2, v: 3 }], p: { numerator: '3', denominator: '7' } };
const dependencyPaths = {
  'exact-circulation': {
    'validate.mjs': [], 'cost.mjs': ['validate.mjs'], 'residual.mjs': ['validate.mjs'],
    'solver.mjs': ['validate.mjs', 'cost.mjs', 'residual.mjs'], 'audit.mjs': ['validate.mjs', 'cost.mjs', 'residual.mjs'],
    'sensitivity.mjs': ['validate.mjs', 'solver.mjs'], 'decompose.mjs': ['validate.mjs'],
  },
  'exact-reliability': {
    'validate.mjs': [], 'components.mjs': ['validate.mjs'], 'trees.mjs': ['validate.mjs', 'components.mjs'],
    'reliability.mjs': ['validate.mjs', 'components.mjs', 'trees.mjs'], 'structure.mjs': ['components.mjs'],
    'transform.mjs': ['validate.mjs'], 'witness.mjs': ['components.mjs'],
  },
};
const build = (id, title, contract, exports, sample, roles) => ({
  id, title, domain: 'math', evaluatorTimeoutMs: 30000,
  goal: `${title}. Build a functioning exact mathematics library across eight cooperating streams. Read protected contracts.md for the full input/output definitions and supported limits. Implement every seeded module and integrate report.mjs. All decimal arithmetic and mathematical certificates must be executable and independently checkable; prose does not count as proof. Solve arbitrary supported inputs, not only samples. Preserve package.json, contracts.md and samples.json byte-for-byte. Use native file tools, no packages, subprocesses or nested agents. File focus is coordination context, never exclusive ownership. Peer changes may affect your assumptions; inspect actual dependencies and preserve their public exports. Executable criteria are independently graded on held-out cases, including precision and adversarial certificates.`,
  files: { 'package.json': manifest, 'contracts.md': contract, 'samples.json': JSON.stringify([sample], null, 2) + '\n', ...Object.fromEntries(Object.entries(exports).map(([path, name]) => [path, seed(name)])) },
  protectedPaths: ['package.json', 'contracts.md', 'samples.json'], editablePaths: Object.keys(exports),
  criteria: (id === 'exact-circulation' ? ['network.validation','network.validation_rejects_bad_domain','network.exact_cost','network.residual_arcs','network.primal_dual_optimality','network.independent_audit_valid','network.independent_audit_forged','network.capacity_sensitivity','network.constructive_decomposition','network.integrated_reports'] : ['graph.validation','graph.validation_rejects_bad_domain','graph.selected_connectivity','graph.exact_spanning_trees','graph.reliability_precision_and_influence','graph.bridge_articulation_witnesses','graph.canonical_deletion_contraction','graph.constructive_tree_or_cut','graph.integrated_reports']).map(id => ({ id, description: id.split('.').at(-1).replaceAll('_', ' ') + ' satisfies the executable protected contract.' })),
  reviewInvocation: { path: 'report.mjs', exportName: exports['report.mjs'], args: [[structuredClone(sample)]] },
  workstreams: Object.entries(exports).map(([path, name], index) => ({ id: roles[index][0], role: roles[index][1],
    brief: `Own the ${roles[index][1]} workstream: implement ${path} export ${name}. Read contracts.md for the exact batch API. ${roles[index][2]} Preserve peer exports; your file focus grants no ownership. Integrate with report.mjs through the documented contracts.`, paths: [path],
    dependencies: (index === 7 ? Object.keys(exports).slice(0, -1) : dependencyPaths[id][path]).map(producerPath => ({ producerPath, consumerPath: path })) })),
});

export const mathMissions = [
  build('exact-circulation', 'Exact resource routing with primal / dual certificates', networkContract, networkExports, networkSample, [
    ['validation', 'network-domain specialist', 'Reject malformed networks with TypeError while preserving exact signed cost strings.'],
    ['cost', 'exact-arithmetic specialist', 'Implement objective accumulation without precision loss, including negative costs.'],
    ['residual', 'residual-network specialist', 'Construct canonical forward/backward capacity arcs and negated exact costs.'],
    ['optimization', 'circulation optimizer', 'Find feasible flows and minimize cost, including independent negative cycles; return an exact optimality or infeasibility certificate.'],
    ['certificates', 'independent-certificate auditor', 'Validate conservation, bounds, reduced-cost inequalities and the exact dual/cut equality; reject forged certificates.'],
    ['sensitivity', 'capacity-sensitivity specialist', 'Solve each one-unit capacity perturbation and report feasibility/objective changes.'],
    ['decomposition', 'constructive-flow specialist', 'Decompose feasible flows into simple supply/demand paths and cycles, including loops.'],
    ['integration', 'mathematical-report integrator', 'Compose the actual module outputs into complete exact reports; never fabricate a certificate.'],
  ]),
  build('exact-reliability', 'Exact graph reliability, combinatorics and constructive witnesses', graphContract, graphExports, graphSample, [
    ['validation', 'graph-domain specialist', 'Validate multigraph endpoints/IDs and exact rational inputs, including single-vertex and disconnected graphs.'],
    ['components', 'connectivity specialist', 'Compute canonical components for arbitrary active edge selections without losing isolated vertices.'],
    ['trees', 'spanning-tree combinatorics specialist', 'Count spanning trees and every edge participation exactly; honor loops and parallel edges.'],
    ['reliability', 'exact-reliability specialist', 'Compute the entire connected-by-size polynomial, exact probability and each forced-edge influence.'],
    ['structure', 'cut-structure specialist', 'Produce all bridge/articulation witnesses, including disconnected baseline graphs.'],
    ['transforms', 'deletion-contraction specialist', 'Canonical graph transformations must preserve parallel edges and support reliability identities.'],
    ['witnesses', 'constructive-certificate specialist', 'Provide a verifiable spanning tree or exact disconnected component witness.'],
    ['integration', 'graph-observatory integrator', 'Compose module results into complete reports and cross-check combinatorial invariants.'],
  ]),
];

const integer = value => typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value);
const natural = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const fraction = (a, b) => { const g = gcd(a < 0n ? -a : a, b); return { numerator: String(a / g), denominator: String(b / g) }; };
const minusFraction = (a, b) => fraction(BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator));
function objective(network, flow) { return network.edges.reduce((sum, edge, i) => sum + BigInt(edge.cost) * BigInt(flow[i]), 0n); }
function validFlow(network, flow, conserving = true) {
  if (!Array.isArray(flow) || flow.length !== network.edges.length || flow.some((v, i) => !Number.isSafeInteger(v) || v < 0 || v > network.edges[i].capacity)) return false;
  const balance = Array(network.n).fill(0); network.edges.forEach((e, i) => { balance[e.u] += flow[i]; balance[e.v] -= flow[i]; });
  return !conserving || balance.every((v, i) => v === network.balances[i]);
}
function validCertificate(network, solution) {
  try {
    if (solution?.status === 'infeasible') {
      const vertices = solution.cut?.vertices;
      if (!Array.isArray(vertices) || !vertices.length || vertices.some((v, i) => !Number.isInteger(v) || v < 0 || v >= network.n || i > 0 && v <= vertices[i - 1])) return false;
      const set = new Set(vertices), deficit = vertices.reduce((sum, v) => sum + network.balances[v], 0) - network.edges.filter(e => set.has(e.u) && !set.has(e.v)).reduce((sum, e) => sum + e.capacity, 0);
      return deficit > 0 && solution.cut.deficit === deficit;
    }
    if (solution?.status !== 'optimal' || !validFlow(network, solution.flow) || !integer(solution.objective) || !integer(solution.dualObjective) || !Array.isArray(solution.potentials) || solution.potentials.length !== network.n || !solution.potentials.every(integer)) return false;
    const p = solution.potentials.map(BigInt), cost = objective(network, solution.flow);
    let dual = -network.balances.reduce((sum, value, v) => sum + BigInt(value) * p[v], 0n);
    for (const [i, edge] of network.edges.entries()) {
      const r = BigInt(edge.cost) + p[edge.u] - p[edge.v];
      if (solution.flow[i] < edge.capacity && r < 0n || solution.flow[i] > 0 && r > 0n) return false;
      dual += BigInt(edge.capacity) * (r < 0n ? r : 0n);
    }
    return String(cost) === solution.objective && String(dual) === solution.dualObjective && cost === dual;
  } catch { return false; }
}
/** Tiny held-outs use exhaustive integer assignments, independent of a submission optimizer. */
function bruteFlow(network) {
  let best = null, witness = null; const flow = Array(network.edges.length).fill(0), balance = Array(network.n).fill(0);
  function visit(index, cost) {
    if (index === network.edges.length) { if (balance.every((v, i) => v === network.balances[i]) && (best === null || cost < best)) { best = cost; witness = [...flow]; } return; }
    const e = network.edges[index]; for (let f = 0; f <= e.capacity; f++) { flow[index] = f; balance[e.u] += f; balance[e.v] -= f; visit(index + 1, cost + BigInt(e.cost) * BigInt(f)); balance[e.u] -= f; balance[e.v] += f; }
  }
  visit(0, 0n); return { objective: best === null ? null : String(best), flow: witness };
}
function expectedResidual(network, flow) {
  return network.edges.flatMap((e, i) => [
    ...(flow[i] < e.capacity ? [{ edgeID: e.id, u: e.u, v: e.v, capacity: e.capacity - flow[i], cost: e.cost, direction: 'forward' }] : []),
    ...(flow[i] > 0 ? [{ edgeID: e.id, u: e.v, v: e.u, capacity: flow[i], cost: String(-BigInt(e.cost)), direction: 'backward' }] : []),
  ]);
}
function assertDecomposition(network, flow, result) {
  assert.ok(result && Array.isArray(result.paths) && Array.isArray(result.cycles));
  const recovered = Array(flow.length).fill(0), balance = Array(network.n).fill(0);
  for (const [kind, entries] of [['paths', result.paths], ['cycles', result.cycles]]) for (const item of entries) {
    assert.ok(Number.isSafeInteger(item.amount) && item.amount > 0 && Array.isArray(item.edgeIDs) && item.edgeIDs.length > 0 && Array.isArray(item.vertices) && item.vertices.length === item.edgeIDs.length + 1);
    if (kind === 'cycles') { assert.equal(item.vertices[0], item.vertices.at(-1)); assert.equal(new Set(item.vertices.slice(0, -1)).size, item.vertices.length - 1); }
    else { assert.equal(new Set(item.vertices).size, item.vertices.length); assert.ok(network.balances[item.vertices[0]] > 0 && network.balances[item.vertices.at(-1)] < 0); balance[item.vertices[0]] += item.amount; balance[item.vertices.at(-1)] -= item.amount; }
    item.edgeIDs.forEach((id, i) => { const index = network.edges.findIndex(e => e.id === id); assert.ok(index >= 0); const e = network.edges[index]; assert.equal(e.u, item.vertices[i]); assert.equal(e.v, item.vertices[i + 1]); recovered[index] += item.amount; });
  }
  assert.deepEqual(recovered, flow); assert.deepEqual(balance, network.balances);
}
function random(seed) { let value = seed >>> 0; return max => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % max; }; }
function networkCases() {
  const cases = [networkSample, { n: 1, balances: [0], edges: [] }, { n: 1, balances: [0], edges: [{ id: 'loop', u: 0, v: 0, capacity: 3, cost: '-9007199254740993' }] },
    { n: 2, balances: [2, -2], edges: [{ id: 'bottleneck', u: 0, v: 1, capacity: 1, cost: '0' }] },
    { n: 2, balances: [0, 0], edges: [{ id: 'a', u: 0, v: 1, capacity: 2, cost: '-5' }, { id: 'b', u: 1, v: 0, capacity: 1, cost: '2' }] }];
  const rng = random(928731);
  for (let k = 0; k < 12; k++) {
    const n = 3 + rng(2), edges = Array.from({ length: 5 + rng(3) }, (_, i) => ({ id: 'e' + i, u: rng(n), v: rng(n), capacity: rng(3), cost: String((k % 3 === 0 ? 100000000000000003n : 0n) + BigInt(rng(17) - 8)) }));
    const balances = Array(n).fill(0); edges.forEach(e => { const f = rng(e.capacity + 1); balances[e.u] += f; balances[e.v] -= f; });
    if (k % 4 === 0) { balances[0] += 3; balances[n - 1] -= 3; }
    cases.push({ n, balances, edges });
  }
  // A larger six-route resource network remains independently enumerable (2^12).
  const edges = []; for (let v = 1; v <= 6; v++) edges.push({ id: 'in' + v, u: 0, v, capacity: 1, cost: String(9007199254740993n + BigInt(v * v)) }, { id: 'out' + v, u: v, v: 7, capacity: 1, cost: '-9007199254740993' });
  cases.push({ n: 8, balances: [3, 0, 0, 0, 0, 0, 0, -3], edges }); return cases;
}

function components(graph, active = graph.edges.map(e => e.id), excluded = -1) {
  const set = new Set(active), remaining = new Set(Array.from({ length: graph.n }, (_, v) => v).filter(v => v !== excluded)), result = [];
  while (remaining.size) {
    const queue = [remaining.values().next().value]; remaining.delete(queue[0]);
    for (let i = 0; i < queue.length; i++) for (const e of graph.edges) if (set.has(e.id) && e.u !== excluded && e.v !== excluded) {
      const next = e.u === queue[i] ? e.v : e.v === queue[i] ? e.u : -1;
      if (remaining.has(next)) { remaining.delete(next); queue.push(next); }
    }
    result.push(queue.sort((a, b) => a - b));
  }
  return result;
}
function probability(coefficients, p, exponent) {
  const a = BigInt(p.numerator), b = BigInt(p.denominator); let total = 0n;
  coefficients.forEach((count, k) => { total += BigInt(count) * a ** BigInt(k) * (b - a) ** BigInt(exponent - k); });
  return fraction(total, b ** BigInt(exponent));
}
/** Independent subset enumeration: count edge configurations, not a submitted determinant/DP. */
function graphOracle(graph) {
  const m = graph.edges.length, counts = Array(m + 1).fill(0n), edgeTrees = Array(m).fill(0n), forced = graph.edges.map(() => [Array(m).fill(0n), Array(m).fill(0n)]); let trees = 0n;
  for (let mask = 0; mask < 2 ** m; mask++) {
    const active = []; let k = 0; for (let e = 0; e < m; e++) if (mask & 2 ** e) { active.push(graph.edges[e].id); k++; }
    if (components(graph, active).length !== 1) continue;
    counts[k]++; if (k === graph.n - 1) { trees++; for (let e = 0; e < m; e++) if (mask & 2 ** e) edgeTrees[e]++; }
    for (let e = 0; e < m; e++) { const present = mask & 2 ** e ? 1 : 0; forced[e][present][k - present]++; }
  }
  return { trees: { count: String(trees), edgeCounts: graph.edges.map((e, i) => ({ id: e.id, count: String(edgeTrees[i]) })) },
    reliability: { connectedBySize: counts.map(String), probability: probability(counts, graph.p, m), influence: graph.edges.map((e, i) => ({ id: e.id, ...minusFraction(probability(forced[i][1], graph.p, m - 1), probability(forced[i][0], graph.p, m - 1)) })) } };
}
function graphStructure(graph) {
  const baseline = components(graph).length;
  return { bridges: graph.edges.flatMap(e => { const value = components(graph, graph.edges.filter(other => other.id !== e.id).map(other => other.id)); return value.length > baseline ? [{ id: e.id, components: value }] : []; }),
    articulations: Array.from({ length: graph.n }, (_, v) => v).flatMap(vertex => { const value = components(graph, undefined, vertex); return value.length > baseline ? [{ vertex, components: value }] : []; }) };
}
function graphTransforms(graph) {
  return { deletions: graph.edges.map(e => ({ id: e.id, graph: { ...graph, edges: graph.edges.filter(other => other.id !== e.id) } })),
    contractions: graph.edges.map(e => { const low = Math.min(e.u, e.v), high = Math.max(e.u, e.v), remap = v => e.u === e.v ? v : (v === high ? low : v) - (v > high ? 1 : 0);
      return { id: e.id, graph: { n: graph.n - Number(e.u !== e.v), edges: graph.edges.filter(other => other.id !== e.id).map(other => ({ id: other.id, u: remap(other.u), v: remap(other.v) })), p: graph.p } }; }) };
}
function assertGraphWitness(graph, witness) {
  const c = components(graph);
  if (c.length > 1) { assert.equal(witness.treeEdgeIDs, null); assert.deepEqual(witness.disconnectedComponents, c); return; }
  assert.equal(witness.disconnectedComponents, null); assert.ok(Array.isArray(witness.treeEdgeIDs)); assert.equal(witness.treeEdgeIDs.length, graph.n - 1);
  assert.equal(new Set(witness.treeEdgeIDs).size, graph.n - 1); assert.ok(witness.treeEdgeIDs.every(id => graph.edges.some(e => e.id === id))); assert.equal(components(graph, witness.treeEdgeIDs).length, 1);
}
function graphCases() {
  const cases = [{ n: 1, edges: [], p: { numerator: '0', denominator: '7' } }, graphSample,
    { n: 3, edges: [{ id: 'a', u: 0, v: 1 }, { id: 'b', u: 0, v: 1 }, { id: 'loop', u: 1, v: 1 }], p: { numerator: '1', denominator: '1' } },
    { n: 4, edges: Array.from({ length: 4 }, (_, u) => Array.from({ length: 3 - u }, (_, i) => ({ id: 'k' + u + (u + i + 1), u, v: u + i + 1 }))).flat(), p: { numerator: '9007199254740993', denominator: '1000000000000000000' } }];
  const rng = random(880193);
  for (let k = 0; k < 7; k++) { const n = 2 + rng(4); cases.push({ n, edges: Array.from({ length: 4 + rng(5) }, (_, i) => ({ id: 'e' + i, u: rng(n), v: rng(n) })), p: { numerator: String(k % 3), denominator: '3' } }); }
  const edges = Array.from({ length: 12 }, (_, i) => ({ id: 'wide' + i, u: i % 6, v: (i % 6 + 1 + Math.floor(i / 6)) % 6 }));
  cases.push({ n: 6, edges, p: { numerator: '999999999999999999', denominator: '1000000000000000000' } }); return cases;
}

export async function verifyMathMission(id, root) {
  const fixture = mathMissions.find(value => value.id === id); if (!fixture) throw RangeError('unknown_math_mission');
  return verifyMission(fixture, root, async ({ invoke, check }) => {
    if (id === 'exact-circulation') await gradeNetworks(invoke, check);
    else await gradeGraphs(invoke, check);
  });
}
async function gradeNetworks(invoke, check) {
  const networks = networkCases(), oracle = networks.map(bruteFlow);
  const call = (file, name, args) => invoke(file, name, [args]);
  await check('network.validation', async () => assert.deepEqual(await call('validate.mjs', 'validateNetworks', networks), networks));
  await check('network.validation_rejects_bad_domain', async () => { for (const bad of [{ ...networkSample, balances: [1, 0, 0] }, { ...networkSample, edges: [{ ...networkSample.edges[0], cost: '-0' }] }, { ...networkSample, edges: [{ ...networkSample.edges[0], cost: '1000000000000000001' }] }, { ...networkSample, edges: [{ ...networkSample.edges[0], capacity: 9 }] }, { ...networkSample, edges: [networkSample.edges[0], networkSample.edges[0]] }, { ...networkSample, balances: [1.5, 0, -1.5] }]) await assert.rejects(call('validate.mjs', 'validateNetworks', [bad])); });
  const flowCases = networks.map(network => ({ network, flow: network.edges.map(e => Math.min(1, e.capacity)) }));
  await check('network.exact_cost', async () => { assert.deepEqual(await call('cost.mjs', 'costFlows', flowCases), flowCases.map(c => String(objective(c.network, c.flow)))); await assert.rejects(call('cost.mjs', 'costFlows', [{ network: networkSample, flow: [3, 0, 0] }])); });
  await check('network.residual_arcs', async () => assert.deepEqual(await call('residual.mjs', 'residualNetworks', flowCases), flowCases.map(c => expectedResidual(c.network, c.flow))));
  await check('network.primal_dual_optimality', async () => { const result = await call('solver.mjs', 'solveNetworks', networks); assert.equal(result.length, networks.length); result.forEach((solution, i) => { assert.ok(validCertificate(networks[i], solution), 'certificate invalid'); assert.equal(solution.status, oracle[i].objective === null ? 'infeasible' : 'optimal'); if (solution.status === 'optimal') assert.equal(solution.objective, oracle[i].objective); }); });
  // Audit inputs are constructed separately, never optimizer-oracle answers.
  // A certificate is the audit API's input; its truth label remains parent-side.
  const auditCases = networks.map(value => {
    const network = structuredClone(value), flow = network.edges.map(e => Math.min(1, e.capacity)); network.balances.fill(0);
    network.edges.forEach((e, i) => { e.cost = '0'; network.balances[e.u] += flow[i]; network.balances[e.v] -= flow[i]; });
    return { network, solution: { status: 'optimal', flow, objective: '0', dualObjective: '0', potentials: Array(network.n).fill('11') } };
  });
  auditCases.push({ network: { n: 2, balances: [1,-1], edges: [] }, solution: { status: 'infeasible', cut: { vertices: [0], deficit: 1 } } },
    { network: { n: 2, balances: [1,-1], edges: [{ id:'priced',u:0,v:1,capacity:2,cost:'3' }] }, solution: { status:'optimal', flow:[1], objective:'3', dualObjective:'3', potentials:['0','3'] } });
  await check('network.independent_audit_valid', async () => assert.deepEqual(await call('audit.mjs', 'auditNetworks', auditCases), auditCases.map(() => ({ valid: true }))));
  const basis = auditCases[0];
  const forged = [ { ...basis, solution: { ...basis.solution, objective: '1' } },
    { ...basis, solution: { ...basis.solution, dualObjective: '1' } }, { ...basis, solution: { status: 'infeasible', cut: { vertices: [0], deficit: 99 } } },
    { ...basis, solution: { ...basis.solution, flow: [0, 0, 0] } }, { ...basis, solution: null } ];
  await check('network.independent_audit_forged', async () => assert.deepEqual(await call('audit.mjs', 'auditNetworks', forged), forged.map(() => ({ valid: false }))));
  const expectedSensitivity = network => network.edges.map((e, index) => ({ edgeID: e.id, ...Object.fromEntries([['minus', -1], ['plus', 1]].map(([key, delta]) => {
    if (e.capacity + delta < 0 || e.capacity + delta > 8) return [key, null]; const perturbed = structuredClone(network); perturbed.edges[index].capacity += delta; const value = bruteFlow(perturbed).objective; return [key, { status: value === null ? 'infeasible' : 'optimal', objective: value }];
  })) }));
  const sensitivityCases = networks.slice(0, 10);
  await check('network.capacity_sensitivity', async () => assert.deepEqual(await call('sensitivity.mjs', 'analyzeCapacity', sensitivityCases), sensitivityCases.map(expectedSensitivity)));
  const feasible = networks.map(value => {
    const network = structuredClone(value), flow = network.edges.map(e => e.capacity); network.balances.fill(0);
    network.edges.forEach((e, i) => { network.balances[e.u] += flow[i]; network.balances[e.v] -= flow[i]; });
    return { network, flow };
  });
  await check('network.constructive_decomposition', async () => { const result = await call('decompose.mjs', 'decomposeFlows', feasible); assert.equal(result.length, feasible.length); result.forEach((r, i) => assertDecomposition(feasible[i].network, feasible[i].flow, r)); });
  const reports = networks.slice(0, 5);
  await check('network.integrated_reports', async () => { const result = await call('report.mjs', 'reportNetworks', reports); assert.equal(result.length, reports.length); result.forEach((r, i) => { assert.ok(validCertificate(reports[i], r.solution)); assert.deepEqual(r.audit, { valid: true }); assert.deepEqual(r.sensitivity, expectedSensitivity(reports[i])); if (r.solution.status === 'optimal') assertDecomposition(reports[i], r.solution.flow, r.decomposition); else assert.equal(r.decomposition, null); }); });
}
async function gradeGraphs(invoke, check) {
  const graphs = graphCases(), expected = graphs.map(graphOracle), call = (file, name, args) => invoke(file, name, [args]);
  await check('graph.validation', async () => assert.deepEqual(await call('validate.mjs', 'validateGraphs', graphs), graphs));
  await check('graph.validation_rejects_bad_domain', async () => { for (const bad of [{ ...graphSample, p: { numerator: '2', denominator: '1' } }, { ...graphSample, edges: [{ id: 'a', u: 0, v: 99 }] }, { ...graphSample, edges: [graphSample.edges[0], graphSample.edges[0]] }, { ...graphSample, n: 1.5 }, { ...graphSample, p: { numerator: '-0', denominator: '1' } }, { ...graphSample, p: { numerator: '1', denominator: '1000000000000000001' } }]) await assert.rejects(call('validate.mjs', 'validateGraphs', [bad])); });
  const selected = graphs.map(graph => ({ graph, activeEdgeIDs: graph.edges.filter((_, i) => i % 2 === 0).map(e => e.id) }));
  await check('graph.selected_connectivity', async () => { assert.deepEqual(await call('components.mjs', 'componentGraphs', selected), selected.map(c => { const value = components(c.graph, c.activeEdgeIDs); return { components: value, connected: value.length === 1 }; })); await assert.rejects(call('components.mjs', 'componentGraphs', [{ graph: graphSample, activeEdgeIDs: ['unknown-edge'] }])); });
  await check('graph.exact_spanning_trees', async () => { const result = await call('trees.mjs', 'treeGraphs', graphs); assert.deepEqual(result, expected.map(e => e.trees)); result.forEach((r, i) => { assert.ok(natural(r.count)); assert.equal(r.edgeCounts.reduce((sum, e) => sum + BigInt(e.count), 0n), BigInt(graphs[i].n - 1) * BigInt(r.count)); }); });
  await check('graph.reliability_precision_and_influence', async () => assert.deepEqual(await call('reliability.mjs', 'reliabilityGraphs', graphs), expected.map(e => e.reliability)));
  await check('graph.bridge_articulation_witnesses', async () => assert.deepEqual(await call('structure.mjs', 'structureGraphs', graphs), graphs.map(graphStructure)));
  await check('graph.canonical_deletion_contraction', async () => {
    const result = await call('transform.mjs', 'transformGraphs', graphs); assert.deepEqual(result, graphs.map(graphTransforms));
    const edges = [1, 3].flatMap(index => graphs[index].edges.slice(0, 4).map((edge, i) => ({ index, edge, deletion: result[index].deletions[i].graph, contraction: result[index].contractions[i].graph })));
    const probabilities = await call('reliability.mjs', 'reliabilityGraphs', edges.flatMap(value => [value.deletion, value.contraction]));
    edges.forEach((value, i) => {
      const p = graphs[value.index].p, a = BigInt(p.numerator), b = BigInt(p.denominator), d = probabilities[2 * i].probability, c = probabilities[2 * i + 1].probability;
      const combined = fraction((b-a)*BigInt(d.numerator)*BigInt(c.denominator)+a*BigInt(c.numerator)*BigInt(d.denominator),b*BigInt(d.denominator)*BigInt(c.denominator));
      assert.deepEqual(combined, expected[value.index].reliability.probability);
    });
  });
  await check('graph.constructive_tree_or_cut', async () => { const result = await call('witness.mjs', 'witnessGraphs', graphs); assert.equal(result.length, graphs.length); result.forEach((r, i) => assertGraphWitness(graphs[i], r)); });
  const integrated = graphs.slice(0, 4);
  await check('graph.integrated_reports', async () => { const result = await call('report.mjs', 'reportGraphs', integrated); assert.equal(result.length, integrated.length); result.forEach((r, i) => { const c = components(integrated[i]); assert.deepEqual(r.components, { components: c, connected: c.length === 1 }); assert.deepEqual(r.trees, expected[i].trees); assert.deepEqual(r.reliability, expected[i].reliability); assert.deepEqual(r.structure, graphStructure(integrated[i])); assert.deepEqual(r.transforms, graphTransforms(integrated[i])); assertGraphWitness(integrated[i], r.witness); }); });
}
