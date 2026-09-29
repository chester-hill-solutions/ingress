/**
 * Canada: Crossroads - chapter selector and chronological timeline.
 *
 * orderedEvents(events) -> fresh array of fresh clones, numeric year then id.
 * mountTimeline(root, {onEra}) -> {update(state), destroy()}
 *
 * Contract notes for the UI specialist:
 *  - Importing this module touches no DOM, so it is safe to load under Node for
 *    the pure helper alone.
 *  - The track is an ordered list built from the era's public mapEvents and
 *    shows year, title and region only. Questions, explanations and answer keys
 *    are never read here and raw history is never fetched.
 *  - Chapter buttons are real <button> elements, so tab, Enter and Space all
 *    work; Left/Right/Up/Down/Home/End move focus between them without
 *    scrolling the page. Choosing a chapter only reports onEra(era): the
 *    pressed state follows the snapshot, so the buttons never claim a change
 *    the server has not confirmed.
 *  - Every dynamic string is written with textContent.
 *  - update() is a no-op once destroyed; destroy() is idempotent and takes the
 *    section, its listeners and its stylesheet with it.
 *  - Chapter names are borrowed from ./era-intro.mjs so the selector, the
 *    introduction card and the heading never disagree.
 */

import {eraIntroduction} from './era-intro.mjs';

const CHAPTERS = ['early-contact', 'confederation', 'modern'];
const EMPTY_TRACK = 'No stops are plotted in this chapter yet.';
const TRACK_NOTE = 'Selected events, oldest first. This sample is not exhaustive.';

// Paper, ink, red and copper, matching the rest of the journey.
const TIMELINE_CSS = `
.cc-timeline{margin:1.25rem 0;padding:1rem 1.1rem 1.15rem;border:1px solid #c9a227;border-radius:12px;background:linear-gradient(#fffdf6,#f9f2e2);color:#153b35}
.cc-tl-title{margin:0 0 .55rem;font:700 1.15rem Georgia,serif;color:#a72a35;letter-spacing:.02em}
.cc-tl-chapters{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 .7rem}
.cc-tl-chapter{font:inherit;font-size:.85rem;padding:.3rem .8rem;border:1px solid #a72a35;border-radius:999px;background:#fff;color:#a72a35;cursor:pointer;transition:background-color .15s ease,color .15s ease}
[data-reduced-motion="true"] .cc-tl-chapter{transition:none}
.cc-tl-chapter:hover{background:#fbe9e6}
.cc-tl-chapter[aria-pressed="true"],.cc-tl-chapter[aria-pressed="true"]:hover{background:#a72a35;color:#fff7ea;font-weight:700}
.cc-tl-chapter:focus{outline:2px solid #1c5b8c;outline-offset:2px}
.cc-tl-chapter:focus-visible{outline-width:3px}
.cc-tl-era{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;margin:0 0 .55rem;font-size:.85rem;color:#4a5a54}
.cc-tl-era-name{font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#153b35}
.cc-tl-track{list-style:none;display:grid;gap:.4rem;margin:0;padding:.1rem 0 .1rem 1.1rem;border-left:2px solid #c9a227}
.cc-tl-stop{position:relative;padding:.3rem .55rem;border-radius:0 8px 8px 0;background:#fffdf6;font-size:.92rem}
.cc-tl-stop::before{content:"";position:absolute;left:-1.41rem;top:.75rem;width:.5rem;height:.5rem;border:2px solid #c9a227;border-radius:50%;background:#f7f1e3}
.cc-tl-stop[data-state="visited"]::before{background:#c9a227}
.cc-tl-stop[data-state="current"]{background:#fdeee0;box-shadow:inset 3px 0 0 #a72a35}
.cc-tl-stop[data-state="current"]::before{background:#a72a35;border-color:#a72a35}
.cc-tl-year{margin-right:.45rem;font:700 .8rem Georgia,serif;color:#a72a35}
.cc-tl-region{display:block;font-size:.78rem;color:#4a5a54}
.cc-tl-stop--empty{background:none;font-style:italic;color:#4a5a54}
.cc-tl-note{margin:.6rem 0 0;font-size:.76rem;color:#4a5a54}
`;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');

let mounted = 0;

/** Deep copy, so a caller editing the result can never reach the caller's data. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = clone(value[key]);
    return copy;
  }
  return value;
}

/** Numeric year; anything unusable sorts last instead of breaking the order. */
function yearValue(event) {
  const raw = event.year;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Events in chronological order: numeric year first, then id. The array and
 * every record in it are fresh copies of the caller's data.
 */
export function orderedEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((event) => isObject(event))
    .map(clone)
    .sort((a, b) => {
      const left = yearValue(a);
      const right = yearValue(b);
      if (left !== right) return left < right ? -1 : 1;
      const first = text(a.id);
      const second = text(b.id);
      return first === second ? 0 : (first < second ? -1 : 1);
    });
}

/** Chapter name from the introduction module, so both cards always agree. */
function titleFor(era) {
  try {
    return eraIntroduction(era).title;
  } catch {
    return typeof era === 'string' ? era : '';
  }
}

function node(doc, tag, className, content) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function wholeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/** One stop: year, title, region, and whether it is answered or awaiting an answer. */
function buildStop(doc, event, answered, currentID) {
  const id = text(event.id);
  const isCurrent = currentID !== '' && id === currentID;
  const item = node(doc, 'li', 'cc-tl-stop');
  item.setAttribute('data-state', answered.has(id) ? 'visited' : (isCurrent ? 'current' : 'ahead'));
  if (isCurrent) item.setAttribute('aria-current', 'step');
  const year = yearValue(event);
  if (Number.isFinite(year)) item.appendChild(node(doc, 'span', 'cc-tl-year', String(year)));
  item.appendChild(node(doc, 'span', 'cc-tl-title', text(event.title)));
  const region = text(event.region);
  if (region !== '') item.appendChild(node(doc, 'span', 'cc-tl-region', region));
  return item;
}

/**
 * Mount the chapter selector and timeline into root.
 * update(state) re-reads era, progress, answered, currentEvent and mapEvents.
 * destroy() removes everything this call created; both are safe to repeat.
 */
export function mountTimeline(root, {onEra = () => {}} = {}) {
  // An element root is the normal case; a document root is honoured too.
  const doc = root?.ownerDocument ?? (typeof root?.createElement === 'function' ? root : null);
  if (!doc || typeof root.appendChild !== 'function') {
    throw new TypeError('mountTimeline requires a DOM element as its root');
  }
  let destroyed = false;
  const choose = typeof onEra === 'function' ? onEra : () => {};
  const headingID = `cc-timeline-${(mounted += 1)}`;

  const section = doc.createElement('section');
  section.className = 'cc-timeline';
  section.setAttribute('aria-labelledby', headingID);

  const style = doc.createElement('style');
  style.textContent = TIMELINE_CSS;
  section.appendChild(style);

  const title = node(doc, 'h2', 'cc-tl-title', 'The road so far');
  title.id = headingID;
  section.appendChild(title);

  const group = doc.createElement('div');
  group.className = 'cc-tl-chapters';
  group.setAttribute('role', 'group');
  // Named apart from any other chapter selector on the page: two groups with
  // the same accessible name are indistinguishable when navigating by group.
  group.setAttribute('aria-label', 'Chapters on this timeline');
  const buttons = CHAPTERS.map((era) => {
    const button = node(doc, 'button', 'cc-tl-chapter', titleFor(era));
    button.type = 'button';
    button.setAttribute('data-era', era);
    button.setAttribute('aria-pressed', 'false');
    group.appendChild(button);
    return button;
  });
  section.appendChild(group);

  const eraLine = node(doc, 'p', 'cc-tl-era');
  const eraName = node(doc, 'span', 'cc-tl-era-name');
  const eraCount = node(doc, 'span', 'cc-tl-count');
  eraLine.appendChild(eraName);
  eraLine.appendChild(eraCount);
  section.appendChild(eraLine);

  const track = node(doc, 'ol', 'cc-tl-track');
  section.appendChild(track);
  section.appendChild(node(doc, 'p', 'cc-tl-note', TRACK_NOTE));

  const onClick = (event) => {
    const target = event.currentTarget;
    const era = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-era') : '';
    if (!era) return;
    try {
      choose(era);
    } catch {
      // The host owns error reporting; the buttons stay exactly as they were.
    }
  };
  for (const button of buttons) button.addEventListener('click', onClick);

  const onKeydown = (event) => {
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    const {key} = event;
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1
      : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
    let next = -1;
    if (step !== 0) next = (index + step + buttons.length) % buttons.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    // Arrows would otherwise scroll the page out from under the selector.
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof buttons[next].focus === 'function') buttons[next].focus();
  };
  group.addEventListener('keydown', onKeydown);

  function render(state) {
    const source = isObject(state) ? state : {};
    const era = typeof source.era === 'string' ? source.era : '';
    const label = titleFor(era);
    for (const [index, button] of buttons.entries()) {
      button.setAttribute('aria-pressed', String(CHAPTERS[index] === era));
    }
    eraName.textContent = label;
    const progress = isObject(source.progress) ? source.progress : {};
    const stops = orderedEvents(source.mapEvents);
    eraCount.textContent = `${wholeNumber(progress.answered)} of ${wholeNumber(progress.total)} answered`;

    const answered = new Set();
    if (Array.isArray(source.answered)) {
      for (const entry of source.answered) {
        if (isObject(entry) && typeof entry.eventID === 'string') answered.add(entry.eventID);
      }
    }
    const currentID = isObject(source.currentEvent) ? text(source.currentEvent.id) : '';

    while (track.firstChild) track.removeChild(track.firstChild);
    for (const stop of stops) track.appendChild(buildStop(doc, stop, answered, currentID));
    if (stops.length === 0) {
      const empty = node(doc, 'li', 'cc-tl-stop cc-tl-stop--empty', EMPTY_TRACK);
      empty.setAttribute('data-state', 'empty');
      track.appendChild(empty);
    }
    track.setAttribute(
      'aria-label',
      `${label}: ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}, oldest first`
    );
  }

  render(null);
  root.appendChild(section);

  return {
    update(state) {
      if (destroyed) return;
      try {
        render(state);
      } catch {
        // A malformed snapshot must never take the page down with it.
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const button of buttons) button.removeEventListener('click', onClick);
      group.removeEventListener('keydown', onKeydown);
      if (section.parentNode) section.parentNode.removeChild(section);
    }
  };
}
