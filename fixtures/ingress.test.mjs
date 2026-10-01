import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {seedIngress,ingressTasks,ingressSpec} from './ingress.mjs';
test('Crossroads seed copies canonical facts, four roles, unfinished modules and no evaluator',async()=>{
 const root=await mkdtemp(join(tmpdir(),'crossroads-seed-'));
 try {
  const fixture=await seedIngress(root);
  assert.deepEqual(fixture.tasks.map(t=>t.id),['content','engine','server','ui']);
  assert.deepEqual(fixture.paths.sort(),['MISSION.md','README.md','data/history.json','engine.mjs','package.json','public/index.html','server.mjs'].sort());
  assert.deepEqual((await readdir(root)).sort(),['MISSION.md','README.md','data','engine.mjs','package.json','public','server.mjs'].sort());
  assert.equal(await readFile(join(root,'data/history.json'),'utf8'),await readFile(new URL('./canadian-history.json',import.meta.url),'utf8'));
  const engine=await import(pathToFileURL(join(root,'engine.mjs')));assert.throws(()=>engine.createGame().snapshot(),/TODO/);
  const server=await import(pathToFileURL(join(root,'server.mjs')));await assert.rejects(server.createGameServer(),/TODO/);
  assert.equal(JSON.parse(await readFile(join(root,'package.json'),'utf8')).scripts.start,'node server.mjs');
  assert.equal(await readFile(join(root,'MISSION.md'),'utf8'),ingressSpec);
  for(const task of fixture.tasks){assert.match(task.task,/SAME workspace/);for(const path of task.files)assert.ok(fixture.paths.includes(path));for(const edge of task.dependencies){assert.ok(fixture.paths.includes(edge.producerPath));assert.ok(fixture.paths.includes(edge.consumerPath));}}
  fixture.tasks[0].files.push('modified');assert.equal(ingressTasks[0].files.length,2);
  await assert.rejects(seedIngress(root),error=>error.code==='EEXIST');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing canonical data fails before seeding placeholder files',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'crossroads-missing-')),root=join(temp,'game');
 try {await assert.rejects(seedIngress(root,{historyPath:join(temp,'absent.json')}));await assert.rejects(readdir(root),error=>error.code==='ENOENT');}
 finally{await rm(temp,{recursive:true,force:true});}
});
