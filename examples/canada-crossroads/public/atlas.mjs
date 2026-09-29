/**
 * Canada: Crossroads - the atlas view.
 *
 * projectMarker(event) -> {x, y, overseas}
 * mountAtlas(root, {onInspect} = {}) -> {update(state), destroy()}
 *
 * The atlas is a pure display surface: it copies only id/title/year/era/region
 * from the public state, so it can never render a question, an option, a
 * correctOptionID or an explanation, and the record handed to onInspect
 * carries those display fields only.
 *
 * Coordinates in data/history.json are illustrative, 0..100, and are not
 * surveyed borders. An event whose region names France is drawn in the
 * labelled France inset rather than on the Canadian landmass.
 *
 * Safe to import in Node: no DOM is touched until mountAtlas() is called.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DISPLAY_FIELDS = ['id', 'title', 'year', 'era', 'region'];
const EARTH = '#5c4632';
const INK = '#1d3a33';
const RED = '#a72a35';
const PAPER = '#f2e8d6';
const WATER = '#bcd2cc';
const SEA = '#d3e1da';

const clamp100 = (value) => Math.min(100, Math.max(0, value));

/** Finite coordinates clamp into 0..100; anything else falls back to the middle. */
function coordinate(value) {
  return Number.isFinite(value) ? clamp100(value) : 50;
}

/** "overseas when region includes France", case- and whitespace-insensitive. */
function mentionsFrance(region) {
  const text = Array.isArray(region) ? region.join(' ') : region;
  return typeof text === 'string' && /france/i.test(text);
}

/** A fresh display record of exactly {x, y, overseas}. */
export function projectMarker(event) {
  const raw = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  return {
    x: coordinate(raw.x),
    y: coordinate(raw.y),
    overseas: mentionsFrance(raw.region)
  };
}

/**
 * Stylized Canada: landmass, Arctic archipelago, Hudson Bay, the Great Lakes,
 * the Cordillera, graticule and sea labels. Authored geometry, deliberately
 * schematic - the map illustrates, it does not survey.
 */
const SCENE = [
  ['defs', {children: [
    ['pattern', {id: 'atlas-waves', width: 6, height: 6, patternUnits: 'userSpaceOnUse', children: [
      ['path', {d: 'M0 4.2 Q1.5 2.2 3 4.2 T6 4.2', fill: 'none', stroke: '#bdd0c9', 'stroke-width': 0.35}]
    ]}],
    ['filter', {id: 'atlas-lift', x: '-20%', y: '-20%', width: '150%', height: '150%', children: [
      ['feDropShadow', {dx: 0.5, dy: 0.8, stdDeviation: 0.6, 'flood-color': '#1d3a33', 'flood-opacity': 0.28}]
    ]}]
  ]}],
  ['rect', {x: 0, y: 0, width: 100, height: 100, fill: `url(#atlas-waves)`}],
  ...[0, 25, 50, 75].map((y) => ['path', {d: `M0 ${y} H100`, stroke: '#a6c4bb', 'stroke-width': 0.2}]),
  // The Arctic archipelago, drawn as scattered floes.
  ['path', {d: 'M24 4 L31 1.5 L36 5 L31 9 L23 7.5 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.3}],
  ['path', {d: 'M39 3 L48 1.5 L52 5.5 L45 9 L38 7.5 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.3}],
  ['path', {d: 'M55 2.5 L65 3 L69 6.5 L60 9.5 L53 7 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.3}],
  ['path', {d: 'M72 4 L82 6 L85 10 L76 12.5 L71 8.5 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.3}],
  ['text', {x: 30, y: 15, class: 'sea-label small', '#': 'Arctic Ocean'}],
  ['text', {x: 5, y: 92, class: 'sea-label', '#': 'Pacific Ocean'}],
  ['text', {x: 80, y: 92, class: 'sea-label', '#': 'Atlantic Ocean'}],
  // Canada: one continuous silhouette, west to east, with the Atlantic coast.
  ['path', {
    d: 'M12 12 L20 14 L27 12 L33 16 L38 15 L43 19 L47 22 L52 24 L56 29 L61 32 L67 33 L72 36 L78 37 L82 41 L88 43 L91 48 L89 53 L93 57 L92 62 L88 65 L89 70 L85 73 L86 78 L82 82 L77 84 L73 90 L67 91 L61 88 L55 86 L50 83 L44 81 L40 77 L34 75 L30 71 L25 68 L21 63 L17 59 L15 53 L12 48 L10 42 L9 35 L10 28 L9 22 Z',
    fill: PAPER,
    stroke: EARTH,
    'stroke-width': 0.6,
    'stroke-linejoin': 'round'
  }],
  // Vancouver Island and Haida Gwaii, sketched off the Pacific coast.
  ['path', {d: 'M6 66 L20 64 L24 65 L16 67 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.4}],
  ['path', {d: 'M6 70 L22 68.5 L24 69.5 L15 71 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.4}],
  ['path', {d: 'M5.5 76 L18 74 L23 75 L14 78 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.4}],
  ['text', {x: 34, y: 58, class: 'country', '#': 'CANADA'}],
  // Hudson Bay: the notch that makes the silhouette recognisable.
  ['path', {d: 'M56 32 L63 30 L69 34 L68 41 L62 45 L55 42 L53 36 Z', fill: WATER, stroke: '#7fa79c', 'stroke-width': 0.35}],
  ['text', {x: 56, y: 38.5, class: 'water-label', '#': 'Hudson Bay'}],
  // The Cordillera and the Appalachians, as hachures rather than a claim.
  ...[[19, 58], [22, 63], [25, 68], [28, 73], [31, 78], [34, 82]].map(([x, y]) => (
    ['path', {d: `M${x - 3} ${y + 3} l3 -4.5 l3 4.5`, fill: 'none', stroke: '#bb9c74', 'stroke-width': 0.45}]
  )),
  ['text', {x: 14, y: 94, class: 'feature', '#': 'the Rockies, schematically'}],
  ...[[70, 54], [73, 58], [76, 62], [79, 66], [82, 70]].map(([x, y]) => (
    ['path', {d: `M${x - 2.5} ${y + 2.5} l2.5 -3.5 l2.5 3.5`, fill: 'none', stroke: '#bb9c74', 'stroke-width': 0.4}]
  )),
  ['text', {x: 66, y: 50, class: 'feature', '#': 'the Appalachians'}],
  ...[[62, 65], [66, 66.5], [70, 66]].map(([x, y]) => (
    ['ellipse', {cx: x, cy: y, rx: 2.6, ry: 1.1, fill: WATER, stroke: '#7fa79c', 'stroke-width': 0.3}]
  )),
  ['text', {x: 56, y: 70.5, class: 'water-label', '#': 'Great Lakes'}],
  ['path', {d: 'M95 6 L95 10.5 M95 6 L93.8 7.9 M95 6 L96.2 7.9', fill: 'none', stroke: INK, 'stroke-width': 0.4}],
  ['text', {x: 95, y: 4.5, class: 'tiny', 'text-anchor': 'middle', '#': 'N'}]
];

/** The France inset: its own frame, its own label, its own slot for overseas pins. */
const INSET = {x: 2, y: 2, w: 36, h: 26, pinX: 6.5, pinY: 17, step: 5.4, maxPinY: 24.5};

const INSET_SCENE = [
  ['rect', {x: INSET.x, y: INSET.y, width: INSET.w, height: INSET.h, rx: 1.5, fill: '#ece2cd', stroke: EARTH, 'stroke-width': 0.55}],
  ['rect', {x: INSET.x + 0.9, y: INSET.y + 0.9, width: INSET.w - 1.8, height: INSET.h - 1.8, rx: 1, fill: 'none', stroke: '#c6b087', 'stroke-width': 0.25}],
  ['path', {d: 'M4.5 6 L8.5 4.6 L11 6.6 L9 9.2 L5.2 8.6 Z', fill: PAPER, stroke: EARTH, 'stroke-width': 0.3}],
  ['text', {x: 4.5, y: 12, class: 'inset-title', '#': 'FRANCE'}],
  ['text', {x: 4.5, y: 14.4, class: 'inset-note', '#': 'overseas theatre'}],
  ['path', {d: `M${INSET.x + 2.5} 15.2 h${INSET.w - 5}`, stroke: '#cdb98f', 'stroke-width': 0.3}]
];

const STYLE = `
.atlas-svg{display:block;width:100%;height:auto;max-width:60rem;margin-inline:auto;
  border:1px solid #cbbb99;border-radius:10px;background:${SEA};
  box-shadow:0 12px 30px rgba(29,58,51,.18)}
.atlas-svg text{font-family:Georgia,'Iowan Old Style',serif;fill:${INK};
  paint-order:stroke;stroke:${SEA};stroke-width:.9px;stroke-linejoin:round}
.atlas-svg .country{font-size:7px;letter-spacing:.5em;fill:${EARTH};stroke-width:1.5px}
.atlas-svg .sea-label{font-size:2.4px;fill:#6f8c83;letter-spacing:.16em;font-style:italic;stroke-width:.6px}
.atlas-svg .sea-label.small{font-size:1.9px}
.atlas-svg .water-label{font-size:1.7px;fill:#4c6b62;font-style:italic;stroke-width:.5px}
.atlas-svg .feature{font-size:1.6px;fill:#8a6f4c;font-style:italic;stroke-width:.5px}
.atlas-svg .tiny{font-size:2.2px;letter-spacing:.1em;stroke-width:.5px}
.atlas-svg .inset-title{font-size:3.2px;letter-spacing:.22em;fill:${RED};stroke:#ece2cd;stroke-width:1.1px}
.atlas-svg .inset-note{font-size:1.6px;fill:#7a6242;font-style:italic;stroke:#ece2cd;stroke-width:.5px}
.atlas-svg .marker{cursor:pointer}
.atlas-svg .marker .halo{fill:${SEA};opacity:.85;stroke:none}
.atlas-svg .marker .pin{fill:${INK};stroke:${PAPER};stroke-width:.5}
.atlas-svg .marker .crown{fill:${RED};stroke:${PAPER};stroke-width:.45}
.atlas-svg .marker .caption{font-size:1.9px;stroke-width:1.2px}
.atlas-svg .marker .year{font-size:1.5px;fill:${EARTH};stroke-width:.9px}
.atlas-svg .marker .leader{stroke:${RED};stroke-width:.35;fill:none;stroke-dasharray:.8 .9}
.atlas-svg .marker.current .pin{fill:${RED}}
.atlas-svg .marker.current .halo,.atlas-svg .marker.overseas .halo{opacity:1;stroke:${RED};stroke-width:.4}
.atlas-svg .marker:hover .halo,.atlas-svg .marker:focus-visible .halo{opacity:1;stroke:${RED};stroke-width:.55}
.atlas-svg .marker:focus-visible .pin{stroke:${RED};stroke-width:.7}
.atlas-svg .legend{font-size:1.7px;fill:#5f7a71;stroke-width:.6px}
.atlas-svg .legend-key{fill:${INK};stroke:${PAPER};stroke-width:.4}
.atlas-svg .legend-key.current{fill:${RED}}
.atlas-svg .legend-key.overseas{fill:${SEA};stroke:${RED};stroke-width:.45}
.atlas-caption{max-width:60rem;margin:.5rem auto 0;font:italic .85rem/1.5 Georgia,serif;color:#5f7a71}
@media (prefers-reduced-motion:no-preference){.atlas-svg .marker{transition:transform .18s ease}}
`;

/** Create an element. Static text only - no innerHTML anywhere in this module. */
function svgNode(doc, name, attrs = {}, text = '') {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== '') node.textContent = String(text);
  return node;
}

function build(doc, [name, attrs = {}]) {
  const {'#': text = '', children = [], ...rest} = attrs;
  const node = svgNode(doc, name, rest, text);
  for (const child of children) node.appendChild(build(doc, child));
  return node;
}

function textNode(doc, x, y, cls, content, anchor = 'middle') {
  return svgNode(doc, 'text', {x, y, class: cls, 'text-anchor': anchor}, content);
}

/** Label only what is safe to show: no question, no option, no answer key. */
function displayRecord(event) {
  const raw = event && typeof event === 'object' ? event : {};
  const record = {};
  for (const field of DISPLAY_FIELDS) {
    if (raw[field] !== undefined) record[field] = raw[field];
  }
  const point = projectMarker(raw);
  record.x = point.x;
  record.y = point.y;
  record.overseas = point.overseas;
  return record;
}

/** Rough advance widths, so labels can be nudged instead of overprinting. */
const widthOf = (value, per = 0.95) => String(value ?? '').length * per;

function overlaps(box, placed) {
  return placed.some((other) =>
    box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0);
}

/**
 * Choose a readable label slot. Candidates run below the pin, above it, then
 * progressively further out; the first that clears every placed label wins.
 */
function placeLabel(x, y, title, year, placed) {
  const anchor = x > 82 ? 'end' : x < 14 ? 'start' : 'middle';
  const span = Math.max(widthOf(title), widthOf(year, 0.8));
  const x0 = anchor === 'end' ? x - 1.6 - span : anchor === 'start' ? x + 1.6 : x - span / 2;
  const candidates = [
    {labelY: y + 5.4, yearY: y + 7.6},
    {labelY: y - 3.2, yearY: y - 5.4},
    {labelY: y + 8, yearY: y + 10.2},
    {labelY: y - 6, yearY: y - 8.2}
  ];
  let chosen = candidates[0];
  for (const candidate of candidates) {
    const box = {x0, x1: x0 + span, y0: candidate.labelY - 1.7, y1: candidate.yearY + 0.5};
    if (!overlaps(box, placed)) {
      chosen = candidate;
      break;
    }
  }
  placed.push({x0, x1: x0 + span, y0: chosen.labelY - 1.7, y1: chosen.yearY + 0.5});
  // The x the text nodes anchor to: the pin, nudged clear of it.
  return {anchor, tx: anchor === 'middle' ? x : x + (anchor === 'end' ? -1.6 : 1.6), ...chosen};
}

/** One interactive marker: halo, pin, title, year, and a keyboard/click hook. */
function makeMarker(doc, record, point, isCurrent, layout, listen, onInspect) {
  const {x, y} = point;
  const group = svgNode(doc, 'g', {
    class: `marker${isCurrent ? ' current' : ''}${layout.overseas ? ' overseas' : ''}`,
    role: 'button',
    tabindex: '0',
    'aria-label': `Inspect ${record.title}, ${record.year}, ${record.region ?? 'region not recorded'}`
  });
  if (layout.overseas) {
    group.appendChild(svgNode(doc, 'path', {
      class: 'leader',
      d: `M${x + 1.6} ${y} h2.4`
    }));
  }
  group.appendChild(svgNode(doc, 'circle', {class: 'halo', cx: x, cy: y, r: 2.5}));
  group.appendChild(svgNode(doc, 'circle', {class: 'pin', cx: x, cy: y, r: 1.15}));
  group.appendChild(svgNode(doc, 'circle', {class: 'crown', cx: x, cy: y, r: 0.45}));

  const label = placeLabel(x, y, record.title, record.year, layout.placed);
  group.appendChild(textNode(doc, label.tx, label.labelY, 'caption', record.title, label.anchor));
  group.appendChild(textNode(doc, label.tx, label.yearY, 'year', record.year, label.anchor));

  const activate = () => {
    if (typeof onInspect !== 'function') return;
    try {
      onInspect(record);
    } catch {
      // A host listener must never break the atlas.
    }
  };
  const onKeyDown = (event) => {
    if (!event) return;
    // `key` is preferred; keyCode/which keep synthetic events working.
    const key = event.key || event.code || '';
    const legacy = event.keyCode ?? event.which;
    const activating = key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Space'
      || legacy === 13 || legacy === 32;
    if (!activating) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    activate();
  };
  listen(group, 'click', () => activate());
  listen(group, 'keydown', onKeyDown);
  return group;
}

/**
 * Render the atlas into root.
 *
 * update(state) redraws from any public snapshot and tolerates missing or
 * malformed state; it never renders currentEvent's question or options.
 * destroy() removes every node and listener this module added, and is safe
 * to call twice.
 */
export function mountAtlas(root, {onInspect = () => {}} = {}) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('mountAtlas requires an element-like root');
  }
  const doc = root.ownerDocument ?? globalThis.document;
  if (!doc || typeof doc.createElementNS !== 'function') {
    throw new TypeError('mountAtlas requires a document able to create SVG elements');
  }

  const teardown = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    teardown.push(() => target.removeEventListener(type, handler));
  };

  // The stylesheet is namespaced to .atlas-* class names, so it cannot leak
  // into the host page; it is removed again by destroy().
  const style = doc.createElement('style');
  style.textContent = STYLE.replace(/\s+/g, ' ').trim();
  const svg = svgNode(doc, 'svg', {
    class: 'atlas-svg',
    viewBox: '0 0 100 104',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
    'aria-label': 'Stylized map of Canada with the selected events, and a France inset for overseas events'
  });
  for (const spec of SCENE) svg.appendChild(build(doc, spec));

  const inset = svgNode(doc, 'g', {class: 'inset', filter: 'url(#atlas-lift)'});
  for (const spec of INSET_SCENE) inset.appendChild(build(doc, spec));
  const markers = svgNode(doc, 'g', {class: 'markers'});
  const legend = svgNode(doc, 'g', {class: 'legend-row'});
  svg.appendChild(inset);
  svg.appendChild(markers);
  svg.appendChild(legend);

  const caption = doc.createElement('p');
  caption.className = 'atlas-caption';
  caption.textContent = 'Map positions are illustrative, not surveyed borders. '
    + 'An event whose region names France is placed in the France inset.';

  root.appendChild(style);
  root.appendChild(svg);
  root.appendChild(caption);

  let latest = null;
  let destroyed = false;

  const emptyLayer = (layer) => {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  };

  function render(state) {
    const source = state && typeof state === 'object' ? state : {};
    latest = source;
    const events = Array.isArray(source.mapEvents) ? source.mapEvents : [];
    const currentID = source.currentEvent && typeof source.currentEvent === 'object'
      ? source.currentEvent.id
      : null;

    // Detach every marker listener before discarding its node.
    while (teardown.length > 0) teardown.pop()();
    emptyLayer(markers);
    emptyLayer(legend);

    const placed = [];
    let overseasSlot = 0;
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const record = displayRecord(event);
      const projected = projectMarker(record);
      // The inset is a callout, not a projection: overseas pins take slots in
      // it so their titles stay readable instead of crowding the coast.
      const point = projected.overseas
        ? {
          x: INSET.pinX,
          y: Math.min(INSET.pinY + overseasSlot * INSET.step, INSET.maxPinY),
          overseas: true
        }
        : {x: projected.x, y: projected.y, overseas: false};
      if (projected.overseas) overseasSlot += 1;
      markers.appendChild(makeMarker(doc, record, point, record.id === currentID, {placed, overseas: projected.overseas}, listen, onInspect));
    }

    if (events.length === 0) {
      markers.appendChild(textNode(doc, 50, 99, 'sea-label', 'This chapter has no events to place.'));
    }

    const keys = [
      ['legend-key current', 'current event'],
      ['legend-key', 'selected event'],
      ['legend-key overseas', 'placed in the France inset']
    ];
    let x = 4;
    for (const [cls, label] of keys) {
      legend.appendChild(svgNode(doc, 'circle', {class: cls, cx: x, cy: 102, r: 0.8}));
      legend.appendChild(textNode(doc, x + 1.8, 102.4, 'legend', label, 'start'));
      x += 4.4 + widthOf(label, 0.78);
    }
  }

  render(null);

  return {
    update(state) {
      if (destroyed) return;
      render(state);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (teardown.length > 0) teardown.pop()();
      latest = null;
      for (const node of [style, svg, caption]) {
        if (typeof root.removeChild === 'function' && node.parentNode === root) {
          root.removeChild(node);
        }
      }
    },
    get state() {
      return latest;
    }
  };
}
