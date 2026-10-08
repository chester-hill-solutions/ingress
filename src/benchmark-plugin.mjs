import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBenchmarkToolPaths } from './benchmark-tool-paths.mjs';
import { createWriteFence, DEFAULT_LEASE_TTL_MS, WRITE_ACTIONS } from './native-fence.mjs';

/**
 * Diagnostic bridge: bounded metadata only; request-local context is not a durable message.
 *
 * When `fenceTtlMs` is a positive number, the plugin also arbitrates native writes: it
 * registers the runtime's permission-evaluation hook and refuses a write to a path another
 * session holds. That is the difference between observing the swarm and fencing it -- see
 * `src/native-fence.mjs` for why, and for what a refusal costs.
 */
export async function installBenchmarkPlugin(root, bridgeDirectory, { fenceTtlMs = null } = {}) {
  if (fenceTtlMs !== null && (!Number.isFinite(fenceTtlMs) || fenceTtlMs <= 0)) throw new RangeError('invalid_fence_ttl');
  const cachePath = join(bridgeDirectory, 'context.json'), receiptPath = join(bridgeDirectory, 'receipts.jsonl');
  await mkdir(join(root, '.opencode/plugins/ingress-benchmark'), { recursive: true });
  await writeFile(cachePath, JSON.stringify({ revision: 0, compiledAt: Date.now(), actors: {} }), { mode: 0o600 });
  await writeFile(receiptPath, '', { mode: 0o600 });
  // The fence policy is inlined, not imported: the plugin runs inside the OpenCode process,
  // which cannot resolve this repository's modules. Same reason `extractPaths` is inlined.
  const fenceSource = fenceTtlMs === null ? '' : `
const WRITE_ACTIONS=${JSON.stringify(WRITE_ACTIONS)};
const DEFAULT_LEASE_TTL_MS=${DEFAULT_LEASE_TTL_MS};
const createWriteFence=${createWriteFence.toString().replace(/^export /, '')};
const fence=createWriteFence({ttlMs:${fenceTtlMs}});`;
  const fenceHook = fenceTtlMs === null ? '' : `
 await ctx.permission.hook('evaluate',event=>{
  const verdict=fence.evaluate({sessionID:event.sessionID,action:event.action,resources:event.resources});
  record({type:'fence',sessionID:event.sessionID,action:event.action,resources:event.resources,decision:verdict.decision,heldBy:verdict.heldBy??null});
  if(verdict.decision==='deny'){event.effect='deny';event.message='file held by another agent: '+verdict.heldBy;}
 });`;
  const source = `
import {readFileSync,appendFileSync,statSync} from 'node:fs';
const path=${JSON.stringify(cachePath)}, output=${JSON.stringify(receiptPath)};
let count=0;const contexts=new Map();${fenceSource}
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
 // A session may be absent from the per-session map -- subagent sessions are created at
 // runtime and cannot be enumerated up front -- so a default entry carries the shared
 // context to them. When no default is set (the benchmark's case) this is unchanged.
 const actor=current.actors[event.sessionID]??current.default;if(!actor)return;
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
 tool:event.tool,id:event.id,messageID:event.messageID,paths:targets.paths,pathsComplete:targets.complete,status:event.status});});${fenceHook}
 return ()=>record({type:'cleanup'});
}};`;
  await writeFile(join(root, '.opencode/plugins/ingress-benchmark/index.ts'), source);
  return { cachePath, receiptPath, source, fenceTtlMs };
}
