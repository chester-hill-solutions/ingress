/**
 * Canada: Crossroads - optional sound feedback.
 *
 *   createSoundscape({audioContextFactory} = {}) -> {setEnabled(bool), play(correct), destroy()}
 *   mountSoundToggle(root, {soundscape} = {}) -> {destroy()}
 *
 * Silent by default: no AudioContext exists until sound is BOTH enabled and a
 * cue is requested, so audio can only ever start after the player has opted in.
 * Cues come from local oscillators, so this module ships no audio assets, fetches
 * nothing and has no dependencies. Missing or blocked WebAudio degrades to a
 * silent no-op and playback never throws. Importing the file touches no DOM;
 * nodes appear only when the caller mounts the toggle.
 */

/** Peak envelope gain: a hint, not a reason to blast the player's speakers. */
const PEAK = 0.14;

/** Cues are {frequency, at, duration} triples; seconds are offsets from start. */
const CORRECT_CUE = [[523.25, 0, 0.16], [659.25, 0.1, 0.18], [783.99, 0.2, 0.34]];
const WRONG_CUE = [[246.94, 0, 0.2], [196, 0.16, 0.36]];

/** Swallow promise-shaped audio APIs without unhandled rejections. */
function ignore(value) {
  if (value && typeof value.catch === 'function') value.catch(() => {});
}

/** Audio APIs fail on their own terms; none of that is fatal here. */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function defaultContextFactory() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') throw new Error('WebAudio is unavailable');
  return new Ctor();
}

export function createSoundscape({audioContextFactory} = {}) {
  const factory = typeof audioContextFactory === 'function' ? audioContextFactory : defaultContextFactory;
  let enabled = false;
  let context = null;
  const voices = new Set();

  /** Cut every sounding voice; used by mute and by destroy. */
  function silence() {
    for (const stop of [...voices]) attempt(stop);
    voices.clear();
  }

  function schedule(cue, when) {
    for (const [frequency, at, duration] of cue) {
      const osc = context.createOscillator();
      const envelope = context.createGain();
      const start = when + at;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(frequency, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(PEAK, start + 0.02);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(envelope);
      envelope.connect(context.destination);
      osc.start(start);
      const stop = () => osc.stop(start + duration + 0.05);
      voices.add(stop);
      osc.onended = () => {
        voices.delete(stop);
        attempt(() => {
          osc.disconnect();
          envelope.disconnect();
        });
      };
    }
  }

  function setEnabled(next) {
    const value = Boolean(next);
    if (value === enabled) return enabled;
    enabled = value;
    if (!enabled) {
      silence();
      // The context is kept (only destroy closes it) but parked, so a muted
      // page is quiet. It still only exists because a play() call asked for it.
      if (context && context.state === 'running') attempt(() => ignore(context.suspend()));
    }
    return enabled;
  }

  function play(correct) {
    if (!enabled) return false;
    if (!context) {
      const created = attempt(() => factory() || null);
      if (!created || typeof created.createOscillator !== 'function') return false;
      context = created;
    }
    // Autoplay policy can leave a fresh context suspended. Resuming here is a
    // request, not a guarantee: callers may well call play() from a snapshot
    // handler rather than a click. If the browser refuses, this attempt is
    // simply silent and the next play() tries again - no autoplay either way.
    if (context.state === 'suspended') attempt(() => ignore(context.resume()));
    const clock = Number.isFinite(context.currentTime) ? context.currentTime : 0;
    let played = false;
    attempt(() => {
      schedule(correct ? CORRECT_CUE : WRONG_CUE, clock + 0.02);
      played = true;
    });
    return played;
  }

  function destroy() {
    enabled = false;
    silence();
    const owned = context;
    context = null;
    if (owned && typeof owned.close === 'function') attempt(() => ignore(owned.close()));
  }

  return {setEnabled, play, destroy};
}

export function mountSoundToggle(root, {soundscape} = {}) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('mountSoundToggle requires an element root');
  }
  const doc = root.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('mountSoundToggle requires a document to build the toggle in');
  }

  // Given no soundscape, the toggle still works using one this call owns.
  const owned = !soundscape;
  const sounds = owned ? createSoundscape() : soundscape;
  let enabled = false;
  let disposed = false;

  const host = doc.createElement('div');
  host.className = 'sound-toggle-host';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'sound-toggle';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', 'Sound effects');
  const label = doc.createElement('span');
  label.className = 'sound-toggle-label';
  button.appendChild(label);
  host.appendChild(button);

  function render() {
    button.setAttribute('aria-checked', enabled ? 'true' : 'false');
    button.setAttribute('data-state', enabled ? 'enabled' : 'muted');
    button.title = enabled ? 'Sound is on' : 'Sound is off';
    label.textContent = enabled ? 'Sound: enabled' : 'Sound: muted';
  }

  function onClick() {
    enabled = !enabled;
    try {
      sounds.setEnabled(enabled);
    } catch {
      enabled = false; // A broken soundscape must never leave the label lying.
    }
    render();
  }

  button.addEventListener('click', onClick);
  render();
  root.appendChild(host);

  function destroy() {
    if (disposed) return;
    disposed = true;
    button.removeEventListener('click', onClick);
    if (host.parentNode) host.parentNode.removeChild(host);
    attempt(() => {
      sounds.setEnabled(false);
      if (owned) sounds.destroy();
    });
  }

  return {destroy};
}
