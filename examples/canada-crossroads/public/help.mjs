/**
 * Canada: Crossroads - keyboard shortcuts and the accessible shortcut guide.
 *
 * mountKeyboardHelp(root, {onAction = () => {}} = {}) -> {update(state), destroy()}
 *
 * - Never changes game state, only reports intents: "1".."4" ->
 *   {type:'answer', eventID, optionID}, "r" -> {type:'restart'}, "?" toggles
 *   the guide. Keystrokes aimed at input/textarea/select/contenteditable, or
 *   carrying Ctrl/Alt/Meta, are left to the page.
 * - One answer is reported per snapshot: repeats wait for the next update().
 * - The guide is a real button (aria-expanded/aria-controls) plus a labelled
 *   region whose body is only built while open, so a closed guide is out of
 *   the way for pointer, keyboard and screen-reader users alike.
 * - destroy() detaches every listener and removes every node it added.
 * - Importing this file has no DOM side effects; nothing happens until mount.
 */

const ANSWER_KEYS = ['1', '2', '3', '4'];
const RESTART_KEYS = ['r', 'R'];
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const SHORTCUTS = [
  ['1 2 3 4', 'choose the answer in that position'],
  ['R', 'restart the current era'],
  ['?', 'show or hide this guide'],
  ['Esc', 'close this guide']
];

const STYLES = `
.cc-help{font:inherit;color:inherit}
.cc-help__toggle{font:inherit;cursor:pointer;background:#fdf8ee;color:#7a1f27;
  border:1px solid #b46b3a;border-radius:6px;padding:.35rem .7rem}
.cc-help__toggle:focus-visible{outline:3px solid #1f6f6b;outline-offset:2px}
.cc-help__panel{margin:.5rem 0 0;padding:.75rem 1rem;max-width:40rem;background:#fdf8ee;
  border:1px solid #b46b3a;border-radius:8px;box-shadow:0 6px 0 rgba(21,59,53,.12)}
.cc-help__panel[hidden]{display:none}
.cc-help__title,.cc-help__subtitle{font:600 1.05rem Georgia,serif;margin:.4rem 0 .2rem}
.cc-help__list,.cc-help__choices{margin:.3rem 0;padding-left:1.15rem;line-height:1.65}
.cc-help__key{font:600 .95rem ui-monospace,monospace;background:#f0e4cd;
  border:1px solid #b46b3a;border-radius:4px;padding:0 .35rem}`;

let mountCount = 0;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isModified = (event) => event.ctrlKey === true || event.altKey === true || event.metaKey === true;
const isQuestionMark = (event) => event.key === '?' || (event.key === '/' && event.shiftKey === true);

/** The element a keystroke really landed on (shadow-DOM aware when possible). */
function eventTarget(event) {
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (Array.isArray(path) && path.length > 0) return path[0];
  }
  return event.target ?? null;
}

/** True while the user is typing somewhere, or inside an editable region. */
function isTypingTarget(node) {
  let element = node;
  for (let steps = 0; element && element.nodeType === 1 && steps < 100; steps += 1) {
    if (TYPING_TAGS.has(element.tagName) || element.isContentEditable === true) return true;
    const editable = element.getAttribute?.('contenteditable');
    if (editable !== null && editable !== undefined && editable !== '' && editable !== 'false') return true;
    if (element.getAttribute?.('role') === 'textbox') return true;
    element = element.parentNode;
  }
  return false;
}

/**
 * Build the guide inside root and bind the shortcut listener.
 * @param {Element} root container that receives the guide
 * @param {{onAction?: (action: {type: string, eventID?: string, optionID?: string}) => void}} [options]
 * @returns {{update: (state: object) => void, destroy: () => void}}
 */
export function mountKeyboardHelp(root, {onAction = () => {}} = {}) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('mountKeyboardHelp requires a root element');
  }
  const doc = root.ownerDocument ?? globalThis.document ?? null;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('mountKeyboardHelp requires a DOM element as root');
  }

  const emit = typeof onAction === 'function' ? onAction : () => {};
  const panelID = `cc-help-panel-${(mountCount += 1)}`;
  const bindings = [];
  let state = null;
  let open = false;
  let answerReported = false;
  let destroyed = false;
  let lastEvent = null;

  function bind(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler);
    bindings.push([target, type, handler]);
  }

  function el(tag, className, textValue) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = String(textValue);
    return node;
  }

  /** One guide row: a run of <kbd> keys, then the description. */
  function row(keys, description) {
    const item = el('li', 'cc-help__row');
    keys.split(' ').forEach((key, index) => {
      if (index > 0) item.appendChild(doc.createTextNode(' '));
      item.appendChild(el('kbd', 'cc-help__key', key));
    });
    item.appendChild(doc.createTextNode(` ${description}`));
    return item;
  }

  function detach(node) {
    if (typeof node.remove === 'function') node.remove();
    else if (node.parentNode) node.parentNode.removeChild(node);
  }

  const currentEvent = () => (isPlainObject(state) && isPlainObject(state.currentEvent) ? state.currentEvent : null);
  const optionText = (option) => (typeof option?.text === 'string' && option.text !== '' ? option.text : 'Answer');

  /** Key labels for the options the player is actually looking at. */
  function choicesList() {
    const list = el('ul', 'cc-help__choices');
    const options = Array.isArray(currentEvent()?.options) ? currentEvent().options : [];
    if (options.length === 0) {
      list.appendChild(el('li', 'cc-help__row', 'No question is waiting for an answer right now.'));
      return list;
    }
    options.forEach((option, index) => {
      if (!ANSWER_KEYS[index]) return; // Only 1..4 are bound.
      list.appendChild(row(ANSWER_KEYS[index], optionText(option)));
    });
    return list;
  }

  function buildBody() {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.appendChild(el('h2', 'cc-help__title', 'Keyboard shortcuts'));
    panel.appendChild(el(
      'p',
      'cc-help__hint',
      'Shortcuts work anywhere on the page except while you are typing in a field.'
    ));
    const shortcuts = el('ul', 'cc-help__list');
    for (const [keys, description] of SHORTCUTS) shortcuts.appendChild(row(keys, description));
    panel.appendChild(shortcuts);
    panel.appendChild(el('h3', 'cc-help__subtitle', 'Keys for the question on screen'));
    panel.appendChild(choicesList());
  }

  const container = el('div', 'cc-help');
  const toggle = el('button', 'cc-help__toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelID);
  toggle.setAttribute('aria-keyshortcuts', '?');
  toggle.appendChild(doc.createTextNode('Keyboard shortcuts '));
  toggle.appendChild(el('kbd', 'cc-help__key', '?'));
  container.appendChild(toggle);

  const panel = el('div', 'cc-help__panel');
  panel.id = panelID;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Keyboard shortcuts');
  panel.setAttribute('hidden', '');
  container.appendChild(panel);

  const style = doc.createElement('style');
  style.textContent = STYLES;
  (doc.head ?? container).appendChild(style);
  root.appendChild(container);

  function setOpen(next) {
    open = next === true;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) {
      panel.setAttribute('hidden', '');
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      return;
    }
    panel.removeAttribute('hidden');
    buildBody();
  }

  function report(action) {
    try {
      emit(action);
    } catch {
      // A throwing host callback must not leave the shortcuts wedged.
    }
  }

  function handleKey(event) {
    if (destroyed || !event || event.defaultPrevented === true) return;
    if (lastEvent === event) return; // The same event, seen by both bound targets.
    lastEvent = event;
    if (isModified(event) || isTypingTarget(eventTarget(event))) return;

    const key = typeof event.key === 'string' ? event.key : '';
    if (isQuestionMark(event)) {
      setOpen(!open);
      event.preventDefault?.();
      return;
    }
    if (key === 'Escape') {
      if (!open) return;
      setOpen(false);
      toggle.focus?.();
      event.preventDefault?.();
      return;
    }
    if (RESTART_KEYS.includes(key)) {
      report({type: 'restart'});
      event.preventDefault?.();
      return;
    }
    const index = ANSWER_KEYS.indexOf(key);
    if (index === -1) return;
    if (answerReported) return; // One answer per snapshot: wait for update().

    const current = currentEvent();
    const options = Array.isArray(current?.options) ? current.options : [];
    const option = options[index];
    if (typeof current?.id !== 'string' || current.id === '') return;
    if (!isPlainObject(option) || typeof option.id !== 'string' || option.id === '') return;

    answerReported = true;
    report({type: 'answer', eventID: current.id, optionID: option.id});
    event.preventDefault?.();
  }

  bind(root, 'keydown', handleKey);
  bind(doc, 'keydown', handleKey);
  bind(toggle, 'click', () => setOpen(!open));

  function update(nextState) {
    if (destroyed) return;
    state = isPlainObject(nextState) ? nextState : null;
    answerReported = false;
    if (open) buildBody();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    while (bindings.length > 0) {
      const [target, type, handler] = bindings.pop();
      try {
        target.removeEventListener(type, handler);
      } catch {
        // The mount is being torn down anyway.
      }
    }
    detach(container);
    detach(style);
    lastEvent = null;
    answerReported = false;
    state = null;
    open = false;
  }

  return {update, destroy};
}
