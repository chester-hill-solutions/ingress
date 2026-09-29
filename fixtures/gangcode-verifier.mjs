import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const OUTPUT_LIMIT = 64 * 1024;
const failure = name => ({ correct: false, checks: [{ name, passed: false }] });
const CASE_NAMES = new Set([
  'fixture-exports', 'content-integrity', 'era-filter-year-order', 'snapshot-isolation', 'public-no-answer-keys',
  'constructor-validation-input-isolation', 'successful-mutations-revision',
  'correct-score-streak', 'wrong-answer-reset', 'streak-bonus-cap', 'reject-duplicate-answer',
  'reject-out-of-order-answer', 'reject-unknown-option', 'reject-unknown-era', 'feedback-cites-source',
  'completion-and-progress', 'first-steps-after-wrong-answer', 'milestone-unlocks-sticky',
  'restart-and-era-reset', 'subscriptions-and-unsubscribe', 'http-server-start', 'http-state',
  'http-answer', 'http-era-and-restart', 'http-reject-invalid-input', 'http-origin-boundary',
  'http-body-bound', 'raw-data-private', 'sse-initial-update', 'ui-interactive-game', 'server-close',
  'verifier-execution', 'verifier-timeout', 'verifier-output-bound', 'verifier-output-invalid',
]);

// The questions, answer keys and independent assertions are outside the model workspace.
const CHILD = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
let input=''; for await (const chunk of process.stdin) input+=chunk;
const { expectedEvents } = JSON.parse(input);
const checks=[];
async function check(name, fn) { try { await fn(); checks.push({name,passed:true}); } catch { checks.push({name,passed:false}); } }
const question=(id,year,era='confederation')=>({id,title:'Hidden event '+id,year,era,region:'Hidden region',question:'Independent question '+id,options:[{id:'a',text:'First option'},{id:'b',text:'Second option'}],correctOptionID:'b',explanation:'Hidden explanation '+id,source:{title:'Independent source '+id,url:'https://example.org/'+id},x:40,y:60});
const three=[question('later',1920),question('earlier',1850),question('middle',1880)];
const five=Array.from({length:5},(_,i)=>question('cap-'+i,1800+i));
let engine, serverModule;
await check('fixture-exports', async()=>{
 engine=await import(pathToFileURL(root+'/engine.mjs'));
 serverModule=await import(pathToFileURL(root+'/server.mjs'));
 assert.equal(typeof engine.createGame,'function');assert.equal(typeof serverModule.createGameServer,'function');
});
if (!engine?.createGame || !serverModule?.createGameServer) {
 console.log(JSON.stringify({correct:false,checks}));
} else {
 const make=(events=three)=>{const g=engine.createGame({events:structuredClone(events),seed:7});g.chooseEra('confederation');return g;};
 const state=value=>value?.state??value?.data??value;
 const safePublic=s=>{
  assert.ok(s&&typeof s==='object');
  for(const event of [s.currentEvent,...(s.mapEvents??[])].filter(Boolean)) {
   assert.ok(!Object.hasOwn(event,'correctOptionID')); assert.ok(!Object.hasOwn(event,'explanation'));
  }
 };
 const milestone=(s,id)=>{const value=s.milestones.find(m=>m.id===id);assert.ok(value);return value.unlocked;};
 await check('content-integrity',async()=>{
  const actual=JSON.parse(await readFile(root+'/data/history.json','utf8'));
  assert.ok(Array.isArray(expectedEvents)&&expectedEvents.length===12);
  assert.ok(Array.isArray(actual)&&actual.length===expectedEvents.length);
  assert.equal(new Set(actual.map(e=>e.id)).size,actual.length);
  for(const expected of expectedEvents){const event=actual.find(e=>e.id===expected.id);assert.ok(event);
   for(const key of ['id','year','era','question','options','correctOptionID','explanation','source'])assert.deepEqual(event[key],expected[key]);
   assert.ok(Number.isFinite(event.x)&&event.x>=0&&event.x<=100&&Number.isFinite(event.y)&&event.y>=0&&event.y<=100);
  }
 });
 await check('era-filter-year-order',()=>{
  const g=make([...three,question('other',1500,'early-contact'),question('tie-a',1880)]);
  const s=g.snapshot();assert.equal(s.era,'confederation');assert.equal(s.phase,'playing');assert.equal(s.currentEvent.id,'earlier');
  assert.deepEqual(s.progress,{answered:0,total:4});assert.equal(s.score,0);assert.equal(s.streak,0);assert.equal(s.feedback,null);
  g.answer('earlier','b');assert.equal(g.snapshot().currentEvent.id,'middle');g.answer('middle','b');assert.equal(g.snapshot().currentEvent.id,'tie-a');
 });
 await check('constructor-validation-input-isolation',()=>{
  const supplied=structuredClone(three),before=structuredClone(supplied);const g=engine.createGame({events:supplied});g.chooseEra('confederation');g.answer('earlier','b');assert.deepEqual(supplied,before);
  assert.throws(()=>engine.createGame({events:[question('duplicate',1800),question('duplicate',1900)]}));
  const duplicateOption=question('duplicate-option',1800);duplicateOption.options[1].id='a';assert.throws(()=>engine.createGame({events:[duplicateOption]}));
  const missingCorrect=question('missing-correct',1800);missingCorrect.correctOptionID='missing';assert.throws(()=>engine.createGame({events:[missingCorrect]}));
 });
 await check('successful-mutations-revision',()=>{
  const g=engine.createGame({events:structuredClone(three)});assert.equal(g.snapshot().revision,0);
  let previous=0;for(const mutation of [()=>g.chooseEra('confederation'),()=>g.answer('earlier','b'),()=>g.restart(),()=>g.chooseEra('confederation')]){const returned=mutation();assert.equal(g.snapshot().revision,previous+1);assert.deepEqual(returned,g.snapshot());previous++;}
 });
 await check('snapshot-isolation',()=>{
  const g=make();const s=g.snapshot();s.score=999;s.answered.push({eventID:'fake'});s.currentEvent.options[0].text='mutated';s.mapEvents[0].title='mutated';
  const next=g.snapshot();assert.equal(next.score,0);assert.equal(next.answered.length,0);assert.notEqual(next.currentEvent.options[0].text,'mutated');assert.notEqual(next.mapEvents[0].title,'mutated');
 });
 await check('public-no-answer-keys',()=>{const g=make();safePublic(g.snapshot());g.answer('earlier','b');safePublic(g.snapshot());});
 await check('correct-score-streak',()=>{
  const g=make();g.answer('earlier','b');let s=g.snapshot();assert.equal(s.score,10);assert.equal(s.streak,1);assert.deepEqual(s.answered[0],{eventID:'earlier',optionID:'b',correct:true});
  g.answer('middle','b');s=g.snapshot();assert.equal(s.score,22);assert.equal(s.streak,2);
  g.answer('later','b');s=g.snapshot();assert.equal(s.score,36);assert.equal(s.streak,3);
 });
 await check('wrong-answer-reset',()=>{const g=make();g.answer('earlier','b');g.answer('middle','a');let s=g.snapshot();assert.equal(s.score,10);assert.equal(s.streak,0);assert.equal(s.feedback.correct,false);g.answer('later','b');assert.equal(g.snapshot().score,20);});
 await check('streak-bonus-cap',()=>{const g=make(five);const scores=[10,22,36,52,68];for(let i=0;i<5;i++){g.answer('cap-'+i,'b');assert.equal(g.snapshot().score,scores[i]);}});
 await check('reject-duplicate-answer',()=>{const g=make();g.answer('earlier','b');const before=g.snapshot();assert.throws(()=>g.answer('earlier','b'));assert.deepEqual(g.snapshot(),before);});
 await check('reject-out-of-order-answer',()=>{const g=make();const before=g.snapshot();assert.throws(()=>g.answer('later','b'));assert.deepEqual(g.snapshot(),before);});
 await check('reject-unknown-option',()=>{const g=make();const before=g.snapshot();assert.throws(()=>g.answer('earlier','missing'));assert.deepEqual(g.snapshot(),before);});
 await check('reject-unknown-era',()=>{const g=make();const before=g.snapshot();assert.throws(()=>g.chooseEra('imaginary'));assert.deepEqual(g.snapshot(),before);});
 await check('feedback-cites-source',()=>{const g=make();g.answer('earlier','a');const s=g.snapshot();assert.equal(s.currentEvent.id,'middle');assert.deepEqual(s.feedback,{eventID:'earlier',correct:false,explanation:three[1].explanation,source:three[1].source});});
 await check('completion-and-progress',()=>{const g=make();for(const id of ['earlier','middle','later'])g.answer(id,'b');const s=g.snapshot();assert.equal(s.phase,'complete');assert.equal(s.currentEvent,null);assert.deepEqual(s.progress,{answered:3,total:3});assert.equal(s.answered.length,3);assert.throws(()=>g.answer('later','a'));});
 await check('first-steps-after-wrong-answer',()=>{const g=make();assert.equal(milestone(g.snapshot(),'first-steps'),false);g.answer('earlier','a');assert.equal(milestone(g.snapshot(),'first-steps'),true);});
 await check('milestone-unlocks-sticky',()=>{
  const g=make(five);for(let i=0;i<3;i++)g.answer('cap-'+i,'b');assert.equal(milestone(g.snapshot(),'streak-three'),true);
  g.answer('cap-3','a');assert.equal(g.snapshot().streak,0);assert.equal(milestone(g.snapshot(),'streak-three'),true);assert.equal(milestone(g.snapshot(),'chapter-complete'),false);
  g.answer('cap-4','a');assert.equal(milestone(g.snapshot(),'chapter-complete'),true);
  const titles=Object.fromEntries(g.snapshot().milestones.map(m=>[m.id,m.title]));assert.equal(titles['first-steps'],'First Steps');assert.equal(titles['streak-three'],'Sharp Eye');assert.equal(titles['chapter-complete'],'Chapter Complete');
 });
 await check('restart-and-era-reset',()=>{
  const g=make([...three,question('early',1600,'early-contact')]);g.answer('earlier','b');const revision=g.snapshot().revision;g.restart();let s=g.snapshot();assert.equal(s.era,'confederation');assert.equal(s.currentEvent.id,'earlier');assert.equal(s.score,0);assert.equal(s.streak,0);assert.equal(s.feedback,null);assert.equal(s.answered.length,0);assert.ok(s.revision>revision);assert.ok(s.milestones.every(m=>m.unlocked===false));
  g.answer('earlier','b');g.chooseEra('early-contact');s=g.snapshot();assert.equal(s.currentEvent.id,'early');assert.deepEqual(s.progress,{answered:0,total:1});assert.equal(s.score,0);assert.ok(s.milestones.every(m=>m.unlocked===false));
 });
 await check('subscriptions-and-unsubscribe',()=>{const g=make();let calls=0;const revisions=[];const unsubscribe=g.subscribe(s=>{calls++;revisions.push(s.revision);});assert.equal(typeof unsubscribe,'function');g.answer('earlier','b');assert.ok(calls>=1);const count=calls;unsubscribe();g.answer('middle','b');assert.equal(calls,count);assert.ok(revisions.every(Number.isSafeInteger));});

 let server, serverReady=false;
 const httpNames=['http-state','http-answer','http-era-and-restart','http-reject-invalid-input','http-origin-boundary','http-body-bound','raw-data-private','sse-initial-update','ui-interactive-game'];
 await check('http-server-start',async()=>{server=await serverModule.createGameServer({events:structuredClone([...three,question('early',1600,'early-contact')]),host:'127.0.0.1',port:0});const url=new URL(server.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(typeof server.close,'function');serverReady=true;});
 if(serverReady){
  const json=async(path,method='GET',body,headers={})=>{const response=await fetch(new URL(path,server.url),{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(1200)});const value=await response.json();return {response,value:state(value)};};
  try {
   await check('http-state',async()=>{const r=await json('/state');assert.equal(r.response.status,200);assert.equal(r.value.era,'early-contact');assert.equal(r.value.currentEvent.id,'early');safePublic(r.value);});
   await check('http-answer',async()=>{await json('/era','POST',{era:'confederation'});const r=await json('/answer','POST',{eventID:'earlier',optionID:'b'});assert.equal(r.response.status,200);assert.equal(r.value.score,10);assert.equal(r.value.currentEvent.id,'middle');safePublic(r.value);});
   await check('http-era-and-restart',async()=>{let r=await json('/restart','POST',{});assert.equal(r.response.status,200);assert.equal(r.value.score,0);assert.equal(r.value.currentEvent.id,'earlier');r=await json('/era','POST',{era:'early-contact'});assert.equal(r.response.status,200);assert.equal(r.value.currentEvent.id,'early');});
   await check('http-reject-invalid-input',async()=>{
    const before=(await json('/state')).value;
    for(const body of [{eventID:'missing',optionID:'b'},{eventID:'early',optionID:'missing'},{}]){const r=await json('/answer','POST',body);assert.equal(r.response.status,400);}
    const malformed=await fetch(new URL('/answer',server.url),{method:'POST',headers:{'content-type':'application/json'},body:'{',signal:AbortSignal.timeout(1200)});assert.equal(malformed.status,400);await malformed.arrayBuffer();assert.deepEqual((await json('/state')).value,before);
   });
   await check('http-origin-boundary',async()=>{const before=(await json('/state')).value;const rejected=await json('/answer','POST',{eventID:'early',optionID:'b'},{origin:'https://foreign.invalid'});assert.equal(rejected.response.status,403);assert.deepEqual((await json('/state')).value,before);const accepted=await json('/restart','POST',{}, {origin:new URL(server.url).origin});assert.equal(accepted.response.status,200);});
   await check('http-body-bound',async()=>{const response=await fetch(new URL('/restart',server.url),{method:'POST',headers:{'content-type':'application/json'},body:'{}'+' '.repeat(70*1024),signal:AbortSignal.timeout(1200)});assert.ok([400,413].includes(response.status));await response.arrayBuffer();});
   await check('raw-data-private',async()=>{for(const path of ['/data/history.json','/data/../data/history.json','/engine.mjs']){const r=await fetch(new URL(path,server.url),{signal:AbortSignal.timeout(1200)});assert.equal(r.status,404);await r.arrayBuffer();}});
   await check('sse-initial-update',async()=>{
    const abort=new AbortController();let reader;let buffer='';
    const next=async()=>{
     while(true){const split=buffer.indexOf('\n\n');if(split>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)return state(JSON.parse(data));continue;}
      const chunk=await Promise.race([reader.read(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE deadline')),1000);timer.unref();})]);assert.equal(chunk.done,false);buffer+=new TextDecoder().decode(chunk.value).replaceAll('\r\n','\n');assert.ok(Buffer.byteLength(buffer)<64*1024);
     }
    };
    try {const response=await fetch(new URL('/events',server.url),{signal:abort.signal});assert.match(response.headers.get('content-type')??'',/text\/event-stream/);reader=response.body.getReader();const initial=await next();safePublic(initial);assert.equal(initial.era,'early-contact');const changed=await json('/era','POST',{era:'confederation'});assert.equal(changed.response.status,200);const update=await next();assert.equal(update.era,'confederation');assert.ok(update.revision>initial.revision);safePublic(update);}
    finally{abort.abort();await reader?.cancel().catch(()=>{});reader?.releaseLock();}
   });
   await check('ui-interactive-game',async()=>{const response=await fetch(new URL('/',server.url),{signal:AbortSignal.timeout(1200)});assert.equal(response.status,200);const html=await response.text();assert.match(html,/Canada/i);assert.match(html,/<button\b|createElement\(['"]button/);for(const term of ['EventSource','fetch','score','streak','era','map'])assert.ok(html.includes(term));assert.ok(!html.includes('correctOptionID'));assert.ok(!html.includes('Hidden explanation'));});
  } finally {await check('server-close',async()=>{await server.close();});}
 } else {for(const name of httpNames)checks.push({name,passed:false});if(server)await check('server-close',async()=>{await server.close();});else checks.push({name:'server-close',passed:false});}
 console.log(JSON.stringify({correct:checks.every(check=>check.passed),checks}));
}
`;

export async function verifyCanadaCrossroads(root, { expectedEvents, timeoutMs = 10_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError('invalid_verifier_deadline');
  if (expectedEvents === undefined) {
    try { expectedEvents = JSON.parse(await readFile(new URL('./canadian-history.json', import.meta.url), 'utf8')); }
    catch { return failure('content-integrity'); }
  }
  return await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, root], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
    });
    let output = '', bytes = 0, issue = null, resolved = false;
    const finish = value => { if (resolved) return; resolved = true; clearTimeout(timer); resolve(value); };
    const terminate = name => { issue ??= name; child.kill('SIGKILL'); };
    const timer = setTimeout(() => terminate('verifier-timeout'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) terminate('verifier-output-bound');
      else output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.once('error', () => finish(failure('verifier-execution')));
    child.once('close', code => {
      if (issue) return finish(failure(issue));
      if (code !== 0) return finish(failure('verifier-execution'));
      try {
        const value = JSON.parse(output.trim());
        if (!value || Object.keys(value).sort().join(',') !== 'checks,correct' || typeof value.correct !== 'boolean'
          || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > CASE_NAMES.size
          || new Set(value.checks.map(check => check.name)).size !== value.checks.length
          || value.checks.some(check => !check || Object.keys(check).sort().join(',') !== 'name,passed'
            || !CASE_NAMES.has(check.name) || typeof check.passed !== 'boolean')
          || value.correct !== value.checks.every(check => check.passed)) return finish(failure('verifier-output-invalid'));
        finish(value);
      } catch { finish(failure('verifier-output-invalid')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ expectedEvents }));
  });
}

export const verifyGangCode = verifyCanadaCrossroads;
