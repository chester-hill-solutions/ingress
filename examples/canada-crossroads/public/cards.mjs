/**
 * Canada: Crossroads - question card.
 *
 * mountQuestionCard(root, {onAnswer = () => {}} = {}) -> {update(state), destroy()}
 *   root       An element to fill, or a document (then body is used).
 *   onAnswer   Called as onAnswer(eventID, optionID) - exactly once per click,
 *              only for the event currently shown, and never with a value the
 *              card has guessed. The card itself never decides what is right.
 *   update(state)
 *              Renders the public snapshot {era, score, streak, progress, mapEvents,
 *              currentEvent, feedback, milestones} and clears the pending lock,
 *              because the snapshot that follows an answer is the one that
 *              advances currentEvent. A state-less or option-less update shows an
 *              honest loading state instead of inventing a question.
 *   destroy()   Detaches every listener and removes this card. Idempotent; any
 *              later update() is a no-op.
 *
 * Contract notes for the shell:
 *  - Importing touches no DOM; every effect happens inside the factory.
 *  - One click fires onAnswer once. The option buttons then stay disabled and
 *    aria-busy until the next update(), so a second click cannot race the
 *    snapshot that advances the question. A click is also ignored when the
 *    state already lists that eventID as answered.
 *  - Nothing is inferred. Feedback shows feedback.correct, feedback.explanation
 *    and feedback.source and nothing else: options are never marked right or
 *    wrong, and this module never reads a correctOptionID even if one is
 *    handed to it. The server advances currentEvent; the "hide" button only
 *    folds the last answer away locally.
 *  - Dynamic strings arrive through textContent, and the one link that is ever
 *    rendered must be an http(s) source URL - anything else is shown as text.
 */

const SAFE_URL = /^https?:\/\//i;
const LOADING = 'loading';
const PLAYING = 'playing';
const COMPLETE = 'complete';

const CARD_CSS = `
.cc-card{margin:0;padding:1.1rem 1.25rem 1.25rem;border:1px solid #d8cba9;border-radius:14px;background:#fffdf6;color:#153b35;line-height:1.55;box-shadow:0 2px 0 rgba(21,59,53,.06)}
.cc-card[data-state="loading"]{background:#f7f1e3;color:#4a5a54}
.cc-card[data-state="complete"]{border-color:#c9a227;background:#fffdf6}
.cc-fb{margin:0 0 1rem;padding:.85rem 1rem;border:1px solid #c9a227;border-left:6px solid #c9a227;border-radius:10px;background:#fdf6e3}
.cc-fb[data-correct="true"]{border-left-color:#a72a35;background:#fdeeec}
.cc-fb[data-correct="false"]{border-left-color:#8a6d1f;background:#f7f1e3}
.cc-fb-verdict{margin:0 0 .3rem;font:700 1.1rem Georgia,serif;letter-spacing:.02em;color:#a72a35}
.cc-fb-why{margin:0;font-size:.95rem}
.cc-fb-source{margin:.45rem 0 0;font-size:.85rem;color:#4a5a54}.cc-fb-source a{color:#1c5b8c}
.cc-fb-toggle{margin:.5rem 0 0;font:inherit;font-size:.78rem;padding:.25rem .65rem;border:1px solid #a72a35;border-radius:999px;background:#fff;color:#a72a35;cursor:pointer}
.cc-fb-toggle:hover{background:#a72a35;color:#fff}
.cc-caption{margin:0 0 .35rem;font-size:.82rem;letter-spacing:.06em;text-transform:uppercase;color:#8a6a1c}
.cc-question{margin:0 0 .8rem;font:700 clamp(1.1rem,2.6vw,1.4rem) Georgia,serif;color:#153b35}
.cc-options{display:grid;gap:.55rem;margin:0;padding:0;border:0}
.cc-option{display:flex;gap:.7rem;align-items:baseline;width:100%;text-align:left;font:inherit;font-size:1rem;padding:.7rem .85rem;border:1px solid #cbb98d;border-radius:10px;background:#fff;color:#153b35;cursor:pointer}
.cc-option:hover:not([disabled]){border-color:#a72a35;background:#fdf6e3}
.cc-option:focus-visible{outline:3px solid #1c5b8c;outline-offset:2px}
.cc-option[disabled]{opacity:.55;cursor:default}
.cc-option-key{font:700 .95rem Georgia,serif;color:#a72a35;min-width:1.2em}
.cc-card[data-state="loading"] .cc-status{margin:0;font-style:italic}.cc-card[data-state="complete"] .cc-status{margin:0;font:700 1.05rem Georgia,serif;color:#8a6a1c}
`;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

let cardCount = 0;

/** An event with no usable options is not a question this card can ask. */
function askedEvent(state) {
  const event = isPlainObject(state) ? state.currentEvent : null;
  if (!isPlainObject(event) || text(event.id).trim() === '') return null;
  return Array.isArray(event.options) ? event : null;
}

/**
 * The one place a snapshot becomes a view. Returns {kind, event, feedback,
 * answered, total} and reads nothing the card will not show.
 */
function toView(state) {
  if (!isPlainObject(state)) return {kind: LOADING, event: null, feedback: null, answered: 0, total: 0};
  const progress = isPlainObject(state.progress) ? state.progress : {};
  const view = {
    event: askedEvent(state),
    feedback: isPlainObject(state.feedback) ? state.feedback : null,
    answered: count(progress.answered),
    total: count(progress.total)
  };
  if (view.event !== null) return {...view, kind: PLAYING};
  // No question: either the chapter is finished (an empty era is finished at
  // 0/0 too) or the next snapshot simply has not arrived yet.
  const finished = state.phase === COMPLETE || (view.total > 0 && view.answered >= view.total);
  return {...view, kind: finished ? COMPLETE : LOADING};
}

function captionFor(view) {
  const parts = [];
  if (view.total > 0) parts.push(`Card ${view.answered + 1} of ${view.total}`);
  const year = view.event && Number.isFinite(view.event.year) ? String(view.event.year) : '';
  if (year !== '') parts.push(year);
  const region = view.event ? text(view.event.region).trim() : '';
  if (region !== '') parts.push(region);
  return parts.join(' · ');
}

function statusFor(view) {
  if (view.kind === LOADING) return 'Gathering the next question…';
  if (view.total === 0) return 'This chapter has no events yet. Pick another era to keep exploring.';
  return `Chapter complete — all ${view.total} events answered.`;
}

/** {href,label} for an official source, or null when there is no safe http(s) URL. */
function safeSource(source) {
  if (!isPlainObject(source)) return null;
  const url = text(source.url).trim();
  if (!SAFE_URL.test(url)) return null;
  return {url, label: text(source.title).trim() || 'Official source'};
}

export function mountQuestionCard(root, {onAnswer = () => {}} = {}) {
  const doc = typeof root?.createElement === 'function' ? root : root?.ownerDocument;
  const host = typeof root?.appendChild === 'function' ? root : (doc?.body ?? doc?.documentElement ?? null);
  if (!doc || !host) throw new TypeError('mountQuestionCard requires a DOM root');
  const answer = typeof onAnswer === 'function' ? onAnswer : () => {};
  const uid = `cc-card-${(cardCount += 1)}`;

  const el = (tag, className, content) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };

  const card = el('section', 'cc-card');
  card.setAttribute('aria-label', 'Question card');

  // Built once and rewritten, so a live region stays live between updates.
  const feedbackBox = el('div', 'cc-fb');
  feedbackBox.setAttribute('role', 'status');
  feedbackBox.setAttribute('aria-live', 'polite');
  const verdict = el('p', 'cc-fb-verdict');
  const why = el('p', 'cc-fb-why');
  const sourceLine = el('p', 'cc-fb-source');
  const sourcePrefix = el('span', 'cc-fb-source-prefix', 'Source: ');
  const sourceLink = el('a', 'cc-fb-source-link');
  sourceLine.append(sourcePrefix, sourceLink);
  const toggle = el('button', 'cc-fb-toggle', 'Hide last answer');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', `${uid}-feedback`);
  toggle.setAttribute('aria-expanded', 'true');
  feedbackBox.id = `${uid}-feedback`;
  feedbackBox.append(verdict, why, sourceLine, toggle);
  feedbackBox.hidden = true;

  const body = el('div', 'cc-body');
  const caption = el('p', 'cc-caption');
  const question = el('h2', 'cc-question');
  question.id = `${uid}-question`;
  const options = el('div', 'cc-options');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-labelledby', question.id);
  body.append(caption, question, options);

  const status = el('p', 'cc-status');
  status.setAttribute('role', 'status');

  const style = doc.createElement('style');
  style.textContent = CARD_CSS;
  card.append(style, feedbackBox, body, status);
  card.dataset.state = LOADING;
  card.setAttribute('aria-busy', 'true');

  let latest = null;
  let pending = false;
  let dismissed = false;
  let destroyed = false;
  let choices = [];

  function releaseChoices() {
    for (const choice of choices) choice.button.removeEventListener('click', choice.onClick);
    choices = [];
    while (options.firstChild) options.removeChild(options.firstChild);
  }

  function setBusy(busy) {
    card.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const {button} of choices) {
      button.disabled = busy;
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
  }

  /**
   * One click, one call. The lock survives repeated clicks and stray synthetic
   * ones, and is released only by the next update().
   */
  function choose(eventID, optionID) {
    if (destroyed || pending) return;
    const alreadyAnswered = Array.isArray(latest?.answered) &&
      latest.answered.some((entry) => isPlainObject(entry) && text(entry.eventID) === eventID);
    if (alreadyAnswered) return;
    pending = true;
    setBusy(true);
    try {
      answer(eventID, optionID);
    } catch {
      // The call never reached the game, so do not strand the card locked.
      pending = false;
      setBusy(false);
    }
  }

  function renderChoices(event) {
    releaseChoices();
    event.options.forEach((option, index) => {
      const optionID = isPlainObject(option) ? text(option.id).trim() : '';
      if (optionID === '') return;
      const button = el('button', 'cc-option');
      button.type = 'button';
      button.setAttribute('data-event-id', text(event.id));
      button.setAttribute('data-option-id', optionID);
      const key = el('span', 'cc-option-key', `${index + 1}.`);
      key.setAttribute('aria-hidden', 'true');
      const label = el('span', 'cc-option-text', text(option.text));
      const onClick = () => choose(text(event.id), optionID);
      button.append(key, label);
      button.addEventListener('click', onClick);
      choices.push({button, onClick});
      options.append(button);
    });
  }

  function renderFeedback(feedback) {
    if (feedback === null) {
      dismissed = false;
      feedbackBox.hidden = true;
      feedbackBox.removeAttribute('data-correct');
      return;
    }
    // Reported outcome only. The card never marks an option, so nothing here
    // can leak or guess the answer key.
    feedbackBox.setAttribute('data-correct', String(feedback.correct === true || feedback.correct === false ? feedback.correct : 'unknown'));
    verdict.textContent = feedback.correct === true ? 'Correct' : (feedback.correct === false ? 'Not quite' : 'Answer recorded');
    const explanation = text(feedback.explanation).trim();
    why.textContent = explanation;
    why.hidden = explanation === '';
    const link = safeSource(feedback.source);
    if (link === null) {
      if (sourceLine.contains(sourceLink)) sourceLine.removeChild(sourceLink);
      sourceLine.hidden = true;
    } else {
      sourceLink.textContent = link.label;
      sourceLink.setAttribute('href', link.url);
      sourceLink.setAttribute('rel', 'noopener noreferrer');
      sourceLink.setAttribute('target', '_blank');
      if (!sourceLine.contains(sourceLink)) sourceLine.append(sourceLink);
      sourceLine.hidden = false;
    }
    feedbackBox.hidden = dismissed;
    toggle.hidden = false;
    toggle.textContent = dismissed ? 'Show last answer' : 'Hide last answer';
    toggle.setAttribute('aria-expanded', dismissed ? 'false' : 'true');
  }

  function render() {
    const view = toView(latest);
    card.dataset.state = view.kind;
    renderFeedback(view.feedback);
    if (view.kind === PLAYING) {
      card.setAttribute('data-event-id', text(view.event.id));
      body.hidden = false;
      status.hidden = true;
      caption.textContent = captionFor(view);
      question.textContent = text(view.event.question) || text(view.event.title);
      renderChoices(view.event);
    } else {
      card.removeAttribute('data-event-id');
      releaseChoices();
      body.hidden = true;
      caption.textContent = '';
      question.textContent = '';
      status.hidden = false;
      status.textContent = statusFor(view);
    }
    setBusy(view.kind === LOADING || pending);
  }

  // Presentation only: the server has already advanced currentEvent, so this
  // folds the previous answer away without touching the game.
  const onToggle = () => {
    dismissed = !dismissed;
    renderFeedback(toView(latest).feedback);
  };
  toggle.addEventListener('click', onToggle);

  function update(state) {
    if (destroyed) return;
    latest = state;
    pending = false;
    render();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    toggle.removeEventListener('click', onToggle);
    releaseChoices();
    if (card.parentNode) card.parentNode.removeChild(card);
    latest = null;
  }

  render();
  host.append(card);
  return {update, destroy};
}
