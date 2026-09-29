import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeClient, safeRuntimeError } from '../src/opencode.mjs';

const envelope = (seq, type, data = {}) => ({ id: `evt_${seq}`, type, created: 1000 + seq, durable: { aggregateID: 'ses_one', seq, version: type === 'session.tool.success' ? 2 : 1 }, data: { sessionID: 'ses_one', ...data } });
function streamResponse(values, { chunks } = {}) {
  const wire = values.map(value => `event: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  const pieces = chunks ?? [bytes];
  return new Response(new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const client = fetchImpl => new OpenCodeClient({ endpoint: 'http://127.0.0.1:1234', password: 'test-pass', directory: '/workspace', model: { providerID: 'opencode', id: 'test-model' }, fetchImpl });

test('authentic native requests preserve admission identity without inherited footer', async () => {
  const calls = [];
  const instance = client(async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/api/session')) return Response.json({ data: { id: 'ses_one' } });
    if (url.endsWith('/prompt')) { const p = JSON.parse(options.body); return Response.json({ data: { id: p.id, sessionID: 'ses_one', delivery: p.delivery, time: { created: 99 }, payload: { text: 'DO NOT INCLUDE IN ADMISSION' } } }); }
    if (url.endsWith('/wait')) return new Response(null, { status: 204 });
    if (url.endsWith('resume=false')) return Response.json({ interrupted: true });
    return Response.json({ data: { outcome: 'succeeded', time: { idle: 100 } } });
  });
  assert.equal(await instance.createSession('Fixture'), 'ses_one');
  assert.deepEqual(await instance.prompt('ses_one', 'Only requested task', { id: 'msg_one' }), { id: 'msg_one', sessionID: 'ses_one', delivery: 'steer', created: 99 });
  assert.equal(JSON.parse(calls[1].body).text, 'Only requested task');
  assert.equal(Object.hasOwn(JSON.parse(calls[1].body),'resume'),false);
  assert.equal(calls[1].headers.authorization, 'Basic '+Buffer.from('opencode:test-pass').toString('base64'));
  assert.equal(JSON.parse(calls[0].body).permissions[0].effect, 'deny');
  assert.deepEqual(await instance.wait('ses_one'), { sessionID: 'ses_one', outcome: 'succeeded', idle: 100 });
  assert.deepEqual(await instance.interrupt('ses_one'), { interrupted: true });
});

test('explicit resume false admits steering without waking an idle successor',async()=>{
  let body;
  const instance=client(async(_url,options)=>{body=JSON.parse(options.body);return Response.json({data:{id:body.id,sessionID:'ses_one',delivery:body.delivery,time:{created:99}}});});
  await instance.prompt('ses_one','Peer fact changed',{id:'msg_notice',resume:false});
  assert.deepEqual(body,{id:'msg_notice',text:'Peer fact changed',delivery:'steer',resume:false});
  await instance.prompt('ses_one','Explicit task',{id:'msg_task',resume:true});assert.equal(body.resume,true);
  await assert.rejects(instance.prompt('ses_one','Bad control',{id:'msg_bad',resume:'false'}),/resume setting/);
});

test('wait polls short GETs through pending states and returns the native terminal outcome', async () => {
  const calls = [], states = [
    { time: {} }, { outcome: 'running', time: {} },
    { outcome: 'failed', time: { idle: 123 } }
  ];
  const instance = client(async (url, options) => {
    calls.push({ url, method: options.method });
    return Response.json({ data: states.shift() });
  });
  assert.deepEqual(await instance.wait('ses_one', undefined, { pollIntervalMs: 1 }), { sessionID: 'ses_one', outcome: 'failed', idle: 123 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.method === 'GET' && c.url.endsWith('/api/session/ses_one')));
});

test('wait ignores a prior terminal outcome using the admission time; parked notices do not reset it', async () => {
  let reads = 0;
  const instance = client(async (url, options) => {
    if (url.endsWith('/prompt')) {
      const input = JSON.parse(options.body);
      return Response.json({ data: { id: input.id, sessionID: 'ses_one', delivery: input.delivery, time: { created: input.resume === false ? 200 : 100 } } });
    }
    return Response.json({ data: { outcome: 'succeeded', time: { idle: ++reads === 1 ? 99 : 110 } } });
  });
  await instance.prompt('ses_one', 'task', { id: 'msg_task' });
  await instance.prompt('ses_one', 'parked notice', { id: 'msg_notice', resume: false });
  assert.equal((await instance.wait('ses_one', undefined, { pollIntervalMs: 1 })).idle, 110);
  assert.equal(reads, 2);
});

test('explicit wait boundary handles existing sessions and interruption; malformed terminal state fails', async () => {
  const states = [{ outcome: 'failed', time: { idle: 12 } }, { outcome: 'interrupted', time: { idle: 20 } }];
  const instance = client(async () => Response.json({ data: states.shift() }));
  assert.equal((await instance.wait('ses_one', undefined, { minIdleAt: 20, pollIntervalMs: 1 })).outcome, 'interrupted');
  await assert.rejects(client(async () => Response.json({ data: { outcome: 'succeeded', time: {} } })).wait('ses_one'), /terminal outcome unknown/);
  await assert.rejects(client(async () => Response.json({ data: null })).wait('ses_one'), /session state/);
  await assert.rejects(instance.wait('ses_one', undefined, { pollIntervalMs: 0 }), /poll interval/);
  await assert.rejects(instance.wait('ses_one', undefined, { minIdleAt: NaN }), /idle boundary/);
});

test('wait cancellation interrupts the polling delay and never starts a successor request', async () => {
  let calls = 0;
  const instance = client(async () => { calls++; return Response.json({ data: { time: {} } }); });
  const controller = new AbortController();
  const waiting = instance.wait('ses_one', controller.signal, { pollIntervalMs: 10000 });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.equal(calls, 1);
  await assert.rejects(instance.wait('ses_one', controller.signal), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('wait aborts an active GET with the caller signal', async () => {
  const instance = client(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const controller = new AbortController();
  const waiting = instance.wait('ses_one', controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('runtime diagnostics retain only allowlisted transport names/codes and numeric HTTP status', async () => {
  const failure = new TypeError('PRIVATE PROVIDER RESPONSE', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT', message: 'PRIVATE URL' } });
  assert.deepEqual(safeRuntimeError(failure), { name: 'TypeError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  assert.deepEqual(safeRuntimeError({ name: 'PRIVATE', code: 'PRIVATE', status: '500', stack: 'PRIVATE' }), { name: 'unknown' });
  const instance = client(async () => new Response('PRIVATE BODY', { status: 503 }));
  await assert.rejects(instance.wait('ses_one'), error => {
    assert.deepEqual(safeRuntimeError(error), { name: 'OpenCodeHTTPError', status: 503 });
    assert.ok(!JSON.stringify(safeRuntimeError(error)).includes('PRIVATE'));
    return true;
  });
});

test('native SSE preserves durable source IDs, cursors and tool correlation without prose', async () => {
  const values = [envelope(1,'session.tool.input.started',{ id: 'tool_1', assistantMessageID:'msg_a', name:'read' }), envelope(2,'session.tool.called',{id:'tool_1',input:{path:'money.mjs',offset:0,limit:30,oldString:'PRIVATE SOURCE'},executed:true}), envelope(3,'session.tool.success',{id:'tool_1',executed:true,content:[{type:'text',text:'PRIVATE MODEL CONTENT'}]}), {type:'log.synced',aggregateID:'ses_one',seq:3}, envelope(4,'session.inbox.delivered',{inboxID:'msg_steer'}), envelope(4,'session.inbox.delivered',{inboxID:'msg_steer'})];
  const bytes = new TextEncoder().encode(values.map(v=>'data: '+JSON.stringify(v)+'\r\n\r\n').join(''));
  let requested;
  const instance = client(async url => { requested=url; return streamResponse([], {chunks:[bytes.slice(0,17),bytes.slice(17,210),bytes.slice(210)]}); });
  const events = []; for await(const event of instance.events('ses_one')) events.push(event);
  assert.equal(events.length,5); assert.match(requested,/after=0&follow=true$/);
  assert.equal(events[0].id,'evt_1'); assert.equal(events[0].seq,1); assert.equal(events[0].time,1001);
  assert.deepEqual(events[2].data.input,{path:'money.mjs',offset:0,limit:30}); assert.equal(events[2].data.toolName,'read');
  assert.equal(events[3].id,null); assert.equal(events[3].time,null);
  assert.equal(events[4].data.inboxID,'msg_steer'); assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});

test('replay after cursor excludes older source events and marks missing tool metadata unknown', async () => {
  const instance=client(async()=>streamResponse([envelope(4,'session.execution.started'),envelope(5,'session.tool.called',{id:'tool_unknown',input:{path:'x'},executed:true}),{type:'log.synced',aggregateID:'ses_one',seq:5}]));
  const events=[];for await(const event of instance.events('ses_one',{after:4}))events.push(event);
  assert.equal(events[0].seq,5);assert.equal(events[0].data.toolName,null);
});

test('volatile native feed signals readiness, includes seq zero and filters other sessions without replay', async () => {
  let requested;
  const seen = [], foreign = envelope(2,'session.execution.started'); foreign.data.sessionID='ses_other'; foreign.durable.aggregateID='ses_other';
  const instance=client(async url=>{requested=url;return streamResponse([
    {id:'evt_connected',type:'server.connected',data:{}},
    {type:'provider.updated',data:{secret:'PRIVATE'}},
    foreign, {type:'session.tool.progress',data:{sessionID:'ses_one',content:'PRIVATE'}},
    envelope(0,'session.created'),envelope(1,'session.inbox.delivered',{inboxID:'msg_notice'})
  ]);});
  const events=[];for await(const event of instance.events('ses_one',{transport:'live',onMetadata:m=>seen.push(m)}))events.push(event);
  assert.equal(requested,'http://127.0.0.1:1234/api/event');assert.equal(events.length,3);
  assert.equal(events[0].type,'server.connected');assert.equal(events[0].seq,null);assert.equal(events[0].id,'evt_connected');
  assert.equal(events[1].seq,0);assert.equal(events[2].data.inboxID,'msg_notice');
  assert.ok(events.every(e=>e.transport==='live'&&e.replay===false));
  assert.equal(seen.length,6);assert.deepEqual(Object.keys(seen[0]),['type','id','seq','sessionMatch']);
  assert.equal(seen[2].sessionMatch,false);assert.ok(!JSON.stringify({events,seen}).includes('PRIVATE'));
  await assert.rejects(instance.events('ses_one',{transport:'live',after:0}).next(),/do not support replay/);
});

test('metadata diagnostics precede cursor exclusion, cap samples and cannot disrupt observation',async()=>{
  const values=Array.from({length:140},(_,i)=>envelope(i,'session.execution.started',{secret:'PRIVATE'}));
  let samples=0;const instance=client(async()=>streamResponse(values));const events=[];
  for await(const event of instance.events('ses_one',{after:100,onMetadata:metadata=>{samples++;assert.ok(!Object.hasOwn(metadata,'data'));throw new Error('ignored diagnostic error');}}))events.push(event);
  assert.equal(samples,128);assert.equal(events.length,39);assert.equal(events[0].seq,101);
});

test('provider JSON-string arguments wrapped by pinned asRecord preserve read/write coordinates without content',async()=>{
  const metadata=[];
  const values=[envelope(1,'session.tool.input.started',{id:'read_1',name:'read'}),
    envelope(2,'session.tool.called',{id:'read_1',input:{value:JSON.stringify({path:'shared.mjs',offset:1,limit:20,content:'PRIVATE CONTENT'})}}),
    envelope(3,'session.tool.success',{id:'read_1',executed:true}),
    envelope(4,'session.tool.input.started',{id:'write_1',name:'write'}),
    envelope(5,'session.tool.called',{id:'write_1',input:{value:JSON.stringify({path:'consumer.mjs',content:'PRIVATE SOURCE'})}}),
    envelope(6,'session.tool.success',{id:'write_1',executed:true})];
  const instance=client(async()=>streamResponse(values)),events=[];
  for await(const event of instance.events('ses_one',{onMetadata:m=>metadata.push(m)}))events.push(event);
  assert.deepEqual(events[2].data.input,{path:'shared.mjs',offset:1,limit:20});
  assert.equal(events[2].data.inputDiagnostics.encoding,'wrapped-json-string');assert.equal(events[2].data.inputDiagnostics.pathField,'path');
  assert.deepEqual(events[5].data.input,{path:'consumer.mjs'});assert.equal(metadata[1].arguments.containerType,'object');
  assert.deepEqual(metadata[1].arguments.keys,['value']);assert.equal(metadata[1].arguments.parseStatus,'parsed');
  assert.ok(!JSON.stringify({events,metadata}).includes('PRIVATE'));
});

test('argument variants retain provenance, malformed/oversized strings remain unknown, conflicts are not guessed',async()=>{
  const inputs=[JSON.stringify({filePath:'alias.mjs',newString:'PRIVATE'}),{file_path:'snake.mjs'},
    {path:'a.mjs',filePath:'b.mjs'}, {value:'PRIVATE INVALID JSON'}, {value:'x'.repeat(256*1024+1)}];
  const values=inputs.flatMap((input,i)=>[envelope(i*2+1,'session.tool.called',{id:'call_'+i,input}),envelope(i*2+2,'session.tool.success',{id:'call_'+i})]);
  const events=[],instance=client(async()=>streamResponse(values));for await(const event of instance.events('ses_one'))events.push(event);
  assert.equal(events[1].data.input.path,'alias.mjs');assert.equal(events[1].data.inputDiagnostics.pathField,'filePath');
  assert.equal(events[3].data.input.path,'snake.mjs');
  assert.deepEqual(events[5].data.input,{});assert.equal(events[5].data.inputDiagnostics.pathStatus,'ambiguous');
  assert.equal(events[7].data.inputDiagnostics.parseStatus,'invalid');assert.equal(events[9].data.inputDiagnostics.parseStatus,'limit');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
});

test('malformed and oversized event frames fail without reflecting raw content', async () => {
  for(const wire of ['data: {PRIVATE\n\n', 'data: '+ 'x'.repeat(1024*1024+1), 'data: {"type":"session.tool.called"}\n\n', 'data: {}']) {
    const instance=client(async()=>streamResponse([], {chunks:[new TextEncoder().encode(wire)]}));
    await assert.rejects(async()=>{for await(const event of instance.events('ses_one'))void event;},error=>!error.message.includes('PRIVATE'));
  }
});

test('event abort and close cancel a pending read', async () => {
  let cancelled=false;
  const instance=client(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  const controller=new AbortController(), iterable=instance.events('ses_one',{signal:controller.signal});
  const pending=iterable.next();await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending);assert.equal(cancelled,true);assert.equal(instance.streams.size,0);
  cancelled=false;const second=instance.events('ses_one').next();await new Promise(resolve=>setImmediate(resolve));instance.close();await assert.rejects(second);assert.equal(cancelled,true);
});

test('bounded JSON and mismatched admissions reject safely', async () => {
  const oversized=client(async()=>new Response('x'.repeat(4*1024*1024+1)));
  await assert.rejects(oversized.context('ses_one'),/exceeds limit/);
  const bad=client(async()=>Response.json({data:{id:'msg_other',sessionID:'ses_one',delivery:'steer',time:{created:1}}}));
  await assert.rejects(bad.prompt('ses_one','task',{id:'msg_one'}),/admission mismatch/);
  await assert.rejects(bad.events('ses_one',{after:-1}).next(),/cursor/);
  assert.throws(()=>new OpenCodeClient({endpoint:'https://example.com',password:'secret'}),/loopback/);
});
