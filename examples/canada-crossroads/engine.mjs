/**
 * Canada: Crossroads - game engine.
 *
 * createGame({events, seed = 1} = {}) -> {
 *   snapshot(), chooseEra(era), answer(eventID, optionID), restart(), subscribe(fn)
 * }
 *
 * Contract notes for the server/UI specialists:
 *  - Events are selected by era and ordered chronologically by year, then by id.
 *    There is no shuffle: the seed is reserved for future reproducibility only.
 *  - Supplied data is never mutated; every record is copied on construction and
 *    every snapshot is built from fresh objects, so callers cannot reach inside.
 *  - Public events whitelist only the fields safe to show. correctOptionID and
 *    explanation never leave the engine; an explanation is reachable only
 *    through snapshot().feedback, which exists only after an answer.
 *  - Every successful mutation bumps revision, returns a fresh snapshot and
 *    synchronously notifies subscribers with their own fresh snapshots.
 *    Rejected mutations throw, change nothing and notify nobody.
 */

const ERAS = ['early-contact', 'confederation', 'modern'];
const DEFAULT_ERA = 'early-contact';

const MILESTONE_FIRST_STEPS = 'first-steps';
const MILESTONE_STREAK_THREE = 'streak-three';
const MILESTONE_CHAPTER_COMPLETE = 'chapter-complete';

/** Milestone order and titles are fixed by the mission. */
const MILESTONE_DEFS = [
  {id: MILESTONE_FIRST_STEPS, title: 'First Steps'},
  {id: MILESTONE_STREAK_THREE, title: 'Sharp Eye'},
  {id: MILESTONE_CHAPTER_COMPLETE, title: 'Chapter Complete'}
];

const POINTS_BASE = 10;
const STREAK_BONUS_STEP = 2;
const STREAK_BONUS_CAP = 3;

/**
 * Optional convenience: createGame() with no events loads the canonical file
 * that sits next to this module (Node built-ins only, resolved relative to
 * engine.mjs). Outside Node there is no filesystem and the game starts empty.
 */
let loadCanonicalEvents = null;
try {
  const [fs, url] = await Promise.all([import('node:fs'), import('node:url')]);
  loadCanonicalEvents = () => {
    const file = new URL('./data/history.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(url.fileURLToPath(file), 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.events) ? parsed.events : null);
    if (!list) throw new TypeError('data/history.json must hold an array of events');
    return list;
  };
} catch {
  loadCanonicalEvents = null;
}

function resolveEvents(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events === 'object' && Array.isArray(events.events)) return events.events;
  if (events === undefined || events === null) return loadCanonicalEvents ? loadCanonicalEvents() : [];
  throw new TypeError('createGame requires an events array');
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function coordinate(value) {
  return Number.isFinite(value) ? value : null;
}

function copySource(source) {
  const raw = source && typeof source === 'object' ? source : {};
  return {title: text(raw.title), url: text(raw.url)};
}

/**
 * Copies one event into engine-owned, answer-key-safe storage. Structural
 * problems (missing ids, empty options, duplicate ids, a correctOptionID that
 * matches no option) are rejected here, during construction.
 */
function normalizeEvent(raw, index, seenEventIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`events[${index}] must be an object`);
  }
  const id = raw.id;
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`events[${index}].id must be a non-empty string`);
  }
  if (seenEventIds.has(id)) {
    throw new Error(`duplicate event id "${id}" in events`);
  }
  seenEventIds.add(id);

  if (!Number.isFinite(raw.year)) {
    throw new TypeError(`event "${id}" must have a numeric year`);
  }
  if (typeof raw.era !== 'string' || raw.era === '') {
    throw new TypeError(`event "${id}" must name an era`);
  }
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    throw new TypeError(`event "${id}" must offer at least one option`);
  }

  const seenOptionIds = new Set();
  const options = raw.options.map((option, optionIndex) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw new TypeError(`event "${id}" option ${optionIndex} must be an object`);
    }
    if (typeof option.id !== 'string' || option.id === '') {
      throw new TypeError(`event "${id}" option ${optionIndex} must have a non-empty id`);
    }
    if (seenOptionIds.has(option.id)) {
      throw new Error(`duplicate option id "${option.id}" in event "${id}"`);
    }
    seenOptionIds.add(option.id);
    return {id: option.id, text: text(option.text)};
  });

  if (typeof raw.correctOptionID !== 'string' || !seenOptionIds.has(raw.correctOptionID)) {
    throw new Error(`event "${id}" has no option matching correctOptionID "${raw.correctOptionID}"`);
  }

  return {
    id,
    title: text(raw.title),
    year: raw.year,
    // An event from an unknown era is kept but is never selectable.
    era: raw.era,
    region: text(raw.region),
    question: text(raw.question),
    options,
    correctOptionID: raw.correctOptionID,
    explanation: text(raw.explanation),
    source: copySource(raw.source),
    x: coordinate(raw.x),
    y: coordinate(raw.y)
  };
}

/** Chronological order, year first, then id. Never shuffles. */
function compareEvents(a, b) {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The only event shape that leaves the engine: no correctOptionID, no explanation. */
function toPublicEvent(event) {
  return {
    id: event.id,
    title: event.title,
    year: event.year,
    era: event.era,
    region: event.region,
    question: event.question,
    options: event.options.map((option) => ({id: option.id, text: option.text})),
    source: {title: event.source.title, url: event.source.url},
    x: event.x,
    y: event.y
  };
}

export function createGame({events, seed = 1} = {}) {
  // Reserved for reproducible ordering in future revisions; unused by design.
  void seed;

  const supplied = resolveEvents(events);
  const seenEventIds = new Set();
  const records = supplied.map((raw, index) => normalizeEvent(raw, index, seenEventIds));

  const byId = new Map(records.map((event) => [event.id, event]));
  const buckets = new Map(ERAS.map((era) => [era, []]));
  for (const event of records) {
    const bucket = buckets.get(event.era);
    if (bucket) bucket.push(event);
  }
  for (const bucket of buckets.values()) bucket.sort(compareEvents);

  let era = DEFAULT_ERA;
  let score = 0;
  let streak = 0;
  let revision = 0;
  let answered = [];
  let answeredIds = new Set();
  let feedback = null;
  const unlocked = {
    [MILESTONE_FIRST_STEPS]: false,
    [MILESTONE_STREAK_THREE]: false,
    [MILESTONE_CHAPTER_COMPLETE]: false
  };

  const subscribers = new Set();

  const eraEvents = () => buckets.get(era) ?? [];
  const isComplete = () => eraEvents().every((event) => answeredIds.has(event.id));
  const currentEvent = () => eraEvents().find((event) => !answeredIds.has(event.id)) ?? null;

  function buildSnapshot() {
    const list = eraEvents();
    const next = currentEvent();
    const complete = list.every((event) => answeredIds.has(event.id));
    return {
      phase: complete ? 'complete' : 'playing',
      era,
      score,
      streak,
      answered: answered.map((entry) => ({
        eventID: entry.eventID,
        optionID: entry.optionID,
        correct: entry.correct
      })),
      currentEvent: next === null ? null : toPublicEvent(next),
      feedback: feedback === null ? null : {
        eventID: feedback.eventID,
        correct: feedback.correct,
        explanation: feedback.explanation,
        source: {title: feedback.source.title, url: feedback.source.url}
      },
      progress: {answered: answered.length, total: list.length},
      milestones: MILESTONE_DEFS.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        unlocked: milestone.id === MILESTONE_CHAPTER_COMPLETE
          ? unlocked[milestone.id] || complete
          : unlocked[milestone.id]
      })),
      mapEvents: list.map(toPublicEvent),
      revision
    };
  }

  /** Each subscriber receives its own fresh snapshot; one bad listener cannot break the game. */
  function notify() {
    if (subscribers.size === 0) return;
    for (const listener of [...subscribers]) {
      try {
        listener(buildSnapshot());
      } catch {
        // Subscriber errors are the caller's problem, not the game's.
      }
    }
  }

  function resetState(nextEra) {
    era = nextEra;
    score = 0;
    streak = 0;
    answered = [];
    answeredIds = new Set();
    feedback = null;
    unlocked[MILESTONE_FIRST_STEPS] = false;
    unlocked[MILESTONE_STREAK_THREE] = false;
    unlocked[MILESTONE_CHAPTER_COMPLETE] = false;
  }

  function chooseEra(nextEra) {
    if (typeof nextEra !== 'string' || !ERAS.includes(nextEra)) {
      throw new RangeError(`unknown era "${nextEra}"; expected one of ${ERAS.join(', ')}`);
    }
    resetState(nextEra);
    revision += 1;
    const snapshot = buildSnapshot();
    notify();
    return snapshot;
  }

  function restart() {
    resetState(era);
    revision += 1;
    const snapshot = buildSnapshot();
    notify();
    return snapshot;
  }

  function answer(eventID, optionID) {
    if (typeof eventID !== 'string' || eventID === '') {
      throw new TypeError('answer requires an eventID string');
    }
    if (typeof optionID !== 'string' || optionID === '') {
      throw new TypeError('answer requires an optionID string');
    }

    const current = currentEvent();
    if (current === null) {
      throw new Error(`the ${era} chapter is already complete; no event is awaiting an answer`);
    }
    if (eventID !== current.id) {
      if (answeredIds.has(eventID)) {
        throw new Error(`event "${eventID}" has already been answered`);
      }
      if (!byId.has(eventID)) {
        throw new Error(`unknown event "${eventID}"`);
      }
      throw new Error(`event "${eventID}" is not the current event; answer "${current.id}"`);
    }
    if (answeredIds.has(eventID)) {
      throw new Error(`event "${eventID}" has already been answered`);
    }
    if (!current.options.some((option) => option.id === optionID)) {
      throw new RangeError(`unknown option "${optionID}" for event "${eventID}"`);
    }

    // Validated: from here the mutation cannot be rejected part-way.
    const previousStreak = streak;
    const correct = optionID === current.correctOptionID;
    if (correct) {
      score += POINTS_BASE + Math.min(previousStreak, STREAK_BONUS_CAP) * STREAK_BONUS_STEP;
      streak = previousStreak + 1;
    } else {
      streak = 0;
    }

    answered.push({eventID, optionID, correct});
    answeredIds.add(eventID);
    feedback = {
      eventID,
      correct,
      explanation: current.explanation,
      source: {title: current.source.title, url: current.source.url}
    };

    if (answered.length >= 1) unlocked[MILESTONE_FIRST_STEPS] = true;
    if (streak >= 3) unlocked[MILESTONE_STREAK_THREE] = true;
    if (isComplete()) unlocked[MILESTONE_CHAPTER_COMPLETE] = true;

    revision += 1;
    const snapshot = buildSnapshot();
    notify();
    return snapshot;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe expects a function');
    }
    subscribers.add(listener);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      subscribers.delete(listener);
    };
  }

  return {snapshot: buildSnapshot, chooseEra, answer, restart, subscribe};
}
