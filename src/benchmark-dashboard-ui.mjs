import { dashboardCSS } from './benchmark-dashboard-style.mjs';

/** Read-only presentation. The same controller runs in the page and DOM behavior tests. */
export function mountBenchmarkDashboard(document, dependencies = {}) {
  const raf = dependencies.requestAnimationFrame ?? globalThis.requestAnimationFrame;
  const Source = dependencies.EventSource ?? globalThis.EventSource;
  const interval = dependencies.setInterval ?? globalThis.setInterval;
  const clear = dependencies.clearInterval ?? globalThis.clearInterval;
  const now = dependencies.now ?? Date.now;
  const $ = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text); return node;
  };
  const number = value => Number.isFinite(value) && value >= 0 ? value : null;
  const count = value => number(value) === null ? '—' : String(value);
  const time = value => number(value) === null ? 'Unknown' : (value / 1000).toFixed(1) + 's';
  const truth = value => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
  const safe = value => typeof value === 'string' ? value.slice(0, 220) : 'Unknown';
  const stat = value => value?.n > 0 ? time(value.median) + ' · n=' + value.n : 'Unknown · n=0';
  const labels = row => Array.isArray(row.modelLabels) && row.modelLabels.length ? row.modelLabels.join(' + ') : (row.models ?? []).join(' + ') || 'Models unknown';
  const knownGroups = ['scope', 'tools', 'requiredBehavior'];
  const groupLabels = { scope: 'Protected files / scope', tools: 'Tool obedience', requiredBehavior: 'Required behavior' };
  const groupText = group => !group || !group.total ? 'Unknown · no observed checks' :
    count(group.passed) + '/' + count(group.total) + ' passed' + (group.unknown ? ' · ' + group.unknown + ' unknown' : '') + (group.confidence === 'partial' ? ' · partial' : '');
  let current = null, pending = null, queued = false, connected = false, invalidUpdate = false;
  let selectedModel = '', selectedConfig = '', lastReceived = null, disposed = false;
  const cohortNodes = new Map(); let modelSignature = '', configSignature = '';
  const matches = row => (!selectedConfig || row.configID === selectedConfig) && (!selectedModel || (row.models ?? []).includes(selectedModel));
  const optionList = (id, values, selected, allLabel, signature) => {
    const next = JSON.stringify(values);
    if (next === signature) return signature;
    const root = $(id), options = [element('option', '', allLabel)]; options[0].value = '';
    for (const value of values) { const option = element('option', '', value); option.value = value; options.push(option); }
    root.replaceChildren(...options); root.value = selected; return next;
  };
  const badge = (text, kind = 'unknown') => element('span', 'status-pill ' + kind, text);
  const setBadge = (id, text, kind) => { $(id).textContent = text; $(id).className = 'status-pill ' + kind; };
  function renderStatus() {
    setBadge('connection-status', connected ? 'Connected · read only' : lastReceived === null ? 'Connecting' : 'Disconnected · last snapshot', connected ? 'running' : 'unknown');
    if (invalidUpdate) { setBadge('evidence-status', 'Invalid update · previous snapshot', 'failed'); return; }
    if (!current) { setBadge('evidence-status', 'Evidence unknown', 'unknown'); return; }
    const final = current.lifecycle === 'settled';
    const stale = current.observation === 'stale' || !final && number(current.modifiedAt) !== null && now() - current.modifiedAt > 10000;
    setBadge('evidence-status', final ? 'Final snapshot' : stale ? 'Evidence stale' : current.observation === 'fresh' ? 'Evidence fresh' : 'Evidence unknown', final ? 'neutral' : stale ? 'deadline' : current.observation === 'fresh' ? 'running' : 'unknown');
    $('snapshot-time').textContent = number(current.modifiedAt) === null ? 'Evidence timestamp unknown' : 'Last evidence write ' + Math.max(0, Math.floor((now() - current.modifiedAt) / 1000)) + 's ago';
  }
  function renderOverview(snapshot) {
    const c = snapshot.counts, n = snapshot.native;
    $('study-stage').textContent = ({ assigned: 'Assignments prepared', active: 'Study in progress', settled: 'Study settled', unknown: 'Study state unknown' })[snapshot.lifecycle] ?? 'Study state unknown';
    const assigned = number(c?.assigned), settled = number(c?.settled), percent = assigned > 0 && settled !== null ? Math.min(100, settled / assigned * 100) : 0;
    $('study-progress').style.width = percent + '%';
    $('study-progress').setAttribute('aria-valuenow', String(Math.round(percent)));
    $('progress-label').textContent = count(settled) + ' / ' + count(assigned) + ' cohorts settled';
    $('progress-detail').textContent = count(c?.running) + ' cohorts in progress · ' + count(c?.checking) + ' checking · ' + count(c?.notRun) + ' not started';
    $('metric-correct').textContent = count(c?.correctCompleted);
    $('metric-artifacts').textContent = count(c?.artifactCorrect);
    $('metric-deadlines').textContent = count(c?.deadline);
    $('metric-admissions').textContent = count(n?.admitted) + ' / ' + count(n?.assigned);
    $('metric-native').textContent = count(n?.succeeded);
    $('metric-active').textContent = number(n?.currentRunning) === null ? 'Unknown' : count(n.currentRunning);
    $('scope-checks').textContent = groupText(snapshot.complianceGroups?.scope);
    $('tool-checks').textContent = groupText(snapshot.complianceGroups?.tools);
    $('behavior-checks').textContent = groupText(snapshot.complianceGroups?.requiredBehavior);
    const protocol = snapshot.protocol;
    $('protocol-copy').textContent = protocol ? count(protocol.repeats) + ' repeats · ' + count(protocol.parallelCohorts) + ' concurrent cohorts · ' + safe(protocol.actorsPerCohort) + ' actors per cohort · ' + time(protocol.deadlineMs) + ' deadline including startup' : 'Declared protocol unknown';
    $('model-copy').textContent = protocol?.models?.length ? protocol.models.join(' · ') : 'Declared models unknown';
    $('failure-copy').textContent = count(c?.failed) + ' failed · ' + count(c?.cancelled) + ' cancelled. These remain in assigned denominators.';
  }
  function renderConfigurations(rows) {
    const table = $('configuration-rows'), charts = $('configuration-chart'); table.replaceChildren(); charts.replaceChildren();
    $('configuration-count').textContent = rows.length + ' configuration / model groups';
    if (!rows.length) { const tr = element('tr'), cell = element('td', 'empty-state', 'No configuration groups match these filters.'); cell.colSpan = 8; tr.append(cell); table.append(tr); return; }
    for (const row of rows) {
      const assigned = number(row.assigned) ?? 0, correct = number(row.correctCompleted) ?? 0, deadline = number(row.deadline) ?? 0;
      const settled = number(row.settled) ?? (row.completed ?? 0) + (row.deadline ?? 0) + (row.failed ?? 0) + (row.cancelled ?? 0);
      const rate = element('div', 'performance-row');
      const heading = element('div', 'cohort-summary'); heading.append(element('strong', '', row.title || row.configID), element('span', 'muted', labels(row)));
      const bar = element('div', 'rate-bar'); bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', correct + ' correct and completed; ' + deadline + ' deadlines; ' + settled + ' settled of ' + assigned + ' assigned');
      for (const [kind, amount] of [['correct', correct], ['deadline', deadline], ['other', Math.max(0, settled - correct - deadline)], ['pending', Math.max(0, assigned - settled)]]) {
        const segment = element('span', 'rate-segment ' + kind); segment.style.width = (assigned ? Math.min(100, amount / assigned * 100) : 0) + '%'; bar.append(segment);
      }
      rate.append(heading, bar, element('span', 'muted', correct + '/' + assigned + ' correct + completed · ' + deadline + ' deadlines')); charts.append(rate);
      const tr = element('tr');
      const title = element('td'); title.append(element('strong', '', row.title || row.configID), element('div', 'muted', labels(row))); tr.append(title);
      const values = [count(row.assigned) + ' / ' + count(row.settled), count(row.correctCompleted) + ' / ' + count(row.artifactCorrect), count(row.deadline) + ' / ' + count(row.failed) + ' / ' + count(row.notRun), stat(row.completedElapsed), groupText(row.complianceGroups?.scope) + '; ' + groupText(row.complianceGroups?.tools), groupText(row.complianceGroups?.requiredBehavior), row.correctCodeLines?.n ? count(row.correctCodeLines.median) + ' · n=' + row.correctCodeLines.n : 'Unknown · n=0'];
      for (const value of values) tr.append(element('td', '', value)); table.append(tr);
    }
  }
  function cohortNode(row) {
    let entry = cohortNodes.get(row.id);
    if (!entry) {
      const root = element('details', 'activity-item disclosure'), summary = element('summary', 'cohort-summary');
      const title = element('strong'), description = element('span', 'muted'), status = element('span', 'status-pill'), result = element('span', 'muted');
      summary.append(title, description, status, result);
      const detail = element('div', 'cohort-detail'), metadata = element('p', 'muted'), actors = element('div', 'actor-roster'), proof = element('p', 'footnote');
      detail.append(metadata, actors, proof); root.append(summary, detail);
      entry = { root, title, description, status, result, metadata, actors, proof }; cohortNodes.set(row.id, entry);
    }
    entry.title.textContent = safe(row.fixtureID) + ' · ' + safe(row.title || row.configID);
    entry.description.textContent = labels(row) + ' · ' + safe(row.id);
    entry.status.textContent = row.outcome === 'running' ? 'Cohort in progress' : row.outcome === 'completed' ? 'Native stages completed' : safe(row.outcome);
    entry.status.className = 'status-pill ' + (row.outcome === 'deadline' ? 'deadline' : row.outcome === 'failed' ? 'failed' : row.correct === true ? 'correct' : 'neutral');
    entry.result.textContent = 'Final artifact: ' + truth(row.artifactCorrect) + ' · correct + completed: ' + truth(row.correct) + ' · ' + time(row.elapsedMs);
    const context = row.context;
    entry.metadata.textContent = count(row.admittedActors) + '/' + count(row.assignedActors) + ' actors admitted · ' + count(row.nativeSucceededActors) + ' native successes · ' + (context?.enabled === false ? 'Stock · no Ingress context' : context?.enabled === true ? 'Context budget ' + count(context.budgetBytes) + ' B · refresh ' + count(context.cacheIntervalMs) + ' ms · compiled maximum ' + count(context.observedMaxBytes) + ' B' : 'Context configuration unknown');
    entry.actors.replaceChildren();
    for (const actor of row.actorBrief ?? []) {
      const card = element('article', 'actor-card');
      card.append(element('strong', 'actor-name', safe(actor.id)), element('p', 'muted', 'Assigned role: ' + safe(actor.role)), element('p', '', safe(actor.modelLabel || actor.modelID)), badge(actor.admitted === true && actor.outcome === 'not-run' ? 'No terminal outcome observed' : safe(actor.outcome), actor.outcome === 'succeeded' ? 'correct' : actor.outcome === 'deadline-or-cancel' ? 'deadline' : 'neutral'), element('p', 'muted', actor.admitted === true ? 'Admission confirmed' : actor.admitted === false ? 'Not admitted' : 'Admission unknown'));
      entry.actors.append(card);
    }
    if (!row.actorBrief?.length) entry.actors.append(element('p', 'empty-state', 'Actor role and model evidence unavailable.'));
    entry.proof.textContent = 'Comparison evidence: ' + truth(row.validComparison) + '. ' + knownGroups.map(key => groupLabels[key] + ': ' + groupText(row.complianceGroups?.[key])).join(' · ') + (row.omittedActors ? ' · ' + row.omittedActors + ' actors omitted from this view.' : '');
    return entry.root;
  }
  function renderActivity(rows) {
    const root = $('cohort-list'); $('activity-count').textContent = rows.length + ' cohorts in the latest view';
    const nodes = rows.map(cohortNode);
    if (!nodes.length) root.replaceChildren(element('p', 'empty-state', 'No recent cohorts match these filters.'));
    else if (root.children.length !== nodes.length || nodes.some((node, index) => root.children[index] !== node)) root.replaceChildren(...nodes);
    // Preserve recent disclosures through filter changes, with a finite retained UI cache.
    const visible = new Set(rows.map(row => row.id));
    if (cohortNodes.size > 128) for (const [id] of cohortNodes) { if (!visible.has(id)) cohortNodes.delete(id); if (cohortNodes.size <= 128) break; }
  }
  function render() {
    if (!current || disposed) return;
    const configurations = Array.isArray(current.configurations) ? current.configurations : [], latest = Array.isArray(current.latest) ? current.latest : [];
    const models = [...new Set([...(current.protocol?.models ?? []), ...configurations.flatMap(row => row.models ?? []), ...latest.flatMap(row => row.models ?? [])])].sort();
    const configs = [...new Set([...(current.protocol?.configs ?? []), ...configurations.map(row => row.configID), ...latest.map(row => row.configID)])].sort();
    modelSignature = optionList('model-filter', models, selectedModel, 'All models', modelSignature);
    configSignature = optionList('config-filter', configs, selectedConfig, 'All configurations', configSignature);
    renderOverview(current); renderConfigurations(configurations.filter(matches)); renderActivity(latest.filter(matches)); renderStatus();
    $('view-omissions').textContent = count(current.omittedConfigurations) + ' configuration groups and ' + count(current.omittedCohorts) + ' older cohorts omitted from the bounded view. Filters apply to these tables, not study totals.';
  }
  function flush() { queued = false; if (pending) { current = pending; pending = null; } render(); }
  function receive(snapshot) {
    if (!snapshot || snapshot.version !== 2 || !Array.isArray(snapshot.configurations) || !Array.isArray(snapshot.latest)) { invalidUpdate = true; renderStatus(); return; }
    pending = snapshot; lastReceived = now(); connected = true; invalidUpdate = false;
    if (!queued) { queued = true; raf(flush); }
  }
  $('model-filter').addEventListener('change', () => { selectedModel = $('model-filter').value; render(); });
  $('config-filter').addEventListener('change', () => { selectedConfig = $('config-filter').value; render(); });
  $('reset-filters').addEventListener('click', () => { selectedModel = selectedConfig = ''; $('model-filter').value = ''; $('config-filter').value = ''; render(); });
  let source;
  try {
    source = new Source('/events');
    source.onopen = () => { connected = true; renderStatus(); };
    source.onerror = () => { connected = false; renderStatus(); };
    source.onmessage = event => { try { receive(JSON.parse(event.data)); } catch { invalidUpdate = true; renderStatus(); } };
  } catch { connected = false; renderStatus(); }
  const timer = interval(renderStatus, 1000);
  return { receive, flush, dispose() { disposed = true; clear(timer); source?.close(); } };
}

export const dashboardHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingress — benchmark observatory</title><style>${dashboardCSS}</style></head><body>
<div class="app-shell"><aside class="sidebar"><a class="brand" href="#overview">Ingress<span class="eyebrow">BENCHMARK OBSERVATORY</span></a><nav aria-label="Dashboard sections"><a class="nav-link" href="#overview">Overview</a><a class="nav-link" href="#configurations">Configurations</a><a class="nav-link" href="#activity">Cohort activity</a><a class="nav-link" href="#protocol">Protocol &amp; limits</a></nav><p class="footnote">Live evidence.<br>Independent checks.<br>Read-only observation.</p></aside>
<main class="main"><header class="page-header"><div><p class="eyebrow">EXPLORATORY TEAM STUDY</p><h1>Observe the work.</h1><p class="subtitle">Different models. Different teams. One shared benchmark goal.</p></div><div class="metadata-grid" aria-live="polite"><span id="connection-status" class="status-pill unknown">Connecting</span><span id="evidence-status" class="status-pill unknown">Evidence unknown</span><span id="snapshot-time" class="muted">Awaiting snapshot</span></div></header>
<section id="overview" aria-labelledby="overview-title"><div class="panel"><div class="panel-header"><h2 id="overview-title">Study overview</h2><span id="study-stage" class="muted">Study state unknown</span></div><div class="progress-meta"><strong id="progress-label">— / — cohorts settled</strong><span id="progress-detail" class="muted">Waiting for evidence</span></div><div class="progress-track"><div id="study-progress" class="progress-fill" role="progressbar" aria-label="Settled assigned cohorts" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div></div></div>
<div class="metrics-grid"><article class="metric-card"><p class="metric-label">Correct + completed</p><strong id="metric-correct" class="metric-value">—</strong><p class="metric-note">Correct output and compliant native completion.</p></article><article class="metric-card"><p class="metric-label">Correct final artifacts</p><strong id="metric-artifacts" class="metric-value">—</strong><p class="metric-note">Independently checked after writer stop.</p></article><article class="metric-card"><p class="metric-label">Deadline outcomes</p><strong id="metric-deadlines" class="metric-value">—</strong><p class="metric-note">A capped observation, not completion time.</p></article><article class="metric-card"><p class="metric-label">Native admissions</p><strong id="metric-admissions" class="metric-value">—</strong><p class="metric-note">Admitted / assigned actors, across the study.</p></article><article class="metric-card"><p class="metric-label">Native successes</p><strong id="metric-native" class="metric-value">—</strong><p class="metric-note">Native success alone does not prove correctness.</p></article><article class="metric-card"><p class="metric-label">Native active now</p><strong id="metric-active" class="metric-value">Unknown</strong><p class="metric-note">Shown only with explicit concurrency evidence.</p></article></div>
<div class="panel"><div class="panel-header"><h2>Instruction evidence</h2><span class="muted">Available checks, with unknowns retained</span></div><div class="metadata-grid"><p><strong>Protected files / scope</strong><br><span id="scope-checks">Unknown</span></p><p><strong>Tool obedience</strong><br><span id="tool-checks">Unknown</span></p><p><strong>Required behavior</strong><br><span id="behavior-checks">Unknown</span></p></div></div></section>
<section id="configurations" aria-labelledby="configuration-title"><div class="panel"><div class="panel-header"><div><p class="eyebrow">COMPARISON WITHOUT A COMPOSITE SCORE</p><h2 id="configuration-title">Configurations</h2></div><span id="configuration-count" class="muted"></span></div><div class="toolbar"><label class="filter-field">Model<select id="model-filter"><option value="">All models</option></select></label><label class="filter-field">Configuration<select id="config-filter"><option value="">All configurations</option></select></label><button id="reset-filters" type="button" class="button">Reset filters</button></div><p class="footnote">Compare matched fixture families and model allocations. Different team sizes are different compute. Completed-only timing excludes deadline outcomes.</p><div class="progress-meta"><span>Green: correct + completed</span><span>Amber: deadlines · Gray: other settled · Dim: pending</span></div><div id="configuration-chart" class="performance-grid"></div><div class="table-wrap"><table class="data-table"><caption class="muted">Configuration and model groups; counts retain assigned outcomes.</caption><thead><tr><th scope="col">Configuration / models</th><th scope="col">Assigned / settled</th><th scope="col">Correct + completed / artifacts</th><th scope="col">Deadline / failed / pending</th><th scope="col">Completed median</th><th scope="col">Scope / tool checks</th><th scope="col">Required behavior</th><th scope="col">Correct-artifact code lines</th></tr></thead><tbody id="configuration-rows"></tbody></table></div><p class="footnote">Code lines are a lexical JavaScript descriptor, not a quality grade. Missing measurements stay unknown.</p></div></section>
<section id="activity" aria-labelledby="activity-title"><div class="panel"><div class="panel-header"><div><p class="eyebrow">LATEST OBSERVATIONS</p><h2 id="activity-title">Cohort activity</h2></div><span id="activity-count" class="muted"></span></div><p class="footnote">Open a cohort to inspect assigned roles, actual model allocations, native outcomes and context evidence. A cohort in progress does not establish how many native agents are active.</p><div id="cohort-list" class="activity-list"></div><p id="view-omissions" class="footnote"></p></div></section>
<section id="protocol" aria-labelledby="protocol-title"><div class="panel"><div class="panel-header"><h2 id="protocol-title">Protocol &amp; interpretation</h2><span class="status-pill neutral">Read only</span></div><p id="protocol-copy">Declared protocol unknown</p><p id="model-copy" class="mono muted">Declared models unknown</p><p id="failure-copy" class="muted"></p><p class="footnote">Final artifact correctness, native termination and observed obedience are separate. Context serialization proves exposure, not adaptation. Timings include provider and host load. Coverage gaps cannot establish inactivity or obedience. Small tasks and three repeats do not qualify a product benefit.</p></div></section>
</main></div><script>(${mountBenchmarkDashboard.toString()})(document);</script></body></html>`;
