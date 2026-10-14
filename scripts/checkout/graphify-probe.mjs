#!/usr/bin/env node
// Optional producer qualification. Node owns snapshots, oracles and retained outcomes.
import { readdir, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { graphifyFiles, spanOracles, callOracles, productCallOracles, productSpanOracles } from './graphify-fixture.mjs';

const { values } = parseArgs({ options: { python: { type: 'string' }, output: { type: 'string' } } });
if (!values.python) throw new Error('Pass --python=/path/to/an/isolated/python/with/graphifyy==0.9.62');
const root = resolve(import.meta.dirname, '../..');
const run = resolve(values.output ?? `artifacts/graphify-qualification-${Date.now()}`);
await mkdir(run); // A new run never replaces a previous outcome.
const python = resolve(values.python), graphify = resolve(dirname(python), 'graphify');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUNBUFFERED: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };

async function command(executable, args, name) {
  const started = performance.now();
  return new Promise(resolveResult => {
    const child = spawn(executable, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let total = 0, overflow = false, timedOut = false;
    const collect = chunk => { total += chunk.length; if (total <= 4 * 1024 * 1024) chunks.push(chunk); else { overflow = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
    let error = null;
    child.on('error', value => { error = value.message; });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await writeFile(resolve(run, `${name}.log`), Buffer.concat(chunks));
      resolveResult({ name, code, signal, error, overflow, timedOut, durationMs: Math.round(performance.now() - started) });
    });
  });
}

async function freeze(files, destination) {
  const manifest = [];
  for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const target = resolve(destination, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); await chmod(target, 0o444);
    manifest.push({ path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
  }
  return { files: manifest, manifestHash: hash(JSON.stringify(manifest)) };
}

const sourceFiles = {};
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && path.endsWith('.mjs')) sourceFiles[relative(root, path)] = await readFile(path);
  }
}
await collect(resolve(root, 'src/product'));
const productRoot = resolve(run, 'product-source'), featureRoot = resolve(run, 'feature-source'), brokenRoot = resolve(run, 'broken-source');
const report = { schema: 1, createdAt: new Date().toISOString(), producer: { package: 'graphifyy', version: '0.9.62', codeOnly: true },
  productManifest: await freeze(sourceFiles, productRoot), featureManifest: await freeze(graphifyFiles, featureRoot),
  brokenManifest: await freeze({ 'broken.mjs': 'export function valid() { return 1; }\nexport function broken( {\n' }, brokenRoot),
  executions: [], checks: [], warnings: [], scope: 'outer MJS product source and explicit edge-case fixtures',
  usefulBenefitQualified: false, productionReady: false };
await writeFile(resolve(run, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
report.executions.push(await command(graphify, ['--version'], 'version'));
if (!(await readFile(resolve(run, 'version.log'), 'utf8')).includes('graphify 0.9.62')) throw new Error('unexpected_graphify_version');

function check(name, passed, detail = null) { report.checks.push({ name, passed, ...(detail === null ? {} : { detail }) }); }
function arc(edge) { return [edge._src ?? edge.source, edge._tgt ?? edge.target]; }
function checkCalls(graph, oracles, label) {
  for (const oracle of oracles) {
    const from = graph.nodes.filter(node => node.source_file === oracle.from[0] && node.label === oracle.from[1]);
    const to = graph.nodes.filter(node => node.source_file === oracle.to[0] && node.label === oracle.to[1]);
    const found = from.length === 1 && to.length === 1 && graph.edges.some(edge => {
      const [source, target] = arc(edge); return source === from[0].id && target === to[0].id && edge.relation === 'calls';
    });
    check(`${label}: ${oracle.name}`, found, { sourceMatches: from.length, targetMatches: to.length });
  }
}

for (const [name, source, manifest, oracles, spans] of [
  ['product', productRoot, report.productManifest, productCallOracles, productSpanOracles],
  ['features', featureRoot, report.featureManifest, callOracles, spanOracles],
  ['broken', brokenRoot, report.brokenManifest, [], []],
]) {
  const destination = resolve(run, `${name}-producer`);
  const extraction = await command(graphify, ['extract', source, '--code-only', '--no-cluster', '--out', destination, '--max-workers', '1', '--timing'], `${name}-extract`);
  report.executions.push(extraction);
  const graphPath = resolve(destination, 'graphify-out/graph.json');
  if (extraction.code !== 0 || extraction.error || extraction.overflow || extraction.timedOut) {
    check(`${name}: extraction completed`, false, extraction); continue;
  }
  const graph = JSON.parse(await readFile(graphPath, 'utf8'));
  const inspectionPath = resolve(run, `${name}-inspection.json`);
  const inspectionRun = await command(python, [resolve(root, 'scripts/checkout/graphify-inspect.py'), source, graphPath, inspectionPath], `${name}-inspect`);
  report.executions.push(inspectionRun);
  if (inspectionRun.code !== 0 || inspectionRun.error) { check(`${name}: AST inspection completed`, false, inspectionRun); continue; }
  const inspection = JSON.parse(await readFile(inspectionPath, 'utf8'));
  const ids = new Set(graph.nodes.map(node => node.id));
  const dangling = graph.edges.filter(edge => { const [a, b] = arc(edge); return !ids.has(a) || !ids.has(b); });
  report[name] = { files: manifest.files.length, extractedSources: graph.extracted_sources.length,
    nodes: graph.nodes.length, edges: graph.edges.length, representation: 'raw-extraction',
    producerSchemaVersion: graph.graph?.schema_version ?? null,
    reportedTokens: { input: graph.input_tokens, output: graph.output_tokens },
    nativeEndSpans: graph.nodes.filter(node => node.end_line || node.endLine || node.end_byte || node.endByte).length,
    callableNodes: graph.nodes.filter(node => node._callable).length,
    adapterMappedCallables: inspection.spans.length, unmappedCallables: inspection.unmappedCallableNodes,
    parseErrorFiles: inspection.files.filter(file => file.hasError).map(file => file.path),
    callSites: inspection.callSites.length, callSitesWithoutMatchingGraphEdge: inspection.callSites.filter(call => !call.graphTargets.length).length,
    danglingEdges: dangling.map(edge => ({ source: arc(edge)[0], target: arc(edge)[1], relation: edge.relation, path: edge.source_file })),
    coverage: inspection.coverage };
  const exactSources = [...graph.extracted_sources].sort().map(path => relative(source, path));
  check(`${name}: exact source coverage`, JSON.stringify(exactSources) === JSON.stringify(manifest.files.map(file => file.path).sort()));
  let intact = true;
  for (const file of manifest.files) if (hash(await readFile(resolve(source, file.path))) !== file.sha256) intact = false;
  check(`${name}: source bytes unchanged`, intact);
  check(`${name}: no model tokens`, graph.input_tokens === 0 && graph.output_tokens === 0);
  check(`${name}: AST parse diagnostics`, name === 'broken' ? inspection.files.some(file => file.hasError) : inspection.files.every(file => !file.hasError));
  checkCalls(graph, oracles, name);
  for (const span of spans) {
    const matches = inspection.spans.filter(actual => actual.path === span.path && actual.name === span.name && actual.startLine === span.startLine);
    const actual = matches.length === 1 ? matches[0] : null;
    const bytes = await readFile(resolve(source, span.path));
    check(`${name}: ${span.name} range at line ${span.startLine}`, !!actual && actual.endLine === span.endLine
      && actual.fileHash === hash(bytes) && bytes.subarray(actual.startByte, actual.endByte).toString('utf8').trimEnd().endsWith('}'), actual);
  }
  if (name === 'features') {
    const shadow = graph.nodes.find(node => node.label === 'shadow()');
    const increment = graph.nodes.find(node => node.label === 'increment()');
    check('features: parameter shadowing does not invent an imported call', !!shadow && !!increment && !graph.edges.some(edge => arc(edge)[0] === shadow.id && arc(edge)[1] === increment.id && edge.relation === 'calls'));
    const dynamic = inspection.callSites.find(call => call.owner === 'dynamic' && call.callee === 'target[key]');
    check('features: computed dispatch remains unresolved', !!dynamic && !dynamic.graphTargets.length);
    check('features: embedded executable string is explicitly outside syntax coverage', !inspection.definitions.some(definition => definition.name === 'hidden'));
  }
}
report.passed = report.checks.every(item => item.passed);
report.warnings.push('Graphify raw output lacks end spans and producer schema metadata; the probe envelope pins the producer and AST adapter supplies measured spans.',
  'Unmatched call sites are not a count of missing application dependencies: many are builtin/external; dynamic and embedded-code coverage remains unknown.',
  'Dangling external imports and unresolved dependencies require an explicit normalization/fallback policy before any grant authority consumes this graph.');
await writeFile(resolve(run, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ run, passed: report.passed, checks: report.checks.length,
  failures: report.checks.filter(item => !item.passed), product: report.product, features: report.features, broken: report.broken }, null, 2));
if (!report.passed) process.exitCode = 1;
