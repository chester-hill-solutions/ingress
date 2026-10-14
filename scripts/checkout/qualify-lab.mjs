// Offline independent repository scenarios. Extraction never receives the oracle.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { extractBindings } from './binding-producer.mjs';
import { bindingCases, checkBindingCase } from './binding-cases.mjs';
import { normalizeGraph, sourceRevision } from '../../src/prototypes/checkout/graph-index.mjs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
import { GraphCheckout } from '../../src/prototypes/checkout/graph-checkout.mjs';

const { values } = parseArgs({ options: { python: { type: 'string' }, repo: { type: 'string' }, output: { type: 'string' } } });
if (!values.python) throw new Error('Pass --python=/path/to/python/with/graphifyy==0.9.62');
const repo = resolve(values.repo ?? '../checkout-arbiter-lab');
const run = resolve(values.output ?? `artifacts/checkout-qualification-${Date.now()}`);
mkdirSync(run); // Never overwrite an assigned run.
const sourceRoot = resolve(run, 'source');
const files = Object.fromEntries(readdirSync(resolve(repo, 'src')).filter(path => path.endsWith('.mjs')).sort()
  .map(path => [`src/${path}`, readFileSync(resolve(repo, 'src', path), 'utf8')]));
const contractText = readFileSync(resolve(repo, 'contracts.json'), 'utf8');
const contracts = JSON.parse(contractText);
for (const [path, text] of Object.entries(files)) {
  const file = resolve(sourceRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, 0o444);
}
writeFileSync(resolve(run, 'contracts.json'), contractText);
const graphify = resolve(dirname(values.python), 'graphify');
const producerRoot = resolve(run, 'producer');
const environment = { PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
  GRAPHIFY_QUERY_LOG_DISABLE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
const version = spawnSync(graphify, ['--version'], { encoding: 'utf8', timeout: 10_000, env: environment });
if (version.status !== 0 || !version.stdout.includes('graphify 0.9.62')) throw new Error('unexpected_graphify_version');
const extraction = spawnSync(graphify, ['extract', sourceRoot, '--code-only', '--no-cluster', '--out', producerRoot,
  '--max-workers', '1'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: environment });
writeFileSync(resolve(run, 'producer.log'), extraction.stdout + extraction.stderr);
if (extraction.error || extraction.status !== 0) throw new Error('graphify_failed');
const graph = JSON.parse(readFileSync(resolve(producerRoot, 'graphify-out/graph.json')));
const scanned = graph.extracted_sources.map(path => relative(sourceRoot, path)).sort();
if (JSON.stringify(scanned) !== JSON.stringify(Object.keys(files).sort()) || graph.input_tokens || graph.output_tokens) throw new Error('graphify_coverage_or_tokens');
const raw = { producer: { name: 'graphifyy', version: '0.9.62', schema: 'raw-extraction' }, sourceRevision: sourceRevision(files), graph };
const baselineAst = extractBindings(files, values.python);
writeFileSync(resolve(run, 'baseline-ast.json'), JSON.stringify(baselineAst, null, 2) + '\n');
const index = normalizeGraph({ files, ast: baselineAst, contracts, raw });
writeFileSync(resolve(run, 'index.json'), JSON.stringify({ ...index, catalog: undefined }, null, 2) + '\n');
let buildNumber = 0, validationNumber = 0;
const buildIndex = candidate => {
  const ast = extractBindings(candidate, values.python);
  writeFileSync(resolve(run, `candidate-ast-${++buildNumber}.json`), JSON.stringify(ast, null, 2) + '\n');
  return normalizeGraph({ files: candidate, ast, contracts, ...(sourceRevision(candidate) === index.revision ? { raw } : {}) });
};
const behaviorSource = resolve(repo, 'test/behavior.test.mjs');
const validate = candidate => {
  const destination = resolve(run, `validation-${++validationNumber}`);
  for (const [path, text] of Object.entries(candidate)) {
    mkdirSync(dirname(resolve(destination, path)), { recursive: true }); writeFileSync(resolve(destination, path), text);
  }
  mkdirSync(resolve(destination, 'checks'));
  copyFileSync(behaviorSource, resolve(destination, 'checks/behavior-check.mjs'));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', 'checks/behavior-check.mjs'], {
    cwd: destination, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(resolve(destination, 'behavior.log'), result.stdout + result.stderr);
  return !result.error && result.status === 0;
};
const baselineValid = validate(files);
const bindingRows = [];
for (const scenario of bindingCases) {
  const ast = extractBindings(scenario.files, values.python);
  writeFileSync(resolve(run, `binding-${scenario.id}.json`), JSON.stringify({ files: scenario.files, ast }, null, 2) + '\n');
  let result, refusal = null;
  try { result = normalizeGraph({ files: scenario.files, ast }); }
  catch (error) { refusal = error.message; }
  bindingRows.push({ id: scenario.id, refusal, passed: scenario.refusal ? refusal === scenario.refusal
    : !!result && checkBindingCase(scenario, result) });
}

// Oracles are consumed only after producer/index construction and by the evaluator.
const oracleText = readFileSync(resolve(repo, 'test/checkout-cases.json'), 'utf8');
writeFileSync(resolve(run, 'assigned-oracles.json'), oracleText);
const oracle = JSON.parse(oracleText), rows = [];
const req = (symbol, actor) => ({ participantId: actor, writes: [{ blockId: `${symbol.path}#${symbol.symbol}` }] });
for (const scenario of oracle.cases) {
  const system = new GraphCheckout({ files, buildIndex: () => index, validate });
  // Use an initial pinned index; trusted candidate producer must run for submissions.
  const fresh = scenario.mutation ? new GraphCheckout({ files, buildIndex, validate }) : system;
  const a = fresh.checkout(req(scenario.a, 'a'), 0);
  const b = scenario.b ? fresh.checkout(req(scenario.b, 'b'), 0) : null;
  let submission = null, candidate = null;
  if (scenario.mutation && a.granted) {
    const m = scenario.mutation;
    if (a.files[m.path].split(m.search).length !== 2) throw new Error('mutation_anchor_changed');
    candidate = { [m.path]: (m.prepend ?? '') + a.files[m.path].replace(m.search, m.replace) };
    submission = fresh.submit({ checkoutId: a.checkoutId, participantId: 'a', files: candidate }, 1);
    writeFileSync(resolve(run, `${scenario.id}-candidate.json`), JSON.stringify(candidate, null, 2) + '\n');
  }
  const forbiddenPresent = scenario.forbiddenEdge && index.edges.some(edge => edge.from === scenario.forbiddenEdge.from && edge.to === scenario.forbiddenEdge.to);
  const actual = submission ? submission.reason ?? (submission.admitted ? 'admitted' : 'refused')
    : !a.granted && a.reason === 'unresolved_dependency' || b?.reason === 'unresolved_dependency' ? 'unknown'
      : a.granted && b?.granted ? 'allow' : b?.reason === 'checkout_conflict' ? 'block' : a.reason ?? b?.reason ?? 'unclassified';
  const matches = scenario.expected === 'validation_refuse' ? actual === 'validation_failed'
    : actual === scenario.expected;
  const unchangedOnRefusal = !submission || submission.admitted || sourceRevision(fresh.snapshot(1).files) === index.revision;
  const summary = result => result && Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'files'));
  rows.push({ id: scenario.id, expected: scenario.expected, actual, passed: matches && !forbiddenPresent && unchangedOnRefusal,
    a: summary(a), b: summary(b), submission, unchangedOnRefusal, forbiddenEdgePresent: !!forbiddenPresent });
  console.log(`${scenario.id}: ${actual} ${rows.at(-1).passed ? 'PASS' : 'FAIL'}`);
}
// Actual two-edit publication on different functions in one file, using independent
// behavior validation and fresh graphs, then a same-file edit outside the grant.
const publish = new GraphCheckout({ files, buildIndex, validate });
const a = publish.checkout(req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }, 'a'), 0);
const b = publish.checkout(req({ path: 'src/pricing.mjs', symbol: 'shippingFee' }, 'b'), 0);
const edit = (grant, anchor, comment) => grant.files['src/pricing.mjs'].replace(anchor, `  // ${comment}\n${anchor}`);
const first = publish.submit({ checkoutId: a.checkoutId, participantId: 'a', files: {
  'src/pricing.mjs': edit(a, '  return Math.round', 'round cents explicitly') } }, 1);
const second = publish.submit({ checkoutId: b.checkoutId, participantId: 'b', files: {
  'src/pricing.mjs': edit(b, '  return weightGrams', 'choose the parcel rate') } }, 2);
const published = publish.snapshot(2);
const c = publish.checkout(req({ path: 'src/pricing.mjs', symbol: 'discountSubtotal' }, 'c'), 3);
const outside = publish.submit({ checkoutId: c.checkoutId, participantId: 'c', files: {
  'src/pricing.mjs': c.files['src/pricing.mjs'].replace('weightGrams < 0', 'weightGrams < 1') } }, 4);
const publication = { first, second, outside, bothCommentsSurvive: published.files['src/pricing.mjs'].includes('round cents explicitly')
  && published.files['src/pricing.mjs'].includes('choose the parcel rate'), graphMatchesCode: published.graphRevision === sourceRevision(published.files),
  refusedOutsideUnchanged: sourceRevision(publish.snapshot(4).files) === published.graphRevision };
publication.passed = first.admitted && second.admitted && second.merged.includes('src/pricing.mjs')
  && publication.bothCommentsSurvive && publication.graphMatchesCode && outside.reason === 'outside_modification_scope' && publication.refusedOutsideUnchanged;
const report = { schema: 1, repo, run, sourceRevision: index.revision, assigned: rows.length, arbiterInvoked: true,
  baselineValid, implementationHashes: Object.fromEntries(['bindings.py', 'binding-producer.mjs', 'qualify-lab.mjs',
    '../../src/prototypes/checkout/graph-index.mjs', '../../src/prototypes/checkout/graph-checkout.mjs'].map(path =>
    [path, hashText(readFileSync(resolve(import.meta.dirname, path)))])), blocks: index.blocks.length, edges: index.edges.length, unknown: index.unknown,
  rawRejectedCalls: index.rawDecisions.filter(edge => edge.relation === 'calls' && !edge.eligible),
  cases: rows, bindingCases: bindingRows, publication, passed: baselineValid && rows.every(row => row.passed) && publication.passed && bindingRows.every(row => row.passed),
  productionReady: false, enforcement: 'local trusted synchronous submission; memory-only; no authenticated durable grants',
  behaviorValidations: validationNumber, graphBuilds: buildNumber };
writeFileSync(resolve(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ run, passed: report.passed, scenarios: rows.filter(r => r.passed).length,
  assigned: rows.length, bindingCases: bindingRows, publication, blocks: index.blocks.length, edges: index.edges.length, graphBuilds: buildNumber }, null, 2));
if (!report.passed) process.exitCode = 1;
