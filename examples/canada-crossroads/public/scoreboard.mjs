/**
 * Canada: Crossroads - score, streak and chapter progress.
 *
 * Stable contract (progress.mjs imports formatScore from here):
 *   formatScore(state) -> {score, streak, progressLabel}
 *   mountScoreboard(root) -> {update(state), destroy(), summary, element}
 *
 * Display only: it reads score, streak and the progress counts, never a
 * question, an option, a correctOptionID or an explanation. Every dynamic
 * string reaches the page through textContent; the only authored markup is
 * this module's own constant CSS.
 *
 * Safe to import in Node: nothing touches a DOM until mountScoreboard() runs.
 */

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const num = (value) => (Number.isFinite(value) ? value : 0);

/** The engine's streak-three milestone: three correct answers in a row. */
const SHARP_EYE = 3;

/** Finite answered/total counts, or 0/0. Never NaN, never undefined. */
function countsOf(state) {
  const progress = record(record(state).progress);
  return {answered: num(progress.answered), total: num(progress.total)};
}

/**
 * Snapshot numbers, defensively: any missing or non-finite score or streak
 * reads as 0, and progressLabel is exactly "answered / total".
 */
export function formatScore(state) {
  const source = record(state);
  const {answered, total} = countsOf(state);
  return {
    score: num(source.score),
    streak: num(source.streak),
    progressLabel: `${answered} / ${total}`
  };
}

// Namespaced so the shell's own stylesheet can never collide with this board.
// Colours read from shared --cc-* custom properties with paper/ink fallbacks.
const CSS = `
.scoreboard{margin:0;font:inherit}
.scoreboard-row{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0}
.scoreboard-tile{flex:1 1 7.5rem;min-width:6rem;padding:.35rem .7rem;text-align:center;
  border:2px solid var(--cc-copper,#b06a2c);border-radius:12px;
  background:var(--cc-paper,#f5efe4);color:var(--cc-ink,#153b35);
  box-shadow:0 2px 0 rgba(90,60,30,.16)}
.scoreboard-tile.is-sharp{border-color:var(--cc-red,#a72a35)}
.scoreboard-label{margin:0;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;opacity:.75}
.scoreboard-value{display:block;margin:0}
.scoreboard-number{display:block;color:var(--cc-red,#a72a35);
  font:700 clamp(1.4rem,4.6vw,2.2rem)/1.05 Georgia,'Iowan Old Style',serif}
.scoreboard-tile.is-sharp .scoreboard-number{color:var(--cc-copper,#8a5a2b)}
.scoreboard-hint{display:block;font-size:.72rem;font-style:italic;opacity:.8}
.scoreboard-bar{display:block;width:100%;height:.5rem;margin:.25rem 0;
  accent-color:var(--cc-copper,#b06a2c)}
`;

/** Create an element, then write text and attributes. innerHTML is never used. */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * Liveness honours both the visitor's OS preference and the data-reduced-motion
 * flag that a11y.mjs writes onto the page root.
 */
function motionOff() {
  try {
    if (globalThis.document?.documentElement?.dataset?.reducedMotion === 'true') return true;
  } catch {
    // A host without a readable dataset simply gets no flag.
  }
  const media = globalThis.matchMedia;
  if (typeof media !== 'function') return false;
  try {
    return media.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function buildBoard(doc, root) {
  const style = el(doc, 'style');
  style.textContent = CSS.replace(/\s+/g, ' ').trim();

  const section = el(doc, 'section', 'scoreboard');
  section.setAttribute('aria-label', 'Scoreboard');
  section.setAttribute('data-phase', 'playing');

  const row = el(doc, 'dl', 'scoreboard-row');
  const tiles = {};
  let bar = null;
  const draft = [
    ['score', 'Score', 'first crossroads ahead'],
    ['streak', 'Streak', 'no run yet'],
    ['progress', 'Progress', 'events answered']
  ];
  for (const [key, label, hint] of draft) {
    const tile = el(doc, 'div', 'scoreboard-tile');
    tile.setAttribute('data-metric', key);
    const number = el(doc, 'span', 'scoreboard-number', '0');
    const note = el(doc, 'span', 'scoreboard-hint', hint);
    const value = el(doc, 'dd', 'scoreboard-value');
    value.appendChild(number);
    if (key === 'progress') {
      bar = el(doc, 'progress', 'scoreboard-bar');
      bar.setAttribute('aria-label', 'Chapter progress');
      bar.setAttribute('max', '1');
      bar.value = 0;
      value.appendChild(bar);
    }
    value.appendChild(note);
    tile.append(el(doc, 'dt', 'scoreboard-label', label), value);
    tiles[key] = {tile, number, hint: note};
    row.appendChild(tile);
  }

  section.appendChild(row);
  root.appendChild(style);
  root.appendChild(section);
  return {section, style, tiles, bar, animations: new Set()};
}

/**
 * Render the scoreboard into root.
 *
 * update(state) repaints from any public snapshot and tolerates a missing or
 * malformed one; it writes to the DOM only when a number actually changed, so a
 * burst of SSE snapshots costs nothing. destroy() removes this board's own style
 * and section and cancels any animation still in flight, and is idempotent.
 */
export function mountScoreboard(root) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('mountScoreboard requires an element-like root');
  }
  const doc = root.ownerDocument ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('mountScoreboard requires a document that can create elements');
  }

  const view = buildBoard(doc, root);
  let destroyed = false;
  let summary = '';

  /** Write only on a real change; returns whether the number moved. */
  function setNumber(part, value) {
    const next = String(value);
    if (part.number.textContent === next) return false;
    part.number.textContent = next;
    return true;
  }

  /** A quick pop when a number lands: decoration, skipped under reduced motion. */
  function pop(part) {
    if (motionOff() || typeof part.number.animate !== 'function') return;
    try {
      const animation = part.number.animate(
        [{transform: 'scale(0.9)'}, {transform: 'scale(1)'}],
        {duration: 340, easing: 'cubic-bezier(.34,1.5,.64,1)'}
      );
      view.animations.add(animation);
      animation.onfinish = () => view.animations.delete(animation);
    } catch {
      // No animation engine, or no permission to use one: the number still shows.
    }
  }

  function update(state) {
    if (destroyed) return;
    const {score, streak, progressLabel} = formatScore(state);
    const {answered, total} = countsOf(state);
    const run = streak >= SHARP_EYE ? 'Sharp Eye run' : streak > 0 ? 'in a row' : 'no run yet';

    if (setNumber(view.tiles.score, score)) pop(view.tiles.score);
    view.tiles.score.hint.textContent = score === 0 ? 'first crossroads ahead' : 'points gathered';

    if (setNumber(view.tiles.streak, streak)) pop(view.tiles.streak);
    view.tiles.streak.hint.textContent = run;
    const marks = view.tiles.streak.tile.classList;
    if (marks && typeof marks.toggle === 'function') marks.toggle('is-sharp', streak >= SHARP_EYE);

    if (setNumber(view.tiles.progress, progressLabel)) pop(view.tiles.progress);
    view.tiles.progress.hint.textContent = total > 0 ? 'events answered' : 'no events yet';
    view.bar.max = total > 0 ? total : 1;
    view.bar.value = total > 0 ? Math.min(answered, total) : 0;

    view.section.setAttribute('data-phase', String(record(state).phase ?? 'playing'));
    summary = `Score ${score}, streak ${streak} ${run}, ${answered} of ${total} answered.`;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const animation of view.animations) {
      try {
        animation.cancel();
      } catch {
        // Already finished or already cancelled.
      }
    }
    view.animations.clear();
    for (const node of [view.style, view.section]) {
      try {
        const parent = node.parentNode;
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(node);
      } catch {
        // Already detached.
      }
    }
  }

  update(null);

  return {
    update,
    destroy,
    /** A short sentence for the shell to hand to a11y.mjs announce(). */
    get summary() {
      return summary;
    },
    get element() {
      return destroyed ? null : view.section;
    }
  };
}
