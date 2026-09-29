/**
 * Canada: Crossroads - chapter introduction card.
 *
 * eraIntroduction(era) -> fresh {title, description} for the selected chapter.
 * mountEraIntro(root)  -> {update(state), destroy()} renders that card.
 *
 * The copy describes how the selected chapter plays, never new history: the
 * sample's own titles, questions, explanations and official sources remain
 * the only historical content here. This module reads public snapshot fields
 * only (era, mapEvents, progress), builds nodes with createElement +
 * textContent, and touches nothing at import time, so it is safe in Node.
 */

// Gameplay copy, not history. Keyed by the engine's era ids.
const CHAPTERS = new Map([
  ['early-contact', {title: 'Early Contact',
    description: 'This opening chapter arrives one stop at a time in date order. Choose an answer, watch the marker settle on the illustrative map, and read the official source that opens beside your reply. Correct picks build your score and streak; a wrong pick awards no points and resets your streak, but never stops the journey.'}],
  ['confederation', {title: 'Confederation',
    description: 'The same rhythm carries on: stops in date order, one answer each, a source after every reply. The reward is the streak, which adds bonus points to each correct answer, and the chapter badge waits until the very last stop is answered. Nothing is timed. Wrong answers award no points and reset the streak; you can keep exploring.'}],
  ['modern', {title: 'Modern Canada',
    description: 'The closing stretch of the sample. Stops run in date order again, and one of them is plotted overseas, so the atlas gives it a clearly labelled inset instead of a spot on the mainland outline. The rules are unchanged: one answer per stop, a bonus for a streak, and an explanation with its official source after every reply.'}]
]);

const EXPLORE = {title: 'Explore',
  description: 'Choose a chapter to set out. Each stop asks one question, every marker on the map is illustrative rather than surveyed, and an official source opens once you have answered.'};

// The sample is a selection, not a survey: this line travels with the card.
const SAMPLE_NOTE = 'Indigenous histories precede this selected sample; twelve events are not exhaustive.';

let mounted = 0;

function eraKey(era) {
  return typeof era === 'string' ? era.trim().toLowerCase() : '';
}

/** The document that owns `root`; nothing global is read until mount time. */
function ownerDocument(root) {
  if (root && typeof root === 'object') {
    if (root.ownerDocument && typeof root.ownerDocument.createElement === 'function') return root.ownerDocument;
    if (root.nodeType === 9) return root;
  }
  const global = typeof globalThis === 'undefined' ? null : globalThis.document;
  return global && typeof global.createElement === 'function' ? global : null;
}

/** Chapter title plus a short invitation for the selected era. Always fresh. */
export function eraIntroduction(era) {
  const chapter = CHAPTERS.get(eraKey(era)) ?? EXPLORE;
  return {title: chapter.title, description: chapter.description};
}

/** Sentence built only from the public mapEvents count of the current chapter. */
function stopSummary(state) {
  const source = state && typeof state === 'object' ? state : {};
  const total = Array.isArray(source.mapEvents) ? source.mapEvents.length : 0;
  if (total === 0) return 'No stops are plotted in this chapter yet.';
  const progress = source.progress && typeof source.progress === 'object' ? source.progress : {};
  const answered = Number.isFinite(progress.answered) ? Math.max(0, progress.answered) : 0;
  const stops = `${total} ${total === 1 ? 'stop' : 'stops'} plotted on this chapter's illustrative map.`;
  return answered >= total ? `${stops} All answered.` : `${stops} ${answered} answered so far.`;
}

/**
 * One class-tagged node. Only spacing and neutral type are set inline, so the
 * shell keeps ownership of colour and faces; every string still goes through
 * textContent.
 */
function element(doc, tag, className, cssText) {
  const node = doc.createElement(tag);
  node.className = className;
  if (cssText && node.style) node.style.cssText = cssText;
  return node;
}

/**
 * Mount the chapter card into root and keep it in step with the snapshot.
 * update() is a no-op once destroyed; destroy() is idempotent.
 */
export function mountEraIntro(root) {
  const doc = ownerDocument(root);
  // A Document (nodeType 9) is accepted as a root and mounted into its body.
  const host = root && typeof root.appendChild === 'function'
    ? root
    : (doc && doc.body && typeof doc.body.appendChild === 'function' ? doc.body : null);
  if (!host) throw new TypeError('mountEraIntro requires a DOM element to mount into');

  const headingID = `era-intro-heading-${++mounted}`;
  // The host may be a .hint (italic, reduced); the card opts out of that
  // inheritance while leaving the shell's colour and fonts in place.
  const card = element(doc, 'section', 'era-intro', 'margin:0;font-size:1rem;font-style:normal;line-height:1.5;');
  card.setAttribute('aria-labelledby', headingID);

  const kicker = element(doc, 'p', 'era-intro__kicker', 'margin:0 0 0.25em;font-size:0.75em;font-style:normal;letter-spacing:0.14em;text-transform:uppercase;');
  kicker.textContent = 'Chapter';

  const heading = element(doc, 'h2', 'era-intro__heading', 'margin:0 0 0.4em;font-size:1.3em;line-height:1.2;');
  heading.id = headingID;

  const description = element(doc, 'p', 'era-intro__description', 'margin:0 0 0.5em;');

  const stops = element(doc, 'p', 'era-intro__stops', 'margin:0 0 0.5em;');

  const note = element(doc, 'p', 'era-intro__note', 'margin:0;font-size:0.85em;');
  note.textContent = SAMPLE_NOTE;

  card.append(kicker, heading, description, stops, note);
  host.appendChild(card);

  let alive = true;

  function render(state) {
    const view = state && typeof state === 'object' ? state : {};
    const intro = eraIntroduction(view.era);
    heading.textContent = intro.title;
    description.textContent = intro.description;
    stops.textContent = stopSummary(view);
  }

  // Render once so a first paint never shows an empty card.
  render(null);
  return {
    update(state) {
      if (!alive) return;
      render(state);
    },
    destroy() {
      if (!alive) return;
      alive = false;
      if (card.parentNode) card.parentNode.removeChild(card);
    }
  };
}
