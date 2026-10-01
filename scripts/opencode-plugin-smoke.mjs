import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startOpenCode } from '../src/process.mjs';
import { OpenCodeClient, safeRuntimeError } from '../src/opencode.mjs';

if (process.argv.slice(2).join(' ') !== '--native-local') {
  throw new Error('Opt-in installed-binary probe: pass --native-local. Uses a loopback scripted provider and a fixture credential.');
}
const root = await mkdtemp(join(tmpdir(), 'oc-plugin-smoke-'));
const workspace = join(root, 'workspace');
const receipts = join(root, 'receipts.jsonl'), revision = join(root, 'revision'), route = join(root, 'route');
const providerRequests = [], steps = new Map(), pending = [];
const evidence = { version: 1, mode: 'installed-native-scripted-provider', date: new Date().toISOString(), providerRequests,
  routing: { observedModelRequests: 'unknown', otherTraffic: 'not measured' } };
let host, client, listened = false, requestCount = 0;

function send(res, model, delta, finish) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (value, reason, usage) => 'data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: value, finish_reason: reason }], ...(usage ? { usage } : {}) }) + '\n\n';
  res.write(chunk(delta, null));
  res.write(chunk({}, finish, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
  res.end('data: [DONE]\n\n');
}
function respond({ res, body, sessionID, step }) {
  if (step === 1) {
    const name = body.tools?.find(t => t.function?.name === 'read')?.function.name;
    if (!name) return send(res, body.model, { content: 'missing native read' }, 'stop');
    send(res, body.model, { tool_calls: [{ index: 0, id: 'call_fixture_' + sessionID, type: 'function',
      function: { name, arguments: JSON.stringify({ path: join(workspace, 'probe.txt') }) } }] }, 'tool_calls');
  } else send(res, body.model, { content: 'fixture complete' }, 'stop');
}
const provider = createServer(async (req, res) => {
  try {
    if (++requestCount > 8) throw new Error('request limit');
    req.setTimeout(5000, () => req.destroy());
    let bytes = 0, text = '';
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('body limit');
      text += chunk;
    }
    const body = JSON.parse(text), messages = JSON.stringify(body.messages ?? []);
    const matches = [...messages.matchAll(/GANGCODE_PROBE:([a-zA-Z0-9_-]{1,160}):(\d+)/g)];
    const header = req.headers['x-ingress-probe-session'];
    const sessionID = typeof header === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(header) ? header : null;
    const marker = matches[0];
    providerRequests.push({ path: req.url === '/v1/chat/completions' ? req.url : 'other', sessionID,
      markerSessionID: marker?.[1] ?? null, markerCount: matches.length, revision: marker ? Number(marker[2]) : null,
      toolCount: body.tools?.length ?? 0 });
    if (!marker) return send(res, body.model, { content: 'auxiliary fixture' }, 'stop');
    if (!sessionID || marker[1] !== sessionID || (!steps.has(sessionID) && steps.size >= 2)) throw new Error('session mismatch');
    const step = (steps.get(sessionID) ?? 0) + 1;
    if (step > 2) throw new Error('step limit');
    steps.set(sessionID, step);
    const item = { res, body, sessionID, step };
    if (step === 1) {
      if (pending.length >= 2) throw new Error('pending limit');
      pending.push(item);
      if (pending.length === 2) {
        evidence.initialRequestsHeldTogether = true;
        await writeFile(revision, '2');
        for (const ready of pending.splice(0)) respond(ready);
      }
    } else respond(item);
  } catch {
    evidence.providerRejectedRequest = true;
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
try {
  evidence.sourceSHA256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  await mkdir(join(workspace, '.opencode/plugins/ingress'), { recursive: true });
  await writeFile(revision, '1');
  await writeFile(join(workspace, 'probe.txt'), 'deterministic fixture\n');
  // No plugin package install: the pinned Promise Plugin.define returns this object shape.
  await writeFile(join(workspace, '.opencode/plugins/ingress/index.ts'), `
import {appendFileSync,readFileSync} from 'node:fs';
let count=0;
const receipt=value=>{if(count++<64)appendFileSync(${JSON.stringify(receipts)},JSON.stringify(value)+'\\n');};
export default {id:'ingress.compatibility',async setup(ctx){
 receipt({type:'setup',version:ctx.app.version});
 await ctx.session.hook('context',event=>{
  const revision=Number(readFileSync(${JSON.stringify(revision)},'utf8'));
  event.system.push({type:'text',text:'GANGCODE_PROBE:'+event.sessionID+':'+revision});
  for(const name of Object.keys(event.tools))if(name!=='read')delete event.tools[name];
  receipt({type:'context',sessionID:event.sessionID,revision});
 });
 await ctx.session.hook('model.request',event=>{event.baseURL=readFileSync(${JSON.stringify(route)},'utf8');});
 await ctx.session.hook('http.request',event=>{
  const target=readFileSync(${JSON.stringify(route)},'utf8')+'/chat/completions';
  event.request=new Request(target,event.request);
  event.request.headers.set('x-ingress-probe-session',event.sessionID);
  receipt({type:'request',sessionID:event.sessionID,kind:event.kind,loopback:new URL(event.request.url).hostname==='127.0.0.1'});
 });
 await ctx.tool.hook('execute.before',event=>receipt({type:'before',sessionID:event.sessionID,tool:event.tool}));
 await ctx.tool.hook('execute.after',event=>receipt({type:'after',sessionID:event.sessionID,tool:event.tool,status:event.status}));
 return ()=>receipt({type:'cleanup'});
}};
`);
  await new Promise((accept, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', accept); });
  listened = true;
  await writeFile(route, `http://127.0.0.1:${provider.address().port}/v1`);
  host = await startOpenCode({ binary: join(homedir(), '.opencode/bin/opencode'), stateDir: join(root, 'state'), directory: workspace,
    apiKey: 'local-fixture-key', baseURL: `http://127.0.0.1:${provider.address().port}/v1`, modelCatalogPath: join(homedir(), '.cache/opencode/models.json') });
  client = new OpenCodeClient({ ...host, directory: workspace, model: { providerID: 'opencode', id: 'space-bunny-free' },
    permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] });
  const signal = AbortSignal.timeout(45000);
  const ids = await Promise.all(['A', 'B'].map(name => client.createSession('Local plugin smoke ' + name, signal)));
  evidence.sessions = ids;
  await Promise.all(ids.map((id, i) => client.prompt(id, 'Read probe.txt once, then finish.', { id: 'msg_plugin_smoke_' + i, signal })));
  evidence.outcomes = await Promise.all(ids.map(id => client.wait(id, signal, { pollIntervalMs: 100 })));
} catch (error) {
  evidence.error = safeRuntimeError(error);
  if (error?.stopUnconfirmed) evidence.stopUnconfirmed = true;
} finally {
  client?.close();
  try { await host?.close(); evidence.processStopped = !evidence.stopUnconfirmed; }
  catch (error) { evidence.cleanupError = safeRuntimeError(error); evidence.processStopped = false; }
  finally {
    provider.closeAllConnections();
    if (listened) await new Promise(resolve => provider.close(resolve));
  }
}
try {
  if ((await stat(receipts)).size > 128 * 1024) throw new Error('receipt limit');
  evidence.receipts = (await readFile(receipts, 'utf8')).trim().split('\n').map(JSON.parse);
} catch { evidence.receipts = []; }
const ids = evidence.sessions ?? [];
const requests = evidence.receipts.filter(row => row.type === 'request');
if (requests.length) evidence.routing.observedModelRequests = requests.every(row => row.loopback) ? 'loopback' : 'non-loopback present';
evidence.checks = {
  twoSessions: ids.length === 2 && new Set(ids).size === 2,
  simultaneousRequests: evidence.initialRequestsHeldTogether === true,
  freshContinuation: ids.length === 2 && ids.every(id => {
    const rows = providerRequests.filter(row => row.sessionID === id);
    return rows.length === 2 && rows[0].revision === 1 && rows[1].revision === 2 &&
      rows.every(row => row.markerSessionID === id && row.markerCount === 1 && row.toolCount === 1);
  }),
  nativeReadHooks: ids.length === 2 && ids.every(id => evidence.receipts.filter(row => row.sessionID === id && row.type === 'before' && row.tool === 'read').length === 1 &&
    evidence.receipts.filter(row => row.sessionID === id && row.type === 'after' && row.tool === 'read' && row.status === 'completed').length === 1),
  loopbackRequests: requests.length === 4 && requests.every(row => row.loopback) && providerRequests.length === 4,
  successfulSessions: evidence.outcomes?.length === 2 && evidence.outcomes.every(row => row.outcome === 'succeeded'),
  pluginCleanup: evidence.receipts.filter(row => row.type === 'cleanup').length === 1,
  stopped: evidence.processStopped === true
};
evidence.passed = !evidence.error && !evidence.cleanupError && !evidence.providerRejectedRequest && Object.values(evidence.checks).every(Boolean);
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks, evidence: join(root, 'evidence.json') }));
if (!evidence.passed) process.exitCode = 1;
