/**
 * Canada: Crossroads - assistive-technology glue.
 *
 * createAccessibility({root = globalThis.document} = {}) -> {
 *   announce(text), setReducedMotion(bool), destroy()
 * }
 *
 * Contract notes for the UI specialist:
 *  - Importing this module touches no DOM; every effect happens in the factory.
 *  - Creation adds one polite aria-live region; announce() writes its
 *    textContent, so dynamic strings are never parsed as markup.
 *  - setReducedMotion() marks dataset.reducedMotion as "true"/"false" on the
 *    documentElement, or on the element handed in as root. Styles hook off
 *    [data-reduced-motion="true"]; game state is never read or written.
 *  - With no document (Node, a bare import, `{root: null}`) every helper is a
 *    safe no-op, so callers never have to feature-detect before wiring it up.
 *  - destroy() removes this instance's own region and restores the motion
 *    marker. It is idempotent.
 */

const LIVE_ID = 'canada-crossroads-live-region';
const MARKER = 'data-canada-crossroads-live-region';
const FLAG_KEY = 'reducedMotion';

// Off-screen but still read: the region must stay in the accessibility tree.
const HIDDEN_CSS = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  border: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  'white-space': 'nowrap'
};

/** Partly-implemented hosts (tests, non-browser) may offer only some of the DOM. */
const setAttr = (el, name, value) => {
  if (!el) return;
  try {
    if (typeof el.setAttribute === 'function') el.setAttribute(name, value);
    else el[name] = value;
  } catch {
    // A host that refuses every spelling simply gets no attribute.
  }
};

const hideVisually = (el) => {
  const style = el?.style;
  if (!style) return;
  try {
    for (const [property, value] of Object.entries(HIDDEN_CSS)) {
      if (typeof style.setProperty === 'function') style.setProperty(property, value);
      else style[property] = value;
    }
  } catch {
    // Styling is decoration; announcing matters far more.
  }
};

/** Carries the motion flag: an element root, else the documentElement. */
function flagTarget(root) {
  if (!root || typeof root !== 'object') return null;
  return root.dataset ? root : (root.documentElement ?? null);
}

const asMessage = (text) => {
  if (typeof text === 'string') return text;
  return text === null || text === undefined ? '' : String(text);
};

export function createAccessibility({root = globalThis.document} = {}) {
  let region = null;
  let host = null;
  let flag = null;
  let flagWasSet = false;
  let flagBefore = null;
  let destroyed = false;

  // root is normally a document; an element root is honoured too, by creating
  // the region through that element's owner document.
  const doc = typeof root?.createElement === 'function' ? root : (root?.ownerDocument ?? null);
  try {
    if (doc) {
      // One live region only: a marked leftover from an earlier instance of
      // this module would make every announcement be read twice.
      const stale = typeof doc.getElementById === 'function' ? doc.getElementById(LIVE_ID) : null;
      if (typeof stale?.remove === 'function') stale.remove();

      const node = doc.createElement('div');
      setAttr(node, 'id', LIVE_ID);
      setAttr(node, MARKER, 'true');
      setAttr(node, 'role', 'status');
      setAttr(node, 'aria-live', 'polite');
      setAttr(node, 'aria-atomic', 'true');
      hideVisually(node);

      // A document hosts the region in body, then documentElement (so it
      // exists even mid-parse); an element root hosts it directly.
      const target = root !== doc && typeof root?.appendChild === 'function'
        ? root
        : (root?.body ?? root?.documentElement ?? doc);
      if (typeof target?.appendChild === 'function') {
        target.appendChild(node);
        region = node;
        host = target;
      }
    }
  } catch {
    // A document we cannot write to degrades to announcing nothing.
  }

  return {
    /** Speak a short status line (score, streak, era change, connection state). */
    announce(text) {
      if (destroyed || !region) return;
      try {
        region.textContent = asMessage(text);
      } catch {
        // Never let an announcement break the game loop.
      }
    },

    /**
     * Record the visitor's motion preference on the page root. Presentation
     * only: no snapshot, score, streak or answer is affected.
     */
    setReducedMotion(value) {
      if (destroyed) return;
      const target = flagTarget(root);
      if (!target?.dataset) return;
      try {
        if (!flag) {
          flag = target;
          flagWasSet = Object.prototype.hasOwnProperty.call(target.dataset, FLAG_KEY);
          flagBefore = target.dataset[FLAG_KEY];
        }
        target.dataset[FLAG_KEY] = value ? 'true' : 'false';
      } catch {
        // Hosts without a writable dataset simply go unmarked.
      }
    },

    /** Remove this instance's own region and undo its motion marker. Idempotent. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (region) {
        const node = region;
        region = null;
        try {
          node.textContent = '';
        } catch {
          // Ignore: the node is going away.
        }
        try {
          const parent = typeof host?.removeChild === 'function' ? host : node.parentNode;
          if (typeof parent?.removeChild === 'function') parent.removeChild(node);
          else if (typeof node.remove === 'function') node.remove();
        } catch {
          // Already detached.
        }
        host = null;
      }
      if (flag?.dataset) {
        try {
          if (flagWasSet) flag.dataset[FLAG_KEY] = flagBefore;
          else delete flag.dataset[FLAG_KEY];
        } catch {
          // Nothing left to restore.
        }
        flag = null;
      }
    }
  };
}
