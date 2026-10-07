import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mapMissions, verifyMapMission } from '../fixtures/missions/map.mjs';
import { verifyMission, missionIsolationAvailable } from '../src/mission-verifier.mjs';

// A submission can only be invoked under the Node 26 permission model; without it there is no
// isolation to test, so the two invocation tests are skipped on an older host rather than
// failed. The fixture-shape test still runs, because it needs no invocation.
const isolation = missionIsolationAvailable();
const needsIsolation = isolation ? false : 'requires Node 26 permission-model isolation';

// Reference implementations are test apparatus only, never part of fixture seeds.

function themeNames(documents) {
  if (!documents || typeof documents !== 'object') throw new Error('INVALID_DOCUMENTS');
  return Object.keys(documents).filter(key => documents[key] && documents[key].sources && documents[key].sources.base);
}
function buildStyle(documents, { theme, archiveUrl } = {}) {
  if (typeof archiveUrl !== 'string' || !archiveUrl) throw new Error('INVALID_ARCHIVE');
  const document = documents && documents[theme];
  if (!document || !document.sources || !document.sources.base) throw new Error('UNKNOWN_THEME');
  const clone = structuredClone(document);
  clone.sources.base.url = archiveUrl;
  return clone;
}
function layerOrder(style) {
  if (!style || !Array.isArray(style.layers)) throw new Error('INVALID_STYLE');
  return style.layers.map(layer => layer.id);
}
const EARTH_RADIUS_M = 6371008.8;
function distanceMeters(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
function haversineMeters(a, b) {
  if (!a || !b || ![a.lon, a.lat, b.lon, b.lat].every(Number.isFinite)) throw new Error('INVALID_POINT');
  return distanceMeters(a, b);
}
function pathLengthMeters(points) {
  if (!Array.isArray(points)) throw new Error('INVALID_POINTS');
  let total = 0;
  for (let index = 1; index < points.length; index++) total += distanceMeters(points[index - 1], points[index]);
  return total;
}
function etaSeconds(meters, speedKph) {
  if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(speedKph) || speedKph <= 0) throw new Error('INVALID_ETA');
  return meters / (speedKph * 1000 / 3600);
}
function buildGraph(roads) {
  if (!roads || !Array.isArray(roads.nodes) || !Array.isArray(roads.edges)) throw new Error('INVALID_ROADS');
  const nodes = [], seen = new Set();
  for (const node of roads.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || seen.has(node.id) || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) throw new Error('INVALID_NODE');
    seen.add(node.id);
    nodes.push({ id: node.id, name: typeof node.name === 'string' ? node.name : node.id, lon: node.lon, lat: node.lat });
  }
  const adjacency = {};
  for (const node of nodes) adjacency[node.id] = [];
  for (const edge of roads.edges) {
    if (!edge || !seen.has(edge.from) || !seen.has(edge.to) || typeof edge.road !== 'string') throw new Error('INVALID_EDGE');
    adjacency[edge.from].push({ to: edge.to, road: edge.road });
    adjacency[edge.to].push({ to: edge.from, road: edge.road });
  }
  return { nodes, adjacency };
}
function nearestNode(graph, point) {
  if (!graph || !Array.isArray(graph.nodes) || !point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) throw new Error('INVALID_NEAREST');
  let best = null;
  for (const node of graph.nodes) {
    const metres = distanceMeters(node, point);
    if (best === null || metres < best.metres || (metres === best.metres && node.id < best.id)) best = { id: node.id, metres };
  }
  return best ? best.id : null;
}
function shortestRoute(graph, fromId, toId) {
  if (!graph || !graph.adjacency || typeof fromId !== 'string' || typeof toId !== 'string') throw new Error('INVALID_ROUTE');
  if (!graph.adjacency[fromId] || !graph.adjacency[toId]) return null;
  const nodes = Object.fromEntries(graph.nodes.map(node => [node.id, node]));
  const distance = { [fromId]: 0 }, previous = {}, settled = new Set();
  const queue = new Set(Object.keys(graph.adjacency));
  while (queue.size) {
    let current = null;
    for (const id of queue) {
      if (distance[id] === undefined) continue;
      if (current === null || distance[id] < distance[current] || (distance[id] === distance[current] && id < current)) current = id;
    }
    if (current === null) break;
    queue.delete(current);
    settled.add(current);
    if (current === toId) break;
    for (const edge of graph.adjacency[current]) {
      if (settled.has(edge.to)) continue;
      const candidate = distance[current] + distanceMeters(nodes[current], nodes[edge.to]);
      if (distance[edge.to] === undefined || candidate < distance[edge.to]) { distance[edge.to] = candidate; previous[edge.to] = current; }
    }
  }
  if (distance[toId] === undefined) return null;
  const path = [toId];
  while (path[path.length - 1] !== fromId) path.push(previous[path[path.length - 1]]);
  path.reverse();
  return { nodes: path, meters: distance[toId] };
}
function bearingDegrees(a, b) {
  if (!a || !b) throw new Error('INVALID_BEARING');
  const rad = Math.PI / 180, dLon = (b.lon - a.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
function directionsFor(graph, route) {
  if (!graph || !Array.isArray(graph.nodes) || !route || !Array.isArray(route.nodes) || route.nodes.length < 2) throw new Error('INVALID_DIRECTIONS');
  const byId = Object.fromEntries(graph.nodes.map(node => [node.id, node]));
  const roadFor = (from, to) => { const edge = (graph.adjacency[from] || []).find(value => value.to === to); return edge ? edge.road : ''; };
  const steps = [];
  let previous = null;
  for (let index = 1; index < route.nodes.length; index++) {
    const from = byId[route.nodes[index - 1]], to = byId[route.nodes[index]];
    const bearing = bearingDegrees(from, to);
    let turn = 'continue';
    if (previous === null) turn = 'start';
    else { const delta = ((bearing - previous + 540) % 360) - 180; turn = delta > 30 ? 'right' : delta < -30 ? 'left' : 'continue'; }
    steps.push({ from: from.id, to: to.id, road: roadFor(from.id, to.id), meters: distanceMeters(from, to), bearing, turn });
    previous = bearing;
  }
  return steps;
}
function placeRecords(collection) {
  if (!collection || !Array.isArray(collection.features)) throw new Error('INVALID_PLACES');
  return collection.features.map(feature => ({ name: feature.properties.name, lon: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] }));
}
function findPlace(places, query) {
  if (typeof query !== 'string') throw new Error('INVALID_QUERY');
  const records = placeRecords(places);
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const best = list => [...list].sort((left, right) => left.name.length - right.name.length || left.name.localeCompare(right.name))[0];
  const exact = records.filter(place => place.name.toLowerCase() === needle);
  if (exact.length) return { ...best(exact) };
  const prefix = records.filter(place => place.name.toLowerCase().startsWith(needle));
  if (prefix.length) return { ...best(prefix) };
  const contains = records.filter(place => place.name.toLowerCase().includes(needle));
  return contains.length ? { ...best(contains) } : null;
}
function nearestPlace(places, point) {
  if (!point) throw new Error('INVALID_NEAREST_PLACE');
  const records = placeRecords(places);
  let best = null;
  for (const place of records) {
    const metres = distanceMeters(place, point);
    if (best === null || metres < best.metres || (metres === best.metres && place.name < best.name)) best = { place, metres, name: place.name };
  }
  return best ? { ...best.place } : null;
}
function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function renderAttribution(record) {
  const rows = record.sources.map(source => /^https?:\/\//.test(source.licence_url) ? `<a href="${esc(source.licence_url)}">${esc(source.text)}</a>` : esc(source.text));
  return `<p class="attribution">${esc(record.combined)} ${rows.join(' · ')}</p>`;
}
function renderNavigation({ theme, origin, destination, route, directions, etaSeconds, attribution } = {}) {
  const steps = Array.isArray(directions) ? directions : [];
  const list = steps.map(step => `<li>${esc(step.turn)} onto ${esc(step.road)} for ${Math.round(step.meters / 1000)} km</li>`).join('');
  const summary = origin && destination && route && Number.isFinite(route.meters)
    ? `<p class="summary">${esc(origin)} to ${esc(destination)}: ${(route.meters / 1000).toFixed(1)} km, ${Math.round((etaSeconds || 0) / 60)} min</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ontario Drive</title></head><body><main><h1>Ontario Drive</h1>`
    + `<div id="map" data-theme="${esc(theme)}"></div>`
    + `<form method="get" action="/route"><label for="origin">From</label><input id="origin" name="origin" type="text"><label for="destination">To</label><input id="destination" name="destination" type="text"><button type="submit">Route</button></form>`
    + `${summary}<ol class="steps">${list}</ol>${renderAttribution(attribution)}</main></body></html>`;
}
async function runScenario({ documents, places, roads, attribution, theme = 'light', archiveUrl, speedKph = 90, size, commands = [] } = {}) {
  const graph = buildGraph(roads);
  let currentTheme = theme, origin = null, destination = null, route = null, directions = null, eta = null;
  const responses = [];
  for (const command of commands) {
    try {
      if (command.op === 'route') {
        const from = findPlace(places, command.origin), to = findPlace(places, command.destination);
        if (!from || !to) throw Object.assign(new Error('PLACE_NOT_FOUND'), { code: 'PLACE_NOT_FOUND' });
        const found = shortestRoute(graph, nearestNode(graph, from), nearestNode(graph, to));
        if (!found) throw Object.assign(new Error('NO_ROUTE'), { code: 'NO_ROUTE' });
        origin = from.name; destination = to.name; route = found; directions = directionsFor(graph, found); eta = etaSeconds(found.meters, speedKph);
        responses.push({ id: command.id, ok: true, data: { origin, destination, route, directions, etaSeconds: eta } });
      } else if (command.op === 'geocode') {
        const place = findPlace(places, command.query);
        if (!place) throw Object.assign(new Error('PLACE_NOT_FOUND'), { code: 'PLACE_NOT_FOUND' });
        responses.push({ id: command.id, ok: true, data: { place } });
      } else if (command.op === 'theme') {
        if (!themeNames(documents).includes(command.theme)) throw Object.assign(new Error('UNKNOWN_THEME'), { code: 'UNKNOWN_THEME' });
        currentTheme = command.theme;
        responses.push({ id: command.id, ok: true, data: { theme: currentTheme } });
      } else throw Object.assign(new Error('UNKNOWN_OP'), { code: 'UNKNOWN_OP' });
    } catch (error) {
      responses.push({ id: command.id, ok: false, error: { code: error && error.code ? error.code : 'INVALID' } });
    }
  }
  const style = buildStyle(documents, { theme: currentTheme, archiveUrl });
  const html = renderNavigation({ theme: currentTheme, origin, destination, route, directions, etaSeconds: eta, attribution, places, style });
  return { responses, state: { theme: currentTheme, archiveUrl, origin, destination, route, directions, etaSeconds: eta }, html };
}

const definition = fn => 'export ' + fn.toString() + '\n';
const geo = `const EARTH_RADIUS_M=${EARTH_RADIUS_M};\n` + definition(distanceMeters);
function referenceFiles() {
  return {
    'styles.mjs': definition(themeNames) + definition(buildStyle) + definition(layerOrder),
    'measure.mjs': `const EARTH_RADIUS_M=${EARTH_RADIUS_M};\n` + definition(distanceMeters) + definition(haversineMeters) + definition(pathLengthMeters) + definition(etaSeconds),
    'graph.mjs': geo + definition(buildGraph) + definition(nearestNode),
    'routing.mjs': geo + definition(shortestRoute),
    'directions.mjs': geo + definition(bearingDegrees) + definition(directionsFor),
    'geocode.mjs': geo + definition(placeRecords) + definition(findPlace) + definition(nearestPlace),
    'view.mjs': definition(esc) + definition(renderAttribution) + definition(renderNavigation),
    'app.mjs': `import {buildStyle,themeNames} from './styles.mjs';\nimport {buildGraph,nearestNode} from './graph.mjs';\nimport {shortestRoute} from './routing.mjs';\nimport {directionsFor} from './directions.mjs';\nimport {findPlace} from './geocode.mjs';\nimport {etaSeconds} from './measure.mjs';\nimport {renderNavigation} from './view.mjs';\n` + definition(runScenario),
  };
}

async function seeded(fixture, reference = false, mutate = null) {
  const root = await mkdtemp(join(tmpdir(), 'mission-map-'));
  const files = { ...fixture.files, ...(reference ? referenceFiles() : {}) };
  mutate?.(files);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test('the drive mission has eight substantial streams, bounded specs and real map assets', async () => {
  for (const fixture of mapMissions) {
    assert.equal(fixture.domain, 'map');
    assert.equal(fixture.workstreams.length, 8);
    assert.ok(Buffer.byteLength(fixture.goal) <= 7000);
    assert.ok(fixture.workstreams.every(stream => Buffer.byteLength(stream.brief) <= 1200 && stream.paths.length));
    assert.equal(new Set(fixture.criteria.map(criterion => criterion.id)).size, fixture.criteria.length);
    assert.ok(fixture.protectedPaths.includes('package.json'));
    assert.ok(fixture.protectedPaths.includes('styles/house/light.json'), 'the real style must be protected');
    assert.ok(fixture.protectedPaths.includes('data/roads.json'));
    const light = JSON.parse(fixture.files['styles/house/light.json']);
    assert.equal(light.layers.length, 28);
    assert.match(light.sources.base.url, /^pmtiles:\/\//);
    const roads = JSON.parse(fixture.files['data/roads.json']);
    assert.ok(roads.nodes.length >= 20 && roads.edges.length >= 20, 'the road graph must be substantial');
    const root = await seeded(fixture);
    try {
      const result = await verifyMapMission(fixture.id, root);
      assert.equal(result.correct, false);
      assert.ok(result.checks.some(check => !check.passed));
      assert.ok(result.instructionChecks.every(check => check.passed));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

for (const fixture of mapMissions) {
  test(`${fixture.title}: a complete test-only reference satisfies every contract`, { skip: needsIsolation }, async () => {
    const root = await seeded(fixture, true);
    try {
      const result = await verifyMapMission(fixture.id, root);
      assert.equal(result.correct, true, JSON.stringify(result.checks));
      assert.equal(fixture.reviewInvocation.path, 'app.mjs');
      assert.equal(fixture.reviewInvocation.exportName, 'runScenario');
      const smoke = await verifyMission({ ...fixture, criteria: [{ id: 'public-review-smoke' }] }, root, async ({ invoke, check }) => {
        await check('public-review-smoke', async () => {
          const invocation = fixture.reviewInvocation;
          const view = await invoke(invocation.path, invocation.exportName, invocation.args);
          assert.ok(view.responses.every(row => row.ok));
          assert.ok(view.html.includes('Toronto') && view.html.includes('Ottawa'));
          assert.match(view.html, /<main\b/);
        });
      });
      assert.equal(smoke.correct, true, 'public review invocation produces a usable view');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the drive grader rejects a view that drops the credit and a router that reports no distance', { skip: needsIsolation }, async () => {
  const fixture = mapMissions[0];
  const mutations = [
    files => { files['view.mjs'] = files['view.mjs'].replace('${renderAttribution(attribution)}', ''); },
    files => { files['routing.mjs'] = files['routing.mjs'].replace('return { nodes: path, meters: distance[toId] };', 'return { nodes: path, meters: 0 };'); },
  ];
  for (const mutate of mutations) {
    const root = await seeded(fixture, true, mutate);
    try {
      const result = await verifyMapMission(fixture.id, root);
      assert.equal(result.correct, false);
      assert.ok(result.checks.some(check => !check.passed));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
