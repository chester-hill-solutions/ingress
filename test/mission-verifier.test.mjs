import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMission, readMissionFile } from '../src/mission-verifier.mjs';
import { gradeMissionSnapshot } from '../src/mission-snapshots.mjs';

async function setup(t, source='export async function run(x){return {value:x*2}}') {
  const root=await mkdtemp(join(tmpdir(),'mission-verifier-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files={'work.mjs':source,'inputs.json':'{"public":true}\n'};
  for(const [path,text]of Object.entries(files))await writeFile(join(root,path),text);
  return {root,fixture:{id:'verifier-test',files,protectedPaths:['inputs.json'],editablePaths:['work.mjs'],criteria:[{id:'behavior'}]}};
}
test('submission sees only public invocation input; private oracle remains in parent',async t=>{
  const {root,fixture}=await setup(t);const secret=918273;
  const result=await verifyMission(fixture,root,async({invoke,check})=>{const value=await invoke('work.mjs','run',[12]);await check('behavior',()=>{assert.deepEqual(value,{value:24});assert.equal(secret,918273)});});
  assert.equal(result.correct,true);
});
test('missing criterion cannot silently produce a passing grade',async t=>{
  const {root,fixture}=await setup(t);const result=await verifyMission(fixture,root,async({check})=>check('other',()=>{}));assert.equal(result.correct,false);assert.equal(result.checks.find(v=>v.name==='behavior').passed,false);
});
test('submission cannot write protected bytes, read private oracle files or spawn processes',async t=>{
  const {root,fixture}=await setup(t,`import {writeFile,readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';export async function run(){const out={};try{await writeFile('inputs.json','changed');out.write=true}catch{out.write=false}try{await readFile(${JSON.stringify(import.meta.filename)});out.read=true}catch{out.read=false}try{spawnSync(process.execPath,['-e','']);out.spawn=true}catch{out.spawn=false}return out}`);
  const result=await verifyMission(fixture,root,async({invoke,check})=>{const value=await invoke('work.mjs','run',[]);await check('behavior',()=>assert.deepEqual(value,{write:false,read:false,spawn:false}));});assert.equal(result.correct,true);assert.equal(await readFile(join(root,'inputs.json'),'utf8'),fixture.files['inputs.json']);
});
test('submission network access is denied under Node permission model',async t=>{
  const {root,fixture}=await setup(t,`export async function run(){try{await fetch('http://127.0.0.1:38001');return 'allowed'}catch(e){return e.code??e.cause?.code??e.message}}`);
  const result=await verifyMission(fixture,root,async({invoke,check})=>{const value=await invoke('work.mjs','run',[]);await check('behavior',()=>assert.equal(value,'ERR_ACCESS_DENIED'));});assert.equal(result.correct,true);
});
test('symlinks and undeclared paths fail before evaluating submission',async t=>{
  const {root,fixture}=await setup(t);await rm(join(root,'work.mjs'));await symlink(import.meta.filename,join(root,'work.mjs'));let evaluated=false;
  const result=await verifyMission(fixture,root,async()=>{evaluated=true});assert.equal(result.correct,false);assert.equal(evaluated,false);await assert.rejects(readMissionFile(root,'../secret'));
});
test('malformed and chatty export results fail closed',async t=>{
  const {root,fixture}=await setup(t,`export const run=()=>{console.log('prose');return {ok:true}}`);
  const result=await verifyMission(fixture,root,async({invoke,check})=>check('behavior',async()=>invoke('work.mjs','run',[])));assert.equal(result.correct,false);
});
test('snapshot grading uses an immutable copy and records its observation limits',async t=>{
  const {root,fixture}=await setup(t);let copy;
  const result=await gradeMissionSnapshot(fixture,root,async(id,snapshot)=>{copy=snapshot;assert.notEqual(snapshot,root);assert.equal(id,fixture.id);await writeFile(join(root,'work.mjs'),'later edit');assert.equal(await readFile(join(snapshot,'work.mjs'),'utf8'),fixture.files['work.mjs']);return {correct:true,checks:[],instructionChecks:[]}});
  assert.equal(result.status,'graded');assert.equal(result.verification.correct,true);assert.match(result.basis,/nonatomic/);await assert.rejects(readFile(join(copy,'work.mjs')));
});
