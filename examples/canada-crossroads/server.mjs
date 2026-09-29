import {createGame} from './engine.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, extname, join, normalize, resolve, sep} from 'node:path';

// Canonical content and static assets always live next to this module, so the
// server behaves the same no matter what directory it is started from.
const HISTORY_FILE = new URL('./data/history.json', import.meta.url);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const INDEX_FILE = join(PUBLIC_DIR, 'index.html');

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Answer keys never leave the process: public events drop these fields, and
// feedback (only ever present after an answer) may keep its explanation.
const EVENT_HIDDEN_FIELDS = new Set(['correctOptionID', 'correctOption', 'answerKey', 'explanation']);
const FEEDBACK_HIDDEN_FIELDS = new Set(['correctOptionID', 'correctOption', 'answerKey']);

// Raw content and anything that smells like an answer key is a 404, never a
// file. Modules (.mjs) are deliberately absent: they are reachable only through
// the exact allowlist below, and no other extension is a servable type.
const DENIED_PATHS = [
  /(^|\/)data(\/|$)/i,
  /history\.json$/i,
  /correctoption/i,
  /answer[-_]?key/i
];

// Peer-authored browser modules, mapped to their file name inside public/.
// Each is served at exactly two paths: /public/<name>.mjs and the /<name>.mjs
// alias. Every other spelling - subdirectories, traversal, case or suffix
// changes, unlisted names - is a plain 404.
const MODULE_FILES = Object.freeze({
  atlas: 'atlas.mjs',
  timeline: 'timeline.mjs',
  cards: 'cards.mjs',
  scoreboard: 'scoreboard.mjs',
  badges: 'badges.mjs',
  sound: 'sound.mjs',
  a11y: 'a11y.mjs',
  progress: 'progress.mjs',
  glossary: 'glossary.mjs',
  itinerary: 'itinerary.mjs',
  notebook: 'notebook.mjs',
  help: 'help.mjs',
  achievements: 'achievements.mjs',
  'era-intro': 'era-intro.mjs'
});

const MODULE_CONTENT_TYPE = 'text/javascript; charset=utf-8';

const MODULE_PATHS = new Map(
  Object.values(MODULE_FILES).flatMap((file) => [
    [`/public/${file}`, file],
    [`/${file}`, file]
  ])
);

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8']
]);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilledString = (value) => typeof value === 'string' && value.trim() !== '';

/** Copy of a public event without any answer-key field. */
function publicEvent(event) {
  if (!isPlainObject(event)) return null;
  const out = {};
  for (const key of Object.keys(event)) {
    if (EVENT_HIDDEN_FIELDS.has(key)) continue;
    out[key] = event[key];
  }
  return out;
}

/** Feedback may keep its explanation, but never an answer key. */
function publicFeedback(feedback) {
  if (!isPlainObject(feedback)) return null;
  const out = {};
  for (const key of Object.keys(feedback)) {
    if (FEEDBACK_HIDDEN_FIELDS.has(key)) continue;
    out[key] = feedback[key];
  }
  return out;
}

/** Snapshot shaped for the wire: map/current events never expose answer keys. */
function publicSnapshot(snapshot) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  const out = {...source};
  out.mapEvents = Array.isArray(source.mapEvents) ? source.mapEvents.map(publicEvent) : [];
  out.currentEvent = publicEvent(source.currentEvent);
  out.feedback = publicFeedback(source.feedback);
  return out;
}

/** Short, single-line, stack-free error text. */
function safeMessage(error, fallback = 'request failed') {
  const raw = error && typeof error.message === 'string' && error.message !== '' ? error.message : fallback;
  const firstLine = String(raw).split('\n')[0].replace(/\s+/g, ' ').trim();
  const withoutFrames = firstLine.replace(/\s*at\s+[^\s(]+\s*\([^)]*\)/g, '').trim();
  const text = withoutFrames !== '' ? withoutFrames : fallback;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function sendBuffer(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  sendBuffer(res, status, body, 'application/json; charset=utf-8');
}

function sendError(res, status, message) {
  sendJSON(res, status, {error: message});
}

function securityHeaders(res) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** Read at most MAX_BODY_BYTES; 413 (never a stack) for anything larger. */
function readLimitedBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(message);
      error.status = status;
      error.oversized = status === 413;
      rejectBody(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        fail(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(chunks, size));
    };
    const onError = () => fail(400, 'request body could not be read');
    const onAborted = () => fail(400, 'request aborted');
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Parsed JSON body, or undefined when a response has already been sent.
 * An absent/empty body is an empty object; malformed JSON is a 400.
 */
async function readJSONBody(req, res) {
  let raw;
  try {
    raw = await readLimitedBody(req);
  } catch (error) {
    if (error && error.oversized) {
      // Stop the upload politely: answer, then let the connection close.
      res.setHeader('Connection', 'close');
      res.once('finish', () => {
        try {
          req.destroy();
        } catch {}
      });
    }
    sendError(res, error.status === 413 ? 413 : 400, safeMessage(error, 'invalid request body'));
    return undefined;
  }
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    sendError(res, 400, 'body must be valid JSON');
    return undefined;
  }
}

function isDeniedPath(pathname) {
  return DENIED_PATHS.some((pattern) => pattern.test(pathname));
}

/** Static asset lookup inside public/, or null. Never escapes public/. */
async function readAsset(pathname) {
  if (isDeniedPath(pathname)) return null;
  const type = STATIC_TYPES.get(extname(pathname).toLowerCase());
  if (!type) return null;
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  if (relative === '' || relative === 'index.html') return null;
  const target = resolve(join(PUBLIC_DIR, relative));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return null;
  try {
    const body = await readFile(target);
    return {body, type};
  } catch {
    return null;
  }
}

/** Exact allowlisted module path -> file name inside public/, else null. */
function moduleFileName(pathname) {
  return MODULE_PATHS.get(pathname) ?? null;
}

/**
 * Read one allowlisted module. The name is a literal from MODULE_FILES (no
 * separators, no dots to traverse), so this can only ever open public/<name>.
 * A module a peer has not written yet simply reads as null, which is a 404.
 */
async function readModule(file) {
  try {
    return await readFile(join(PUBLIC_DIR, file));
  } catch {
    return null;
  }
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/** JSON array of events, or the `events` array of an envelope. */
function eventsFromPayload(payload, source) {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload) && Array.isArray(payload.events)) return payload.events;
  throw new TypeError(`${source} must be a JSON array of events or an object with an events array`);
}

async function loadCanonicalEvents() {
  let text;
  try {
    text = await readFile(HISTORY_FILE, 'utf8');
  } catch (error) {
    throw new Error(`unable to read canonical history data: ${safeMessage(error, 'read failed')}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TypeError('canonical history data is not valid JSON');
  }
  return eventsFromPayload(payload, 'data/history.json');
}

/**
 * Start the Canada: Crossroads HTTP + SSE server on loopback only.
 * Resolves to {url, close}; close() is asynchronous and idempotent.
 */
export async function createGameServer({events, host = '127.0.0.1', port = 0, seed = 1} = {}) {
  const bindHost = String(host ?? '127.0.0.1').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(bindHost)) {
    throw new TypeError(`host must be a loopback address (127.0.0.1, ::1 or localhost), received ${host}`);
  }
  const requestedPort = Number(port ?? 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new TypeError(`port must be an integer between 0 and 65535, received ${port}`);
  }

  // Canonical data is read server-side only, and handed to the engine as a copy
  // so nothing in this process can mutate the loaded content.
  const source = events === undefined ? await loadCanonicalEvents() : events;
  if (!Array.isArray(source)) {
    throw new TypeError('events must be an array of canonical history events');
  }
  const gameEvents = JSON.parse(JSON.stringify(source));
  const game = createGame({events: gameEvents, seed});

  // Settled by listen(), but declared up front: a request can arrive between
  // the 'listening' event and the address lookup, and must never see a
  // half-initialised port.
  let boundPort = requestedPort;

  /**
   * Origin must be this server's own loopback origin; an omitted Origin is
   * fine. Everything else - another port, another host, https, credentials, a
   * path, a duplicate or malformed header - is refused with 403, so a page on
   * any other origin can neither read the state nor drive the game.
   */
  const originAllowed = (origin) => {
    if (origin === undefined || origin === null || origin === '') return true;
    if (typeof origin !== 'string' || origin === 'null') return false;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:') return false;
    if (url.username !== '' || url.password !== '') return false;
    // A serialised Origin is scheme+host+port only: new URL('http://127.0.0.1:1234')
    // normalises to pathname '/', so both spellings are this server's own origin.
    if (url.pathname !== '' && url.pathname !== '/') return false;
    if (url.search !== '' || url.hash !== '') return false;
    const originHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(originHost)) return false;
    // URL drops an explicit default port, so compare numbers and treat a bare
    // "http://127.0.0.1" as port 80 on both sides of the comparison.
    const originPort = url.port === '' ? 80 : Number(url.port);
    return originPort === Number(boundPort);
  };

  const streams = new Set();
  const sockets = new Set();
  const gameSubscriptions = new Set();
  let closing = null;

  const detach = (stream) => {
    if (!streams.delete(stream)) return;
    if (typeof stream.unsubscribe === 'function') gameSubscriptions.delete(stream.unsubscribe);
    try {
      stream.unsubscribe?.();
    } catch {}
    if (stream.heartbeat) {
      clearInterval(stream.heartbeat);
      stream.heartbeat = null;
    }
    try {
      stream.res.end();
    } catch {}
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      try {
        if (!res.headersSent) sendError(res, 500, 'unexpected server error');
        else res.end();
      } catch {}
      console.error('canada-crossroads: request failed:', safeMessage(error));
    });
  });

  server.timeout = 0;
  server.keepAliveTimeout = 5000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  /**
   * Exactly one frame per snapshot, in the default (unnamed) event.
   *
   * A snapshot is written once, never twice: an earlier revision sent each one
   * as both a default and an `event: snapshot` frame, so a reader saw the
   * opening snapshot duplicated and the first real update arrive third. The
   * unnamed form is what EventSource delivers to onmessage, and it is still a
   * well-formed named form for any reader that looks for the data line, so one
   * frame serves every documented reader.
   */
  function writeSnapshot(res, snapshot) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(publicSnapshot(snapshot))}\n\n`);
  }

  function openEventStream(req, res) {
    // A stream opened while the server is closing would outlive close(): it is
    // registered after the detach pass and nothing would ever end it.
    if (closing) {
      sendError(res, 503, 'server is closing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);

    const stream = {res, unsubscribe: null, heartbeat: null};
    streams.add(stream);

    // Detaching is idempotent, so close, error and abort can all race safely.
    const cleanup = () => {
      detach(stream);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('aborted', cleanup);
    req.on('error', cleanup);

    // No retry: prelude and nothing but a data frame before the opening
    // snapshot, so the first readable block on the wire is the snapshot
    // itself. EventSource reconnects on its own default, and the page has its
    // own reconnect path.
    // Initial snapshot first, then subscribe: the engine mutates synchronously,
    // so a state change can never slip between the two.
    writeSnapshot(res, game.snapshot());

    const notify = (snapshot) => {
      writeSnapshot(res, snapshot);
    };
    try {
      const unsubscribe = game.subscribe(notify);
      if (typeof unsubscribe === 'function') {
        stream.unsubscribe = unsubscribe;
        gameSubscriptions.add(unsubscribe);
      }
    } catch (error) {
      console.error('canada-crossroads: subscription failed:', safeMessage(error));
    }

    stream.heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        detach(stream);
        return;
      }
      res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);
    if (typeof stream.heartbeat.unref === 'function') stream.heartbeat.unref();

    // The client may have vanished while the handshake was in flight; without
    // this the subscription and heartbeat would stay until close().
    if (res.writableEnded || res.destroyed) detach(stream);
  }

  async function serveIndex(res) {
    try {
      const body = await readFile(INDEX_FILE);
      sendBuffer(res, 200, body, 'text/html; charset=utf-8');
    } catch (error) {
      sendError(res, 500, 'index.html is unavailable');
      console.error('canada-crossroads: index.html:', safeMessage(error));
    }
  }

  async function postAnswer(req, res) {
    const body = await readJSONBody(req, res);
    if (body === undefined) return;
    if (!isPlainObject(body) || !isFilledString(body.eventID) || !isFilledString(body.optionID)) {
      sendError(res, 400, 'eventID and optionID are required strings');
      return;
    }
    try {
      sendJSON(res, 200, publicSnapshot(game.answer(body.eventID, body.optionID) ?? game.snapshot()));
    } catch (error) {
      sendError(res, 400, safeMessage(error, 'invalid answer'));
    }
  }

  async function postEra(req, res) {
    const body = await readJSONBody(req, res);
    if (body === undefined) return;
    if (!isPlainObject(body) || !isFilledString(body.era)) {
      sendError(res, 400, 'era is required');
      return;
    }
    try {
      sendJSON(res, 200, publicSnapshot(game.chooseEra(body.era) ?? game.snapshot()));
    } catch (error) {
      sendError(res, 400, safeMessage(error, 'invalid era'));
    }
  }

  async function postRestart(req, res) {
    const body = await readJSONBody(req, res);
    if (body === undefined) return;
    if (body !== null && !isPlainObject(body)) {
      sendError(res, 400, 'body must be a JSON object');
      return;
    }
    try {
      sendJSON(res, 200, publicSnapshot(game.restart() ?? game.snapshot()));
    } catch (error) {
      sendError(res, 400, safeMessage(error, 'restart failed'));
    }
  }

  async function handleRequest(req, res) {
    securityHeaders(res);

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      sendError(res, 400, 'invalid request path');
      return;
    }
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      sendError(res, 403, 'origin is not this server');
      return;
    }
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      // Never a wildcard: only this server's own origin is ever echoed.
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    if (isDeniedPath(pathname)) {
      sendError(res, 404, 'not found');
      return;
    }

    if (method === 'POST') {
      if (pathname === '/answer') return void (await postAnswer(req, res));
      if (pathname === '/era') return void (await postEra(req, res));
      if (pathname === '/restart') return void (await postRestart(req, res));
      sendError(res, 404, 'not found');
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/') return void (await serveIndex(res));
      if (pathname === '/state') return void sendJSON(res, 200, publicSnapshot(game.snapshot()));
      if (pathname === '/events') return void openEventStream(req, res);
      const module = moduleFileName(pathname);
      if (module !== null) {
        const body = await readModule(module);
        if (body) {
          sendBuffer(res, 200, body, MODULE_CONTENT_TYPE);
          return;
        }
        sendError(res, 404, 'not found');
        return;
      }
      const asset = await readAsset(pathname);
      if (asset) {
        sendBuffer(res, 200, asset.body, asset.type);
        return;
      }
      sendError(res, 404, 'not found');
      return;
    }

    sendError(res, 404, 'not found');
  }

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(new Error(`unable to listen on ${bindHost}:${requestedPort}: ${safeMessage(error, 'listen failed')}`));
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, bindHost);
  });

  const address = server.address();
  boundPort = typeof address === 'object' && address !== null ? address.port : requestedPort;
  const url = `http://${formatHost(bindHost)}:${boundPort}/`;

  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const stream of [...streams]) detach(stream);
      streams.clear();
      for (const unsubscribe of gameSubscriptions) {
        try {
          unsubscribe();
        } catch {}
      }
      gameSubscriptions.clear();
      const closed = new Promise((resolveClose) => {
        server.close(() => resolveClose());
      });
      for (const socket of [...sockets]) {
        try {
          socket.destroy();
        } catch {}
      }
      sockets.clear();
      await closed;
    })();
    return closing;
  }

  return {url, close};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createGameServer();
  console.log('Canada: Crossroads listening on ' + server.url);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}
