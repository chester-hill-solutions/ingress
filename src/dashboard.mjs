import { createServer } from 'node:http';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Collaboration</title><style>
:root{color-scheme:dark;font:15px system-ui;background:#11151c;color:#e7eaf0}body{margin:0;padding:32px;max-width:1200px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #34404b;padding-bottom:24px}h1{font-size:36px;letter-spacing:-1px;margin:10px 0}h2{font-size:19px}p{line-height:1.5}small,.muted{color:#a5b2c0}.tag{border:1px solid #3d6270;border-radius:20px;padding:7px 12px;color:#8ee9d1}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:24px 0}.card{border:1px solid #34404b;border-radius:14px;padding:20px;background:#19212c}.row{display:flex;justify-content:space-between;gap:15px;border-bottom:1px solid #2e3a47;padding:12px 0}code{color:#8ee9d1;font-size:13px;overflow-wrap:anywhere}#events{max-height:380px;overflow:auto}.good{color:#8ee9d1}.bad{color:#ffb4a5}@media(max-width:700px){.grid{grid-template-columns:1fr}body{padding:20px}h1{font-size:28px}}</style>
<header><div><small>AGENT COLLABORATION / RT-0</small><h1>One workspace. Shared awareness.</h1><p class="muted">Native activity, observed changes and bounded decisions.</p></div><span class="tag" id="connected">Connecting</span></header>
<p id="phase" class="muted">Waiting for workspace state</p><div id="agents" class="grid"></div>
<div class="grid"><section class="card"><h2>Observed files</h2><div id="files"></div><p class="muted">Observed bytes have unknown authorship. Read locations do not prove revision freshness.</p></section><section class="card"><h2>Evidence and checks</h2><div id="results"></div><p class="muted">Native observation does not prevent stale writes. Shadow decisions do not prove collaboration benefit.</p></section></div><section class="card"><h2>Live causal feed</h2><div id="events"></div></section>
<script>const $=id=>document.getElementById(id);const el=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n};const row=(a,b)=>{const n=el('div','','row');n.append(el('span',a),el('code',b));return n};const stream=new EventSource('/events');stream.onopen=()=>{$('connected').textContent='Live / loopback'};stream.onerror=()=>{$('connected').textContent='Reconnecting'};stream.onmessage=event=>{const s=JSON.parse(event.data);$('phase').textContent=s.phase||'Observation';$('agents').replaceChildren();for(const p of s.state?.participants||[]){const c=el('article','','card');c.append(el('h2',p.id),el('p',p.task?.text||'Assigned goal unknown'),row('Status',p.status),row('Intention',p.intention?.text||'No agent declaration'),row('Last observed location',p.lastLocation?.path||'Unknown'),row('Read basis',p.lastLocation?.confidence||'Unknown'));$('agents').append(c)}$('files').replaceChildren();for(const f of s.state?.files||[])$('files').append(row(f.path,'r'+f.revision+' · '+(f.hash?.slice(0,10)||'absent')));$('results').replaceChildren();$('results').append(row('Current coverage',s.state?.coverage?.complete?'Observed':'Incomplete'),row('Historical completeness','Unknown / coalesced native writes'));for(const r of s.results||[])$('results').append(row(r.condition,r.verification?.correct?'Independent checks passed':'Check failure / incomplete'));$('events').replaceChildren();for(const e of (s.events||[]).slice(-25).reverse())$('events').append(row(e.actor||e.source||'workspace',[e.type,e.path,e.status].filter(Boolean).join(' · ')))};</script></html>`;

/** Read-only loopback view. Never serves fixture files or accepts native controls. */
export async function startDashboard(getState) {
  const clients = new Set();
  const encode = () => {
    const value = JSON.stringify(getState());
    if (Buffer.byteLength(value) > 256 * 1024) throw new Error('Dashboard state exceeds bound');
    return `data: ${value}\n\n`;
  };
  const server = createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url !== '/events') { res.writeHead(404).end(); return; }
    if (clients.size >= 8) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-content-type-options': 'nosniff' });
    try { res.write(encode()); } catch { res.end(); return; }
    clients.add(res); req.on('close', () => clients.delete(res));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    push() { let text; try { text = encode(); } catch { return; } for (const client of clients) if (!client.write(text)) { clients.delete(client); client.destroy(); } },
    async close() { for (const client of clients) client.end(); clients.clear(); await new Promise(resolve => server.close(resolve)); },
  };
}
