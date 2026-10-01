import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBenchmarkToolPaths } from './benchmark-tool-paths.mjs';

/** Diagnostic bridge: bounded metadata only; request-local context is not a durable message. */
export async function installBenchmarkPlugin(root, bridgeDirectory) {
  const cachePath = join(bridgeDirectory, 'context.json'), receiptPath = join(bridgeDirectory, 'receipts.jsonl');
  await mkdir(join(root, '.opencode/plugins/ingress-benchmark'), { recursive: true });
  await writeFile(cachePath, JSON.stringify({ revision: 0, compiledAt: Date.now(), actors: {} }), { mode: 0o600 });
  await writeFile(receiptPath, '', { mode: 0o600 });
  const source = `
import {readFileSync,appendFileSync,statSync} from 'node:fs';
const path=${JSON.stringify(cachePath)}, output=${JSON.stringify(receiptPath)};
let count=0;const contexts=new Map();
function record(row){if(count++<4096)appendFileSync(output,JSON.stringify({time:Date.now(),...row})+'\\n');}
function snapshot(){if(statSync(path).size>1024*1024)throw Error('bounded context');return JSON.parse(readFileSync(path,'utf8'));}
const extractPaths=${extractBenchmarkToolPaths.toString()};
async function marker(request,expected){
 if(!request.body)return false;
 const reader=request.clone().body.getReader();let bytes=0,text='',found=false;
 try{for(;;){const row=await reader.read();if(row.done)break;bytes+=row.value.byteLength;if(bytes>2*1024*1024)return null;
 text+=new TextDecoder().decode(row.value);if(text.includes(expected))found=true;text=text.slice(-128);}
 return found;}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export default {id:'ingress.benchmark',async setup(ctx){
 record({type:'setup',version:ctx.app.version});
 await ctx.session.hook('context',event=>{
 const began=performance.now();let current;
 const availableToolNames=Object.keys(event.tools).filter(name=>/^[a-zA-Z0-9_.-]{1,128}$/.test(name)).slice(0,128);
 const toolNameOmissions=Object.keys(event.tools).length-availableToolNames.length;
 try{current=snapshot();}catch{record({type:'bridge.error',sessionID:event.sessionID});return;}
 const actor=current.actors[event.sessionID];if(!actor)return;
 const injected=actor.condition==='awareness-on';
 if(injected)event.system.push({type:'text',text:'GCCTX:'+actor.contextID+'\\n'+actor.text});
 contexts.set(event.sessionID,{contextID:actor.contextID,injected});
 record({type:'context',sessionID:event.sessionID,contextID:actor.contextID,injected,bytes:injected?actor.bytes:0,
 revision:current.revision,availableToolNames,toolNameOmissions,ageMs:Math.max(0,Date.now()-current.compiledAt),durationMs:performance.now()-began});
 });
 await ctx.session.hook('http.request',async event=>{
 const expected=contexts.get(event.sessionID);if(!expected)return;
 let present=null;try{present=await marker(event.request,'GCCTX:'+expected.contextID);}catch{}
 record({type:'request',sessionID:event.sessionID,kind:event.kind,contextID:expected.contextID,
 injected:expected.injected,markerPresent:present});
 });
 await ctx.tool.hook('execute.before',event=>{const targets=extractPaths(event.input,event.tool);record({type:'tool.before',sessionID:event.sessionID,
 tool:event.tool,id:event.id,messageID:event.messageID,paths:targets.paths,pathsComplete:targets.complete});});
 await ctx.tool.hook('execute.after',event=>{const targets=extractPaths(event.input,event.tool);record({type:'tool.after',sessionID:event.sessionID,
 tool:event.tool,id:event.id,messageID:event.messageID,paths:targets.paths,pathsComplete:targets.complete,status:event.status});});
 return ()=>record({type:'cleanup'});
}};`;
  await writeFile(join(root, '.opencode/plugins/ingress-benchmark/index.ts'), source);
  return { cachePath, receiptPath, source };
}
