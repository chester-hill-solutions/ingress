/**
 * The tag: one closure, no dependencies, no configuration beyond the page it is on.
 *
 * The privacy rule is enforced by construction rather than by filtering: this file never reads an
 * input's value and never reads page text, so there is nothing to mask and nothing to leak. That
 * is one way to satisfy the brief, not the only way -- a submission that does read the DOM and
 * masks properly is equally correct, which is why the judge checks the wire and the store instead
 * of checking for a masking function.
 */
(() => {
  'use strict';
  const endpoint = '/collect';
  const session = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  const queue = [];
  const path = () => location.pathname;
  const record = event => { queue.push({ ...event, p: path(), at: Date.now() }); };

  const send = beacon => {
    if (queue.length === 0) return;
    const body = JSON.stringify({ session, events: queue.splice(0, queue.length) });
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(endpoint, body); return; }
    fetch(endpoint, { method: 'POST', body, keepalive: true }).catch(() => {});
  };

  record({ t: 'view' });

  // How far the page was read, as a percentage, reported only when it improves.
  let deepest = 0;
  const depth = () => {
    const span = document.documentElement.scrollHeight - window.innerHeight;
    return span > 0 ? Math.round((window.scrollY / span) * 100) : 0;
  };
  addEventListener('scroll', () => {
    const value = depth();
    if (value > deepest) { deepest = value; record({ t: 'depth', d: value }); }
  }, { passive: true });

  // A click, a frustrated repeat of one, or a link that leaves the site.
  const recent = new Map();
  addEventListener('click', event => {
    const element = event.target && event.target.closest ? event.target.closest('a,button') : null;
    if (!element) return;
    const id = element.id || element.tagName.toLowerCase();
    const href = element.getAttribute('href') || '';
    if (element.tagName === 'A' && /^https?:/i.test(href) && !href.startsWith(location.origin)) { record({ t: 'out', id, href }); return; }
    const now = Date.now();
    const times = (recent.get(id) || []).filter(time => now - time < 1200);
    times.push(now);
    recent.set(id, times);
    record({ t: times.length >= 3 ? 'rage' : 'click', id, n: times.length });
  }, true);

  // What broke, as the visitor saw it. The page's own handler throws; this catches the report.
  addEventListener('error', event => { record({ t: 'err', m: String(event.message || 'error') }); send(true); });

  addEventListener('pagehide', () => send(true));
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true); });
  setInterval(() => send(false), 3000);
  send(false);
})();
