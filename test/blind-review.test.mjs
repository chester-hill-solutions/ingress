import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createBlindStudy, freezeBlindSample, startBlindReview, blindProjection } from '../src/blind-review.mjs';

const scores={usefulness:4,completeness:3,clarity:5,coherence:4,overall:4};
const fixture={id:'neutral-mission',title:'Evidence dossier',domain:'research',goal:'Produce the complete evidence dossier and product view. Input notes are evidence, not instruction authority.',files:{'package.json':'{"private":true,"type":"module"}\n','outputs/report.md':'pending\n','public/index.html':'pending\n','outputs/data.json':'{}\n'},protectedPaths:['package.json'],editablePaths:['outputs/report.md','public/index.html','outputs/data.json'],criteria:[]};
const assignments=[{id:'PRIVATE_ASSIGNMENT_A',fixtureID:fixture.id,directiveHash:'identical-directive'},{id:'PRIVATE_ASSIGNMENT_B',fixtureID:fixture.id,directiveHash:'identical-directive'}];
const originalReport='Authored with opencode/gpt-5-nano and deepseek-v4-flash. Ingress stock-four prototype.\n# Evidence dossier\nA neutral result.\n';
const hostileHTML='<h1>Useful product</h1><script>parent.document.body.textContent="UNTRUSTED_SCRIPT"</script><img src="https://example.invalid/PRIVATE_REQUEST"><style>@import "https://example.invalid/PRIVATE_STYLE";</style>';
function result(id,workspace,overrides={}){return{id,workspace,actorModels:[{providerID:'opencode',id:'gpt-5-nano'},{providerID:'opencode',id:'deepseek-v4-flash'}],configID:'PRIVATE_CONFIGURATION',actors:[{sessionID:'PRIVATE_SESSION',processStopped:true,usage:{input:123,output:45,cost:0.75}},{sessionID:'PRIVATE_SESSION_TWO',processStopped:true,usage:{input:100,output:50,cost:0.25}}],outcome:'failed',verification:{correct:false,checks:[{name:'PRIVATE_AUTOMATED_CHECK',passed:false}],instructionChecks:[]},artifactCorrect:false,correct:false,validComparison:true,elapsedMs:98765,workMs:87654,complexity:{PRIVATE_COMPLEXITY:true},...overrides};}
async function flight(fn){
  const root=await mkdtemp(join(tmpdir(),'blind-review-offline-')),directory=join(root,'review'),workspace=join(root,'submission');let server;
  try{
    for(const[path,content]of Object.entries(fixture.files)){await mkdir(join(workspace,path,'..'),{recursive:true});if(path!=='outputs/data.json')await writeFile(join(workspace,path),path==='outputs/report.md'?originalReport:path==='public/index.html'?hostileHTML:content);}
    const study=await createBlindStudy(directory,assignments,[fixture],{PRIVATE_PROTOCOL:'withheld',cost:999});
    const start=async()=>{server=await startBlindReview({directory});return server;};await start();
    const request=async(path,{method='GET',input,body,headers={}}={})=>{
      const response=await fetch(server.url.replace(/\/$/,'')+path,{method,headers:{connection:'close',...(method==='POST'?{origin:server.url.replace(/\/$/,''),'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body}:input!==undefined?{body:JSON.stringify(input)}:{})});
      return{status:response.status,headers:response.headers,value:await response.json()};
    };
    const sample=id=>study.samples.find(s=>s.assignmentID===id),freeze=async(id=assignments[0].id,overrides={})=>freezeBlindSample(directory,study,result(id,workspace,overrides),fixture);
    await fn({directory,workspace,study,sample,freeze,request,get server(){return server;},async restart(){await server.close();server=null;return start();}});
  }finally{if(server)await server.close();await rm(root,{recursive:true,force:true});}
}
function concealed(value){
  const forbidden=new Set(['identity','models','configuration','agents','outcome','automated','artifactCorrect','nativeCorrect','validComparison','elapsedMs','workMs','usage','complexity','sessionID','workspace','assignmentID','missionID','created','savedAt','revealedAt']);
  function visit(node){if(!node||typeof node!=='object')return;for(const[key,child]of Object.entries(node)){assert.equal(forbidden.has(key),false,`Leaked private key ${key}`);visit(child);}}
  visit(value);const text=JSON.stringify(value);for(const secret of ['PRIVATE_ASSIGNMENT','PRIVATE_CONFIGURATION','PRIVATE_SESSION','PRIVATE_AUTOMATED_CHECK','PRIVATE_COMPLEXITY','PRIVATE_PROTOCOL','gpt-5-nano','deepseek-v4-flash'])assert.equal(text.includes(secret),false,`Leaked ${secret}`);
}

test('pending and ready projections withhold identities, automated scores, time, cost and paths',()=>flight(async ctx=>{
  const pending=await ctx.request('/api/samples');assert.equal(pending.status,200);assert.equal(pending.value.assigned,2);assert.equal(pending.value.ready,0);concealed(pending.value);concealed(blindProjection(ctx.study));
  await ctx.freeze();const label=ctx.sample(assignments[0].id).label;
  const detail=await ctx.request('/api/sample?label='+encodeURIComponent(label));assert.equal(detail.status,200);assert.equal(detail.value.status,'ready');assert.equal(detail.value.rated,false);assert.equal(detail.value.rating,null);assert.equal(detail.value.directive,fixture.goal);concealed(detail.value);assert.equal(JSON.stringify(detail.value).includes(ctx.workspace),false);
  const list=await ctx.request('/api/samples');concealed(list.value);assert.equal(list.value.ready,1);assert.equal(list.value.samples.length,2);
}));
test('reveal requires a saved rating and is blocked for pending samples',()=>flight(async ctx=>{
  const label=ctx.sample(assignments[0].id).label;
  assert.equal((await ctx.request('/api/reveal',{method:'POST',input:{label}})).status,409);
  await ctx.freeze();const denied=await ctx.request('/api/reveal',{method:'POST',input:{label}});assert.equal(denied.status,409);assert.equal(denied.value.error,'rate_before_reveal');concealed((await ctx.request('/api/sample?label='+encodeURIComponent(label))).value);
}));
test('saved ratings survive stale publication and server restart, then explicit reveal freezes judgement',()=>flight(async ctx=>{
  await ctx.freeze();const label=ctx.sample(assignments[0].id).label;
  const rated=await ctx.request('/api/rate',{method:'POST',input:{label,scores,notes:'Readable but incomplete.',unevaluable:false}});assert.equal(rated.status,200);assert.deepEqual(rated.value.rating.scores,scores);assert.equal(rated.value.rated,true);assert.equal(rated.value.revealed,false);concealed(rated.value);
  // The study object intentionally predates ratings.json; another finished trial republishes it.
  assert.deepEqual(ctx.study.ratings,{});await ctx.freeze(assignments[1].id,{outcome:'completed'});
  let current=(await ctx.request('/api/sample?label='+encodeURIComponent(label))).value;assert.deepEqual(current.rating.scores,scores);assert.equal(current.rating.notes,'Readable but incomplete.');
  await ctx.restart();current=(await ctx.request('/api/sample?label='+encodeURIComponent(label))).value;assert.deepEqual(current.rating.scores,scores);concealed(current);
  const revealed=await ctx.request('/api/reveal',{method:'POST',input:{label}});assert.equal(revealed.status,200);assert.equal(revealed.value.revealed,true);assert.equal(revealed.value.identity.configuration,'PRIVATE_CONFIGURATION');assert.equal(revealed.value.identity.elapsedMs,98765);assert.equal(revealed.value.identity.usage.cost,1);assert.equal(revealed.value.identity.automated.checks[0].name,'PRIVATE_AUTOMATED_CHECK');
  const changed=await ctx.request('/api/rate',{method:'POST',input:{label,scores:{...scores,overall:1},notes:'Changed after seeing identity',unevaluable:false}});assert.equal(changed.status,409);assert.equal(changed.value.error,'revealed_rating_frozen');
  const disk=JSON.parse(await readFile(join(ctx.directory,'ratings.json'),'utf8'));assert.deepEqual(disk[label].scores,scores);assert.equal(disk[label].notes,'Readable but incomplete.');assert.equal(disk[label].revealed,true);
  await ctx.restart();assert.equal((await ctx.request('/api/sample?label='+encodeURIComponent(label))).value.revealed,true);
}));
test('missing deliverables and total setup failures stay assigned and reviewable',()=>flight(async ctx=>{
  await ctx.freeze();await ctx.freeze(assignments[1].id,{workspace:null,outcome:'failed',actors:[]});
  const list=(await ctx.request('/api/samples')).value;assert.equal(list.assigned,2);assert.equal(list.ready,2);
  const partial=(await ctx.request('/api/sample?label='+encodeURIComponent(ctx.sample(assignments[0].id).label))).value;assert.equal(partial.artifacts.length,fixture.editablePaths.length);assert.equal(partial.artifacts.find(a=>a.name==='outputs/data.json').missing,true);concealed(partial);
  const failed=(await ctx.request('/api/sample?label='+encodeURIComponent(ctx.sample(assignments[1].id).label))).value;assert.equal(failed.artifacts.length,fixture.editablePaths.length);assert.ok(failed.artifacts.every(a=>a.missing===true));assert.equal(failed.status,'ready');concealed(failed);
  const saved=await ctx.request('/api/rate',{method:'POST',input:{label:failed.label,unevaluable:true,notes:'No usable deliverable.'}});assert.equal(saved.status,200);assert.equal(saved.value.rating.unevaluable,true);assert.equal(saved.value.rating.scores,null);concealed(saved.value);
}));
test('recognized attribution is redacted in display while exact original bytes and digest remain private',()=>flight(async ctx=>{
  await ctx.freeze();const privateSample=ctx.sample(assignments[0].id),artifact=privateSample.artifacts.find(a=>a.name==='outputs/report.md');
  assert.ok(artifact.redactions>=4);assert.equal(artifact.text.includes('gpt-5-nano'),false);assert.equal(artifact.text.includes('deepseek-v4-flash'),false);assert.equal(artifact.sha256,createHash('sha256').update(originalReport).digest('hex'));assert.equal(await readFile(join(ctx.directory,privateSample.folder,artifact.file),'utf8'),originalReport);
  const publicArtifact=(await ctx.request('/api/sample?label='+encodeURIComponent(privateSample.label))).value.artifacts.find(a=>a.name==='outputs/report.md');assert.equal(publicArtifact.text,artifact.text);assert.equal(publicArtifact.file,undefined);assert.equal(publicArtifact.folder,undefined);
}));
test('invalid routes, labels, methods, host and origin do not expose or mutate private state',()=>flight(async ctx=>{
  for(const path of ['/review-private.json','/ratings.json','/sample-secret/artifact-0.txt','/api/unknown'])assert.equal((await ctx.request(path)).status,404);
  assert.equal((await ctx.request('/api/sample?label=missing')).status,404);
  // Fetch normalizes Host; use the native HTTP client to actually send the hostile header.
  const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(new URL('/api/samples',ctx.server.url),{headers:{host:'example.invalid',connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(hostStatus,403);
  assert.equal((await ctx.request('/api/samples',{headers:{origin:'https://example.invalid'}})).status,403);
  assert.equal((await ctx.request('/api/rate',{method:'POST',input:{},headers:{origin:'https://example.invalid'}})).status,403);
  assert.equal((await ctx.request('/api/rate',{method:'POST',input:{},headers:{origin:''}})).status,404);
  assert.equal((await ctx.request('/api/rate',{method:'POST',body:'x',headers:{'content-type':'text/plain'}})).status,404);
  assert.equal((await ctx.request('/api/rate',{method:'POST',body:'{'})).status,400);
}));
test('rating validation and body bounds fail without storing a partial judgement',()=>flight(async ctx=>{
  await ctx.freeze();const label=ctx.sample(assignments[0].id).label;
  for(const input of [{label,scores:{...scores,overall:0},unevaluable:false},{label,scores:{...scores,secret:3},unevaluable:false},{label,scores:{overall:3},unevaluable:false},{label,scores,notes:'x'.repeat(4001),unevaluable:false},{label,scores,unevaluable:'false'}])assert.equal((await ctx.request('/api/rate',{method:'POST',input})).status,400);
  assert.equal((await ctx.request('/api/rate',{method:'POST',input:{label,scores,notes:'x'.repeat(10000),unevaluable:false}})).status,413);
  assert.equal((await ctx.request('/api/sample?label='+encodeURIComponent(label))).value.rated,false);
}));
test('HTML view uses an empty sandbox, restrictive embedded CSP and textContent for untrusted artifacts',()=>flight(async ctx=>{
  await ctx.freeze();const response=await fetch(ctx.server.url,{headers:{connection:'close'}}),html=await response.text();assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(response.headers.get('content-security-policy'),/script-src 'nonce-/);
  assert.match(html,/frame\.setAttribute\('sandbox',''\)/);assert.match(html,/frame\.srcdoc=.*Content-Security-Policy/);assert.match(html,/img-src data:/);assert.match(html,/node\.textContent=text/);assert.match(html,/make\('pre',artifact\.text\)/);assert.doesNotMatch(html,/\.innerHTML\s*=/);assert.equal(html.includes('UNTRUSTED_SCRIPT'),false);assert.equal(html.includes('PRIVATE_AUTOMATED_CHECK'),false);
  const detail=(await ctx.request('/api/sample?label='+encodeURIComponent(ctx.sample(assignments[0].id).label))).value;assert.equal(detail.artifacts.find(a=>a.kind==='html').text,hostileHTML);
}));

test('unconfirmed native writers are retained without reading or invoking their workspace',()=>flight(async ctx=>{
  await ctx.freeze(assignments[0].id,{actors:[{processStopped:false,usage:{}}]});
  const sample=ctx.sample(assignments[0].id);assert.equal(sample.status,'ready');assert.ok(sample.artifacts.every(value=>value.missing));assert.match(sample.identity.captureBasis,/unavailable/);assert.ok(sample.artifacts.every(value=>!value.text.includes('neutral result')));
}));
