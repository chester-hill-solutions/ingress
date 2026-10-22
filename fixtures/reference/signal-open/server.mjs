/**
 * A reference implementation of Signal, written to be *satisfiable* rather than good.
 *
 * Its only job is to prove that the design mission's judge is not a trap: a competent product
 * that follows the brief -- and nothing but the brief -- passes every check. It is deliberately
 * unremarkable. The dashboard is a table and a list; the tag is one closure; the store is a map.
 * A submission that does something more interesting should pass at least as easily, and the
 * blind review is where "more interesting" gets judged.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);

/** What the owner sees: views per page, and the errors visitors hit. */
const views = new Map();
const errors = new Map();
const sessions = new Set();

const read = path => readFileSync(join(root, path), 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/** The tag goes in the page the server serves; the customer's file is never edited. */
const instrument = html => html.replace('</head>', '  <script src="/signal.js" defer></script>\n</head>');

const send = (response, status, type, body) => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
};

/** Accept a batch, keep what is worth keeping, ignore what a hostile client might send. */
function collect(body) {
  let batch;
  try { batch = JSON.parse(body); } catch { return { ok: false, code: 'bad_json' }; }
  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.events)) return { ok: false, code: 'bad_schema' };
  if (typeof batch.session === 'string') sessions.add(batch.session);
  let kept = 0;
  for (const event of batch.events.slice(0, 200)) {
    if (!event || typeof event !== 'object') continue;
    const path = typeof event.p === 'string' && event.p.startsWith('/') ? event.p : '/';
    if (event.t === 'view') { views.set(path, (views.get(path) ?? 0) + 1); kept += 1; }
    if (event.t === 'err' && typeof event.m === 'string') {
      const message = event.m.slice(0, 300);
      errors.set(message, (errors.get(message) ?? 0) + 1);
      kept += 1;
    }
  }
  return { ok: true, kept };
}

const dashboard = () => {
  const rows = [...views.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => `<tr><td>${escape(path)}</td><td>${count}</td></tr>`)
    .join('\n');
  const failures = [...errors.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([message, count]) => `<li><code>${escape(message)}</code> <span>${count}×</span></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signal · what is working</title><link rel="stylesheet" href="/dashboard.css"></head>
<body>
<main>
<h1>What is working</h1>
<p>${sessions.size} session${sessions.size === 1 ? '' : 's'} recorded.</p>
<h2>Pages</h2>
<table><thead><tr><th>Page</th><th>Views</th></tr></thead><tbody>
${rows || '<tr><td colspan="2">Nothing recorded yet.</td></tr>'}
</tbody></table>
<h2>What broke</h2>
<ul>${failures || '<li>No errors recorded.</li>'}</ul>
</main>
</body>
</html>`;
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/campaigns')) {
    const name = url.pathname === '/' ? 'index.html' : 'campaigns.html';
    try { send(response, 200, 'text/html; charset=utf-8', instrument(read(`site/${name}`))); }
    catch { send(response, 500, 'text/plain', 'the customer page is missing'); }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/site/style.css') {
    try { send(response, 200, 'text/css; charset=utf-8', read('site/style.css')); } catch { send(response, 404, 'text/plain', 'missing'); }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/signal.js') {
    try { send(response, 200, 'text/javascript; charset=utf-8', read('public/signal.js')); } catch { send(response, 404, 'text/plain', 'missing'); }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/dashboard.css') {
    try { send(response, 200, 'text/css; charset=utf-8', read('public/dashboard.css')); } catch { send(response, 404, 'text/plain', 'missing'); }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/collect') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 512 * 1024) request.destroy();
    });
    request.on('end', () => {
      const result = collect(body);
      send(response, result.ok ? 202 : 400, 'application/json', JSON.stringify(result));
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/dashboard') { send(response, 200, 'text/html; charset=utf-8', dashboard()); return; }
  send(response, 404, 'text/plain', 'not found');
});

server.listen(port, '127.0.0.1', () => { console.log(`signal listening on ${port}`); });
