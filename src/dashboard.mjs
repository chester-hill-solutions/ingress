import { createServer } from 'node:http';
function compactText(value, length = 150) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const points = Array.from(text); return points.length > length ? points.slice(0, length).join('') + '…' : text;
}
function focusText(value) {
  if (typeof value !== 'string') return '';
  const start = value.search(/\b(Export|Implement|Build|Polish)\b/);
  return start >= 0 ? value.slice(start) : value;
}
/** Presentation metadata only; native counts are never inferred from card status. */
export function summarizeDashboard(value) {
  const result = value.result ?? value.results?.at(-1), count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const native = result?.executionConcurrency;
  return {
    participants: (value.state?.participants ?? []).map(p => {
      const intention = p.intention?.text ?? '', assignment = /^(Assigned focus|Coordinator assigned focus)/i.test(intention);
      const label = assignment ? 'Coordinator-assigned focus' : p.intention?.authority === 'agent_self_report' ? 'Agent-declared intention' : intention ? 'Intention · source unknown' : 'No intention recorded';
      const taskExcerpt = compactText(focusText(p.task?.text)), intentionExcerpt = compactText(focusText(intention), 90);
      return { id:p.id, status:p.status ?? 'unknown', taskText:p.task?.text ?? 'Assigned goal unknown', taskExcerpt:taskExcerpt || 'Assigned goal unknown', intentionText:intention, intentionLabel:label, intentionExcerpt:assignment && taskExcerpt.startsWith(intentionExcerpt.replace(/…$/, '')) ? 'Matches assignment' : intentionExcerpt, path:p.lastLocation?.path ?? 'Location unknown', confidence:p.lastLocation?.confidence ?? 'unknown' };
    }),
    native: { currentRunning:count(native?.currentRunning), peakRunning:count(native?.peakRunning), currentAdmitted:count(native?.currentAdmitted), peakAdmitted:count(native?.peakAdmitted) },
    checks: (value.results ?? (value.result ? [value.result] : [])).map(result => {
      const checks = result.verification?.checks ?? [], passed = checks.filter(check => check.passed === true).length;
      return { condition:result.condition ?? 'Independent verification', status:checks.length ? result.verification.correct === true ? 'passed' : 'incomplete' : 'pending', label:checks.length ? result.verification.correct === true ? `${passed} / ${checks.length} checks passed` : `${passed} / ${checks.length} passed · incomplete` : 'Pending independent checks' };
    }),
  };
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Collaboration</title><style>
:root{color-scheme:dark;font:14px system-ui;background:#11151c;color:#e7eaf0}body{margin:0;padding:28px;max-width:1450px;margin:auto}header{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #34404b;padding-bottom:20px}h1{font-size:32px;letter-spacing:-1px;margin:8px 0}h2{font-size:17px;margin:0}p{line-height:1.45}small,.muted{color:#a5b2c0}.tag{border:1px solid #3d6270;border-radius:20px;padding:6px 10px;color:#8ee9d1;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}#agents{grid-template-columns:repeat(3,minmax(0,1fr))}.card{border:1px solid #34404b;border-radius:12px;padding:16px;background:#19212c}.heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.status{font:12px system-ui;border:1px solid #47606e;border-radius:12px;padding:3px 8px;color:#bcd6e0}.status[data-status=running]{color:#8ee9d1;border-color:#398478}.excerpt{font-size:13px;line-height:1.45;min-height:38px;margin:10px 0}.focus{font-size:12px;color:#a5b2c0;margin:8px 0}.row{display:flex;justify-content:space-between;gap:15px;border-bottom:1px solid #2e3a47;padding:9px 0}code{color:#8ee9d1;font-size:12px;overflow-wrap:anywhere;text-align:right}.location{margin:10px 0 4px;font:12px ui-monospace,monospace;color:#8ee9d1;overflow-wrap:anywhere}details{font-size:12px;margin-top:10px}summary{cursor:pointer;color:#bbc8d7}details p{white-space:pre-wrap;overflow-wrap:anywhere;color:#c1ccd8;max-height:250px;overflow:auto}#roster{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}#events,#files{max-height:330px;overflow:auto}.good{color:#8ee9d1}.bad{color:#ffb4a5}@media(min-width:1300px){#agents{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:1000px){#agents{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.grid,#agents{grid-template-columns:1fr}body{padding:18px}h1{font-size:26px}header{align-items:flex-start}}
</style><header><div><small>AGENT COLLABORATION / RT-0</small><h1>One workspace. Shared awareness.</h1><p class="muted">Native activity and observed changes.</p></div><span class="tag" id="connected">Connecting</span></header>
<p id="phase" class="muted">Waiting for workspace state</p><div id="roster" aria-live="polite"></div><div id="agents" class="grid"></div>
<div class="grid"><section class="card"><h2>Observed files</h2><div id="files"></div><p class="muted">Observed bytes have unknown authorship. Read locations do not prove revision freshness.</p></section><section class="card"><h2>Evidence and checks</h2><div id="results"></div><p class="muted">Native observation does not prevent stale writes. Historical coverage remains unknown.</p></section></div><section class="card"><h2>Live causal feed</h2><div id="events"></div></section>
<script>${compactText.toString()};${focusText.toString()};${summarizeDashboard.toString()};
const $=id=>document.getElementById(id);const el=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n};const row=(a,b)=>{const n=el('div','','row');n.append(el('span',a),el('code',b));return n};
const stream=new EventSource('/events');stream.onopen=()=>{$('connected').textContent='Live / loopback'};stream.onerror=()=>{$('connected').textContent='Reconnecting'};
stream.onmessage=event=>{const s=JSON.parse(event.data),view=summarizeDashboard(s);$('phase').textContent=s.phase||'Observation';$('roster').replaceChildren(el('span',view.participants.length+' participants','tag'));if(view.native.currentRunning!==null)$('roster').append(el('span',view.native.currentRunning+' native running','tag'));if(view.native.peakRunning!==null)$('roster').append(el('span',view.native.peakRunning+' peak native running','tag'));if(view.native.currentAdmitted!==null)$('roster').append(el('span',view.native.currentAdmitted+' tasks admitted','tag'));
const expanded=new Set([...$('agents').querySelectorAll('details[open]')].map(n=>n.dataset.agent));$('agents').replaceChildren();for(const p of view.participants){const c=el('article','','card'),heading=el('div','','heading'),status=el('span',p.status,'status');status.dataset.status=p.status;heading.append(el('h2',p.id),status);c.append(heading,el('p',p.taskExcerpt,'excerpt'),el('p',p.intentionLabel+(p.intentionExcerpt?' · '+p.intentionExcerpt:''),'focus'),el('p',p.path,'location'),el('small','Location confidence: '+p.confidence));const details=el('details','');details.dataset.agent=p.id;details.open=expanded.has(p.id);details.append(el('summary','Assignment details'),el('p',p.taskText));if(p.intentionText)details.append(el('small',p.intentionLabel),el('p',p.intentionText));c.append(details);$('agents').append(c)}
$('files').replaceChildren();for(const f of s.state?.files||[])$('files').append(row(f.path,'r'+f.revision+' · '+(f.hash?.slice(0,10)||'absent')));$('results').replaceChildren();$('results').append(row('Current coverage',s.state?.coverage?.complete?'Observed':'Incomplete'),row('Historical completeness','Unknown / coalesced native writes'));for(const r of view.checks){const item=row(r.condition,r.label);if(r.status==='passed')item.classList.add('good');$('results').append(item)}$('events').replaceChildren();for(const e of (s.events||[]).slice(-25).reverse())$('events').append(row(e.actor||e.source||'workspace',[e.type,e.path,e.status].filter(Boolean).join(' · ')))};</script></html>`;

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
