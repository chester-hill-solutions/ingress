import { setTimeout as delay } from 'node:timers/promises';

const RESPONSE_LIMIT = 4 * 1024 * 1024;
const EVENT_LIMIT = 1024 * 1024;
const identifier = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid runtime identifier'); return value; };

/** Small diagnostic vocabulary only; provider messages, bodies and stacks stay private. */
export function safeRuntimeError(error) {
  const names = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'OpenCodeHTTPError']);
  const codes = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR']);
  const code = [error?.code, error?.cause?.code].find(value => codes.has(value));
  return { name: names.has(error?.name) ? error.name : 'unknown', ...(code ? { code } : {}), ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) };
}

async function boundedText(response, limit, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal?.throwIfAborted(); const { value, done } = await reader.read(); signal?.throwIfAborted(); if (done) break; size += value.length; if (size > limit) throw new Error('OpenCode response exceeds limit'); chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Authenticated native v2 observer/control adapter; it does not mediate filesystem writes. */
export class OpenCodeClient {
  constructor({ endpoint, password, model, directory, fetchImpl = fetch, permissions }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Requires a dedicated loopback OpenCode endpoint');
    Object.assign(this, { endpoint: url.origin, password, model, directory, fetchImpl, permissions });
    this.streams = new Set();
    this.admissions = new Map();
  }

  async request(path, method = 'GET', body, signal) {
    signal?.throwIfAborted();
    const response = await this.fetchImpl(this.endpoint + path, { method, signal, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); const error = new Error(`OpenCode ${method} returned HTTP ${response.status}`); error.name = 'OpenCodeHTTPError'; error.status = response.status; throw error; }
    if (response.status === 204) return;
    const text = await boundedText(response, RESPONSE_LIMIT, signal);
    try { return text ? JSON.parse(text) : undefined; } catch { throw new Error('Invalid OpenCode JSON response'); }
  }

  async createSession(title, signal) {
    const result = await this.request('/api/session', 'POST', { title, location: { directory: this.directory }, model: this.model, permissions: this.permissions ?? [{ action: '*', resource: '*', effect: 'deny' }, ...['read', 'write', 'edit', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' }))] }, signal);
    return identifier(result?.data?.id);
  }

  async prompt(sessionID, text, { id, delivery = 'steer', resume, signal } = {}) {
    identifier(sessionID); identifier(id);
    if (!['steer', 'queue'].includes(delivery)) throw new Error('Unsupported delivery mode');
    if (resume !== undefined && typeof resume !== 'boolean') throw new Error('Invalid resume setting');
    const result = await this.request(`/api/session/${sessionID}/prompt`, 'POST', { id, text, delivery, ...(resume === undefined ? {} : { resume }) }, signal);
    const admitted = result?.data;
    if (admitted?.id !== id || admitted.sessionID !== sessionID || !Number.isFinite(admitted.time?.created) || admitted.delivery !== delivery) throw new Error('OpenCode admission mismatch');
    // Parked notifications must not change the terminal boundary of the running task.
    if (resume !== false) this.admissions.set(sessionID, admitted.time.created);
    return { id, sessionID, delivery, created: admitted.time.created };
  }

  async wait(sessionID, signal, { pollIntervalMs = 1000, minIdleAt } = {}) {
    identifier(sessionID);
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10000) throw new Error('Invalid native wait poll interval');
    if (minIdleAt !== undefined && (!Number.isFinite(minIdleAt) || minIdleAt < 0)) throw new Error('Invalid native wait idle boundary');
    const admittedAt = this.admissions.get(sessionID);
    const boundary = minIdleAt === undefined ? admittedAt : admittedAt === undefined ? minIdleAt : Math.max(minIdleAt, admittedAt);
    // The experimental POST wait holds response headers until native execution
    // settles. Short GETs avoid one transport request spanning a long model turn.
    while (true) {
      signal?.throwIfAborted();
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const result = await this.request(`/api/session/${sessionID}`, 'GET', undefined, requestSignal);
      signal?.throwIfAborted();
      const data = result?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid OpenCode session state');
      if (['succeeded', 'failed', 'interrupted'].includes(data.outcome)) {
        if (!Number.isFinite(data.time?.idle)) throw new Error('OpenCode terminal outcome unknown');
        if (boundary === undefined || data.time.idle >= boundary) return { sessionID, outcome: data.outcome, idle: data.time.idle };
      }
      await delay(pollIntervalMs, undefined, { signal });
    }
  }

  context(sessionID, signal) { return this.request(`/api/session/${identifier(sessionID)}/context`, 'GET', undefined, signal); }
  inbox(sessionID, signal) { return this.request(`/api/session/${identifier(sessionID)}/inbox`, 'GET', undefined, signal); }
  async interrupt(sessionID, { resume = false, signal } = {}) {
    const value = await this.request(`/api/session/${identifier(sessionID)}/interrupt?resume=${Boolean(resume)}`, 'POST', undefined, signal);
    if (typeof value?.interrupted !== 'boolean') throw new Error('OpenCode interruption acceptance unknown');
    return { interrupted: value.interrupted }; // Acceptance only; wait/terminal proves settlement.
  }

  async *events(sessionID, { after, signal, transport = 'log', onMetadata } = {}) {
    identifier(sessionID);
    if (!['log', 'live'].includes(transport)) throw new Error('Invalid native event transport');
    if (transport === 'live' && after !== undefined) throw new Error('Native live events do not support replay cursors');
    const initialCursor = after ?? 0;
    if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) throw new Error('Invalid native log cursor');
    if (onMetadata !== undefined && typeof onMetadata !== 'function') throw new Error('Invalid native metadata observer');
    const controller = new AbortController(); this.streams.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let reader;
    try {
      // Default Bus persistence is disabled in v2.0.16. The global live feed is
      // independent of retained log rows; disconnects have no replay guarantee.
      const path = transport === 'live' ? '/api/event' : `/api/experimental/session/${sessionID}/log?after=${initialCursor}&follow=true`;
      const response = await this.fetchImpl(this.endpoint + path, { signal: combined, redirect: 'error', headers: { accept: 'text/event-stream', authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` } });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) { await response.body?.cancel(); throw new Error('OpenCode native log stream unavailable'); }
      reader = response.body.getReader();
      let cursor = transport === 'live' ? -1 : initialCursor, samples = 0; const tools = new Map();
      for await (const raw of decodeSSE(reader, combined)) {
        // Before normalization/cursor filtering, capped per subscription, with
        // no native payload, prose, credentials, or tool arguments exposed.
        if (onMetadata && samples++ < 128) {
          const type = typeof raw?.type === 'string' && /^(session|server|log|project|integration|provider|model|agent|command|skill|websearch|reference|plugin|models-dev)\.[a-z][a-z.]{0,90}$/.test(raw.type) ? raw.type : 'unknown';
          try { onMetadata({ type, id: typeof raw?.id === 'string' && /^evt_[a-zA-Z0-9_-]{1,156}$/.test(raw.id) ? raw.id : null, seq: Number.isSafeInteger(raw?.durable?.seq) ? raw.durable.seq : Number.isSafeInteger(raw?.seq) ? raw.seq : null, sessionMatch: raw?.data?.sessionID === sessionID || raw?.aggregateID === sessionID, ...(raw?.type === 'session.tool.called' ? { arguments: safeArguments(raw?.data?.input).diagnostics } : {}) }); } catch { /* Diagnostics cannot interrupt observation. */ }
        }
        if (transport === 'live') {
          if (raw?.type === 'server.connected') {
            if (typeof raw.id !== 'string' || !/^evt_[a-zA-Z0-9_-]{1,156}$/.test(raw.id)) throw new Error('Invalid native connected marker');
            yield { id: raw.id, seq: null, type: raw.type, data: {}, time: null, transport: 'live', replay: false };
            continue;
          }
          // All-location feed includes configuration updates and ephemeral
          // streams. Only selected session durable envelopes enter this adapter.
          if (raw?.data?.sessionID !== sessionID || raw?.durable === undefined) continue;
        }
        const event = normalizeEvent(raw, sessionID, tools);
        if (event.type === 'log.synced') { if (event.seq !== null && event.seq < cursor) throw new Error('Native log watermark moved backwards'); yield event; continue; }
        if (event.seq <= cursor) continue; // Native replay cursor, not arrival time.
        cursor = event.seq;
        yield transport === 'live' ? { ...event, transport: 'live', replay: false } : event;
      }
    } finally { controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock(); this.streams.delete(controller); }
  }

  close() { for (const controller of this.streams) controller.abort(); }
}

/** SSE data JSON is the pinned public Event envelope, not {data:{...}} or V1 properties. */
export async function* decodeSSE(reader, signal, { maxEventBytes = EVENT_LIMIT } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', eventBytes = 0, data = [];
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted(); const chunk = await reader.read(); signal?.throwIfAborted();
      if (chunk.done) { decoder.decode(); if (buffer || data.length) throw new Error('Native event stream ended mid-frame'); break; }
      if (chunk.value.length > maxEventBytes) throw new Error('Native event chunk exceeds limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffer) > maxEventBytes) throw new Error('Native event buffer exceeds limit');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        eventBytes += Buffer.byteLength(line) + 1;
        if (eventBytes > maxEventBytes) throw new Error('Native event exceeds limit');
        if (line === '') {
          if (data.length) { let value; try { value = JSON.parse(data.join('\n')); } catch { throw new Error('Invalid native event JSON'); } yield value; }
          data = []; eventBytes = 0;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}

// Native asRecord wraps provider JSON-string arguments in {value}. Parse only
// bounded argument JSON and retain file coordinates, never source/edit content.
function safeArguments(raw) {
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const knownKeys = new Set(['path','filePath','file_path','offset','limit','value','content','oldString','newString','replaceAll','command','pattern','include']);
  const keys = value => type(value) === 'object' ? [...new Set(Object.keys(value).slice(0,32).map(key=>knownKeys.has(key)?key:'<other>'))] : [];
  let args = raw, encoding = 'object', parseStatus = 'not-needed';
  const diagnostics = { containerType:type(raw), keys:keys(raw) };
  const encoded = typeof raw === 'string' ? raw : typeof raw?.value === 'string' ? raw.value : undefined;
  if (encoded !== undefined) {
    encoding = typeof raw === 'string' ? 'json-string' : 'wrapped-json-string';
    if (Buffer.byteLength(encoded) > 256*1024) { args = null; parseStatus = 'limit'; }
    else { try { args = JSON.parse(encoded); parseStatus = 'parsed'; } catch { args = null; parseStatus = 'invalid'; } }
  }
  const input = {}, candidates = type(args) === 'object' ? ['path','filePath','file_path'].filter(key=>typeof args[key] === 'string') : [];
  const distinct = new Set(candidates.map(key=>args[key]));
  const pathField = distinct.size === 1 ? candidates[0] : null;
  if (pathField && args[pathField].length <= 4096) input.path = args[pathField];
  for (const key of ['offset','limit']) if (Number.isSafeInteger(args?.[key]) && args[key] >= 0) input[key] = args[key];
  return { input, diagnostics:{...diagnostics, encoding, parseStatus, decodedType:type(args), decodedKeys:keys(args), pathField, pathStatus:distinct.size>1?'ambiguous':input.path===undefined?'unknown':'present'} };
}

function normalizeEvent(value, sessionID, tools) {
  if (value?.type === 'log.synced') {
    if (value.aggregateID !== sessionID || (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0))) throw new Error('Invalid native synced marker');
    return { id: null, seq: value.seq ?? null, type: value.type, data: { aggregateID: sessionID }, time: null };
  }
  if (typeof value?.id !== 'string' || !value.id.startsWith('evt_') || typeof value.type !== 'string' || !value.type.startsWith('session.') || !Number.isFinite(value.created) || !Number.isSafeInteger(value.durable?.seq) || value.durable.seq < 0 || !Number.isSafeInteger(value.durable.version) || value.durable.version < 1 || value.durable.aggregateID !== sessionID || value.data?.sessionID !== sessionID) throw new Error('Invalid native event envelope');
  const source = value.data, data = { sessionID };
  for (const field of ['assistantMessageID', 'inboxID', 'id', 'name', 'agent', 'reason', 'delivery', 'finish']) if (typeof source[field] === 'string') data[field] = source[field].slice(0, 512);
  if (typeof source.executed === 'boolean') data.executed = source.executed;
  if (value.type === 'session.tool.input.started') {
    if (tools.size >= 256 && !tools.has(source.id)) throw new Error('Native tool correlation exceeds limit');
    tools.set(source.id, { ...tools.get(source.id), name: source.name });
  }
  if (value.type === 'session.tool.called') {
    const prior = tools.get(source.id) ?? {};
    const { input, diagnostics } = safeArguments(source.input);
    if (tools.size >= 256 && !tools.has(source.id)) throw new Error('Native tool correlation exceeds limit');
    tools.set(source.id, { ...prior, input, diagnostics });
  }
  if (value.type.startsWith('session.tool.')) {
    const tool = tools.get(source.id);
    data.toolName = tool?.name ?? null; data.input = tool?.input ?? null;
    data.inputDiagnostics = tool?.diagnostics ?? null;
    if (value.type === 'session.tool.success' || value.type === 'session.tool.failed') tools.delete(source.id);
  }
  if (source.model && typeof source.model.providerID === 'string' && typeof source.model.id === 'string') data.model = { providerID: source.model.providerID, id: source.model.id };
  if (Number.isFinite(source.started)) data.started = source.started;
  if (source.tokens && typeof source.tokens === 'object') data.tokens = Object.fromEntries(Object.entries(source.tokens).filter(([, n]) => Number.isFinite(n)));
  if (Number.isFinite(source.cost)) data.cost = source.cost;
  if (Array.isArray(source.files)) data.files = source.files.filter(file => typeof file === 'string').slice(0, 200);
  return { id: value.id, seq: value.durable.seq, type: value.type, data, time: value.created, version: value.durable.version };
}
