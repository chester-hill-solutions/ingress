import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {benchmarkFixtures} from '../fixtures/benchmarks.mjs';
import {configureBenchmarkFixture} from '../fixtures/benchmark-configurations.mjs';
import {assignBenchmarkStudy} from '../fixtures/benchmark-study.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('entire frozen study preassigns144 cohorts and324 actors before execution',()=>{
  const rows=assignBenchmarkStudy(benchmarkFixtures);
  assert.equal(rows.length,144);assert.equal(rows.flatMap(row=>row.actors).length,324);assert.equal(new Set(rows.map(row=>row.id)).size,144);
  assert.deepEqual([...new Set(rows.map(row=>row.repeat))],[1,2,3]);
  for(const repeat of [1,2,3]){const block=rows.filter(row=>row.repeat===repeat);assert.equal(block.length,48);assert.equal(block.filter(row=>row.studyVariant==='core').length,18);assert.equal(block.filter(row=>row.studyVariant==='role-context-tuning').length,15);assert.equal(block.filter(row=>row.studyVariant==='additional-model').length,12);assert.equal(block.filter(row=>row.studyVariant==='mixed-pair').length,3);}
  assert.ok(rows.every(row=>row.assigned&&row.outcome==='not-run'&&!row.correct&&row.deadlineMs===90000));
  assert.ok(rows.flatMap(row=>row.actors).every(actor=>actor.assigned&&!actor.admitted&&actor.outcome==='not-run'&&actor.processStopped===null));
});

test('seeded within-repeat scheduling is reproducible and independent of input fixture order',()=>{
  const first=assignBenchmarkStudy(benchmarkFixtures),same=assignBenchmarkStudy([...benchmarkFixtures].reverse()),changed=assignBenchmarkStudy(benchmarkFixtures,{seed:104730});
  assert.deepEqual(first,same);assert.notDeepEqual(first.map(row=>row.id),changed.map(row=>row.id));
  assert.deepEqual([...first.map(row=>row.id)].sort(),[...changed.map(row=>row.id)].sort());
  for(const repeat of [1,2,3])assert.ok(first.filter(row=>row.repeat===repeat).some((row,index,array)=>index>0&&row.studyVariant!==array[index-1].studyVariant));
});

test('goal and seed hashes match runner configuration exactly and remain invariant across arms',()=>{
  const fixtures=new Map(benchmarkFixtures.map(f=>[f.id,f])),rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:1});
  for(const row of rows){const base=fixtures.get(row.fixtureID),configured=configureBenchmarkFixture(base,row.configID);assert.equal(row.workGoalHash,hash(configured.canonicalGoal));assert.equal(row.seedHash,hash(JSON.stringify(base.files)));assert.equal(row.actorModels.length,configured.tasks.length);assert.deepEqual(row.phases,configured.phases);assert.equal(row.condition,configured.awareness?'awareness-on':'awareness-off');assert.equal(row.system,configured.nativePlugin?'gangcode':'stock');assert.deepEqual(row.actors.map(a=>a.id),configured.tasks.map(t=>t.id));assert.deepEqual(row.actors.map(a=>a.model),row.actorModels);}
  for(const fixtureID of fixtures.keys()){const matched=rows.filter(row=>row.fixtureID===fixtureID);assert.equal(new Set(matched.map(row=>row.workGoalHash)).size,1);assert.equal(new Set(matched.map(row=>row.seedHash)).size,1);}
});

test('homogeneous and mixed models have sorted unique identities with alternating role allocations',()=>{
  const rows=assignBenchmarkStudy(benchmarkFixtures),mixed=rows.filter(row=>row.studyVariant==='mixed-pair');
  assert.equal(mixed.length,9);
  for(const row of mixed){assert.equal(row.configID,'gang-pair');assert.equal(row.modelSet,'opencode/gpt-5-nano+opencode/space-bunny-free');assert.equal(new Set(row.actorModels.map(model=>model.id)).size,2);assert.ok(row.id.includes('mixed-pair'));}
  const shared=mixed.filter(row=>row.fixtureID==='shared-features').sort((a,b)=>a.repeat-b.repeat);assert.notDeepEqual(shared[0].actorModels,shared[1].actorModels);assert.deepEqual(shared[0].actorModels,shared[2].actorModels);
  const extra=rows.filter(row=>row.studyVariant==='additional-model');assert.equal(extra.length,36);assert.deepEqual([...new Set(extra.map(row=>row.modelSet))].sort(),['opencode/deepseek-v4-flash','opencode/gpt-5-nano']);assert.ok(extra.every(row=>['stock-solo','gang-pair'].includes(row.configID)));
});

test('baseline choice distinguishes matched pairs, practical alternatives and unmatched mixed arms',()=>{
  const rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:1});
  for(const row of rows){if(row.system==='stock'){assert.equal(row.baselineConfigID,null);assert.equal(row.baselineAvailable,null);}else if(row.studyVariant==='mixed-pair'){assert.equal(row.baselineConfigID,'stock-parallel-pair');assert.equal(row.baselineAvailable,false);}else{assert.equal(row.baselineAvailable,true);if(row.studyVariant==='additional-model'||row.configID==='builder-reviewer'||row.plannedAgentCount>2){assert.equal(row.baselineConfigID,'stock-solo');assert.equal(row.baselineKind,'practical-stock-alternative-not-equal-compute');}else assert.equal(row.baselineConfigID,'stock-parallel-pair');}}
});

test('planned protocol is deeply frozen while callers can clone mutable execution evidence',()=>{
  const rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:1}),copy=structuredClone(rows);assert.ok(Object.isFrozen(rows));assert.ok(Object.isFrozen(rows[0]));assert.ok(Object.isFrozen(rows[0].actors[0]));assert.ok(Object.isFrozen(rows[0].actorModels[0]));assert.ok(Object.isFrozen(rows[0].phases[0]));assert.throws(()=>{rows[0].actors[0].outcome='succeeded';},TypeError);copy[0].actors[0].outcome='succeeded';assert.equal(rows[0].actors[0].outcome,'not-run');
});

test('bounds, duplicate fixtures and conflicting main candidates fail explicitly',()=>{
  for(const options of [{repeats:0},{repeats:11},{seed:-1},{seed:2**32},{seed:1.2},{mainModel:{providerID:'opencode',id:'gpt-5-nano'}},{mainModel:{providerID:'opencode',id:'deepseek-v4-flash'}}])assert.throws(()=>assignBenchmarkStudy(benchmarkFixtures,options),RangeError);
  assert.throws(()=>assignBenchmarkStudy(benchmarkFixtures.slice(1)),/invalid_benchmark_study/);assert.throws(()=>assignBenchmarkStudy([...benchmarkFixtures.slice(0,5),benchmarkFixtures[0]]),/invalid_benchmark_study/);assert.throws(()=>assignBenchmarkStudy(benchmarkFixtures,{mainModel:{providerID:'private prose',id:'model'}}),/invalid_study_model/);
  const rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:1,mainModel:{providerID:'custom',id:'model:release/v1',ignored:'NOT_PERSISTED'}});assert.ok(rows.every(row=>/^[a-z0-9-]+$/.test(row.id)&&row.id.length<=128));assert.equal(JSON.stringify(rows).includes('NOT_PERSISTED'),false);assert.ok(rows.filter(row=>row.studyVariant==='core').every(row=>row.modelSet==='custom/model:release/v1'));
});


test('maximum accepted repeat and model labels keep safe bounded unique assignment IDs',()=>{
  const rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:10,mainModel:{providerID:'p'.repeat(64),id:'m'.repeat(128)}});
  assert.equal(rows.length,480);assert.ok(rows.every(row=>row.id.length<=128));assert.equal(new Set(rows.map(row=>row.id)).size,480);
});


test('additional candidates are explicit bounded distinct models without alias rewriting',()=>{
  const models=[{providerID:'custom',id:'first:v1',ignored:'NOT_PERSISTED'},{providerID:'opencode',id:'deepseek-v4-flash'}];
  const rows=assignBenchmarkStudy(benchmarkFixtures,{repeats:1,additionalModels:models});
  assert.equal(rows.length,48);assert.equal(rows.flatMap(row=>row.actors).length,108);
  assert.deepEqual([...new Set(rows.filter(row=>row.studyVariant==='additional-model').map(row=>row.modelSet))].sort(),['custom/first:v1','opencode/deepseek-v4-flash']);
  assert.ok(rows.filter(row=>row.studyVariant==='mixed-pair').every(row=>row.modelSet==='custom/first:v1+opencode/space-bunny-free'));
  assert.equal(JSON.stringify(rows).includes('NOT_PERSISTED'),false);
  models[0].id='changed-after-assignment';
  assert.ok(rows.some(row=>row.modelSet==='custom/first:v1'));
  for(const additionalModels of [null,[],[models[0]],[...models,models[0]], [models[0],models[0]], [{providerID:'opencode',id:'space-bunny-free'},models[0]]])assert.throws(()=>assignBenchmarkStudy(benchmarkFixtures,{additionalModels}),RangeError);
  assert.throws(()=>assignBenchmarkStudy(benchmarkFixtures,{additionalModels:[{providerID:'invalid label',id:'a'},models[0]]}),/invalid_study_model/);
  const historical=assignBenchmarkStudy(benchmarkFixtures,{repeats:1,additionalModels:[{providerID:'opencode',id:'big-pickle'},{providerID:'opencode',id:'mimo-v2.6-flash-free'}]});
  assert.ok(historical.some(row=>row.modelSet==='opencode/big-pickle'));
  assert.deepEqual(assignBenchmarkStudy(benchmarkFixtures),assignBenchmarkStudy(benchmarkFixtures,{additionalModels:[{providerID:'opencode',id:'gpt-5-nano'},{providerID:'opencode',id:'deepseek-v4-flash'}]}));
});
