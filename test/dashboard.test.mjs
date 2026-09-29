import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard, summarizeDashboard } from '../src/dashboard.mjs';

test('loopback view refuses cross-origin/mutating and unknown requests', async () => {
  const server = await startDashboard(() => ({ phase: 'test', state: null, events: [] }));
  try {
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(server.url, { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(server.url + 'fixture/producer.mjs')).status, 404);
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /textContent/);
  } finally { await server.close(); }
});

test('SSE first snapshot and later push deliver changed state without polling', async () => {
  let state = { phase: 'first', state: null, events: [] };
  const server = await startDashboard(() => state);
  const controller = new AbortController();
  let reader;
  try {
    const response = await fetch(server.url + 'events', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"phase":"first"/);
    state = { ...state, phase: 'second' }; server.push();
    const second = await reader.read();
    assert.match(new TextDecoder().decode(second.value), /"phase":"second"/);
  } finally { controller.abort(); await reader?.cancel().catch(() => {}); await server.close(); }
});

test('sixteen-person view keeps coordinator focus separate from native concurrency and pending checks',()=>{
  const task='Extend EXISTING game with peers. Export meaningfulGameModule and implement useful visible behavior. '+ 'detail '.repeat(80);
  const participants=Array.from({length:16},(_,index)=>({id:'actor-'+index,status:'running',task:{text:task},intention:{text:'Assigned focus (squad coordinator), role: '+task}}));
  const result={executionConcurrency:{currentRunning:16,peakRunning:16,currentAdmitted:16,peakAdmitted:16},verification:{correct:false,checks:[]}};
  const view=summarizeDashboard({state:{participants},result,results:[result]});
  assert.equal(view.participants.length,16);assert.equal(view.native.currentRunning,16);assert.equal(view.native.peakRunning,16);
  assert.equal(view.checks[0].status,'pending');assert.equal(view.checks[0].label,'Pending independent checks');
  assert.ok(view.participants.every(p=>p.taskExcerpt.length<=151&&p.taskText===task));
  assert.equal(view.participants[0].intentionLabel,'Coordinator-assigned focus');assert.equal(view.participants[0].intentionExcerpt,'Matches assignment');
  assert.match(view.participants[0].taskExcerpt,/^Export meaningfulGameModule/);
  const unknown=summarizeDashboard({state:{participants}});assert.equal(unknown.native.currentRunning,null);assert.equal(unknown.native.peakRunning,null);
});

test('recorded intention without provenance is unknown; checked failures are distinct from pending',()=>{
  const value={state:{participants:[{id:'one',task:{text:'Build'},intention:{text:'I will investigate'}},{id:'two',intention:{text:'I will inspect',authority:'agent_self_report'}}]},results:[{verification:{correct:false,checks:[{passed:true},{passed:false}]}},{verification:{correct:true,checks:[{passed:true}]}}]};
  const view=summarizeDashboard(value);
  assert.equal(view.participants[0].intentionLabel,'Intention · source unknown');assert.equal(view.participants[1].intentionLabel,'Agent-declared intention');
  assert.equal(view.checks[0].status,'incomplete');assert.equal(view.checks[0].label,'1 / 2 passed · incomplete');assert.equal(view.checks[1].label,'1 / 1 checks passed');
});

test('served browser script remains syntactically valid and exposes expandable read-only assignments',async()=>{
  const server=await startDashboard(()=>({state:null}));
  try{const html=await(await fetch(server.url)).text();const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new Function(script));assert.match(html,/Assignment details/);assert.match(html,/peak native running/);assert.ok(!html.includes('innerHTML'));assert.ok(!html.includes('Check failure \/ incomplete'));}
  finally{await server.close();}
});
