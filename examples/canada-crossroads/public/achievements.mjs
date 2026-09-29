/**
 * Canada: Crossroads - milestone badges with their how-to-earn details.
 *
 * milestoneDetails(state) -> fresh [{id, title, unlocked, description}]
 *   One entry per milestone the snapshot supplies, in the order supplied.
 *   Nothing is invented: `unlocked` is a strict read of the snapshot, so this
 *   module can never show a badge the engine has not granted, and `title` is
 *   passed through untouched. `description` is the how-to-earn rule for a
 *   known milestone and '' for an unrecognised id, so an unknown badge shows
 *   its name and state but never a made-up rule. Every call returns new
 *   objects; the snapshot is neither mutated nor retained.
 *
 * mountAchievementDetails(root, {heading = 'Milestones'} = {}) -> {update, destroy}
 *   Renders the badge list inside `root`: a name, an Earned/Locked state and,
 *   for the three known milestones, a keyboard-operable "How to earn" toggle
 *   (aria-expanded + aria-controls + aria-describedby) that reveals the rule
 *   in place. A milestone with no known description renders as plain text with
 *   no control, rather than a button that would open nothing. update() patches
 *   the existing nodes (so focus and open disclosures survive a snapshot) and
 *   only rebuilds when the milestone ids themselves change; destroy() removes
 *   only this instance's section. Both are idempotent, and update() after
 *   destroy() is a no-op.
 *   Pass heading: false (or '') when the page already labels the slot, so the
 *   section is named by aria-label instead of a second, duplicate heading.
 *
 * Importing this module touches no DOM: nothing reads `document` and no node
 * exists until mountAchievementDetails() runs. Announce a newly earned badge
 * through the accessibility helper (createAccessibility().announce) rather
 * than a live region here, so snapshots do not re-read the whole list.
 *
 * Peer integration: import {milestoneDetails, mountAchievementDetails} from
 * '/achievements.mjs', mount once into any element, call update(snapshot) on
 * every snapshot and destroy() on teardown. It sits beside mountBadges():
 * that module owns the earned/locked seals, this one owns the how-to-earn
 * text. Style via the cc-ach* class names or override the injected defaults.
 */

const HOW_TO = new Map([
  ['first-steps', 'Answer one event in the chapter you are playing. Any answer counts, right or wrong.'],
  ['streak-three', 'Answer three events correctly in a row, for three consecutive correct answers. Once earned it stays earned until the chapter is restarted.'],
  ['chapter-complete', 'Answer every event in the era you are playing to finish the chapter.']
]);

const CSS = `
.cc-achievements{margin:1.25rem 0;padding:1rem 1.1rem;border:1px solid #c9a227;border-radius:10px;background:#fffdf6;color:#153b35;line-height:1.5}
.cc-ach-heading{margin:0 0 .35rem;font:700 1.15rem Georgia,serif;color:#a72a35;letter-spacing:.02em}
.cc-ach-status{margin:.2rem 0;font-size:.85rem;color:#40514b}
.cc-ach-list{margin:.6rem 0 0;padding:0;list-style:none;display:grid;gap:.5rem}
.cc-ach-list[hidden],.cc-ach-howto[hidden],.cc-ach-empty[hidden]{display:none}
.cc-ach-item{display:grid;gap:.3rem;padding:.45rem .6rem;border:1px solid #e0d5bd;border-left:4px solid #cbb98d;border-radius:4px 10px 10px 4px;background:#f9f3e6}
.cc-ach-item[data-unlocked="true"]{border-left-color:#a72a35;background:#fdf1ec}
.cc-ach-row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.cc-ach-name{font-weight:700}
.cc-ach-state{margin-left:auto;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:#6d5730}
.cc-ach-item[data-unlocked="true"] .cc-ach-state{color:#a72a35}
.cc-ach-toggle{font:inherit;font-size:.78rem;padding:.2rem .6rem;border:1px solid #a72a35;border-radius:999px;background:#fff;color:#a72a35;cursor:pointer}
.cc-ach-toggle:hover{background:#fdf1ec}
.cc-ach-toggle:focus-visible{outline:3px solid #1c5b8c;outline-offset:2px}
.cc-ach-howto{margin:0;font-size:.85rem;color:#3c4b46}
.cc-ach-empty{margin:.45rem 0 0;font-size:.85rem;color:#40514b}
`;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');

export function milestoneDetails(state) {
  const supplied = isPlainObject(state) && Array.isArray(state.milestones) ? state.milestones : [];
  return supplied.filter(isPlainObject).map((entry) => {
    const id = text(entry.id);
    return {
      id,
      title: text(entry.title),
      unlocked: entry.unlocked === true,
      description: HOW_TO.get(id) ?? ''
    };
  });
}

let mounts = 0;

export function mountAchievementDetails(root, options = {}) {
  // A document root is accepted too; an element root is the normal case.
  const doc = root && root.nodeType === 9 ? root : (root?.ownerDocument ?? root);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('mountAchievementDetails requires a DOM root');
  }
  const host = root && root.nodeType !== 9 && typeof root.appendChild === 'function'
    ? root
    : (root?.body ?? root);
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('mountAchievementDetails requires a DOM root');
  }

  const opts = isPlainObject(options) ? options : {};
  const headingText = 'heading' in opts ? opts.heading : 'Milestones';
  const showHeading = typeof headingText === 'string' && headingText.trim() !== '';

  const uid = `cc-ach-${(mounts += 1)}`;
  const make = (tag, className) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const section = make('section', 'cc-achievements');
  if (showHeading) {
    section.setAttribute('aria-labelledby', `${uid}-title`);
  } else {
    section.setAttribute('aria-label', 'Milestone badges');
  }
  const style = make('style');
  style.textContent = CSS;
  section.appendChild(style);
  if (showHeading) {
    const heading = make('h2', 'cc-ach-heading');
    heading.id = `${uid}-title`;
    heading.textContent = headingText;
    section.appendChild(heading);
  }
  const status = make('p', 'cc-ach-status');
  const list = make('ul', 'cc-ach-list');
  const empty = make('p', 'cc-ach-empty');
  empty.textContent = 'Milestones appear as you answer in a chapter.';
  section.append(status, list, empty);
  host.appendChild(section);

  const items = new Map();
  const opened = new Set();
  let signature = null;
  let destroyed = false;

  function setOpen(id, expanded) {
    if (expanded) opened.add(id);
    else opened.delete(id);
    const entry = items.get(id);
    if (entry?.button) {
      entry.button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      entry.howto.hidden = !expanded;
    }
  }

  function build(detail) {
    const item = make('li', 'cc-ach-item');
    item.setAttribute('data-milestone-id', detail.id);
    const row = make('div', 'cc-ach-row');
    const name = make('span', 'cc-ach-name');
    const state = make('span', 'cc-ach-state');
    row.append(name, state);
    item.appendChild(row);
    const entry = {item, name, state, button: null, howto: null, onClick: null};

    // No known rule: name and state only, never a control that opens nothing.
    if (detail.description === '') return entry;

    const howtoID = `${uid}-howto-${detail.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const button = make('button', 'cc-ach-toggle');
    button.type = 'button';
    button.textContent = 'How to earn';
    button.setAttribute('aria-label', `How to earn ${detail.title !== '' ? detail.title : detail.id}`);
    button.setAttribute('aria-controls', howtoID);
    button.setAttribute('aria-describedby', howtoID);
    const howto = make('p', 'cc-ach-howto');
    howto.id = howtoID;
    howto.textContent = detail.description;
    entry.button = button;
    entry.howto = howto;
    entry.onClick = () => setOpen(detail.id, !opened.has(detail.id));
    if (typeof button.addEventListener === 'function') button.addEventListener('click', entry.onClick);
    button.setAttribute('aria-expanded', opened.has(detail.id) ? 'true' : 'false');
    howto.hidden = !opened.has(detail.id);
    row.appendChild(button);
    item.appendChild(howto);
    return entry;
  }

  function paint(detail, entry) {
    const label = detail.title !== '' ? detail.title : detail.id;
    entry.name.textContent = label;
    entry.state.textContent = detail.unlocked ? 'Earned' : 'Locked';
    entry.item.setAttribute('data-unlocked', detail.unlocked ? 'true' : 'false');
  }

  function rebuild(details) {
    // Rebuilding can move focus, so hand it back to the same badge if we can.
    const active = doc.activeElement;
    const holder = active && typeof active.closest === 'function' ? active.closest('[data-milestone-id]') : null;
    const focusedID = holder ? holder.getAttribute('data-milestone-id') : null;
    for (const entry of items.values()) {
      if (entry.onClick && typeof entry.button?.removeEventListener === 'function') {
        entry.button.removeEventListener('click', entry.onClick);
      }
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    items.clear();
    for (const detail of details) {
      const entry = build(detail);
      items.set(detail.id, entry);
      list.appendChild(entry.item);
      paint(detail, entry);
    }
    const restore = focusedID === null ? null : items.get(focusedID)?.button;
    if (restore && typeof restore.focus === 'function') restore.focus();
  }

  function update(state) {
    if (destroyed) return;
    const details = milestoneDetails(state);
    const next = details.map((detail) => detail.id).join('\u0000');
    if (next !== signature) {
      signature = next;
      rebuild(details);
    } else {
      for (const detail of details) {
        const entry = items.get(detail.id);
        if (entry) paint(detail, entry);
      }
    }
    const total = details.length;
    const earned = details.filter((detail) => detail.unlocked).length;
    status.textContent = total === 0 ? 'No milestones yet.' : `Earned ${earned} of ${total}`;
    list.hidden = total === 0;
    empty.hidden = total > 0;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const entry of items.values()) {
      if (entry.onClick && typeof entry.button?.removeEventListener === 'function') {
        entry.button.removeEventListener('click', entry.onClick);
      }
    }
    items.clear();
    opened.clear();
    signature = null;
    if (section.parentNode) section.parentNode.removeChild(section);
  }

  update(null);
  return {update, destroy};
}
