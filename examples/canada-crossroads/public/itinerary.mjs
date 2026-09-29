/**
 * Canada: Crossroads - journey checklist.
 *
 * itineraryFor(state) -> fresh [{id, title, year, visited, current}]
 *   Built only from public state.mapEvents, ordered by numeric year then id.
 *   visited: this id appears in the recorded answered list, which says an
 *   answer was recorded and never whether it was right. This module infers
 *   nothing: no correctness, no options, no explanations, no answer keys.
 *   current: state.currentEvent names this id.
 *
 * mountItinerary(root, {onInspect}) -> {update(state), destroy()}
 *   A compact ordered checklist of the stops. Activating a stop (click, Enter
 *   or Space) reports only that stop's id. Arrow keys, Home and End move
 *   between stops through a single roving tab stop.
 *
 * Nothing here touches the DOM at import time, so Node may import the module.
 * Self-contained on purpose: it shares no state with the other view modules.
 *
 * Shell wiring (the page file owns the markup and the module import):
 *   const checklist = mountItinerary(document.querySelector('#itinerary'), {
 *     onInspect: (eventID) => highlight(eventID)   // selection only, no answers
 *   });
 *   checklist.update(snapshot);   // once per GET /state or SSE snapshot
 *   checklist.destroy();          // on teardown
 */

/** Honest markers: "answered" is known, "right" is not. */
const MARKERS = {current: '▸', visited: '✓', upcoming: '○'};
const LABELS = {current: 'current stop', visited: 'answered', upcoming: 'ahead'};

/** data-state words shared with the timeline stops and the atlas legend. */
const STATES = {current: 'current', visited: 'visited', upcoming: 'ahead'};

// Paper, ink, red and copper, matching the rest of the journey.
const ITINERARY_CSS = `
.cc-itinerary{margin:1rem 0 0;padding:.85rem 1rem 1rem;border:1px solid #c9a227;border-radius:12px;background:linear-gradient(#fffdf6,#f9f2e2);color:#153b35}
.cc-itinerary__title{margin:0 0 .5rem;font:700 1.05rem Georgia,serif;color:#a72a35;letter-spacing:.02em}
.cc-itinerary__summary{margin:0 0 .55rem;font-size:.85rem;color:#4a5a54}
.cc-itinerary__list{list-style:none;display:grid;gap:.3rem;margin:0;padding:0}
.cc-itinerary__button{display:flex;align-items:baseline;gap:.5rem;width:100%;font:inherit;font-size:.9rem;text-align:left;padding:.32rem .55rem;border:1px solid transparent;border-radius:8px;background:#fffdf6;color:#153b35;cursor:pointer;transition:background-color .15s ease}
[data-reduced-motion="true"] .cc-itinerary__button{transition:none}
.cc-itinerary__button:hover{background:#f7f1e3}
.cc-itinerary__button:focus{outline:2px solid #1c5b8c;outline-offset:2px}
.cc-itinerary__button:focus-visible{outline-width:3px}
.cc-itinerary__button[data-state="current"]{border-color:#a72a35;box-shadow:inset 3px 0 0 #a72a35}
.cc-itinerary__marker{flex:none;width:1rem;color:#8d8f7a}
.cc-itinerary__button[data-state="visited"] .cc-itinerary__marker{color:#b06a2c}
.cc-itinerary__button[data-state="current"] .cc-itinerary__marker{color:#a72a35}
.cc-itinerary__year{flex:none;font:700 .8rem Georgia,serif;color:#a72a35}
.cc-itinerary__name{flex:1 1 auto;min-width:0}
.cc-itinerary__label{flex:none;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#4a5a54}
`;

/** Keeps heading ids unique when the shell mounts the checklist more than once. */
let mounted = 0;

const kindOf = (stop) => (stop.current ? 'current' : stop.visited ? 'visited' : 'upcoming');
const yearOf = (value) => (Number.isFinite(value) ? value : Number.POSITIVE_INFINITY);

/** Answered ids only: reads eventID, never correct, optionID or explanations. */
function answeredIds(state) {
  const list = state == null ? null : state.answered;
  const ids = new Set();
  const add = (entry) => {
    const id = typeof entry === 'string' ? entry : entry == null ? null : entry.eventID;
    if (typeof id === 'string' && id !== '') ids.add(id);
  };
  if (Array.isArray(list)) {
    for (const entry of list) add(entry);
  } else if (list != null && typeof list !== 'string' && typeof list[Symbol.iterator] === 'function') {
    for (const entry of list) add(entry);
  }
  return ids;
}

/** Chronological order, then id, matching the engine's own ordering. */
function compare(a, b) {
  const years = [yearOf(a.year), yearOf(b.year)];
  if (years[0] !== years[1]) return years[0] < years[1] ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function itineraryFor(state) {
  const events = state != null && Array.isArray(state.mapEvents) ? state.mapEvents : [];
  const answered = answeredIds(state);
  const current = state != null && state.currentEvent != null ? state.currentEvent.id : null;
  const currentId = typeof current === 'string' && current !== '' ? current : null;
  return events
    .filter((event) => event != null && typeof event.id === 'string' && event.id !== '')
    .map((event) => ({
      id: event.id,
      title: typeof event.title === 'string' && event.title !== '' ? event.title : event.id,
      year: Number.isFinite(event.year) ? event.year : null,
      visited: answered.has(event.id),
      current: currentId !== null && currentId === event.id
    }))
    .sort(compare);
}

export function mountItinerary(root, {onInspect = () => {}} = {}) {
  if (root == null || typeof root.appendChild !== 'function') {
    throw new TypeError('mountItinerary requires a root element');
  }
  const doc = root.ownerDocument != null
    ? root.ownerDocument
    : (typeof globalThis.document === 'object' ? globalThis.document : null);
  if (doc == null || typeof doc.createElement !== 'function') {
    throw new TypeError('mountItinerary requires a document that can create elements');
  }
  const inspect = typeof onInspect === 'function' ? onInspect : () => {};

  const shell = doc.createElement('section');
  shell.className = 'cc-itinerary';
  const headingID = `cc-itinerary-${(mounted += 1)}`;
  shell.setAttribute('aria-labelledby', headingID);
  const style = doc.createElement('style');
  style.textContent = ITINERARY_CSS;
  const heading = doc.createElement('h2');
  heading.className = 'cc-itinerary__title';
  heading.id = headingID;
  heading.textContent = 'Journey checklist';
  const summary = doc.createElement('p');
  summary.className = 'cc-itinerary__summary';
  summary.setAttribute('role', 'status');
  const list = doc.createElement('ol');
  list.className = 'cc-itinerary__list';
  list.setAttribute('aria-label', 'Journey stops in chronological order');
  shell.appendChild(style);
  shell.appendChild(heading);
  shell.appendChild(summary);
  shell.appendChild(list);
  root.appendChild(shell);

  let stops = [];
  let buttons = [];
  let focusId = null;
  let destroyed = false;

  function report(id) {
    if (destroyed) return;
    try {
      inspect(id);
    } catch {
      // A caller's error must never break the checklist.
    }
  }

  /** One roving tab stop: the focused stop, else the current one, else the first. */
  function tabbableIndex(preferredId) {
    const remembered = stops.findIndex((stop) => stop.id === preferredId);
    if (remembered >= 0) return remembered;
    const current = stops.findIndex((stop) => stop.current);
    return current >= 0 ? current : 0;
  }

  function onKeydown(event) {
    if (buttons.length === 0) return;
    const here = buttons.indexOf(doc.activeElement);
    const at = here >= 0 ? here : tabbableIndex(focusId);
    let next;
    switch (event.key) {
      case 'ArrowDown': case 'ArrowRight': next = at + 1; break;
      case 'ArrowUp': case 'ArrowLeft': next = at - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const target = buttons[Math.min(Math.max(next, 0), buttons.length - 1)];
    if (target == null) return;
    focusId = target.dataset.eventId;
    for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
    if (typeof target.focus === 'function') target.focus();
  }
  list.addEventListener('keydown', onKeydown);

  /** Returns the stop button plus its list item, so the row stays one unit. */
  function buildStop(stop, index, tabbable) {
    const kind = kindOf(stop);
    const state = STATES[kind];
    const item = doc.createElement('li');
    item.className = 'cc-itinerary__stop';
    item.setAttribute('data-state', state);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'cc-itinerary__button';
    button.dataset.eventId = stop.id;
    button.dataset.eventIndex = String(index);
    button.setAttribute('data-state', state);
    button.tabIndex = tabbable ? 0 : -1;
    if (stop.current) button.setAttribute('aria-current', 'step');
    const marker = doc.createElement('span');
    marker.className = 'cc-itinerary__marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = MARKERS[kind];
    const name = doc.createElement('span');
    name.className = 'cc-itinerary__name';
    name.textContent = stop.title;
    const year = doc.createElement('span');
    year.className = 'cc-itinerary__year';
    year.textContent = Number.isFinite(stop.year) ? String(stop.year) : 'year unknown';
    const label = doc.createElement('span');
    label.className = 'cc-itinerary__label';
    label.textContent = LABELS[kind];
    button.appendChild(marker);
    button.appendChild(name);
    button.appendChild(year);
    button.appendChild(label);
    button.addEventListener('click', () => report(stop.id));
    item.appendChild(button);
    return {item, button};
  }

  function render(state) {
    stops = itineraryFor(state);
    const answeredCount = stops.filter((stop) => stop.visited).length;
    const current = stops.find((stop) => stop.current) ?? null;
    summary.textContent = stops.length === 0
      ? 'No stops to show yet.'
      : `${answeredCount} of ${stops.length} stops answered. `
        + (current == null ? 'No stop is current.' : `Now at ${current.title}.`);

    const active = doc.activeElement;
    const hadFocus = active != null && typeof list.contains === 'function' && list.contains(active);
    const keepId = hadFocus && active.dataset != null && typeof active.dataset.eventId === 'string'
      ? active.dataset.eventId
      : focusId;
    const tabbable = tabbableIndex(keepId);

    while (list.firstChild != null) list.removeChild(list.firstChild);
    buttons = [];
    stops.forEach((stop, index) => {
      const row = buildStop(stop, index, index === tabbable);
      list.appendChild(row.item);
      buttons.push(row.button);
    });
    focusId = stops.length === 0 ? null : stops[tabbable].id;
    if (hadFocus) restoreFocus(keepId);
  }

  function restoreFocus(id) {
    for (const button of buttons) {
      if (button.dataset.eventId !== id) continue;
      if (typeof button.focus === 'function') button.focus();
      return;
    }
  }

  return {
    update(state) {
      if (destroyed) return;
      render(state == null ? null : state);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stops = [];
      buttons = [];
      list.removeEventListener('keydown', onKeydown);
      if (shell.parentNode != null) shell.parentNode.removeChild(shell);
    }
  };
}
