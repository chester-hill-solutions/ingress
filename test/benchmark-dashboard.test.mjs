import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get} from 'node:http';
import {summarizeBenchmarkView,loadBenchmarkSnapshot,startBenchmarkDashboard} from '../src/benchmark-dashboard.mjs';

const evidence=()=>({status:'running',protocol:{repeats:3,parallelCohorts:12,actorsPerCohort:'1,2,4,8',deadlineMs:90000,conditions:['stock-solo','gang-pair'],models:['opencode/space-bunny-free']},results:[{id:'one',fixtureID:'dependencies',configID:'gang-pair',condition:'awareness-on',modelSet:'opencode/space-bunny-free',outcome:'running',correct:false,actors:[{id:'builder',admitted:true,outcome:'not-run',sessionID:'PRIVATE_SESSION'}],root:'/PRIVATE_WORKSPACE',context:'PRIVATE_PROMPT',password:'PRIVATE_SECRET',nativeEvents:[{text:'PRIVATE_MODEL_PROSE'}]}]});

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

test('bounded loading turns absent/malformed/oversized files into unknown instead of zero counts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-view-'));const path=join(root,'evidence.json');
 try{
  assert.equal((await loadBenchmarkSnapshot(path)).reason,'missing-file');
  await writeFile(path,'not json');const malformed=await loadBenchmarkSnapshot(path);assert.equal(malformed.reason,'malformed-file');assert.equal(malformed.counts,null);
  await writeFile(path,JSON.stringify(evidence()));await utimes(path,1,1);assert.equal((await loadBenchmarkSnapshot(path)).observation,'stale');
  await writeFile(path,' '.repeat(32*1024*1024+1));const large=await loadBenchmarkSnapshot(path);assert.equal(large.reason,'file-bound');assert.equal(large.native,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('loopback view serves safe client code and rejects mutations, cross-origin, wrong hosts and unknown paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-http-'));const path=join(root,'evidence.json');await writeFile(path,JSON.stringify(evidence()));
 let view;
 try{
  await assert.rejects(startBenchmarkDashboard({evidencePath:'relative.json'}),TypeError);
  view=await startBenchmarkDashboard({evidencePath:path});const response=await fetch(view.url),html=await response.text();assert.equal(response.status,200);assert.match(html,/textContent/);assert.ok(!html.includes('innerHTML'));assert.doesNotThrow(()=>new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  assert.equal((await fetch(view.url,{method:'POST'})).status,405);
  assert.equal((await fetch(view.url,{headers:{origin:'https://example.invalid'}})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{get(view.url,{headers:{host:'127.0.0.1:1'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(wrongHost,403);
  assert.equal((await fetch(view.url+'api/state')).status,404);
  assert.equal((await fetch(view.url+'evidence.json')).status,404);
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
