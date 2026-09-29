/**
 * Canada: Crossroads — game-term glossary.
 *
 * glossaryEntries() -> fresh [{term, definition}]
 *   Vocabulary for playing, never a restatement of history and never a hint at
 *   which option is right. Each call returns new objects, so a caller that
 *   mutates the result cannot affect anyone else.
 *
 * mountGlossary(root, {labelled} = {}) -> {update(state), destroy()}
 *   A compact <details>/<summary> disclosure — native keyboard operation and
 *   expanded/collapsed announcement, so no listeners to unbind — around a
 *   <dl> of terms. Every dynamic string is assigned via textContent.
 *   update(state) marks which terms are live right now (a current chapter, a
 *   running streak, an earned badge, feedback that carries a source) by
 *   accenting the row's left rule. It adds no numbers the scoreboard, badge
 *   row and milestone notes already show, and it is not a live region: the
 *   accessibility owner does the announcing.
 *   destroy() is idempotent, removes the section, and makes update() a no-op.
 *
 * Importing this module touches no DOM: nothing reads `document` and no node is
 * created until mountGlossary() runs. Peers: call update(snapshot) per
 * snapshot; style via the glossary* class names.
 */

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isCount = (value) => Number.isFinite(value) && value > 0;

/**
 * The one source of truth for the guide. `live` is internal bookkeeping for
 * update() and is never exposed: glossaryEntries() returns only term and
 * definition, so these constants are the only copy of this wording.
 */
const GLOSSARY_TERMS = [
  {
    term: 'Era',
    definition:
      'Chapter selection. Choosing an era loads that chapter of events in year order and clears your score, streak, answers and badges.',
    live: (view) => isText(view.era)
  },
  {
    term: 'Streak',
    definition:
      'Consecutive correct answers in the chapter you are playing. A correct answer adds one; a wrong answer returns the count to zero.',
    live: (view) => isCount(view.streak)
  },
  {
    term: 'Milestone',
    definition:
      'An earned game badge. First Steps arrives after your first answer, Sharp Eye at a streak of three, and Chapter Complete once the chapter is finished.',
    live: (view) => Array.isArray(view.milestones) && view.milestones.some((badge) => badge && badge.unlocked === true)
  },
  {
    term: 'Source',
    definition:
      'The official reference shown with your feedback. It points to where the game\u2019s own history text was researched, and appears only after you answer.',
    live: (view) => {
      const source = view.feedback && view.feedback.source;
      return !!source && (isText(source.title) || isText(source.url));
    }
  }
].map((entry) => Object.freeze(entry));

/** Fresh copies, in reading order. Mutating them cannot reach the originals. */
export function glossaryEntries() {
  return GLOSSARY_TERMS.map((entry) => ({term: entry.term, definition: entry.definition}));
}

/** The document that owns `root`; never reads a global at import time. */
function ownerDocument(root) {
  if (root && typeof root === 'object') {
    if (root.ownerDocument && typeof root.ownerDocument.createElement === 'function') return root.ownerDocument;
    if (root.nodeType === 9 && root.body) return root;
  }
  const global = typeof globalThis === 'undefined' ? null : globalThis.document;
  return global && typeof global.createElement === 'function' ? global : null;
}

/** The element to append to, or null when the caller gave us nothing usable. */
function hostFor(root, doc) {
  // An element host is the normal case. A document mounts into its body.
  if (root && typeof root.appendChild === 'function') {
    return root.nodeType === 9 ? (root.body ?? root) : root;
  }
  if (root) return null;
  return doc && doc.body && typeof doc.body.appendChild === 'function' ? doc.body : null;
}

/** True when the host does not already announce a name, so we must not add one. */
function needsHeading(host) {
  if (host.getAttribute('aria-label') || host.getAttribute('aria-labelledby')) return false;
  const sibling = host.previousElementSibling;
  return !(sibling && /^H[1-6]$/.test(sibling.tagName));
}

/** One themed, class-tagged element. Text is only ever assigned textContent. */
function element(doc, tag, className, cssText) {
  const node = doc.createElement(tag);
  node.className = className;
  node.style.cssText = cssText;
  return node;
}

let instances = 0;

/** Build the guide. Throws a TypeError when there is no DOM element to use. */
export function mountGlossary(root, {labelled} = {}) {
  const doc = ownerDocument(root);
  const host = doc ? hostFor(root, doc) : null;
  if (!host) throw new TypeError('mountGlossary requires a DOM element to mount into');

  const section = element(doc, 'section', 'glossary', 'margin:0;font-size:.92em;line-height:1.45;');

  // A host that already names itself (or sits under its own heading) must not
  // gain a second, out-of-order heading from us.
  if (labelled === undefined ? needsHeading(host) : labelled !== false) {
    instances += 1;
    const headingID = `glossary-heading-${instances}`;
    const heading = element(doc, 'h2', 'glossary__heading', 'font:inherit;font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;opacity:.75;margin:0 0 .35em;');
    heading.id = headingID;
    heading.textContent = 'Field guide';
    section.setAttribute('aria-labelledby', headingID);
    section.append(heading);
  }

  const details = element(doc, 'details', 'glossary__disclosure', 'border:1px solid rgba(29,43,48,.16);border-radius:10px;padding:.45rem .65rem;');
  const summary = element(doc, 'summary', 'glossary__summary', 'cursor:pointer;font-weight:600;');
  summary.textContent = 'Game terms';

  const list = element(doc, 'dl', 'glossary__list', 'margin:.55rem 0 0;');
  const rows = GLOSSARY_TERMS.map((entry) => {
    const row = element(doc, 'div', 'glossary__row', 'border-left:3px solid transparent;padding-left:.5rem;margin:0 0 .45rem;');
    const term = element(doc, 'dt', 'glossary__term', 'font-weight:700;');
    term.textContent = entry.term;
    const definition = element(doc, 'dd', 'glossary__definition', 'margin:.1rem 0 0;');
    definition.textContent = entry.definition;
    row.append(term, definition);
    list.append(row);
    return row;
  });

  details.append(summary, list);
  section.append(details);
  host.appendChild(section);

  let alive = true;

  function update(state) {
    if (!alive) return;
    const view = state && typeof state === 'object' ? state : {};
    for (let index = 0; index < rows.length; index += 1) {
      rows[index].style.borderLeftColor = GLOSSARY_TERMS[index].live(view) === true ? 'currentColor' : 'transparent';
    }
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    if (section.parentNode) section.parentNode.removeChild(section);
  }

  return {update, destroy};
}
