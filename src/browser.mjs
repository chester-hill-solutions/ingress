/**
 * A browser, for judges that cannot be satisfied by a string.
 *
 * Every other mission in this repository grades modules: the verifier replays a submission's
 * functions under Node's permission model and compares the output with figures computed in the
 * parent. That works because those missions hand the submission a contract, and a contract can be
 * checked. A mission that hands over a *problem* instead cannot be checked that way -- "does this
 * tag tell an owner what is happening on their page" is not a property of a function, and any
 * judge that answers it by inspecting module signatures has quietly reintroduced the design it
 * was supposed to measure.
 *
 * So this is the other instrument: a real Chrome, driven over the DevTools protocol, visiting the
 * submission's own server. What it observes is what a visitor would cause and an owner would see.
 *
 * Three properties are deliberate.
 *
 * It is optional. Chrome is not a dependency of this repository's tests, and a machine without it
 * must be able to say so rather than fail a submission for the host -- `browserAvailable()` exists
 * so the caller can record a missing capability, the same way the isolated verifier records a
 * runtime without the permission model.
 *
 * It is disposable. The browser runs with a throwaway profile in a temp directory and is killed on
 * the way out, including when the judge throws. Nothing here reads the user's Chrome profile.
 *
 * It is bounded. Every wait has a deadline, because the thing on the other side is submission code
 * that may never finish. A timeout here is a fact about the submission, recorded as a failed
 * check, never a hung harness.
 *
 * The protocol is spoken directly: Node has had a global WebSocket since v22, and CDP is JSON over
 * one. A driver library would be a dependency for a hundred lines of message plumbing.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** The browser this machine has, or null. Callers record the absence; they never guess. */
export function browserAvailable() {
  return CANDIDATES.find(path => existsSync(path)) ?? null;
}

/**
 * Start a browser and attach to a page.
 *
 * Resolves to a session with `navigate`, `evaluate`, `click`, `type`, `scroll`, `screenshot` and
 * `close`, plus the `requests` and `exceptions` it has observed. `close` is idempotent and kills
 * the process even if the protocol connection is already gone.
 */
export async function launchBrowser({ timeoutMs = 20000, width = 1280, height = 900 } = {}) {
  const executable = browserAvailable();
  if (!executable) throw Error('browser_unavailable');
  const profile = await mkdtemp(join(tmpdir(), 'signal-browser-'));
  const child = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const endpoint = await devtoolsEndpoint(child, timeoutMs);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('browser_connect_timeout')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('browser_connect_failed')); }, { once: true });
  });

  let nextID = 1;
  const pending = new Map();
  const listeners = new Set();
  const requests = [];
  const exceptions = [];
  const consoleErrors = [];
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(Error(`cdp_${message.error.message ?? 'error'}`));
      else waiter.resolve(message.result);
      return;
    }
    const { method, params, sessionId } = message;
    if (method === 'Network.requestWillBeSent') requests.push({ url: params.request?.url ?? '', method: params.request?.method ?? 'GET', body: params.request?.postData ?? null, type: params.type ?? null });
    if (method === 'Runtime.exceptionThrown') exceptions.push({ text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception' });
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') consoleErrors.push({ text: (params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ') });
    for (const listener of listeners) listener({ method, params, sessionId });
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextID++;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`cdp_timeout:${method}`)); }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });

  const waitFor = (method, sessionId, deadline = timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`browser_wait_timeout:${method}`)); }, deadline);
    const listener = event => {
      if (event.method !== method || event.sessionId !== sessionId) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(event.params);
    };
    listeners.add(listener);
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);

  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw Error(`browser_evaluate_threw:${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? ''}`.slice(0, 400));
    return result.result?.value;
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { socket.close(); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    try { await rm(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return {
    evaluate,
    requests,
    exceptions,
    consoleErrors,
    /** Navigate and wait for the load event; a page that never loads fails here, by deadline. */
    async navigate(url, { waitMs = timeoutMs } = {}) {
      const loaded = waitFor('Page.loadEventFired', sessionId, waitMs);
      const result = await send('Page.navigate', { url }, sessionId);
      if (result.errorText) throw Error(`browser_navigate_failed:${result.errorText}`);
      await loaded;
      return result;
    },
    /** Click the centre of an element, with real mouse events so listeners see coordinates. */
    async click(selector, { delayMs = 0 } = {}) {
      const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 }; })()`);
      if (!box || !box.visible) throw Error(`browser_element_not_clickable:${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
      }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      return box;
    },
    /** Type into a focused element with the browser's own input pipeline. */
    async type(selector, text) {
      const focused = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`);
      if (!focused) throw Error(`browser_element_not_focusable:${selector}`);
      await send('Input.insertText', { text }, sessionId);
      return true;
    },
    /** Scroll the window the way a wheel would, so scroll listeners fire. */
    async scroll(y) {
      return evaluate(`(window.scrollTo(0, ${Number(y)}), window.scrollY)`);
    },
    async screenshot(filePath) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(filePath, Buffer.from(data, 'base64'));
      return filePath;
    },
    close,
  };
}

/** The DevTools endpoint, from the line Chrome prints when the port is assigned. */
function devtoolsEndpoint(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(Error('browser_launch_timeout'));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.stderr?.off('data', onData); child.off('exit', onExit); };
    const onData = chunk => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { cleanup(); resolve(match[1]); }
    };
    const onExit = code => { cleanup(); reject(Error(`browser_exited:${code}`)); };
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}
