import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {selectedProfile} from '../src/profile.mjs';
import {startOpenCode} from '../src/process.mjs';
import {OpenCodeClient,safeRuntimeError} from '../src/opencode.mjs';
import {installBenchmarkPlugin} from '../src/benchmark-plugin.mjs';
import {WorkspaceState} from '../src/workspace-state.mjs';
import {assembleAgentContext} from '../src/context.mjs';
import {boundedBenchmarkContext} from '../src/benchmark.mjs';

if(process.argv.slice(2).join(' ')!=='--real')throw Error('Opt-in native read/write probe: --real');
const root=await realpath(await mkdtemp(join(tmpdir(),'gangcode-model-preflight-')));
const workspace=join(root,'workspace'),receipts=join(root,'receipts.jsonl'),bridge=join(root,'bridge');
const models=['gpt-5-nano','deepseek-v4-flash'];
await mkdir(join(workspace,'.opencode/plugins/availability'),{recursive:true});
await mkdir(bridge);await writeFile(receipts,'');
for(const id of models)await writeFile(join(workspace,id+'.txt'),'before\n');
const plugin=await installBenchmarkPlugin(workspace,bridge);
// This observer records only model IDs, status codes and tool names. It never changes a menu.
await writeFile(join(workspace,'.opencode/plugins/availability/index.ts'),`
import{appendFileSync}from'node:fs';let n=0;
const record=row=>{if(n++<128)appendFileSync(${JSON.stringify(receipts)},JSON.stringify(row)+'\\n')};
export default{id:'benchmark.model-availability',async setup(ctx){
 await ctx.session.hook('context',event=>record({type:'menu',sessionID:event.sessionID,
  tools:Object.keys(event.tools).filter(name=>/^[a-zA-Z0-9_.-]{1,80}$/.test(name)).sort()}));
 await ctx.session.hook('http.response',event=>record({type:'http',sessionID:event.sessionID,
  model:event.model.id,kind:event.kind,status:event.response.status}));
 await ctx.tool.hook('execute.after',event=>record({type:'tool',sessionID:event.sessionID,
  tool:event.tool,status:event.status}));
}};
`);
const evidence={version:2,kind:'requested-model-native-gangcode-read-write',date:new Date().toISOString(),models,outcomes:[]};
const state=new WorkspaceState({epoch:randomUUID()});
let host;const clients=[];
try{
 const profile=await selectedProfile();
 host=await startOpenCode({...profile,directory:workspace,stateDir:join(root,'state')});
 const signal=AbortSignal.timeout(60000);
 const actors=await Promise.all(models.map(async id=>{
  const client=new OpenCodeClient({...host,directory:workspace,model:{providerID:'opencode',id},permissions:[
   {action:'*',resource:'*',effect:'deny'},
   ...['read','glob','grep'].map(action=>({action,resource:'*',effect:'allow'})),
   {action:'edit',resource:id+'.txt',effect:'allow'},
   {action:'external_directory',resource:'*',effect:'deny'}]});
  clients.push(client);
  const row={model:id};evidence.outcomes.push(row);
  row.sessionID=await client.createSession('Requested model native edit preflight',signal);
  const task='Read '+id+'.txt and change its complete contents to exactly after followed by a newline. Use your native file editing tool, then finish. Preserve every other file.';
  state.register({id,sessionID:row.sessionID,generation:1,task:{id,text:task,revision:1},dependencies:[]});
  return{id,client,row,task};
 }));
 const entries={};
 for(const actor of actors){
  const joinSnapshot=state.joinFile(actor.id,actor.id+'.txt');
  const context=assembleAgentContext({state,participantID:actor.id,join:joinSnapshot});
  const projection=boundedBenchmarkContext(context);
  entries[actor.row.sessionID]={condition:'awareness-on',contextID:projection.context.contextID,text:projection.text,bytes:projection.bytes};
 }
 await writeFile(plugin.cachePath,JSON.stringify({revision:state.version,compiledAt:Date.now(),actors:entries}));
 await Promise.all(actors.map(async actor=>{
  try{
   await actor.client.prompt(actor.row.sessionID,actor.task,{id:'msg_availability_'+actor.id.replaceAll('-','_'),signal});
   actor.row.terminal=await actor.client.wait(actor.row.sessionID,signal,{pollIntervalMs:100});
  }catch(error){actor.row.error=safeRuntimeError(error)}
 }));
}catch(error){evidence.error=safeRuntimeError(error);if(error?.stopUnconfirmed)evidence.stopUnconfirmed=true}
finally{
 for(const client of clients)client.close();
 try{await host?.close();evidence.stopped=!evidence.stopUnconfirmed}catch(error){evidence.stopped=false;evidence.stopError=safeRuntimeError(error)}
}
evidence.receipts=(await readFile(receipts,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
evidence.pluginReceipts=(await readFile(plugin.receiptPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
evidence.nativeBytesVerified=(await Promise.all(models.map(async id=>await readFile(join(workspace,id+'.txt'),'utf8')==='after\n'))).every(Boolean);
evidence.contextSerialized=evidence.outcomes.length===2&&evidence.outcomes.every(row=>evidence.pluginReceipts.some(r=>r.type==='request'&&r.kind==='primary'&&r.sessionID===row.sessionID&&r.markerPresent===true));
evidence.nativeBytesChanged=(await Promise.all(models.map(async id=>await readFile(join(workspace,id+'.txt'),'utf8')!=='before\n'))).every(Boolean);
evidence.passed=evidence.stopped===true&&!evidence.error&&evidence.nativeBytesChanged&&evidence.contextSerialized&&evidence.outcomes.length===2&&evidence.outcomes.every(row=>row.terminal?.outcome==='succeeded'&&evidence.receipts.some(r=>r.type==='tool'&&r.sessionID===row.sessionID&&['patch','write','edit'].includes(r.tool)&&r.status==='completed'));
await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:evidence.passed,stopped:evidence.stopped,nativeBytesVerified:evidence.nativeBytesVerified,nativeBytesChanged:evidence.nativeBytesChanged,contextSerialized:evidence.contextSerialized,outcomes:evidence.outcomes.map(row=>({model:row.model,outcome:row.terminal?.outcome??'unknown',error:row.error})),http:evidence.receipts.filter(row=>row.type==='http').map(row=>({model:row.model,kind:row.kind,status:row.status})),evidence:join(root,'evidence.json')}));
if(!evidence.passed)process.exitCode=1;
