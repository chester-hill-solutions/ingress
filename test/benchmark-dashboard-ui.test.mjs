import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHTML, mountBenchmarkDashboard } from '../src/benchmark-dashboard-ui.mjs';
import { summarizeBenchmarkView } from '../src/benchmark-dashboard.mjs';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.value = ''; this.open = false; this.ownText = ''; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(' '); }
  set innerHTML(value) { throw Error('Dynamic HTML is forbidden: ' + value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.replacements = (this.replacements ?? 0) + 1; this.ownText = ''; this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  dispatch(name) { this.listeners[name]?.({ target: this }); }
}
function harness(t) {
  const elements = new Map([...dashboardHTML.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Node('div')]));
  const document = { getElementById: id => elements.get(id), createElement: tag => new Node(tag) };
  const frames = [], ticks = []; let source, clock = 100000;
  const controller = mountBenchmarkDashboard(document, {
    EventSource: class { constructor(url) { this.url = url; source = this; } close() { this.closed = true; } },
    requestAnimationFrame: fn => frames.push(fn), setInterval: fn => { ticks.push(fn); return 1; }, clearInterval() {}, now: () => clock,
  });
  t.after(() => controller.dispose());
  return { elements, source, frames, controller, tick(time) { clock = time; ticks.forEach(fn => fn()); },
    update(value) { source.onmessage({ data: JSON.stringify(value) }); }, flush() { frames.splice(0).forEach(fn => fn()); } };
}
const groups = { scope: { passed: 2, total: 2, unknown: 0, confidence: 'observed' }, tools: { passed: 1, total: 2, unknown: 1, confidence: 'partial' }, requiredBehavior: { passed: 3, total: 4, unknown: 0, confidence: 'observed' } };
const config = (id, model) => ({ configID: id, title: id, models: [model], assigned: 4, settled: 3, completed: 2, correctCompleted: 1,
  artifactCorrect: 2, deadline: 1, failed: 0, notRun: 1, completedElapsed: { n: 2, median: 5000 }, complianceGroups: groups, correctCodeLines: { n: 2, median: 40 } });
const row = (id, configID, model) => ({ id, fixtureID: 'money', configID, models: [model], outcome: 'deadline', elapsedMs: 90000,
  artifactCorrect: true, correct: false, validComparison: true, assignedActors: 2, admittedActors: 2, nativeSucceededActors: 1,
  actorBrief: [{ id: 'producer', role: 'specialist', modelID: model, outcome: 'succeeded', admitted: true }, { id: 'consumer', role: 'reviewer', modelID: 'model/other', outcome: 'deadline-or-cancel', admitted: true }],
  context: { enabled: true, budgetBytes: 8192, cacheIntervalMs: 100, observedMaxBytes: null }, complianceGroups: groups });
function snapshot() {
  return { version: 2, observation: 'fresh', lifecycle: 'active', modifiedAt: 100000, evidenceStatus: 'running',
    counts: { assigned: 8, settled: 6, running: 1, checking: 0, notRun: 1, completed: 4, deadline: 2, failed: 0, cancelled: 0, artifactCorrect: 4, correctCompleted: 2 },
    native: { assigned: 16, admitted: 12, succeeded: 6, currentRunning: null }, complianceGroups: groups,
    protocol: { repeats: 3, parallelCohorts: 12, actorsPerCohort: '1,2,4,8', deadlineMs: 90000, models: ['model/one', 'model/two'], configs: ['ingress-pair', 'stock-solo'] },
    configurations: [config('ingress-pair', 'model/one'), config('stock-solo', 'model/two')], latest: [row('one', 'ingress-pair', 'model/one'), row('two', 'stock-solo', 'model/two')], omittedConfigurations: 0, omittedCohorts: 3 };
}

test('the emitted browser script parses and the page supplies accessible section/filter controls', () => {
  const script = dashboardHTML.match(/<script>([\s\S]+)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  for (const id of ['overview', 'configurations', 'activity', 'protocol', 'model-filter', 'config-filter']) assert.ok(dashboardHTML.includes('id="' + id + '"'));
  assert.ok(dashboardHTML.includes('aria-label="Dashboard sections"'));
  assert.equal(/steer|interrupt agent|queue command/i.test(dashboardHTML), false);
});

test('coalesced snapshots separate artifact correctness, deadline and unknown native activity', t => {
  const ui = harness(t), first = snapshot(), last = snapshot(); last.counts.correctCompleted = 3;
  ui.update(first); ui.update(last); assert.equal(ui.frames.length, 1); ui.flush();
  assert.equal(ui.elements.get('metric-correct').textContent, '3');
  assert.equal(ui.elements.get('metric-artifacts').textContent, '4');
  assert.equal(ui.elements.get('metric-deadlines').textContent, '2');
  assert.equal(ui.elements.get('metric-active').textContent, 'Unknown');
  assert.equal(ui.elements.get('progress-label').textContent, '6 / 8 cohorts settled');
  assert.ok(ui.elements.get('tool-checks').textContent.includes('1 unknown'));
  assert.ok(ui.elements.get('cohort-list').textContent.includes('Final artifact: Yes · correct + completed: No'));
  assert.ok(ui.elements.get('cohort-list').textContent.includes('compiled maximum — B'));
});

test('model/config filters persist and cohort disclosures keep identity/open state through updates', t => {
  const ui = harness(t); ui.update(snapshot()); ui.flush();
  const firstCard = ui.elements.get('cohort-list').children[0]; firstCard.open = true;
  const model = ui.elements.get('model-filter'); model.value = 'model/one'; model.dispatch('change');
  assert.equal(ui.elements.get('cohort-list').children.length, 1);
  assert.equal(ui.elements.get('configuration-rows').children.length, 1);
  const replacements = ui.elements.get('cohort-list').replacements;
  const next = snapshot(); next.latest[0].actorBrief[1].outcome = 'succeeded'; ui.update(next); ui.flush();
  assert.equal(model.value, 'model/one'); assert.equal(ui.elements.get('cohort-list').children[0], firstCard); assert.equal(firstCard.open, true);
  assert.equal(ui.elements.get('cohort-list').replacements, replacements, 'stable cards stay attached across metadata updates');
  assert.ok(firstCard.textContent.includes('Assigned role: reviewer'));
  assert.ok(firstCard.textContent.includes('model/other'));
  const filter = ui.elements.get('config-filter'); filter.value = 'stock-solo'; filter.dispatch('change');
  assert.ok(ui.elements.get('cohort-list').textContent.includes('No recent cohorts'));
  ui.elements.get('reset-filters').dispatch('click');
  assert.equal(ui.elements.get('cohort-list').children.length, 2); assert.equal(ui.elements.get('cohort-list').children[0].open, true);
});

test('disconnect/staleness and malformed updates preserve explicitly labelled prior observations', t => {
  const ui = harness(t); ui.update(snapshot()); ui.flush(); ui.source.onerror();
  assert.ok(ui.elements.get('connection-status').textContent.includes('Disconnected'));
  ui.tick(111000); assert.equal(ui.elements.get('evidence-status').textContent, 'Evidence stale');
  ui.source.onmessage({ data: '{bad' });
  assert.equal(ui.elements.get('evidence-status').textContent, 'Invalid update · previous snapshot');
  assert.equal(ui.elements.get('metric-artifacts').textContent, '4');
  const final = snapshot(); final.lifecycle = 'settled'; final.observation = 'stale'; ui.update(final); ui.flush();
  assert.equal(ui.elements.get('evidence-status').textContent, 'Final snapshot');
});

test('provider-shaped strings remain text and an unknown snapshot clears scoring without implying zero', t => {
  const ui = harness(t), data = snapshot();
  data.latest[0].actorBrief[0].role = '<img src=x onerror=attack()>';
  ui.update(data); ui.flush();
  assert.ok(ui.elements.get('cohort-list').textContent.includes('<img src=x onerror=attack()>'));
  ui.update({ version: 2, observation: 'unknown', lifecycle: 'unknown', modifiedAt: null, counts: null, native: null, configurations: [], latest: [], protocol: null }); ui.flush();
  assert.equal(ui.elements.get('metric-correct').textContent, '—');
  assert.equal(ui.elements.get('metric-active').textContent, 'Unknown');
  assert.ok(ui.elements.get('configuration-rows').textContent.includes('No configuration groups'));
});

test('the real server projection version and schema render roles/models/results through the page controller', t => {
  const ui = harness(t);
  const view = summarizeBenchmarkView({ status: 'running', protocol: { conditions: ['ingress-pair'], models: ['opencode/gpt-5-nano'], repeats: 3 }, results: [{
    id: 'cohort-real-schema', fixtureID: 'money', configID: 'ingress-pair', condition: 'awareness-on', modelSet: 'opencode/gpt-5-nano',
    outcome: 'completed', ended: '2026-09-29T12:00:00Z', correct: true, sourceCoverage: 'live-no-replay', nativePlugin: true,
    contextBytes: 8192, cacheIntervalMs: 100, elapsedMs: 1234, validComparison: true,
    verification: { correct: true, checks: [{ name: 'money_contract', passed: true }], instructionChecks: [{ name: 'no_observed_forbidden_tool_attempts', passed: true }] },
    actors: [{ id: 'builder', role: 'specialist', model: { providerID: 'opencode', id: 'gpt-5-nano' }, outcome: 'succeeded', admitted: true }],
  }] }, { modifiedAt: 100000, now: 100000 });
  assert.equal(view.version, 2); ui.update(view); ui.flush();
  assert.equal(ui.elements.get('metric-correct').textContent, '1');
  assert.equal(ui.elements.get('progress-label').textContent, '1 / 1 cohorts settled');
  assert.ok(ui.elements.get('cohort-list').textContent.includes('GPT-5 Nano'));
  assert.ok(ui.elements.get('cohort-list').textContent.includes('Assigned role: specialist'));
  assert.equal(ui.elements.get('metric-active').textContent, 'Unknown');
  assert.equal(ui.elements.get('evidence-status').textContent, 'Evidence fresh');
});
