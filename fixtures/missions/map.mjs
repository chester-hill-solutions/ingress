import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyMission } from '../../src/mission-verifier.mjs';

/**
 * A driving navigation application built on `@chester-hill-solutions/map-tiles`.
 *
 * The assets are the real ones: the two house style documents, the attribution record and a
 * slice of the real place fixture, all copied out of `packages/map-tiles` on `origin/main`.
 * The road network is a small hand-built highway graph over the real place coordinates -- 26
 * towns and cities joined by the 400, 401, 403, 407, 416, 417, 11, 17, 101 and 8 corridors.
 * The mission is therefore "drive on the chester-hill-solutions map" in the literal sense:
 * the submission must route between real Ontario places over real coordinates, produce
 * turn-by-turn directions, and render the credit the licence requires.
 *
 * Why it is pure functions and a rendered string
 *
 * The mission verifier runs every submission under Node's permission model with no network
 * and no writes (`src/mission-verifier.mjs`). A live routing UI cannot be exercised there, so
 * the application is expressed the way the other missions are: pure modules with public
 * contracts, plus one rendered HTML view. The map is data (the style document), the drive is
 * arithmetic (graph, shortest path, bearing, distance, ETA), and the view is a string.
 *
 * What is real and what is not, stated plainly
 *
 * The style documents, layer order, source URL, attribution and place coordinates are real.
 * The place seed is a 48-feature slice of the real 6,652-feature fixture -- the full file is
 * 1.23 MB and the verifier caps a seeded file at 1 MB. The road graph is hand-built from those
 * coordinates; the edge distances are computed by the submission from the coordinates, so the
 * graph records only which places a road connects, not how long it is. That is a harness
 * fixture, not a claim about the Ontario Road Network.
 */

const asset = name => readFileSync(fileURLToPath(new URL('./map/' + name, import.meta.url)), 'utf8');

const shared = `Build a complete local driving navigation application using Node built-ins and ES modules. No external services, network or assets. Modules export pure functions; app.mjs exports async runScenario(options) returning plain JSON {responses,state,html}. The application is built on the @chester-hill-solutions/map-tiles contract: it consumes the seeded MapLibre style documents and the seeded attribution record, routes over the seeded road graph, and never invents map data. state {theme,archiveUrl,origin,destination,route,directions,etaSeconds} is server-side; html is a complete public view. Responses are {id,ok:true,data} or {id,ok:false,error:{code}}; a rejected command leaves state unchanged and must not crash the batch. Eight module boundaries are public contracts, focus areas rather than exclusive ownership. Preserve protected files. Finish the entire application regardless of team size.`;

const spec = `Product: Ontario Drive, a driving navigation application over a self-hosted Ontario vector basemap. Two themes are seeded as full MapLibre style documents (styles/house/light.json, styles/house/dark.json), each with sources.base.url, glyphs and 28 ordered layers. The licence record is styles/house/attribution.json (combined notice plus per-source text, licence and licence_url). Places are data/places.json, a GeoJSON FeatureCollection with properties name, settlement, scale and Point [lon,lat]. The road network is data/roads.json: nodes [{id,name,lon,lat}] and undirected edges [{from,to,road}]; edge length is never stored and must be computed from coordinates.

styles.mjs: themeNames(documents) -> theme keys whose document has a sources.base. buildStyle(documents,{theme,archiveUrl}) -> a deep clone of documents[theme] with sources.base.url set to archiveUrl; throw on an unknown theme, a non-string or empty archiveUrl, or a document without sources.base. layerOrder(style) -> the ordered layer id strings.

measure.mjs: haversineMeters(a,b) -> great-circle metres for {lon,lat} using an Earth radius of 6371008.8. pathLengthMeters(points) -> the summed path, 0 for fewer than two points. etaSeconds(meters,speedKph) -> metres divided by speedKph converted to m/s; throw on a non-finite or negative distance or a non-positive speed.

graph.mjs: buildGraph(roads) -> {nodes,adjacency}, where nodes is an array of {id,name,lon,lat} in the order given and adjacency maps every node id to a symmetric list of {to,road}; throw on a duplicate node id, a non-finite coordinate, or an edge naming an unknown node. nearestNode(graph,{lon,lat}) -> the id of the node with the smallest great-circle distance, ties broken by ascending id; null for an empty graph.

routing.mjs: shortestRoute(graph,fromId,toId) -> {nodes,meters} for the least-distance path, where meters is the summed great-circle length of its edges, or null when a node is unknown or no path exists. The result must be deterministic: where two paths tie, the one whose node ids sort first wins. A route must not repeat a node.

directions.mjs: bearingDegrees(a,b) -> the initial bearing in [0,360) from a to b. directionsFor(graph,route) -> one step per edge {from,to,road,meters,bearing,turn}; the first turn is 'start', and a later turn is 'right' when the bearing increases by more than 30 degrees, 'left' when it decreases by more than 30, otherwise 'continue'.

geocode.mjs: both functions read the FeatureCollection directly and return a fresh {name,lon,lat}. findPlace(places,query) -> the best match, or null; an exact case-insensitive name wins, then the shortest name with the query as a prefix, then the shortest name containing it, ties by ascending name. nearestPlace(places,{lon,lat}) -> the nearest place by great-circle distance, ties by ascending name, or null for no places.

view.mjs: renderNavigation({theme,origin,destination,route,directions,etaSeconds,attribution,places,style}) -> a complete HTML string with exactly one <main>, an <h1>, a map container <div id="map" data-theme="THEME">, a route form (method get) whose origin and destination text inputs each have an id and a matching <label for>, the escaped origin and destination with the distance in kilometres and the ETA in minutes, an ordered escaped turn list, and the escaped attribution combined notice (record.combined) with its source links. Escape all dynamic content; no data may become markup.

app.mjs: runScenario({documents,places,roads,attribution,theme='light',archiveUrl,speedKph=90,size,commands=[]}) -> async {responses,state,html}. state {theme,archiveUrl,origin,destination,route,directions,etaSeconds}. commands {id,op,...}: route{origin,destination}->{origin,destination,route,directions,etaSeconds}, where the echoed origin and destination are the resolved place names as strings (not the place objects), geocoding each input name and snapping it to the nearest graph node, with error code PLACE_NOT_FOUND for an unknown name and NO_ROUTE when no path exists; geocode{query}->{place}; theme{theme}->{theme}. An unknown op is UNKNOWN_OP; invalid input is INVALID; a rejected command leaves state unchanged. html is renderNavigation over the current state and the built style. No model, author or team identifiers in the view.`;

const notReady = (name, async = false) =>
  `export ${async ? 'async ' : ''}function ${name}() { throw new Error('Not implemented'); }\n`;

const modules = {
  'styles.mjs': notReady('themeNames') + notReady('buildStyle') + notReady('layerOrder'),
  'measure.mjs': notReady('haversineMeters') + notReady('pathLengthMeters') + notReady('etaSeconds'),
  'graph.mjs': notReady('buildGraph') + notReady('nearestNode'),
  'routing.mjs': notReady('shortestRoute'),
  'directions.mjs': notReady('bearingDegrees') + notReady('directionsFor'),
  'geocode.mjs': notReady('findPlace') + notReady('nearestPlace'),
  'view.mjs': notReady('renderNavigation'),
  'app.mjs': notReady('runScenario', true),
};

const files = {
  'package.json': JSON.stringify({ name: 'ontario-drive', private: true, type: 'module' }, null, 2) + '\n',
  'PRODUCT.md': shared + '\n\n' + spec + '\n',
  'schema.json': JSON.stringify({
    schemaVersion: 1,
    kind: 'drive',
    state: ['theme', 'archiveUrl', 'origin', 'destination', 'route', 'directions', 'etaSeconds'],
    response: { success: ['id', 'ok', 'data'], failure: ['id', 'ok', 'error.code'] },
  }, null, 2) + '\n',
  'styles/house/light.json': asset('styles/house/light.json'),
  'styles/house/dark.json': asset('styles/house/dark.json'),
  'styles/house/attribution.json': asset('styles/house/attribution.json'),
  'data/places.json': asset('data/places.json'),
  'data/roads.json': asset('data/roads.json'),
  ...modules,
  'public/drive.css': '/* Build a responsive, accessible navigation stylesheet. */\n',
  'README.md': '# Ontario Drive\n\nImplement the driving navigation application described in PRODUCT.md on top of the seeded @chester-hill-solutions/map-tiles style documents and the seeded road graph. Run a local scenario by importing runScenario from app.mjs and supplying the seeded style documents, places, roads and commands. No packages or external services are needed. Document the completed modules and local scenario usage here.\n',
};

const editablePaths = [...Object.keys(modules), 'public/drive.css', 'README.md'];

const roles = [
  ['styles', 'Style documents', 'Implement theme selection, deep-clone style building with the archive source, and ordered layer ids. Consume the real 28-layer style documents; do not retype them.', 'styles.mjs'],
  ['measure', 'Distance and ETA', 'Implement great-circle distance, path length and speed-based ETA with the stated Earth radius and input validation.', 'measure.mjs'],
  ['graph', 'Road graph', 'Implement graph construction from nodes and undirected edges, symmetric adjacency, validation, and nearest-node lookup with a deterministic tie-break.', 'graph.mjs'],
  ['routing', 'Shortest route', 'Implement deterministic least-distance routing over the graph, refusing unknown nodes and unreachable destinations, with no repeated nodes.', 'routing.mjs'],
  ['directions', 'Turn-by-turn', 'Implement initial bearing and per-edge driving directions with start/left/right/continue classification at the stated threshold.', 'directions.mjs'],
  ['geocode', 'Place lookup', 'Implement name matching with the exact/prefix/contains precedence and nearest-place lookup, both deterministic and returning fresh objects.', 'geocode.mjs'],
  ['view', 'Accessible navigation view', 'Build the styled navigation view: one main region, themed map container, labelled origin/destination controls, the distance and ETA summary, an escaped turn list and the escaped attribution with source links.', 'view.mjs'],
  ['app', 'Application integration', 'Implement runScenario end to end: geocode both endpoints, route and snap to graph nodes, ordered responses, state unchanged on refusal, and the rendered view.', 'app.mjs'],
];

const criteria = [
  'style-theme-selection',
  'style-archive-source',
  'style-layer-order-preserved',
  'graph-nearest-node',
  'route-shortest-path',
  'route-unreachable-refused',
  'directions-turn-by-turn',
  'geocode-place-lookup',
  'distance-and-eta',
  'rendered-navigation-view',
  'accessible-route-control',
  'public-style-contract',
  'public-routing-contract',
  'public-measure-contract',
];

function fixture() {
  const workstreams = roles.map(([id, role, brief, path]) => ({
    id,
    role,
    brief: brief + ' Read PRODUCT.md and the shared schema. Implement the whole stated contract, integrate with peer modules and preserve the seeded assets. Workstream focus is not exclusive ownership.',
    paths: id === 'view' ? [path, 'public/drive.css'] : id === 'app' ? [path, 'README.md'] : [path],
    dependencies:
      id === 'app'
        ? Object.keys(modules).filter(p => p !== 'app.mjs').map(producerPath => ({ producerPath, consumerPath: 'app.mjs' }))
        : id === 'view'
          ? ['directions.mjs', 'measure.mjs'].map(producerPath => ({ producerPath, consumerPath: 'view.mjs' }))
          : [],
  }));

  const seed = {
    documents: { light: JSON.parse(files['styles/house/light.json']), dark: JSON.parse(files['styles/house/dark.json']) },
    places: JSON.parse(files['data/places.json']),
    roads: JSON.parse(files['data/roads.json']),
    attribution: JSON.parse(files['styles/house/attribution.json']),
    theme: 'dark',
    archiveUrl: 'https://tiles.example.test/ontario.pmtiles',
    speedKph: 90,
    size: { width: 1024, height: 768 },
    commands: [
      { id: 'route', op: 'route', origin: 'Toronto', destination: 'Ottawa' },
      { id: 'theme', op: 'theme', theme: 'light' },
    ],
  };

  return {
    id: 'ontario-drive',
    title: 'Ontario Drive',
    domain: 'map',
    goal: shared + '\n\n' + spec,
    files,
    protectedPaths: Object.keys(files).filter(path => !editablePaths.includes(path)),
    editablePaths,
    criteria: criteria.map(id => ({ id, description: id.replaceAll('-', ' ') })),
    workstreams,
    evaluatorTimeoutMs: 30000,
    reviewInvocation: { path: 'app.mjs', exportName: 'runScenario', args: [structuredClone(seed)] },
  };
}

export const mapMissions = [fixture()];

// --- grading -------------------------------------------------------------------

const ARCHIVE = 'https://tiles.example.test/ontario.pmtiles';
const SIZE = { width: 800, height: 600 };

const response = (result, id) => {
  const row = result.responses.find(value => value.id === id);
  assert.ok(row, `response missing: ${id}`);
  return row;
};
const successful = (result, id) => {
  const row = response(result, id);
  assert.equal(row.ok, true, `${id} was refused: ${JSON.stringify(row.error)}`);
  return row.data;
};

function forms(html) {
  const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? true]));
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(m => ({
    attrs: attrs(m[1]),
    body: m[2],
    inputs: [...m[2].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map(n => ({ tag: n[1], attrs: attrs(n[2]) })),
  }));
}

export async function verifyMapMission(id, root) {
  const fixture = mapMissions.find(value => value.id === id);
  if (!fixture) throw new Error('Unknown map mission');
  return verifyMission(fixture, root, async tools => { await gradeDrive(fixture, tools); });
}

/**
 * Every submission invocation is made once, up front, and cached.
 *
 * The verifier caps a mission at 16 invocations (`missionBounds.invocations`). Grading the
 * drive needs fourteen, so the calls are collected here and the checks assert against the
 * results. A failed call is stored, not thrown, so one broken module fails only the checks
 * that read it instead of collapsing the whole evaluation.
 */
async function gradeDrive(fixture, { invoke, check }) {
  const light = JSON.parse(fixture.files['styles/house/light.json']);
  const attribution = JSON.parse(fixture.files['styles/house/attribution.json']);
  const places = JSON.parse(fixture.files['data/places.json']);
  const roads = JSON.parse(fixture.files['data/roads.json']);
  const documents = { light, dark: JSON.parse(fixture.files['styles/house/dark.json']) };
  const base = { documents, places, roads, attribution, theme: 'light', archiveUrl: ARCHIVE, speedKph: 90, size: SIZE };
  const disconnected = { nodes: [{ id: 'a', name: 'A', lon: 0, lat: 0 }, { id: 'b', name: 'B', lon: 10, lat: 10 }], adjacency: { a: [], b: [] } };

  const call = async (path, name, args) => {
    try { return { ok: true, value: await invoke(path, name, args) }; }
    catch (error) { return { ok: false, error }; }
  };
  const need = result => { assert.ok(result.ok, `invocation failed: ${result.error?.message}`); return result.value; };

  // Dependencies are guarded rather than asserted at this point. `need()` throws, and a
  // throw here would abandon the whole evaluation -- one unimplemented module would report
  // every other contract as failed, which is a lie about the submission and makes the
  // result unreadable. A failed dependency instead marks its dependents failed and the
  // rest of the grading proceeds.
  const failed = error => ({ ok: false, error });
  const names = await call('styles.mjs', 'themeNames', [documents]);
  const built = await call('styles.mjs', 'buildStyle', [documents, { theme: 'light', archiveUrl: ARCHIVE }]);
  const order = await call('styles.mjs', 'layerOrder', [light]);
  const graph = await call('graph.mjs', 'buildGraph', [roads]);
  const nearest = graph.ok ? await call('graph.mjs', 'nearestNode', [graph.value, { lon: -79.3733, lat: 43.7417 }]) : failed(graph.error);
  const route = graph.ok ? await call('routing.mjs', 'shortestRoute', [graph.value, 'toronto', 'ottawa']) : failed(graph.error);
  const unreachable = await call('routing.mjs', 'shortestRoute', [disconnected, 'a', 'b']);
  const steps = graph.ok && route.ok ? await call('directions.mjs', 'directionsFor', [graph.value, route.value]) : failed(route.error ?? graph.error);
  const found = await call('geocode.mjs', 'findPlace', [places, 'timm']);
  const near = await call('geocode.mjs', 'nearestPlace', [places, { lon: -79.3733, lat: 43.7417 }]);
  const meters = await call('measure.mjs', 'haversineMeters', [{ lon: -79.3733, lat: 43.7417 }, { lon: -75.58429, lat: 45.33339 }]);
  const eta = await call('measure.mjs', 'etaSeconds', [360000, 90]);
  const run = await call('app.mjs', 'runScenario', [{
    ...base,
    commands: [
      { id: 'route', op: 'route', origin: 'Toronto', destination: 'Ottawa' },
      { id: 'missing', op: 'route', origin: 'Toronto', destination: 'Atlantis' },
      { id: 'theme', op: 'theme', theme: 'dark' },
    ],
  }]);
  const rejected = await call('styles.mjs', 'buildStyle', [documents, { theme: 'nope', archiveUrl: ARCHIVE }]);

  await check('style-theme-selection', () => {
    assert.deepEqual([...need(names)].sort(), ['dark', 'light']);
    assert.equal(need(built).name, light.name, 'buildStyle did not return the requested theme');
    assert.deepEqual(need(built).layers.map(layer => layer.id), light.layers.map(layer => layer.id));
  });

  await check('style-archive-source', () => {
    assert.equal(need(built).sources.base.url, ARCHIVE);
    assert.equal(need(built).glyphs, light.glyphs, 'the glyphs endpoint was dropped or rewritten');
    assert.equal(need(built).sources.base.attribution, light.sources.base.attribution, 'the source attribution was dropped');
  });

  await check('style-layer-order-preserved', () => {
    assert.deepEqual(need(order), light.layers.map(layer => layer.id));
  });

  await check('graph-nearest-node', () => {
    const builtGraph = need(graph);
    assert.equal(builtGraph.nodes.length, roads.nodes.length);
    for (const node of builtGraph.nodes) {
      const neighbours = builtGraph.adjacency[node.id];
      assert.ok(Array.isArray(neighbours), `no adjacency for ${node.id}`);
      for (const edge of neighbours) assert.ok(builtGraph.adjacency[edge.to].some(back => back.to === node.id), `adjacency is not symmetric at ${node.id}`);
    }
    assert.equal(need(nearest), 'toronto', 'the nearest node to Toronto is not Toronto');
  });

  await check('route-shortest-path', () => {
    const path = need(route);
    assert.ok(path && Array.isArray(path.nodes) && Number.isFinite(path.meters));
    assert.equal(path.nodes[0], 'toronto');
    assert.equal(path.nodes[path.nodes.length - 1], 'ottawa');
    assert.equal(new Set(path.nodes).size, path.nodes.length, 'the route repeats a node');
    for (let index = 1; index < path.nodes.length; index++) {
      assert.ok(need(graph).adjacency[path.nodes[index - 1]].some(edge => edge.to === path.nodes[index]), 'the route uses an edge that does not exist');
    }
    assert.ok(path.meters > 300000 && path.meters < 600000, `Toronto to Ottawa routed ${path.meters} m`);
  });

  await check('route-unreachable-refused', () => {
    assert.equal(need(unreachable), null, 'a disconnected destination produced a route');
  });

  await check('directions-turn-by-turn', () => {
    const list = need(steps);
    assert.equal(list.length, need(route).nodes.length - 1, 'there must be one step per edge');
    assert.equal(list[0].turn, 'start');
    for (const step of list) {
      assert.ok(typeof step.road === 'string' && step.road.length > 0, 'a step is missing its road');
      assert.ok(Number.isFinite(step.meters) && step.meters > 0);
      assert.ok(Number.isFinite(step.bearing) && step.bearing >= 0 && step.bearing < 360);
      assert.ok(['start', 'left', 'right', 'continue'].includes(step.turn));
    }
  });

  await check('geocode-place-lookup', () => {
    assert.equal(need(found).name, 'Timmins');
    assert.equal(need(near).name, 'Toronto');
  });

  await check('distance-and-eta', () => {
    const metres = need(meters);
    assert.ok(metres > 300000 && metres < 430000, `Toronto to Ottawa measured ${metres} m`);
    assert.equal(need(eta), 14400, '360 km at 90 km/h is 14400 s');
  });

  await check('rendered-navigation-view', () => {
    const result = need(run);
    const html = result.html;
    assert.equal((html.match(/<main\b/gi) ?? []).length, 1, 'the view must have exactly one main region');
    assert.ok(html.includes(attribution.combined), 'the attribution notice is not in the view');
    assert.ok(html.includes('Toronto') && html.includes('Ottawa'), 'the route endpoints are not in the view');
    assert.match(html, /\d+(\.\d+)?\s*km/, 'the distance is not in the view');
    assert.match(html, /<ol\b[^>]*>[\s\S]*<li\b/i, 'the turn list is not an ordered list');
    assert.equal(successful(result, 'route').origin, 'Toronto');
    assert.equal(response(result, 'missing').ok, false, 'an unknown destination was routed');
    assert.equal(response(result, 'missing').error.code, 'PLACE_NOT_FOUND');
  });

  await check('accessible-route-control', () => {
    const html = need(run).html;
    const form = forms(html).find(value => value.attrs.method?.toLowerCase() === 'get');
    assert.ok(form, 'no route form');
    for (const name of ['origin', 'destination']) {
      const input = form.inputs.find(value => value.attrs.name === name);
      assert.ok(input && input.attrs.id, `the ${name} input has no id`);
      const id = String(input.attrs.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(form.body, new RegExp(`<label\\b[^>]*for=["']${id}["'][^>]*>[^<]+`, 'i'), `the ${name} input has no label`);
    }
    assert.match(form.body, /<button\b[^>]*type=["']submit["'][^>]*>[^<]+/i, 'the route form has no submit button');
  });

  await check('public-style-contract', () => {
    assert.equal(rejected.ok, false, 'an unknown theme was accepted');
  });

  await check('public-routing-contract', () => {
    assert.equal(need(unreachable), null);
    assert.equal(need(route).nodes.length >= 2, true);
  });

  await check('public-measure-contract', () => {
    assert.ok(need(meters) > 0);
    assert.equal(need(eta), 14400);
  });
}
