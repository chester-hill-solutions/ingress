/**
 * Canada: Crossroads - milestone badges.
 *
 * unlockedMilestones(state) -> string[]
 *   Ids of the public milestones whose `unlocked` is exactly true, in snapshot
 *   order. A fresh array every call.
 * mountBadges(root, {onCelebrate = () => {}} = {}) -> {update(state), destroy()}
 *   The badge wall: First Steps, Sharp Eye and Chapter Complete, each shown as
 *   earned or locked.
 *
 * Truthfulness rules this component keeps:
 *  - A badge is drawn as earned only when state.milestones says
 *    `unlocked === true`. Score, streak and progress are never used to guess,
 *    so a badge can never claim something the engine has not unlocked.
 *  - State that is missing or malformed renders every badge as locked, which
 *    is the honest rendering of "not known yet".
 *  - "Just earned" fires only on a locked -> unlocked transition seen between
 *    two game snapshots while this instance is mounted. A badge that is already
 *    unlocked in the first snapshot is shown as earned without being called
 *    new: we never watched it happen. The note also clears itself, so a
 *    restart leaves no stale claim behind.
 *  - onCelebrate(id, message) replaces the built-in polite announcement, so a
 *    host that already owns a live region (see a11y.mjs) is not read twice.
 *
 * Each badge is a real button with aria-expanded/aria-controls around its
 * description, so pointer, Tab and screen-reader users all reach the rules;
 * buttons already answer Enter and Space, so no key handler is bound. Views are
 * reused between updates, so focus survives a redraw. Every dynamic string is
 * assigned through textContent - there is no innerHTML in this file.
 *
 * Importing this file touches no DOM: the document comes from the root passed
 * to mountBadges, so the module is safe to import under Node.
 */

const FALLBACK = [
  {id: 'first-steps', title: 'First Steps', how: 'Earned once you have answered any one event in this chapter, right or wrong.'},
  {id: 'streak-three', title: 'Sharp Eye', how: 'Earned by answering three events correctly in a row. It stays earned until the chapter is reset.'},
  {id: 'chapter-complete', title: 'Chapter Complete', how: 'Earned when every event in the selected chapter has been answered.'}
];

const CELEBRATION_MS = 7000;

const STYLES = `
.cc-badges{font:inherit;color:inherit;margin:0}
.cc-badges__heading{font:600 .95rem Georgia,serif;margin:0 0 .45rem;text-transform:uppercase;letter-spacing:.08em}
.cc-badges__list{list-style:none;display:flex;flex-wrap:wrap;gap:.6rem;margin:0;padding:0}
.cc-badges__item{display:flex;flex-direction:column;gap:.2rem;flex:1 1 9.5rem;min-width:9.5rem;max-width:16rem}
.cc-badges__badge{font:inherit;cursor:pointer;display:flex;align-items:center;gap:.45rem;text-align:start;
  background:#fdf8ee;color:#153b35;border:1px solid #b46b3a;border-radius:999px;padding:.35rem .8rem}
.cc-badges__badge:focus-visible{outline:3px solid #1f6f6b;outline-offset:2px}
.cc-badges__seal{color:#b46b3a;font-size:1.05rem;line-height:1}
.cc-badges__title{font:600 .95rem Georgia,serif;flex:1 1 auto}
.cc-badges__status{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#7a1f27;
  border:1px solid #d9c7a4;border-radius:999px;padding:0 .45rem}
.cc-badges__item[data-state="unlocked"] .cc-badges__badge{background:#f6e7c9;border-color:#a8722f}
.cc-badges__item[data-state="unlocked"] .cc-badges__status{background:#7a1f27;border-color:#7a1f27;color:#fdf8ee}
.cc-badges__item[data-state="locked"] .cc-badges__badge{opacity:.72;background:#f4efe3}
.cc-badges__item[data-state="locked"] .cc-badges__seal{color:#a49a86}
.cc-badges__new{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#7a1f27}
.cc-badges__how{margin:0;font-size:.85rem;line-height:1.4;color:#4c6b62}
.cc-badges__how[hidden],.cc-badges__new[hidden]{display:none}
.cc-badges__live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;
  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){
  .cc-badges__badge{transition:transform .2s ease,background-color .2s ease}
  .cc-badges__item[data-celebrating="true"] .cc-badges__badge{transform:scale(1.06)}
}
@media (prefers-reduced-motion:reduce){.cc-badges__badge{transition:none}}
`;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

let mountCount = 0;

/** Well-formed milestone records from a snapshot, in the order given. */
function milestoneRecords(state) {
  const list = isPlainObject(state) && Array.isArray(state.milestones) ? state.milestones : [];
  return list
    .filter((entry) => isPlainObject(entry) && isText(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: isText(entry.title) ? entry.title : entry.id,
      how: isText(entry.description) ? entry.description : '',
      unlocked: entry.unlocked === true
    }));
}

/**
 * Ids of the milestones the snapshot marks as unlocked.
 * A truthy-but-not-true `unlocked` (1, 'yes', a missing flag) is not an
 * unlock: only `unlocked === true` counts.
 */
export function unlockedMilestones(state) {
  const ids = [];
  for (const record of milestoneRecords(state)) {
    if (record.unlocked && !ids.includes(record.id)) ids.push(record.id);
  }
  return ids;
}

/**
 * Badge wall for the three canonical milestones, plus any extra milestone the
 * snapshot reports. A milestone the snapshot omits is shown locked, never
 * silently dropped, so the wall always names all three.
 */
function badgeRecords(state) {
  const reported = milestoneRecords(state);
  const known = new Map(FALLBACK.map((item) => [item.id, item]));
  return [
    ...reported,
    ...FALLBACK.filter((item) => !reported.some((record) => record.id === item.id))
      .map((item) => ({...item, unlocked: false}))
  ].map((record) => ({
    ...record,
    how: record.how || known.get(record.id)?.how || 'Earned when the game reports it as unlocked.'
  }));
}

/** Mount the badge wall into root. Throws without a usable DOM root. */
export function mountBadges(root, {onCelebrate = () => {}} = {}) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('mountBadges requires a root element');
  }
  const doc = root.ownerDocument ?? globalThis.document ?? null;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('mountBadges requires a document able to create elements');
  }

  const uid = (mountCount += 1);
  const teardown = [];
  /** Ids already known to be earned; a re-run after a reset may celebrate again. */
  const earned = new Set();
  /** Views are keyed by id and reused, so re-rendering keeps focus where it is. */
  const views = new Map();
  let timer = null;
  /** Monotonic, so a description id is never reused or duplicated. */
  let seq = 0;
  /** False until the game sends its first snapshot, so loading is not "new". */
  let primed = false;
  let destroyed = false;

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  const section = el('div', 'cc-badges');
  const heading = el('h2', 'cc-badges__heading', 'Milestones');
  heading.id = `cc-badges-heading-${uid}`;
  section.setAttribute('aria-labelledby', heading.id);
  const list = el('ul', 'cc-badges__list');
  section.append(heading, list);

  // A host that owns its own live region announces for us instead, so a
  // player is never told the same thing twice.
  const speaks = typeof onCelebrate === 'function';
  let live = null;
  if (!speaks) {
    live = el('p', 'cc-badges__live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    section.appendChild(live);
  }

  const style = doc.createElement('style');
  style.textContent = STYLES;
  (doc.head ?? section).appendChild(style);
  root.appendChild(section);

  function createView(record) {
    const item = el('li', 'cc-badges__item');
    const button = el('button', 'cc-badges__badge');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    const seal = el('span', 'cc-badges__seal', '\u2606');
    seal.setAttribute('aria-hidden', 'true');
    const title = el('span', 'cc-badges__title', record.title);
    const status = el('span', 'cc-badges__status');
    button.append(seal, title, status);
    const note = el('span', 'cc-badges__new', 'Just earned');
    note.setAttribute('hidden', '');
    const how = el('p', 'cc-badges__how', record.how);
    how.id = `cc-badges-how-${uid}-${(seq += 1)}`;
    how.setAttribute('hidden', '');
    button.setAttribute('aria-controls', how.id);
    item.append(button, note, how);
    return {item, button, seal, title, status, note, how, open: false};
  }

  function setOpen(view, open) {
    view.open = open;
    view.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) view.how.removeAttribute('hidden');
    else view.how.setAttribute('hidden', '');
  }

  const onBadgeClick = (event) => {
    const button = event.target?.closest?.('.cc-badges__badge');
    if (!button || !list.contains(button)) return;
    for (const view of views.values()) {
      if (view.button === button) {
        setOpen(view, !view.open);
        return;
      }
    }
  };
  list.addEventListener('click', onBadgeClick);
  teardown.push(() => list.removeEventListener('click', onBadgeClick));

  function clearCelebration() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const view of views.values()) {
      view.item.removeAttribute('data-celebrating');
      view.note.setAttribute('hidden', '');
    }
  }

  function celebrate(records) {
    clearCelebration();
    for (const record of records) {
      const view = views.get(record.id);
      if (!view) continue;
      view.item.setAttribute('data-celebrating', 'true');
      view.note.removeAttribute('hidden');
    }
    const message = records.map((record) => `${record.title} earned.`).join(' ');
    if (speaks) {
      for (const record of records) {
        try {
          onCelebrate(record.id, `${record.title} earned.`);
        } catch {
          // A throwing host callback must not stop the badge from showing.
        }
      }
    } else {
      live.textContent = message;
    }
    timer = setTimeout(clearCelebration, CELEBRATION_MS);
  }

  /** Put the list in `wanted` order, restoring focus if a move took it away. */
  function order(wanted) {
    const current = [...list.children];
    if (current.length === wanted.length && current.every((node, i) => node === wanted[i])) return;
    const active = doc.activeElement;
    for (const node of wanted) list.appendChild(node);
    if (active && list.contains(active) && doc.activeElement !== active && typeof active.focus === 'function') {
      active.focus();
    }
  }

  function render(state) {
    // The snapshot is authoritative only when it actually carries milestones;
    // anything else is "not known yet" and renders the locked fallback.
    const authoritative = isPlainObject(state) && Array.isArray(state.milestones);
    const records = badgeRecords(state);
    const wanted = [];
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      let view = views.get(record.id);
      if (!view) {
        view = createView(record);
        views.set(record.id, view);
      }
      const open = view.button.getAttribute('aria-expanded') === 'true';
      view.item.setAttribute('data-id', record.id);
      view.item.setAttribute('data-state', record.unlocked ? 'unlocked' : 'locked');
      view.seal.textContent = record.unlocked ? '\u2605' : '\u2606';
      view.title.textContent = record.title;
      view.status.textContent = record.unlocked ? 'Earned' : 'Locked';
      if (view.how.textContent !== record.how) view.how.textContent = record.how;
      if (open !== view.open) setOpen(view, open);
      wanted.push(view.item);
    }
    for (const [id, view] of views) {
      if (seen.has(id)) continue;
      views.delete(id);
      if (view.item.parentNode) view.item.parentNode.removeChild(view.item);
    }
    order(wanted);

    // A reset (era change or restart) re-locks badges, which clears any
    // celebration and lets the same badge be celebrated again when re-earned.
    const nowEarned = records.filter((record) => record.unlocked);
    const dropped = [...earned].filter((id) => !nowEarned.some((record) => record.id === id));
    if (dropped.length > 0) clearCelebration();
    for (const id of dropped) earned.delete(id);
    const fresh = nowEarned.filter((record) => !earned.has(record.id));
    for (const record of nowEarned) earned.add(record.id);
    // Only a locked -> unlocked change seen between two game snapshots is news.
    // The first snapshot we receive merely loads the wall, so badges already
    // earned in an earlier session are shown as earned, never as "Just earned".
    if (primed && fresh.length > 0) celebrate(fresh);
    if (authoritative) primed = true;
  }

  render(null);

  return {
    update(state) {
      if (destroyed) return;
      render(state);
    },
    /** Remove every node, listener and timer this instance added. Idempotent. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of teardown.splice(0)) off();
      clearCelebration();
      views.clear();
      earned.clear();
      if (typeof section.remove === 'function') section.remove();
      else if (section.parentNode) section.parentNode.removeChild(section);
      if (typeof style.remove === 'function') style.remove();
      else if (style.parentNode) style.parentNode.removeChild(style);
    }
  };
}
