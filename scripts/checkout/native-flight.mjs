// Opt-in real native checkout study. All assigned outcomes remain, including refusals.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mission,roles,referenceFiles } from './native-mission.mjs';
import { gradeNative } from './native-grader.mjs';
import { pendingAssignments } from './native-continuation.mjs';
import { missionSet } from './native-varied-missions.mjs';
import { NativeBridge } from './native-bridge.mjs';
import { ProductReplay } from './product-replay.mjs';
import { extractBindings } from './binding-producer.mjs';
import { normalizeGraph,sourceRevision } from '../../src/prototypes/checkout/graph-index.mjs';
import { CheckoutArbiter } from '../../src/prototypes/checkout/arbiter.mjs';
import { GraphCheckout } from '../../src/prototypes/checkout/graph-checkout.mjs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';
import { selectedProfile } from '../../src/profile.mjs';
import { startOpenCode } from '../../src/process.mjs';
import { OpenCodeClient,safeRuntimeError } from '../../src/opencode.mjs';
import { readMissionFile } from '../../src/mission-verifier.mjs';

const {values}=parseArgs({options:{real:{type:'boolean'},plan:{type:'boolean'},preflight:{type:'boolean'},campaign:{type:'string',default:'single'},'continue-from':{type:'string'},python:{type:'string'},model:{type:'string',default:'deepseek-v4-flash'},repo:{type:'string'},output:{type:'string'},repeats:{type:'string',default:'3'},'deadline-ms':{type:'string',default:'600000'}}});
if(!!values.real===!!values.plan)throw Error('Pass exactly one of --real or --plan');
if(!values.python)throw Error('Pass the pinned offline AST Python');
const repeats=Number(values.repeats),deadlineMs=Number(values['deadline-ms']);
if(!Number.isSafeInteger(repeats)||repeats<1||repeats>6||!Number.isSafeInteger(deadlineMs)||deadlineMs<10000||deadlineMs>1200000)throw Error('invalid_budget');
const run=resolve(values.output??`artifacts/checkout-native-${Date.now()}`),repo=resolve(values.repo??'../checkout-arbiter-lab');mkdirSync(run);
const seed=Object.fromEntries(readdirSync(resolve(repo,'src')).filter(x=>x.endsWith('.mjs')).sort().map(x=>['src/'+x,readFileSync(resolve(repo,'src',x),'utf8')]));
const behavior=readFileSync(resolve(repo,'test/behavior.test.mjs'),'utf8'),contracts=JSON.parse(readFileSync(resolve(repo,'contracts.json'),'utf8'));
if(!['deepseek-v4-flash','deepseek-v4-pro','deepseek-v4.1-flash'].includes(values.model))throw Error('unsupported_requested_v4_model');
const model={providerID:'opencode',id:values.model},arms=['current','blocks','graph'];
if(!['single','varied'].includes(values.campaign))throw Error('unsupported_campaign');
const missions=values.campaign==='varied'?missionSet(seed,contracts):[{id:'tax-stock',directive:mission,roles,seed,contracts,reference:referenceFiles,grade:gradeNative,seedTransform:'Original synthetic lab'}];
let assignments=[];for(let repeat=1;repeat<=repeats;repeat++)for(let mi=0;mi<missions.length;mi++)for(let i=0;i<3;i++){
 const m=missions[mi],arm=arms[(i+repeat-1+mi)%3],offset=(repeat-1)%m.roles.length;
 const roleOrder=[...m.roles.slice(offset),...m.roles.slice(0,offset)].map(r=>r.id);
 assignments.push({id:values.campaign==='single'?`r${repeat}-${arm}`:`${m.id}-r${repeat}-${arm}`,missionId:m.id,repeat,arm,roleOrder,status:'assigned',actors:m.roles.map(r=>({id:r.id,status:'assigned'}))});
}
const fingerprints=['native-flight.mjs','native-continuation.mjs','native-mission.mjs','native-varied-missions.mjs','native-ledger-mission.mjs','native-policy-mission.mjs','native-grader.mjs','native-bridge.mjs','expansion-request.mjs','product-replay.mjs','binding-producer.mjs','bindings.py','../../src/prototypes/checkout/graph-checkout.mjs','../../src/prototypes/checkout/arbiter.mjs','../../src/prototypes/checkout/graph-index.mjs','../../src/prototypes/checkout/impact.mjs','../../src/prototypes/checkout/regions.mjs','../../src/process.mjs','../../src/opencode.mjs','../../src/profile.mjs','../../src/mission-verifier.mjs',
 ...readdirSync(resolve(import.meta.dirname,'../../src/product'),{recursive:true}).filter(path=>path.endsWith('.mjs')).sort().map(path=>'../../src/product/'+path)];
const protocol={schema:2,campaign:values.campaign,model,deadlineMs,repeats,plannedCohorts:assignments.length,plannedActors:assignments.length*4,assignments,missions:missions.map(m=>({id:m.id,roles:m.roles,seedTransform:m.seedTransform,seedRevision:sourceRevision(m.seed),directiveHash:hashText(m.directive),contractsHash:hashText(JSON.stringify(m.contracts))})),
 seedRevision:sourceRevision(seed),missionHash:hashText(mission),contractsHash:hashText(JSON.stringify(contracts)),behaviorHash:hashText(behavior),
 implementationHashes:Object.fromEntries(fingerprints.map(p=>[p,hashText(readFileSync(resolve(import.meta.dirname,p)))])),
 maximumNativeTurnsPerActor:3,parallelCohorts:1,privateCopies:true,nativeToolPolicy:'Native read/write/edit/glob/grep and model-specific patch menu; shell/packages/subagents/external_directory denied; instructions/test/package protected',
 preparation:'All four initial native prompts admit together. Acquisition order rotates within each mission/repeat and is matched across arms. Agents may prepare private edits without a grant. Publication requires one. Changed issued bases require a new native edit turn, never automatic evidence relabeling.',
 feedback:'Only actual grant/submission refusal and refreshed published source; held acceptance results never provided; no unplanned rescue or separate integrator',
 scopeExpansion:'Runner explicitly requests introduced blocks and candidate-derived dependencies after a scope refusal in both scoped arms. Exact-candidate authority; old base movement requires another native edit turn. Expansion attempts and refusals retained.',
 timing:'Cohort setup, initial prompt admissions, per-turn terminal and submission, initial grant waiting, first observed correct publication, settlement and stop; includes local producer/validator overhead',
 usage:'Live closed-step observations and separate final native SQLite cumulative totals; missing usage unknown; reported cost is not a billing reconciliation',
 sourceCoverage:'Live native event streams have no replay; gaps/omissions recorded separately from output correctness',usefulBenefitQualified:false};
mkdirSync(resolve(run,'implementation'));for(const p of fingerprints)writeFileSync(resolve(run,'implementation',p.replaceAll('../','up-').replaceAll('/','_')),readFileSync(resolve(import.meta.dirname,p)));
for(const m of missions){mkdirSync(resolve(run,'missions',m.id),{recursive:true});writeFileSync(resolve(run,'missions',m.id,'seed.json'),JSON.stringify(m.seed,null,2));writeFileSync(resolve(run,'missions',m.id,'contracts.json'),JSON.stringify(m.contracts,null,2));}
if(values['continue-from']){
 const parentRun=resolve(values['continue-from']),prior=JSON.parse(readFileSync(resolve(parentRun,'results.json')));
 const inherited=assignments;assignments=pendingAssignments(assignments,prior,protocol);
 protocol.continuation={parentRun,parentResultsHash:hashText(readFileSync(resolve(parentRun,'results.json'))),parentProtocolHash:hashText(readFileSync(resolve(parentRun,'protocol.json'))),originalPlanned:inherited.length,retainedCompleted:prior.rows.filter(r=>['settled','deadline-or-cancel','setup-failed'].includes(r.status)).map(r=>r.id),remaining:assignments.map(r=>r.id),driverChange:'Operational pending-selection and provenance recording only; all original experimental implementation hashes except the driver verified unchanged'};
 protocol.assignments=assignments;protocol.plannedCohorts=assignments.length;protocol.plannedActors=assignments.length*4;
}
writeFileSync(resolve(run,'protocol.json'),JSON.stringify(protocol,null,2)+'\n');writeFileSync(resolve(run,'seed.json'),JSON.stringify(seed,null,2)+'\n');
if(values.plan){console.log(JSON.stringify({run,model,plannedCohorts:assignments.length,plannedActors:assignments.length*4,deadlineMs}));process.exit(0);}
const cancellation=new AbortController();process.once('SIGINT',()=>cancellation.abort());process.once('SIGTERM',()=>cancellation.abort());
const evidence={schema:1,run,model,createdAt:new Date().toISOString(),status:'preflight',protocol,preflight:null,rows:[],modelRuns:0};
const save=()=>writeFileSync(resolve(run,'results.json'),JSON.stringify(evidence,null,2)+'\n');save();
const referenceGrades=new Map();const references=[];
for(const m of missions){const initial=m.grade(m.seed,resolve(run,'reference',m.id,'seed'),behavior),reference=m.grade(m.reference(m.seed),resolve(run,'reference',m.id,'solution'),behavior);referenceGrades.set(m.id,initial);references.push({id:m.id,seed:initial,reference});}
writeFileSync(resolve(run,'references.json'),JSON.stringify(references,null,2));
if(references.some(r=>r.seed.correct||!r.seed.legacyValid||!r.reference.correct))throw Error('independent_reference_preflight_failed');
const profile=await selectedProfile();profile.model=model; // User-requested explicit choice; no saved settings are changed.
const permissions=[{action:'*',resource:'*',effect:'deny'},...['read','write','edit','glob','grep'].map(action=>({action,resource:'*',effect:'allow'})),{action:'external_directory',resource:'*',effect:'deny'},...['MISSION.md','package.json','test/**','.opencode/**'].flatMap(resource=>['write','edit'].map(action=>({action,resource,effect:'deny'})))];
const messageID=()=>`msg_${randomUUID().replaceAll('-','')}`;
function writeCopy(root,files,directive=mission){rmSync(resolve(root,'src'),{recursive:true,force:true});for(const [path,text]of Object.entries(files)){mkdirSync(dirname(resolve(root,path)),{recursive:true});writeFileSync(resolve(root,path),text);}mkdirSync(resolve(root,'test'),{recursive:true});writeFileSync(resolve(root,'test/behavior.test.mjs'),behavior);writeFileSync(resolve(root,'MISSION.md'),directive);writeFileSync(resolve(root,'package.json'),JSON.stringify({type:'module',private:true}));}
async function collectCopy(root,directive=mission){
 const files={};let bytes=0;
 async function walk(dir){for(const entry of readdirSync(resolve(root,dir),{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isSymbolicLink())throw Error('source_symlink');if(entry.isDirectory())await walk(path);else if(entry.isFile()){if(!path.endsWith('.mjs'))throw Error('unexpected_source_file');files[path]=await readMissionFile(root,path);bytes+=Buffer.byteLength(files[path]);if(bytes>1024*1024||Object.keys(files).length>64)throw Error('source_bounds');}}}
 await walk('src');
 for(const [path,text]of Object.entries({'MISSION.md':directive,'test/behavior.test.mjs':behavior,'package.json':JSON.stringify({type:'module',private:true})}))if(await readMissionFile(root,path)!==text)throw Error('protected_bytes_changed');
 return files;
}
async function observe(actor,signal,live){
 let readyResolve;actor.ready=new Promise(r=>readyResolve=r);
 actor.feed=(async()=>{try{for await(const event of actor.client.events(actor.sessionID,{signal,transport:'live'})){
   if(event.type==='server.connected'){actor.coverage='live-no-replay';readyResolve();continue;}
   if(actor.lastSeq!==undefined&&event.seq!==actor.lastSeq+1)actor.sequenceGaps++;actor.lastSeq=event.seq;
   if(event.type==='session.execution.started'){if(!actor.running){actor.running=true;live.count++;live.peak=Math.max(live.peak,live.count);}}
   if(['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(event.type)&&actor.running){actor.running=false;live.count--;}
   if(event.type==='session.step.ended'){actor.usage.steps++;for(const key of ['input','output']){const value=event.data.tokens?.[key];if(Number.isFinite(value)&&value>=0)actor.usage[key]=(actor.usage[key]??0)+value;else actor.usage.missing++;}if(Number.isFinite(event.data.cost))actor.usage.cost=(actor.usage.cost??0)+event.data.cost;else actor.usage.missingCost++;}
   if(event.type==='session.tool.input.started'&&typeof event.data.toolName==='string')actor.tools[event.data.toolName]=(actor.tools[event.data.toolName]??0)+1;
   if(actor.eventCount++>8192){actor.eventOmissions++;continue;}
 }}catch{if(!signal.aborted)actor.coverage='gap';readyResolve();}})();
 await Promise.race([actor.ready,delay(5000).then(()=>{throw Error('native_feed_not_ready');})]);if(actor.coverage!=='live-no-replay')throw Error('native_feed_unavailable');
}
function nativeDiagnostics(stateRoot,sessionIDs){
 const db=new DatabaseSync(join(stateRoot,'opencode/home/.local/share/opencode/opencode.db'),{readOnly:true});
 try{return sessionIDs.map(sessionID=>{
  const raw=db.prepare('select model,idle_outcome,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,cost from session_v2 where id=?').get(sessionID);
  const totals=raw?{model:JSON.parse(raw.model),outcome:raw.idle_outcome,input:raw.tokens_input,output:raw.tokens_output,reasoning:raw.tokens_reasoning,cacheRead:raw.tokens_cache_read,cost:raw.cost}:null;
  const errors=[];for(const row of db.prepare("select data from session_message where session_id=? and type='assistant'").all(sessionID)){
   const e=JSON.parse(row.data).error;
   if(e)errors.push({type:typeof e.type==='string'&&/^[a-z][a-z0-9_.:-]{0,100}$/.test(e.type)?e.type:'unknown',status:Number.isInteger(e.status)?e.status:null});
  }
  return {sessionID,totals,errors};
 });}finally{db.close();}
}
async function runtimePreflight(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'checkout-native-preflight-'))),state=await realpath(await mkdtemp(join(tmpdir(),'checkout-native-preflight-state-')));
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,cancellation.signal,AbortSignal.timeout(120000)]),record={assignedActors:2,root,actors:[],passed:false,stopConfirmed:false};let host;
 try{await mkdir(join(root,'a'));await mkdir(join(root,'b'));for(const id of ['a','b'])writeFileSync(join(root,id,'marker.mjs'),`export const marker = '${id}';\n`);
 host=await startOpenCode({...profile,directory:root,stateDir:state,signal});
 await Promise.all(['a','b'].map(async id=>{const client=new OpenCodeClient({...host,model,directory:join(root,id),permissions});const sessionID=await client.createSession(`Checkout preflight ${id}`,signal);const row={id,sessionID,admitted:false,outcome:null};record.actors.push(row);evidence.modelRuns++;await client.prompt(sessionID,`Read marker.mjs in your directory. Replace its single exported marker value with '${id}-verified'. Use native file tools only. Do not create other files.`,{id:messageID(),signal});row.admitted=true;const terminal=await client.wait(sessionID,signal);row.outcome=terminal.outcome;client.close();}));
 record.passed=record.actors.every(a=>a.outcome==='succeeded')&&['a','b'].every(id=>readFileSync(join(root,id,'marker.mjs'),'utf8').includes(`${id}-verified`));
 }catch(error){record.error=safeRuntimeError(error);}finally{controller.abort();try{if(host)await host.close();record.stopConfirmed=true;}catch{record.stopConfirmed=false;}}
 try{record.diagnostics=nativeDiagnostics(state,record.actors.map(a=>a.sessionID));}catch{record.diagnosticsUnavailable=true;}
 record.passed&&=record.stopConfirmed;return record;
}
evidence.preflight=await runtimePreflight();save();console.log(JSON.stringify({phase:'preflight',passed:evidence.preflight.passed,model,run}));
if(!evidence.preflight.passed||values.preflight){evidence.status=evidence.preflight.passed?'preflight-complete':'preflight-failed';save();process.exit(evidence.preflight.passed?0:1);}

async function cohort(assignment){
 const selected=missions.find(m=>m.id===assignment.missionId);const {seed,roles,contracts,directive,grade}=selected,initGrade=referenceGrades.get(selected.id);
 const started=Date.now(),output=resolve(run,assignment.id);mkdirSync(output);const root=await realpath(await mkdtemp(join(tmpdir(),`checkout-${assignment.id}-`))),stateRoot=await realpath(await mkdtemp(join(tmpdir(),'checkout-native-state-')));
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,cancellation.signal,AbortSignal.timeout(deadlineMs)]),live={count:0,peak:0};
 const result={...assignment,status:'running',root,actors:[],decisions:[],grade:initGrade,firstCorrectMs:null,peakNative:0,stopConfirmed:false,graphBuildMs:0,validationMs:0,model};let host,system,bridge,revision=0,gradeNumber=0,chain=Promise.resolve();
 const persist=()=>{writeFileSync(resolve(output,'result.json'),JSON.stringify(result,(key,value)=>['client','feed','ready'].includes(key)?undefined:value,2));save();};
 const locked=operation=>{const next=chain.then(operation);chain=next.catch(()=>{});return next;};
 const build=files=>{const begin=performance.now();try{const ast=extractBindings(files,values.python);writeFileSync(resolve(output,`ast-${++revision}.json`),JSON.stringify(ast,null,2));return normalizeGraph({files,ast,contracts});}finally{result.graphBuildMs+=performance.now()-begin;}};
 const validate=files=>{const begin=performance.now();try{return grade(files,resolve(output,`validation-${++gradeNumber}`),behavior).legacyValid;}finally{result.validationMs+=performance.now()-begin;}};
 try{
 if(assignment.arm==='current'){system=new ProductReplay(validate);await system.seed(seed);}else if(assignment.arm==='blocks'){system=new CheckoutArbiter({files:seed,blocks:build(seed).blocks,edges:[]});}else system=new GraphCheckout({files:seed,buildIndex:build,validate});
 bridge=new NativeBridge({system,arm:assignment.arm,roles,validate,buildIndex:build});
 const publish=async(actor,candidate,turn)=>{
   let decision=await bridge.submit(actor.id,candidate,Date.now());
   if(['scope_expansion_required','outside_modification_scope'].includes(decision.reason)&&assignment.arm!=='current'){
     result.decisions.push({actor:actor.id,turn,phase:'submission-before-expansion',elapsedMs:Date.now()-started,...decision});
     const expanded=await bridge.requestExpansion(actor.id,candidate,Date.now());
     result.decisions.push({actor:actor.id,turn,phase:'expansion',elapsedMs:Date.now()-started,...expanded});
     decision=expanded.expanded?await bridge.submit(actor.id,candidate,Date.now()):{...expanded,expansionAttempt:true};
   }
   if(decision.admitted&&assignment.arm==='blocks')system.reindex({blocks:build((await bridge.snapshot(Date.now())).files).blocks,edges:[]});
   return decision;
 };
 host=await startOpenCode({...profile,directory:root,stateDir:stateRoot,signal});
 for(const roleId of assignment.roleOrder){const role=roles.find(r=>r.id===roleId);const dir=join(root,role.id);await mkdir(dir);const prepare=await bridge.begin(role.id,Date.now());writeCopy(dir,prepare.files,directive);
 const client=new OpenCodeClient({...host,model,directory:dir,permissions}),sessionID=await client.createSession(`Checkout ${assignment.id}/${role.id}`,signal);
 const actor={id:role.id,dir,client,sessionID,coverage:'unknown',usage:{input:null,output:null,cost:null,steps:0,missing:0,missingCost:0},sequenceGaps:0,eventCount:0,eventOmissions:0,tools:{},turns:[],status:'ready',permission:prepare.permission,initialGrant:Object.fromEntries(Object.entries(prepare.decision).filter(([key])=>key!=='files'))};result.actors.push(actor);await observe(actor,signal,live);}
 result.setupMs=Date.now()-started;
 const execute=async actor=>{
 const role=roles.find(r=>r.id===actor.id);let feedback=null;
 for(let turn=1;turn<=3&&!signal.aborted;turn++){
  const turnRecord={turn,startedMs:Date.now()-started,admitted:false,outcome:null,submission:null};actor.turns.push(turnRecord);actor.status='running';
  const text=`Read MISSION.md and the current source. Your focus: ${role.focus}\nYour modification scopes: ${role.writes.map(([p,s])=>`${p}#${s}`).join(', ')}.\nImplement these scopes in your private copy to satisfy the full documented mission. Other actors independently implement the other concerns. Finish actual code changes; do not only propose them. Publication is separate. ${feedback?`The runner returned this actual submission/refreshed-base result: ${JSON.stringify(feedback)}. Your source has been refreshed to the issued base. Re-read it and redo your assigned changes as needed. No acceptance-check feedback is available.`:''}`;
  try{evidence.modelRuns++;await actor.client.prompt(actor.sessionID,text,{id:messageID(),signal});turnRecord.admitted=true;turnRecord.admittedMs=Date.now()-started;persist();const terminal=await actor.client.wait(actor.sessionID,signal,{pollIntervalMs:500});turnRecord.outcome=terminal.outcome;turnRecord.terminalMs=Date.now()-started;if(terminal.outcome!=='succeeded'){actor.status='native-failed';break;}
  const candidate=await collectCopy(actor.dir,directive);writeFileSync(resolve(output,`${actor.id}-turn${turn}-candidate.json`),JSON.stringify(candidate,null,2));
  let decision=await locked(async()=>{
    let decision=await publish(actor,candidate,turn);
    // A granted but blocked publication waits for the current holder to finish.
    // No model execution is queued: all initial private preparation ran together.
    return decision;
  });
  while(decision.reason==='checkout_conflict'&&!decision.expansionAttempt&&!signal.aborted){actor.status='waiting-for-grant';const began=Date.now();await delay(500,undefined,{signal});actor.waitingMs=(actor.waitingMs??0)+Date.now()-began;decision=await locked(()=>publish(actor,candidate,turn));}
  const {files,...summary}=decision;turnRecord.submission=summary;result.decisions.push({actor:actor.id,turn,elapsedMs:Date.now()-started,...summary});
  if(decision.admitted){actor.status='published';await locked(async()=>{const published=(await bridge.snapshot(Date.now())).files;result.grade=grade(published,resolve(output,`check-${++gradeNumber}`),behavior);if(result.grade.correct&&result.firstCorrectMs===null)result.firstCorrectMs=Date.now()-started;});break;}
  feedback=summary;
  if(turn===3){actor.status='submission-refused';break;}
  const prepare=files?{files}:await locked(()=>bridge.retry(actor.id,Date.now()));writeCopy(actor.dir,prepare.files,directive);persist();
  }catch(error){turnRecord.error=safeRuntimeError(error);actor.status=signal.aborted?'deadline-or-cancel':'runtime-failed';break;}finally{turnRecord.endedMs=Date.now()-started;persist();}
 }
 if(signal.aborted&&actor.status==='running')actor.status='deadline-or-cancel';await locked(()=>bridge.release(actor.id,Date.now())).catch(()=>{});
 };
 // Promise.all admits every initial native task; dependencies gate publication only.
 await Promise.all(result.actors.map(execute));await chain;result.status=signal.aborted?'deadline-or-cancel':'settled';
 }catch(error){result.error=safeRuntimeError(error);result.status=signal.aborted?'deadline-or-cancel':'setup-failed';}
 finally{controller.abort();for(const actor of result.actors)actor.client?.close();await Promise.allSettled(result.actors.map(a=>a.feed));try{if(host)await host.close();result.stopConfirmed=true;}catch{result.stopConfirmed=false;}
 result.peakNative=live.peak;result.elapsedMs=Date.now()-started;
 if(bridge&&result.stopConfirmed){const final=(await bridge.snapshot(Date.now())).files;writeFileSync(resolve(output,'published-files.json'),JSON.stringify(final,null,2));result.grade=grade(final,resolve(output,'final'),behavior);}
 try{result.nativeDiagnostics=nativeDiagnostics(stateRoot,result.actors.map(a=>a.sessionID));}catch{result.diagnosticsUnavailable=true;}
 for(const actor of result.actors){delete actor.client;delete actor.feed;delete actor.ready;delete actor.running;}
 result.correct=!!result.grade.correct&&result.stopConfirmed;
 result.correctWithinBudget=result.correct&&result.status==='settled'&&result.firstCorrectMs!==null&&result.firstCorrectMs<=deadlineMs&&result.elapsedMs<=deadlineMs;persist();}
 return result;
}
for(const assignment of assignments){if(cancellation.signal.aborted)break;console.log(`Starting ${assignment.id} (${model.id})`);const row={...assignment,status:'running'};evidence.rows.push(row);evidence.status='running';save();const complete=await cohort(assignment);Object.assign(row,complete);save();console.log(JSON.stringify({trial:assignment.id,correct:row.correct,correctWithinBudget:row.correctWithinBudget,elapsedMs:row.elapsedMs,firstCorrectMs:row.firstCorrectMs,peakNative:row.peakNative,actors:row.actors.map(a=>({id:a.id,status:a.status,turns:a.turns.length}))}));}
evidence.status=cancellation.signal.aborted?'cancelled':'complete';evidence.completedAt=new Date().toISOString();save();
const summary={run,campaign:values.campaign,model,planned:assignments.length,completed:evidence.rows.length,modelRuns:evidence.modelRuns,arms:arms.map(arm=>({arm,assigned:assignments.filter(a=>a.arm===arm).length,attempted:evidence.rows.filter(r=>r.arm===arm).length,correct:evidence.rows.filter(r=>r.arm===arm&&r.correct).length,correctWithinBudget:evidence.rows.filter(r=>r.arm===arm&&r.correctWithinBudget).length,rows:evidence.rows.filter(r=>r.arm===arm).map(r=>({id:r.id,missionId:r.missionId,correct:r.correct,correctWithinBudget:r.correctWithinBudget,elapsedMs:r.elapsedMs,firstCorrectMs:r.firstCorrectMs,peakNative:r.peakNative,status:r.status}))})),missions:missions.map(m=>({id:m.id,arms:arms.map(arm=>({arm,assigned:assignments.filter(a=>a.missionId===m.id&&a.arm===arm).length,correct:evidence.rows.filter(r=>r.missionId===m.id&&r.arm===arm&&r.correct).length,correctWithinBudget:evidence.rows.filter(r=>r.missionId===m.id&&r.arm===arm&&r.correctWithinBudget).length}))})),usefulBenefitQualified:false};
writeFileSync(resolve(run,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
