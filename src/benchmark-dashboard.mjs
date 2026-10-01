import {createServer} from 'node:http';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {summarizeBenchmarks} from './benchmark-report.mjs';
import {dashboardHTML} from './benchmark-dashboard-ui.mjs';

const FILE_LIMIT=32*1024*1024,VIEW_LIMIT=256*1024,ROW_LIMIT=4096;
const numeric=value=>Number.isFinite(value)&&value>=0?value:null;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/+,-]{0,180}$/.test(value)?value:'unknown';
const outcomes=new Set(['not-run','running','completed','deadline','failed','cancelled']);
const statuses=new Set(['assigned','running','complete','completed','failed','cancelled']);
const bool=value=>typeof value==='boolean'?value:null;
const unknown=reason=>({version:2,observation:'unknown',reason,evidenceStatus:'unknown',lifecycle:'unknown',modifiedAt:null,protocol:null,counts:null,native:null,complianceGroups:null,configurations:[],latest:[],omittedConfigurations:null,omittedCohorts:null});
const models=value=>typeof value==='string'?value.split('+').slice(0,16).map(identifier):[];
const finalStatuses=new Set(['complete','completed','failed','cancelled']);
const terminalOutcomes=new Set(['completed','deadline','failed','cancelled']);
const actorOutcomes=new Set(['not-run','running','succeeded','failed','interrupted','setup-failed','runtime-failed','deadline-or-cancel']);
const titles={'stock-solo':'Stock · one builder','stock-parallel-pair':'Stock · two concurrent specialists','ingress-pair':'Ingress · two specialists','ingress-four':'Ingress · four concurrent roles','ingress-eight':'Ingress · eight concurrent roles','builder-reviewer':'Ingress · builder then reviewer','ingress-pair-small-context':'Ingress · 8 KiB context','ingress-pair-slow-updates':'Ingress · 500 ms context refresh','mixed-pair':'Ingress · mixed models'};
const modelNames={'space-bunny-free':'Space Bunny','big-pickle':'Big Pickle','mimo-v2.6-flash-free':'MiMo V2.6 Flash','gpt-5-nano':'GPT-5 Nano','deepseek-v3.2-free':'DeepSeek V3.2 Free','deepseek-v4-flash':'DeepSeek V4 Flash'};
const modelLabel=id=>modelNames[id.split('/').at(-1)]??id;
const title=id=>titles[id]??id;
const roleLabel=value=>typeof value==='string'&&/^[A-Za-z0-9 _/()+,.:\-]{1,96}$/.test(value)?value:'unknown';
const settled=(row,evidence)=>terminalOutcomes.has(row.outcome)&&(finalStatuses.has(evidence.status)||Number.isFinite(Date.parse(row.ended))||(numeric(row.verificationMs)!==null&&numeric(row.elapsedMs)!==null));
const modelID=actor=>typeof actor.modelID==='string'?identifier(actor.modelID):typeof actor.model==='string'?identifier(actor.model):typeof actor.model?.id==='string'&&typeof actor.model.providerID==='string'?identifier(actor.model.providerID+'/'+actor.model.id):'unknown';

function complianceGroups(rows){
 const groups=Object.fromEntries(['scope','tools','requiredBehavior','other'].map(key=>[key,{passed:0,total:0,failed:0,unknown:0,confidence:'unknown'}]));
 for(const row of rows)for(const check of Array.isArray(row.verification?.instructionChecks)?row.verification.instructionChecks:[]){
  const name=typeof check?.name==='string'?check.name:'';
  const key=name.startsWith('required_behavior:')?'requiredBehavior':name==='no_observed_forbidden_tool_attempts'?'tools':name.startsWith('protected:')||['declared_files_regular_confined_bounded','no_observed_protected_write_attempts'].includes(name)?'scope':'other';
  const group=groups[key];group.total++;
  const scopeAttempt=name==='no_observed_protected_write_attempts',toolAttempt=name==='no_observed_forbidden_tool_attempts';
  const knownViolation=row.actors.some(actor=>scopeAttempt?(numeric(actor.protectedWriteAttempts)??0)>0||(numeric(actor.externalWriteAttempts)??0)>0:toolAttempt&&(numeric(actor.forbiddenToolAttempts)??0)>0);
  const unknownTargetOnly=scopeAttempt&&row.writeTargetCoverage==='incomplete'&&row.actors.some(actor=>(numeric(actor.unknownWriteAttempts)??0)>0)&&!knownViolation;
  const uncertain=typeof check?.passed!=='boolean'||!knownViolation&&(check?.confidence==='unknown'||unknownTargetOnly||name.startsWith('no_observed_')&&(row.sourceCoverage!=='live-no-replay'||numeric(row.nativeEventOmissions??0)!==0));
  if(uncertain)group.unknown++;else if(check.passed)group.passed++;else group.failed++;
 }
 for(const group of Object.values(groups))group.confidence=!group.total||group.unknown===group.total?'unknown':group.unknown?'partial':'observed';
 return groups;
}

/** Projection only: provider prose, source, contexts, paths and session IDs never enter it. */
export function summarizeBenchmarkView(evidence,{modifiedAt=null,now=Date.now(),staleAfterMs=10000}={}){
 if(!evidence||!Array.isArray(evidence.results)||evidence.results.length>ROW_LIMIT||evidence.results.some(row=>!row||typeof row.fixtureID!=='string'||(typeof row.configID!=='string'&&typeof row.condition!=='string')||!Array.isArray(row.actors)||row.actors.length>64||row.actors.some(actor=>!actor||typeof actor!=='object')))return unknown('invalid-shape');
 const results=evidence.results,summary=summarizeBenchmarks(results),protocol=evidence.protocol??{},actorCount=results.reduce((n,row)=>n+row.actors.length,0);
 const observation=numeric(modifiedAt)===null?'unknown':now-modifiedAt>staleAfterMs?'stale':'fresh';
 const counts={assigned:results.length,settled:0,checking:0,running:0,completed:0,deadline:0,failed:0,cancelled:0,notRun:0,unknownOutcome:0,artifactCorrect:0,correctCompleted:0};
 for(const row of results){const key=row.outcome==='not-run'?'notRun':outcomes.has(row.outcome)?row.outcome:'unknownOutcome';counts[key]++;if(settled(row,evidence))counts.settled++;else if(terminalOutcomes.has(row.outcome))counts.checking++;const verified=typeof row.verification?.correct==='boolean'?row.verification.correct:row.artifactCorrect;if(row.outcome!=='not-run'&&row.outcome!=='running'&&verified===true)counts.artifactCorrect++;if(row.outcome==='completed'&&row.correct===true)counts.correctCompleted++;}
 const actors=results.flatMap(row=>row.actors),running=results.filter(row=>row.outcome==='running');
 const native={assigned:actorCount,admitted:actors.filter(actor=>actor.admitted===true).length,succeeded:actors.filter(actor=>actor.outcome==='succeeded').length,currentRunning:running.length&&running.every(row=>numeric(row.executionConcurrency?.currentRunning)!==null)?running.reduce((n,row)=>n+row.executionConcurrency.currentRunning,0):null};
 const configurations=summary.configurations.slice(0,128).map(c=>{
  const members=results.filter(row=>(row.configID??row.condition)===c.configID&&(row.condition??null)===c.condition&&JSON.stringify(models(row.modelSet??row.modelID))===JSON.stringify(c.models));
  return{key:JSON.stringify([identifier(c.configID),identifier(c.condition),c.models.slice(0,16).map(identifier)]),configID:identifier(c.configID),title:title(identifier(c.configID)),models:c.models.map(identifier).slice(0,16),modelLabels:c.models.map(identifier).slice(0,16).map(modelLabel),assigned:c.assigned,attempted:c.attempted,settled:members.filter(row=>settled(row,evidence)).length,checking:members.filter(row=>terminalOutcomes.has(row.outcome)&&!settled(row,evidence)).length,completed:c.completed,artifactCorrect:c.artifactCorrect,correctCompleted:c.correctCompleted,deadline:c.timedOut,failed:c.failed,cancelled:c.cancelled,notRun:c.notRun,admittedActors:c.admittedActors,assignedActors:c.assignedActors,nativeSucceededActors:c.nativeSucceededActors,elapsed:c.allOutcomeElapsedMs,completedElapsed:c.completedElapsedMs,compliance:c.compliance,complianceGroups:complianceGroups(members),validComparisons:c.validComparisons,correctCodeLines:c.complexityCorrectArtifacts.metrics.codeLines};
 });
 const latest=results.map((row,index)=>({row,index,time:Date.parse(row.ended??row.started??'')||0})).filter(({row})=>row.outcome!=='not-run').sort((a,b)=>b.time-a.time||b.index-a.index).slice(0,40).map(({row})=>{
  const roster=row.actors.slice(0,8).map(actor=>{const id=modelID(actor);return{id:identifier(actor.id),role:roleLabel(actor.role),modelID:id,modelLabel:modelLabel(id),outcome:actorOutcomes.has(actor.outcome)?actor.outcome:'unknown',admitted:bool(actor.admitted),contextObservedBytes:numeric(actor.context?.maxBytes)};});
  const observed=row.actors.map(actor=>numeric(actor.context?.maxBytes)).filter(value=>value!==null),modelIDs=models(row.modelSet??row.modelID),configID=identifier(row.configID??row.condition);
  return{id:identifier(row.id),fixtureID:identifier(row.fixtureID),configID,title:title(configID),models:modelIDs,modelLabels:modelIDs.map(modelLabel),outcome:outcomes.has(row.outcome)?row.outcome:'unknown',settled:settled(row,evidence),elapsedMs:numeric(row.elapsedMs),validComparison:bool(row.validComparison),artifactCorrect:['not-run','running'].includes(row.outcome)?null:typeof row.verification?.correct==='boolean'?row.verification.correct:bool(row.artifactCorrect),correct:['not-run','running'].includes(row.outcome)?null:bool(row.correct),assignedActors:row.actors.length,admittedActors:row.actors.filter(actor=>actor.admitted===true).length,nativeSucceededActors:row.actors.filter(actor=>actor.outcome==='succeeded').length,actorBrief:roster,omittedActors:row.actors.length-roster.length,context:{enabled:bool(row.nativePlugin),budgetBytes:numeric(row.contextBytes),cacheIntervalMs:numeric(row.cacheIntervalMs),observedMaxBytes:observed.length?Math.max(...observed):null},complianceGroups:complianceGroups([row])};
 });
 return{version:2,observation,reason:observation==='stale'?'no-recent-evidence-write':observation==='unknown'?'timestamp-unknown':null,evidenceStatus:statuses.has(evidence.status)?evidence.status:'unknown',lifecycle:finalStatuses.has(evidence.status)?'settled':evidence.status==='running'?'active':evidence.status==='assigned'?'assigned':'unknown',modifiedAt:numeric(modifiedAt),protocol:{repeats:numeric(protocol.repeats),parallelCohorts:numeric(protocol.parallelCohorts),actorsPerCohort:identifier(protocol.actorsPerCohort),deadlineMs:numeric(protocol.deadlineMs),configs:Array.isArray(protocol.conditions)?protocol.conditions.slice(0,128).map(identifier):[],models:Array.isArray(protocol.models)?protocol.models.slice(0,32).map(identifier):[]},counts,native,complianceGroups:complianceGroups(results),configurations,latest,omittedConfigurations:Math.max(0,summary.configurations.length-configurations.length),omittedCohorts:Math.max(0,results.filter(row=>row.outcome!=='not-run').length-latest.length)};
}

export async function loadBenchmarkSnapshot(evidencePath,options={},cache=null){
 let file;
 try{
  file=await open(evidencePath,'r');const before=await file.stat();if(!before.isFile()||before.size>FILE_LIMIT)return unknown('file-bound');
  const identity=[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(':');
  if(cache?.identity===identity){const snapshot=cache.snapshot;if(snapshot.counts===null)return snapshot;const observation=(options.now??Date.now())-snapshot.modifiedAt>(options.staleAfterMs??10000)?'stale':'fresh';return{...snapshot,observation,reason:observation==='stale'?'no-recent-evidence-write':null};}
  const buffer=Buffer.alloc(before.size+1);let size=0;
  while(size<buffer.length){const read=await file.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await file.stat();if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)return unknown('unstable-file');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)));}catch{return unknown('malformed-file');}
  try{const snapshot=summarizeBenchmarkView(value,{...options,modifiedAt:after.mtimeMs});if(cache){cache.identity=identity;cache.snapshot=snapshot;}return snapshot;}catch{return unknown('invalid-shape');}
 }catch(error){return unknown(error.code==='ENOENT'?'missing-file':'unreadable-file');}finally{await file?.close().catch(()=>{});}
}


export async function startBenchmarkDashboard({evidencePath,port=0}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new RangeError('Invalid loopback port');
 if(typeof evidencePath!=='string'||!isAbsolute(evidencePath))throw new TypeError('Explicit absolute evidence path required');
 const encode=value=>{const encoded=JSON.stringify(value);return Buffer.byteLength(encoded)>VIEW_LIMIT?JSON.stringify(unknown('view-bound')):encoded;};
 const cache={};let encoded=encode(await loadBenchmarkSnapshot(evidencePath,{},cache)),closed=false,busy=false;const clients=new Map();
 const server=createServer((req,res)=>{
  const host=req.headers.host??'',expected='127.0.0.1:'+server.address().port;
  if(host!==expected||(req.headers.origin&&req.headers.origin!==`http://${expected}`)){res.writeHead(403).end();return;}
  if(req.method!=='GET'){res.writeHead(405).end();return;}res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(dashboardHTML);return;}
  if(req.url!=='/events'){res.writeHead(404).end();return;}if(clients.size>=8){res.writeHead(503).end();return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  // write(false) means this snapshot was accepted but transport is backpressured.
  // Keep exactly one newest pending snapshot until drain, never a history queue.
  let blocked=false,pending=null,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;pending=null;res.off('drain',drain);clients.delete(res);};
  const offer=payload=>{if(stopped||closed||res.destroyed||res.writableEnded){stop();return;}if(blocked){pending=payload;return;}try{blocked=!res.write(payload);}catch{stop();res.destroy();}};
  const drain=()=>{if(stopped||closed)return;blocked=false;if(pending!==null){const latest=pending;pending=null;offer(latest);}};
  res.on('drain',drain);res.once('close',stop);res.once('error',stop);req.once('close',stop);clients.set(res,{offer,stop});offer(`data: ${encoded}\n\n`);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const timer=setInterval(async()=>{if(busy||closed)return;busy=true;try{const value=encode(await loadBenchmarkSnapshot(evidencePath,{},cache));if(closed||value===encoded)return;encoded=value;const payload=`data: ${encoded}\n\n`;for(const client of clients.values())client.offer(payload);}finally{busy=false;}},1000);
 return{url:`http://127.0.0.1:${server.address().port}/`,async close(){if(closed)return;closed=true;clearInterval(timer);for(const[res,client]of clients){client.stop();res.end();}clients.clear();const closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections?.();await closing;}};
}
