/**
 * Canada: Crossroads - saved progress.
 *
 * createProgressStore(storage, key = 'canada-crossroads-progress-v1')
 *   -> {read(), write(snapshot), clear()}
 * mountProgress(root, {storage}) -> {update(state), destroy()}
 *
 * Stored shape: {version: 1, eras: {[era]: {score, answered, total}}} for the
 * three canonical eras only, capped at 8 KiB. Reading is total: a missing,
 * unreadable or malformed value simply yields empty progress, and clear() just
 * forgets this key. Only scores and counts are persisted - no question text,
 * option text, answer key or explanation is ever written here.
 *
 * Importing this module in Node has no side effects: no DOM, no storage and no
 * top-level reads. All DOM work happens inside mountProgress().
 */

import {formatScore} from './scoreboard.mjs';

const ERAS = ['early-contact', 'confederation', 'modern'];
const ERA_LABELS = {
  'early-contact': 'Early Contact',
  confederation: 'Confederation',
  modern: 'Modern Canada'
};
const DEFAULT_KEY = 'canada-crossroads-progress-v1';
const MAX_BYTES = 8 * 1024;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Non-negative whole number; numeric strings pass, anything else counts as zero. */
const count = (value) => {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
};

function byteLength(text) {
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  } catch {
    // Fall through to the character count below.
  }
  return text.length;
}

/** Best of two chapter records: higher score wins, a tie goes to more answers. */
function isBetter(next, best) {
  if (!best) return true;
  if (next.score !== best.score) return next.score > best.score;
  return next.answered > best.answered;
}

function toRecord(raw) {
  if (!isObject(raw)) return null;
  return {score: count(raw.score), answered: count(raw.answered), total: count(raw.total)};
}

const eraOf = (snapshot) => {
  const era = isObject(snapshot) ? snapshot.era : '';
  return typeof era === 'string' && ERAS.includes(era) ? era : '';
};

/**
 * A tiny, forgiving wrapper over any getItem/setItem/removeItem storage.
 * A throwing, absent or hostile storage degrades to empty progress in memory.
 */
export function createProgressStore(storage, key = DEFAULT_KEY) {
  const slot = typeof key === 'string' && key !== '' ? key : DEFAULT_KEY;
  const empty = () => ({version: 1, eras: {}});

  function read() {
    let raw = null;
    try {
      raw = storage?.getItem?.(slot);
    } catch {
      return empty();
    }
    if (typeof raw !== 'string' || raw === '') return empty();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty();
    }
    if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.eras)) return empty();
    const eras = {};
    for (const era of ERAS) {
      const saved = toRecord(parsed.eras[era]);
      if (saved) eras[era] = saved;
    }
    return {version: 1, eras};
  }

  /** Merges one era's result, keeping the best score and the winning counts. */
  function write(snapshot) {
    const era = eraOf(snapshot);
    if (era === '') return false;
    const state = isObject(snapshot) ? snapshot : {};
    const progress = isObject(state.progress) ? state.progress : {};
    const candidate = {
      score: count(state.score),
      answered: count(progress.answered),
      total: count(progress.total)
    };
    const saved = read();
    const best = saved.eras[era] ?? null;
    saved.eras[era] = isBetter(candidate, best) ? candidate : best;
    const payload = JSON.stringify(saved);
    if (byteLength(payload) > MAX_BYTES) return false;
    if (typeof storage?.setItem !== 'function') return false;
    try {
      storage.setItem(slot, payload);
      return true;
    } catch {
      return false;
    }
  }

  function clear() {
    if (typeof storage?.removeItem !== 'function') return false;
    try {
      storage.removeItem(slot);
      return true;
    } catch {
      return false;
    }
  }

  return {read, write, clear};
}

/**
 * Renders live and saved chapter progress into root.
 *
 * Every node is phrasing content (spans, styled block) so the panel can also be
 * mounted into a paragraph or a caption; colour and type stay with the shell.
 * Dynamic strings go through textContent only, and destroy() detaches the panel.
 */
export function mountProgress(root, {storage} = {}) {
  const host = root;
  const doc = isObject(host) && isObject(host.ownerDocument) ? host.ownerDocument : globalThis.document;
  if (!isObject(host) || typeof host.appendChild !== 'function' || !doc || typeof doc.createElement !== 'function') {
    return {update() {}, destroy() {}};
  }
  const store = createProgressStore(storage);

  const line = (className) => {
    const node = doc.createElement('span');
    node.className = className;
    // Layout only: the shell keeps ownership of colour and type.
    if (node.style) node.style.cssText = 'display:block;margin:.35rem 0 0;font-size:.86em;';
    return node;
  };
  const panel = doc.createElement('span');
  panel.className = 'cc-progress';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Saved chapter progress');
  panel.setAttribute('aria-live', 'polite');
  const live = line('cc-progress__live');
  const best = line('cc-progress__best');
  const detail = line('cc-progress__detail');
  panel.appendChild(live);
  panel.appendChild(best);
  panel.appendChild(detail);
  host.appendChild(panel);

  let alive = true;

  /** Score display always goes through the scoreboard formatter. */
  function view(state) {
    const fallback = {score: 0, streak: 0, progressLabel: '0 / 0'};
    try {
      const formatted = formatScore(isObject(state) ? state : {});
      if (!isObject(formatted)) return fallback;
      const label = formatted.progressLabel;
      return {
        score: count(formatted.score),
        streak: count(formatted.streak),
        progressLabel: typeof label === 'string' && label !== '' ? label : fallback.progressLabel
      };
    } catch {
      return fallback;
    }
  }

  function update(state) {
    if (!alive) return panel;
    const current = view(state);
    const era = eraOf(state);
    if (era !== '') store.write(state);
    const saved = store.read();
    live.textContent = `Score ${current.score} - Streak ${current.streak} - This chapter ${current.progressLabel}`;
    best.textContent = ERAS.map((id) => {
      const record = saved.eras[id];
      if (!record) return `${ERA_LABELS[id]}: not played yet`;
      return `${ERA_LABELS[id]}: best ${record.score} (${record.answered} / ${record.total})`;
    }).join(' | ');
    const mine = era === '' ? null : saved.eras[era] ?? null;
    detail.textContent = mine === null
      ? 'No saved chapter yet - pick an era to begin.'
      : `Saved best for ${ERA_LABELS[era]}: ${mine.score} points, ${mine.answered} of ${mine.total} answered.`;
    return panel;
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    try {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      else if (typeof host.removeChild === 'function') host.removeChild(panel);
    } catch {
      // A host that already dropped the panel is destroyed as far as we care.
    }
    panel.textContent = '';
  }

  return {update, destroy};
}
