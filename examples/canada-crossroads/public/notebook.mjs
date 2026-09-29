/**
 * Canada: Crossroads - field notebook: review notes for answers already given.
 *
 * createNotebook() -> {record(state), entries(), clear()}
 *   record(state)  Reads state.feedback and nothing else. A note is stored only
 *                  when a real feedback object is present, so nothing is ever
 *                  invented. One note per eventID; once 32 are stored, the
 *                  oldest is dropped. Returns a fresh copy of the notes.
 *   entries()      Fresh array of fresh {eventID, correct, explanation, source}.
 *   clear()        Forgets every note. Idempotent.
 *   Stored notes and returned notes are deep copies: a caller cannot reach in.
 *
 * mountNotebook(root, {notebook = createNotebook()} = {}) -> {update(state), destroy()}
 *   update(state)  Records the supplied feedback, then re-renders the notes.
 *   destroy()      Removes the section and its listener. Idempotent; a later
 *                  update() is a no-op.
 *
 * A note exists only because the server produced feedback, so only answered
 * evidence is ever shown. Raw history and answer keys are never read here, and
 * map events are consulted for a title only, never for question content.
 */

const MAX_ENTRIES = 32;
const SAFE_URL = /^https?:\/\//i;

const NOTEBOOK_CSS = `
.cc-notebook{margin:1.25rem 0;padding:1rem 1.1rem;border:1px solid #c9a227;border-radius:10px;background:#fffdf6;color:#153b35;line-height:1.5}
.cc-notebook h2{margin:0 0 .35rem;font:700 1.15rem Georgia,serif;color:#a72a35;letter-spacing:.02em}
.cc-nb-top{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;justify-content:space-between}
.cc-nb-hint,.cc-nb-status{margin:.2rem 0;font-size:.85rem;color:#4a5a54}
.cc-nb-status{font-weight:600;color:#a72a35}
.cc-nb-clear{font:inherit;font-size:.78rem;padding:.25rem .6rem;border:1px solid #a72a35;border-radius:999px;background:#fff;color:#a72a35;cursor:pointer}
.cc-nb-clear[disabled]{opacity:.5;cursor:default}
.cc-nb-list{margin:.6rem 0 0;padding-left:1.3rem;display:grid;gap:.55rem}
.cc-nb-note{padding:.5rem .65rem;border-left:4px solid #cbb98d;background:#f7f1e3;border-radius:0 8px 8px 0}
.cc-nb-note[data-correct="true"]{border-left-color:#a72a35}
.cc-nb-head{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:space-between;margin:0 0 .2rem;font-size:.9rem}
.cc-nb-verdict{font-weight:700;color:#a72a35;white-space:nowrap}
.cc-nb-text{margin:0;font-size:.9rem}
.cc-nb-source{margin:.35rem 0 0;font-size:.8rem}
.cc-nb-source a{color:#1c5b8c}
`;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');

let headingCount = 0;

function copyNote(note) {
  return {
    eventID: note.eventID,
    correct: note.correct,
    explanation: note.explanation,
    source: {title: note.source.title, url: note.source.url}
  };
}

/** Feedback -> a storable note, or null when there is no usable feedback. */
function toNote(feedback) {
  if (!isPlainObject(feedback)) return null;
  const eventID = text(feedback.eventID).trim();
  if (eventID === '') return null;
  const source = isPlainObject(feedback.source) ? feedback.source : {};
  return {
    eventID,
    correct: feedback.correct === true,
    explanation: text(feedback.explanation),
    source: {title: text(source.title), url: text(source.url)}
  };
}

/** Title of an already-answered event, from the era's public map events. */
function titleFor(events, eventID) {
  if (!Array.isArray(events)) return '';
  for (const event of events) {
    if (isPlainObject(event) && event.id === eventID) return text(event.title);
  }
  return '';
}

export function createNotebook() {
  const notes = [];
  const seen = new Set();

  function entries() {
    return notes.map(copyNote);
  }

  function record(state) {
    const note = toNote(isPlainObject(state) ? state.feedback : null);
    if (note !== null && !seen.has(note.eventID)) {
      seen.add(note.eventID);
      notes.push(note);
      // Bounded: once the book is full, the oldest note is the one that goes.
      if (notes.length > MAX_ENTRIES) seen.delete(notes.shift().eventID);
    }
    return entries();
  }

  function clear() {
    notes.length = 0;
    seen.clear();
  }

  return {record, entries, clear};
}

function buildNote(doc, note, title) {
  const item = doc.createElement('li');
  item.className = 'cc-nb-note';
  item.setAttribute('data-event-id', note.eventID);
  item.setAttribute('data-correct', note.correct ? 'true' : 'false');

  const head = doc.createElement('p');
  head.className = 'cc-nb-head';
  const name = doc.createElement('span');
  name.className = 'cc-nb-title';
  name.textContent = title !== '' ? title : note.eventID;
  const verdict = doc.createElement('span');
  verdict.className = 'cc-nb-verdict';
  verdict.textContent = note.correct ? 'Correct' : 'Not this time';
  head.appendChild(name);
  head.appendChild(verdict);
  item.appendChild(head);

  if (note.explanation !== '') {
    const why = doc.createElement('p');
    why.className = 'cc-nb-text';
    why.textContent = note.explanation;
    item.appendChild(why);
  }

  const {url} = note.source;
  const label = note.source.title !== '' ? note.source.title : url;
  if (label !== '') {
    const line = doc.createElement('p');
    line.className = 'cc-nb-source';
    const prefix = doc.createElement('span');
    prefix.textContent = 'Source: ';
    line.appendChild(prefix);
    if (SAFE_URL.test(url)) {
      const link = doc.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('target', '_blank');
      link.textContent = label;
      line.appendChild(link);
    } else {
      const plain = doc.createElement('span');
      plain.textContent = label;
      line.appendChild(plain);
    }
    item.appendChild(line);
  }
  return item;
}

export function mountNotebook(root, {notebook = createNotebook()} = {}) {
  // An element host is the normal case, and a document is honoured by mounting
  // into its body: the page hands us whichever slot element it has, and the
  // section is always removed from the host it was appended to.
  const doc = root && typeof root.createElement === 'function' ? root : (root?.ownerDocument ?? null);
  const host = root && typeof root.appendChild === 'function' && root.nodeType !== 9
    ? root
    : (doc?.body ?? null);
  if (!doc || !host) {
    throw new TypeError('mountNotebook requires a DOM element as its root');
  }
  const uid = `cc-notebook-${(headingCount += 1)}`;

  const section = doc.createElement('section');
  section.className = 'cc-notebook';
  section.setAttribute('aria-labelledby', `${uid}-title`);
  const style = doc.createElement('style');
  style.textContent = NOTEBOOK_CSS;
  section.appendChild(style);

  const heading = doc.createElement('h2');
  heading.id = `${uid}-title`;
  heading.textContent = 'Field notebook';
  section.appendChild(heading);

  const top = doc.createElement('div');
  top.className = 'cc-nb-top';
  const hint = doc.createElement('p');
  hint.className = 'cc-nb-hint';
  hint.textContent = 'Notes for the answers you have already given, newest last.';
  const clearButton = doc.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'cc-nb-clear';
  clearButton.textContent = 'Clear notes';
  top.appendChild(hint);
  top.appendChild(clearButton);
  section.appendChild(top);

  const status = doc.createElement('p');
  status.className = 'cc-nb-status';
  status.setAttribute('role', 'status');
  section.appendChild(status);

  const list = doc.createElement('ol');
  list.className = 'cc-nb-list';
  section.appendChild(list);

  let titles = [];
  let destroyed = false;

  const onClear = () => {
    if (typeof notebook.clear === 'function') notebook.clear();
    render();
  };
  if (typeof clearButton.addEventListener === 'function') {
    clearButton.addEventListener('click', onClear);
  }

  function render() {
    const notes = typeof notebook.entries === 'function' ? notebook.entries() : [];
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const note of notes) {
      list.appendChild(buildNote(doc, note, titleFor(titles, note.eventID)));
    }
    const count = notes.length;
    status.textContent = `${count} review note${count === 1 ? '' : 's'}`;
    clearButton.disabled = count === 0;
  }

  function update(state) {
    if (destroyed) return;
    // Copied, so the book never holds on to the caller's live array.
    titles = Array.isArray(state?.mapEvents) ? state.mapEvents.slice() : [];
    if (typeof notebook.record === 'function') notebook.record(state);
    render();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (typeof clearButton.removeEventListener === 'function') {
      clearButton.removeEventListener('click', onClear);
    }
    if (section.parentNode) section.parentNode.removeChild(section);
    titles = [];
  }

  render();
  host.appendChild(section);
  return {update, destroy};
}
