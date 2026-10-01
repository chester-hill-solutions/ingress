import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get} from 'node:http';
import {summarizeBenchmarkView,loadBenchmarkSnapshot,startBenchmarkDashboard} from '../src/benchmark-dashboard.mjs';

const evidence=()=>({status:'running',protocol:{repeats:3,parallelCohorts:12,actorsPerCohort:'1,2,4,8',deadlineMs:90000,conditions:['stock-solo','ingress-pair'],models:['opencode/space-bunny-free']},results:[{id:'one',fixtureID:'dependencies',configID:'ingress-pair',condition:'awareness-on',modelSet:'opencode/space-bunny-free',outcome:'running',correct:false,actors:[{id:'builder',admitted:true,outcome:'not-run',sessionID:'PRIVATE_SESSION'}],root:'/PRIVATE_WORKSPACE',context:'PRIVATE_PROMPT',password:'PRIVATE_SECRET',nativeEvents:[{text:'PRIVATE_MODEL_PROSE'}]}]});

test('projection exposes recorded counts while withholding contexts, paths, credentials and sessions',()=>{
 const snapshot=summarizeBenchmarkView(evidence(),{now:1100,modifiedAt:1000});
 assert.equal(snapshot.observation,'fresh');assert.equal(snapshot.counts.assigned,1);assert.equal(snapshot.counts.running,1);
 assert.equal(snapshot.native.admitted,1);assert.equal(snapshot.native.currentRunning,null);
 assert.equal(snapshot.latest[0].correct,null);assert.equal(snapshot.latest[0].artifactCorrect,null);
 assert.equal(snapshot.configurations[0].assigned,1);
 for(const secret of ['PRIVATE_SESSION','PRIVATE_WORKSPACE','PRIVATE_PROMPT','PRIVATE_SECRET','PRIVATE_MODEL_PROSE'])assert.ok(!JSON.stringify(snapshot).includes(secret));
 const stale=summarizeBenchmarkView(evidence(),{now:20000,modifiedAt:1000});assert.equal(stale.observation,'stale');assert.equal(stale.reason,'no-recent-evidence-write');
 const bad=summarizeBenchmarkView({results:null});assert.equal(bad.observation,'unknown');assert.equal(bad.counts,null);
 const observed=evidence();observed.results[0].executionConcurrency={currentRunning:1};assert.equal(summarizeBenchmarkView(observed).native.currentRunning,1);
});

test('missing evidence stays unknown; recorded zero and running native metadata stay distinct',()=>{
 const missing=summarizeBenchmarkView(null);assert.equal(missing.counts,null);assert.equal(missing.native,null);assert.equal(missing.lifecycle,'unknown');
 const zero=evidence();zero.status='assigned';zero.results=[];const assigned=summarizeBenchmarkView(zero,{modifiedAt:1000,now:1000});assert.equal(assigned.counts.assigned,0);assert.equal(assigned.counts.settled,0);assert.equal(assigned.native.assigned,0);assert.equal(assigned.native.currentRunning,null);assert.equal(assigned.lifecycle,'assigned');
 const running=evidence();running.results[0].executionConcurrency={currentRunning:0};const observed=summarizeBenchmarkView(running,{modifiedAt:1000,now:1000});assert.equal(observed.native.currentRunning,0);assert.equal(observed.lifecycle,'active');assert.equal(observed.counts.running,1);assert.equal(observed.counts.settled,0);
});

test('safe role/model allocation and context capacities preserve zero without exposing actor private fields',()=>{
 const value=evidence(),row=value.results[0];row.nativePlugin=true;row.contextBytes=8192;row.cacheIntervalMs=500;
 row.actors=[{id:'builder',role:'Builder',model:{providerID:'opencode',id:'space-bunny-free'},outcome:'succeeded',admitted:true,context:{maxBytes:4096,text:'PRIVATE_PROMPT'},sessionID:'PRIVATE_SESSION'},{id:'reviewer',role:'Reviewer',model:{providerID:'opencode',id:'deepseek-v4-flash'},outcome:'not-run',admitted:false}];row.modelSet='opencode/deepseek-v4-flash+opencode/space-bunny-free';
 const snapshot=summarizeBenchmarkView(value),latest=snapshot.latest[0];
 assert.deepEqual(latest.actorBrief.map(actor=>[actor.id,actor.role,actor.modelLabel]),[['builder','Builder','Space Bunny'],['reviewer','Reviewer','DeepSeek V4 Flash']]);
 assert.equal(latest.actorBrief[1].contextObservedBytes,null);assert.equal(latest.context.observedMaxBytes,4096);assert.equal(latest.context.budgetBytes,8192);assert.equal(latest.context.cacheIntervalMs,500);assert.equal(latest.title,'Ingress · two specialists');
 row.contextBytes=0;row.cacheIntervalMs=0;row.nativePlugin=false;const stock=summarizeBenchmarkView(value).latest[0];assert.equal(stock.context.budgetBytes,0);assert.equal(stock.context.cacheIntervalMs,0);assert.equal(stock.context.enabled,false);
 assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
});

test('scope, tool obedience and required behavior remain separate; unavailable observations are unknown',()=>{
 const value=evidence(),row=value.results[0];row.outcome='completed';row.verification={correct:true,instructionChecks:[{name:'protected:/PRIVATE_WORKSPACE',passed:true},{name:'declared_files_regular_confined_bounded',passed:true},{name:'no_observed_protected_write_attempts',passed:false},{name:'no_observed_forbidden_tool_attempts',passed:false},{name:'required_behavior:core-api',passed:false}]};row.correct=false;
 const first=summarizeBenchmarkView(value,{modifiedAt:1000,now:1000});assert.equal(first.counts.checking,1);assert.equal(first.counts.settled,0);assert.equal(first.counts.artifactCorrect,1);assert.equal(first.counts.correctCompleted,0);
 assert.equal(first.complianceGroups.scope.passed,2);assert.equal(first.complianceGroups.scope.unknown,1);assert.equal(first.complianceGroups.tools.unknown,1);assert.equal(first.complianceGroups.tools.failed,0);assert.equal(first.complianceGroups.requiredBehavior.failed,1);
 row.sourceCoverage='live-no-replay';row.ended='2026-09-29T12:00:00Z';const final=summarizeBenchmarkView(value);assert.equal(final.counts.settled,1);assert.equal(final.complianceGroups.tools.failed,1);assert.equal(final.configurations[0].settled,1);assert.equal(final.latest[0].complianceGroups.requiredBehavior.failed,1);assert.ok(!JSON.stringify(final).includes('PRIVATE_WORKSPACE'));
 value.status='complete';const aged=summarizeBenchmarkView(value,{now:20000,modifiedAt:1000});assert.equal(aged.lifecycle,'settled');assert.equal(aged.observation,'stale','data age remains separate from recorded final lifecycle');
});

test('unknown write targets are uncertainty; explicitly recorded scope violations remain failed',()=>{
 const value=evidence(),row=value.results[0];row.sourceCoverage='live-no-replay';row.writeTargetCoverage='incomplete';row.verification={correct:false,instructionChecks:[{name:'no_observed_protected_write_attempts',passed:false}]};row.actors[0].unknownWriteAttempts=2;
 const uncertain=summarizeBenchmarkView(value).complianceGroups.scope;assert.equal(uncertain.unknown,1);assert.equal(uncertain.failed,0);
 row.actors[0].protectedWriteAttempts=1;const violation=summarizeBenchmarkView(value).complianceGroups.scope;assert.equal(violation.unknown,0);assert.equal(violation.failed,1);
 assert.equal(row.verification.instructionChecks[0].passed,false,'presentation never changes the runner grade');
});

test('bounded loading turns absent/malformed/oversized files into unknown instead of zero counts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-view-'));const path=join(root,'evidence.json');
 try{
  assert.equal((await loadBenchmarkSnapshot(path)).reason,'missing-file');
  await writeFile(path,'not json');const malformed=await loadBenchmarkSnapshot(path);assert.equal(malformed.reason,'malformed-file');assert.equal(malformed.counts,null);
  await writeFile(path,JSON.stringify(evidence()));await utimes(path,1,1);assert.equal((await loadBenchmarkSnapshot(path)).observation,'stale');
  const cache={};const cached=await loadBenchmarkSnapshot(path,{now:1000},cache);assert.equal(cached.observation,'fresh');const aged=await loadBenchmarkSnapshot(path,{now:20000},cache);assert.equal(aged.observation,'stale');assert.deepEqual(cached.counts,aged.counts);
  await writeFile(path,'not json');assert.equal((await loadBenchmarkSnapshot(path,{},cache)).reason,'malformed-file','invalid updated evidence never reuses historical counts');
  await writeFile(path,' '.repeat(32*1024*1024+1));const large=await loadBenchmarkSnapshot(path);assert.equal(large.reason,'file-bound');assert.equal(large.native,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('loopback view serves safe client code and rejects mutations, cross-origin, wrong hosts and unknown paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-http-'));const path=join(root,'evidence.json');await writeFile(path,JSON.stringify(evidence()));
 let view;
 try{
  await assert.rejects(startBenchmarkDashboard({evidencePath:'relative.json'}),TypeError);
  await assert.rejects(startBenchmarkDashboard({evidencePath:path,port:-1}),RangeError);
  await assert.rejects(startBenchmarkDashboard({evidencePath:path,port:65536}),RangeError);
  view=await startBenchmarkDashboard({evidencePath:path});const response=await fetch(view.url),html=await response.text();assert.equal(response.status,200);assert.match(html,/textContent/);assert.ok(!html.includes('innerHTML'));assert.doesNotThrow(()=>new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  assert.equal((await fetch(view.url,{method:'POST'})).status,405);
  assert.equal((await fetch(view.url,{headers:{origin:'https://example.invalid'}})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{get(view.url,{headers:{host:'127.0.0.1:1'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(wrongHost,403);
  assert.equal((await fetch(view.url+'api/state')).status,404);
  assert.equal((await fetch(view.url+'evidence.json')).status,404);
  const port=Number(new URL(view.url).port);await view.close();view=await startBenchmarkDashboard({evidencePath:path,port});assert.equal(Number(new URL(view.url).port),port);assert.equal((await fetch(view.url)).status,200);
 }finally{await view?.close();await rm(root,{recursive:true,force:true});}
});

test('SSE supplies initial state, skips unchanged polls and publishes only sanitized changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-sse-'));const path=join(root,'evidence.json');const value=evidence();await writeFile(path,JSON.stringify(value));const view=await startBenchmarkDashboard({evidencePath:path});const abort=new AbortController();let reader;
 try{
  const response=await fetch(view.url+'events',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(6000)])});reader=response.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/"evidenceStatus":"running"/);assert.ok(!first.includes('PRIVATE_'));
  let arrived=false;const next=reader.read().then(result=>{arrived=true;return result;});await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(arrived,false,'unchanged polling does not emit another event');
  value.status='cancelled';value.results[0].outcome='cancelled';await writeFile(path,JSON.stringify(value));const changed=new TextDecoder().decode((await next).value);assert.match(changed,/"evidenceStatus":"cancelled"/);assert.ok(!changed.includes('PRIVATE_'));
 }finally{abort.abort();await reader?.cancel().catch(()=>{});await view.close();await view.close();await rm(root,{recursive:true,force:true});}
});

test('large snapshots survive several updates on the same SSE connection despite write backpressure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-large-sse-'));const path=join(root,'evidence.json'),value=evidence();
 value.results=Array.from({length:32},(_,index)=>({id:'cohort-'+index,fixtureID:'fixture',configID:'ingress-config-'+index,condition:'awareness-on',modelSet:'opencode/'+('model-'.repeat(12)),outcome:'running',actors:Array.from({length:8},(_,actor)=>({id:'actor-'+actor+'-'+('x'.repeat(60)),role:'Builder '+('focus '.repeat(12)),model:{providerID:'opencode',id:'model-'.repeat(12)},outcome:'not-run',admitted:true,context:{maxBytes:8000}}))}));
 const bytes=Buffer.byteLength(JSON.stringify(summarizeBenchmarkView(value,{modifiedAt:Date.now()})));assert.ok(bytes>64*1024,`fixture payload ${bytes} exceeds normal HTTP write highWaterMark`);assert.ok(bytes<256*1024);
 await writeFile(path,JSON.stringify(value));const view=await startBenchmarkDashboard({evidencePath:path}),abort=new AbortController();let reader,buffer='';
 const frame=async()=>{for(;;){const end=buffer.indexOf('\n\n');if(end>=0){const data=buffer.slice(0,end);buffer=buffer.slice(end+2);return JSON.parse(data.slice(6));}const chunk=await reader.read();assert.equal(chunk.done,false,'the original SSE connection must remain open');buffer+=new TextDecoder().decode(chunk.value);}};
 try{
  const response=await fetch(view.url+'events',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});reader=response.body.getReader();assert.equal((await frame()).counts.assigned,32);
  for(let change=1;change<=3;change++){value.results[0].elapsedMs=change*1000;await writeFile(path,JSON.stringify(value));const snapshot=await frame();assert.equal(snapshot.latest.find(row=>row.id==='cohort-0').elapsedMs,change*1000);}
 }finally{abort.abort();await reader?.cancel().catch(()=>{});await view.close();await rm(root,{recursive:true,force:true});}
});
