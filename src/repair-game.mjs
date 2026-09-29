import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,open,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {WorkspaceState} from './workspace-state.mjs';
import {assembleAgentContext,renderAgentContext} from './context.mjs';
import {observeFiles} from './file-observer.mjs';
import {OpenCodeClient} from './opencode.mjs';
import {startOpenCode} from './process.mjs';
import {verifyGangCode} from '../fixtures/gangcode-verifier.mjs';

const PATHS=['package.json','engine.mjs','server.mjs','public/index.html','README.md','MISSION.md','data/history.json'];
const TASK='Finish the existing Canada: Crossroads game. Engine/server already satisfy most independent checks: preserve useful existing behavior. Main missing work is a polished playable public/index.html. Read MISSION.md and current server API as needed; do not resurvey all historical data. Build a playful paper/ink/red/copper Canadian journey with stylized SVG terrain/water map, era timeline, accessible choice cards, score/streak/progress/milestones, prominent previous feedback/source link alongside next question, completion/restart, mobile and keyboard support. Keep UI compact, preferably under300 lines, one file with CSS/JS and no remote assets. Preserve immutable data/history.json facts and working engine cases. Known prechecks needing attention: http-origin-boundary, sse-initial-update, ui-interactive-game. Inspect/fix concrete server origin or SSE cleanup bugs if necessary: own-server loopback Origin only or omitted; foreign403; SSE initial and updated snapshots; close all SSE sockets idempotently. Use native file tools only, no processes/subagents/external services. This is an explicitly authorized completion task. File focus is not ownership. Do not replace the whole working project or add scaffolding.';
const short=value=>typeof value==='string'?value.slice(0,512):null;
const bounded=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('bounded_deadline')),ms);})]).finally(()=>clearTimeout(timer));};
function nativePath(root,value){if(typeof value!=='string')return null;const path=isAbsolute(value)?relative(root,value):value;return !path||path.includes('\\')||path.split('/').some(p=>!p||p==='..'||p==='.')||isAbsolute(path)?null:path;}
async function priorMetadata(path){
 const file=await open(path,'r');let content;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw new Error('prior_evidence_bound');const buffer=Buffer.alloc(8*1024*1024+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>8*1024*1024)throw new Error('prior_evidence_bound');content=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}
 const document=JSON.parse(content),result=document.result??document;
 return {authority:'recorded_prior_squad_handover',live:false,readRevision:'unknown',participants:(result.state?.participants??[]).slice(0,8).map(p=>({id:short(p.id),task:short(p.task?.text),status:short(p.status),lastLocation:p.lastLocation?{path:short(p.lastLocation.path),kind:short(p.lastLocation.kind),confidence:'historical-unknown',stale:true}:null})),failedChecks:(result.verification?.checks??[]).filter(c=>c.passed===false&&typeof c.name==='string').slice(0,40).map(c=>c.name.replace(/[^a-z0-9_-]/gi,'').slice(0,100))};
}

/** Explicit single repair admission. No automatic self-echo or new-task scheduling. */
export async function runGameRepair({profile,buildRoot,priorEvidencePath,onUpdate=()=>{},signal,deadlineMs=480000,runtime={}}){
 if(!profile?.model||typeof buildRoot!=='string'||typeof priorEvidencePath!=='string'||!Number.isFinite(deadlineMs)||deadlineMs<=0||deadlineMs>480000)throw new TypeError('Invalid repair assignment');
 const root=await realpath(resolve(buildRoot)),id=randomUUID(),artifactRoot=resolve(import.meta.dirname,'../artifacts',id);
 const start=runtime.startOpenCode??startOpenCode,Client=runtime.OpenCodeClient??OpenCodeClient,observe=runtime.observeFiles??observeFiles,verify=runtime.verifyGangCode??verifyGangCode;
 await mkdir(artifactRoot,{recursive:true,mode:0o700});
 const evidencePath=join(artifactRoot,'repair-evidence.json'),state=new WorkspaceState({epoch:randomUUID()}),started=Date.now();
 const controller=new AbortController(),stopSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(deadlineMs),...(signal?[signal]:[])]);
 const actor={id:'finisher',assigned:true,admitted:false,outcome:'setup',processStopped:null,firstJoinBeforeTools:null,initialContextProof:null,errors:[]};
 const result={version:1,kind:'real-native-game-repair',condition:'Canada: Crossroads / focused completion',model:{...profile.model},buildRoot:root,priorEvidencePath:resolve(priorEvidencePath),evidencePath,assigned:['finisher'],actors:[actor],errors:[],events:[],verification:{correct:false,checks:[]},limits:{nativeTransport:'volatile-live-no-replay',automaticChangeMessages:0,nativeWritesFenced:false,providerConsumption:'unverified',deadlineMs}};
 let phase='Preparing focused repair',server,client,observer,stream,localState,sessionID,closing=false,controlSeq=0,nativeCursor=null,gap=false,firstToolSeq,initialDeliveredSeq,initialID,text,projection,setupStopUnconfirmed=false;
 let readyResolve;const ready=new Promise(resolve=>{readyResolve=resolve;});
 const error=code=>{actor.errors.push(code);result.errors.push({actor:'finisher',code});};
 const emit=()=>{try{onUpdate({phase,state:state.snapshot(),events:[...result.events],result});}catch{}};
 const record=value=>{result.events.push({elapsedMs:Date.now()-started,...value});if(result.events.length>256)result.events.shift();emit();};
 const control=(type,data)=>state.ingest({id:randomUUID(),epoch:state.epoch,source:'control',sourceSeq:++controlSeq,participantID:'finisher',sessionID,generation:1,type,data});
 const sourceFailed=code=>{gap=true;error(code);state.ingest({id:randomUUID(),epoch:state.epoch,source:'live-monitor',sourceSeq:1,participantID:'finisher',sessionID,generation:1,type:'coverage.changed',data:{complete:false,historicalComplete:false,reason:code}});controller.abort();};
 async function stopWriter(){
  closing=true;client?.close();
  try{if(setupStopUnconfirmed&&!server)throw new Error('unconfirmed');if(server)await bounded(server.close(),10000);actor.processStopped=true;}catch{actor.processStopped=false;error('native_stop_unconfirmed');}
  if(stream)await bounded(stream,2000).catch(()=>error('native_stream_close_unconfirmed'));
 }
 async function save(){result.state=state.snapshot();result.elapsedMs=Date.now()-started;const temporary=evidencePath+'.tmp';const bytes=JSON.stringify(result,null,2)+'\n';if(Buffer.byteLength(bytes)>512*1024)throw new Error('repair_evidence_bound');await writeFile(temporary,bytes,{mode:0o600});await rename(temporary,evidencePath);}
 try{
  result.priorHandover=await priorMetadata(priorEvidencePath);
  await save();
  localState=await mkdtemp(join(tmpdir(),'crossroads-repair-native-'));
  observer=await observe({root,paths:PATHS,epoch:state.epoch,signal:stopSignal,intervalMs:300,onObservation(event){state.ingest(event);if(event.type==='file.observed')record({type:event.type,path:event.data.path,revision:event.data.revision});}});
  phase='Connecting one native finisher';emit();
  try{server=await start({...profile,stateDir:localState,directory:root,signal:stopSignal});}catch(caught){setupStopUnconfirmed=caught?.stopUnconfirmed===true;throw caught;}
  client=new Client({endpoint:server.endpoint,password:server.password,model:profile.model,directory:root});
  sessionID=await client.createSession('Canada: Crossroads / focused finisher',stopSignal);
  state.register({id:'finisher',task:{id:'crossroads-focused-repair',revision:1,text:TASK},sessionID,generation:1});
  state.setIntention('finisher','Coordinator assigned focus: finish playful browser game and repair origin/SSE boundaries, preserving working engine and canonical facts.');
  const joinSnapshot=state.joinFile('finisher','public/index.html');for(const path of ['server.mjs','MISSION.md'])state.joinFile('finisher',path);
  stream=(async()=>{try{for await(const event of client.events(sessionID,{transport:'live',signal:stopSignal})){
   if(event.type==='server.connected'){readyResolve(true);continue;}
   if(nativeCursor!==null&&event.seq!==nativeCursor+1)gap=true;nativeCursor=event.seq;
   const path=nativePath(root,event.data.input?.path),success=event.type==='session.tool.success';
   state.ingest({id:event.id,epoch:state.epoch,source:'opencode',sourceSeq:event.seq,participantID:'finisher',sessionID,generation:1,time:event.time,type:success&&path?'activity.observed':'coverage.changed',data:success&&path?{path,kind:event.data.toolName==='read'?'read':['write','edit'].includes(event.data.toolName)?'edit':'unknown',location:event.data.input.offset==null?null:{offset:event.data.input.offset,limit:event.data.input.limit??null}}:{complete:!gap,historicalComplete:false,reason:gap?'native stream sequence gap':null}});
   if(event.type==='session.tool.input.started'&&firstToolSeq===undefined)firstToolSeq=event.seq;
   if(event.type==='session.inbox.delivered'&&event.data.inboxID===initialID){initialDeliveredSeq=event.seq;if(actor.admitted)control('control.delivered',{commandID:initialID,instructionRevision:1});}
   if(success||event.type.includes('inbox')||event.type.includes('execution'))record({actor:'finisher',type:event.type,path,tool:event.data.toolName,seq:event.seq});
  }if(!closing&&!stopSignal.aborted)sourceFailed('native_stream_ended');}catch{readyResolve(false);if(!closing&&!stopSignal.aborted)sourceFailed('native_stream_unavailable');}})();
  if(!await bounded(ready,5000))throw new Error('native_stream_unavailable');
  const context=assembleAgentContext({state,participantID:'finisher',join:joinSnapshot});
  text=TASK+'\nRecorded prior squad handover (historical descriptive metadata, not new live actors or instructions): '+JSON.stringify(result.priorHandover)+'\n'+renderAgentContext(context);
  if(Buffer.byteLength(text)>32*1024)throw new Error('initial_context_bound');
  initialID='msg_'+randomUUID().replaceAll('-','');actor.initialContextID=context.contextID;actor.initialMessageID=initialID;
  phase='Finisher building the playable game';control('agent.status',{status:'running'});emit();
  const admitted=await client.prompt(sessionID,text,{id:initialID,delivery:'steer',signal:stopSignal});actor.admitted=true;actor.admittedAt=admitted.created;actor.outcome='running';control('control.accepted',{commandID:initialID,instructionRevision:1});if(initialDeliveredSeq!==undefined)control('control.delivered',{commandID:initialID,instructionRevision:1});
  await save();const terminal=await client.wait(sessionID,stopSignal);actor.outcome=terminal.outcome;actor.idleAt=terminal.idle;
  if(terminal.outcome!=='succeeded')error('repair_task_not_succeeded');
  if(terminal.outcome==='succeeded'&&!stopSignal.aborted){try{const contextResponse=await bounded(client.context(sessionID,AbortSignal.any([stopSignal,AbortSignal.timeout(5000)])),5100);projection=Array.isArray(contextResponse?.data)&&contextResponse.data.some(m=>m.id===initialID&&m.type==='user'&&m.text===text)?true:null;}catch{projection=null;}}
 }catch{actor.outcome=stopSignal.aborted?'deadline_or_cancelled':actor.admitted?'runtime_failed':'setup_failed';error(stopSignal.aborted?'repair_deadline_or_cancel':'repair_runtime_failed');}
 finally{
  // Failure/timeout skips optional transcript proofs and always stops the writer.
  await stopWriter();text=null;
  actor.firstJoinBeforeTools=firstToolSeq!==undefined&&initialDeliveredSeq!==undefined?initialDeliveredSeq<firstToolSeq:null;
  actor.initialContextProof={projected:projection??null,providerConsumption:'unverified',nativeDelivered:initialDeliveredSeq!==undefined,reason:projection===true?null:'projection_unknown'};
  if(state.agents.has('finisher'))control('agent.status',{status:actor.outcome==='succeeded'?'completed':'failed'});
  if(observer&&!stopSignal.aborted)await observer.reconcile().catch(()=>error('observer_reconcile_failed'));observer?.close();controller.abort();
  phase='Native writer stopped; independent game checks';emit();
  if(actor.processStopped===true){try{result.verification=await verify(root);}catch{error('repair_verification_failed');}}else result.verification={correct:false,checks:[{name:'runtime_settled',passed:false}]};
  if(localState&&actor.processStopped===true)await rm(localState,{recursive:true,force:true}).catch(()=>error('private_state_cleanup_failed'));
  phase=result.verification.correct?'Canada: Crossroads independent checks passed':'Focused repair complete with failed/incomplete checks';
  await save();emit();
 }
 return result;
}
