import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFixtures } from '../fixtures/benchmarks.mjs';
import { benchmarkConfigurations, configureBenchmarkFixture } from '../fixtures/benchmark-configurations.mjs';

test('configuration metadata exposes stock baselines, role scales and bounded tuning without models',()=>{
  assert.deepEqual(benchmarkConfigurations.map(c=>c.id),['stock-solo','stock-parallel-pair','ingress-pair','ingress-four','ingress-eight','builder-reviewer','ingress-pair-small-context','ingress-pair-slow-updates']);
  for(const config of benchmarkConfigurations){assert.equal(config.mixModels,'per_actor_assignment');assert.equal(Object.hasOwn(config,'model'),false);assert.ok(Object.isFrozen(config));}
  const stock=benchmarkConfigurations.filter(c=>c.id.startsWith('stock-'));assert.ok(stock.every(c=>!c.nativePlugin&&!c.awareness&&c.contextBytes===0));
  assert.equal(benchmarkConfigurations.find(c=>c.id==='ingress-pair-small-context').contextBytes,8192);
  assert.equal(benchmarkConfigurations.find(c=>c.id==='ingress-pair-slow-updates').cacheIntervalMs,500);
});

for(const fixture of benchmarkFixtures)test(`${fixture.id}: all layouts preserve fixture outcome, scope and canonical combined goal`,()=>{
  const before=structuredClone(fixture),configs=benchmarkConfigurations.map(c=>configureBenchmarkFixture(fixture,c.id));
  assert.equal(new Set(configs.map(c=>c.canonicalGoal)).size,1);
  for(const result of configs){
    for(const key of ['files','criteria','protectedPaths','editablePaths']){assert.deepEqual(result[key],fixture[key]);assert.notEqual(result[key],fixture[key]);}
    assert.equal(result.id,fixture.id);assert.equal(result.title,fixture.title);assert.equal(result.fixtureID,fixture.id);assert.equal(result.tasks.length,result.agentCount);
    assert.equal(new Set(result.tasks.map(task=>task.id)).size,result.tasks.length);
    assert.deepEqual([...result.phases.flat()].sort(),result.tasks.map(task=>task.id).sort());
    assert.ok(result.tasks.every(task=>Buffer.byteLength(task.text)<=4096&&!task.text.includes('one peer')));
    assert.ok(result.tasks.every(task=>!Object.hasOwn(task,'ownedFiles')&&!Object.hasOwn(task,'ownedPaths')&&!Object.hasOwn(task,'model')));
    for(const task of result.tasks)for(const edge of task.dependencies){assert.ok(Object.hasOwn(fixture.files,edge.producerPath));assert.ok(Object.hasOwn(fixture.files,edge.consumerPath));}
    assert.equal(result.oversubscription.benefit,'unmeasured');
  }
  assert.deepEqual(fixture,before);
  const solo=configs.find(c=>c.configurationID==='stock-solo');assert.deepEqual(solo.phases,[['solo']]);assert.equal(solo.peakPlannedConcurrency,1);assert.ok(solo.tasks[0].text.includes(solo.canonicalGoal));assert.equal(/\bpeer\b|other assigned roles/.test(solo.tasks[0].text),false);
  const pair=configs.find(c=>c.configurationID==='stock-parallel-pair');assert.deepEqual(pair.tasks.map(t=>t.id),fixture.tasks.map(t=>t.id));assert.deepEqual(pair.tasks.map(t=>t.dependencies),fixture.tasks.map(t=>t.dependencies));
  const four=configs.find(c=>c.configurationID==='ingress-four');assert.equal(four.peakPlannedConcurrency,4);assert.deepEqual(four.tasks.slice(2).map(t=>t.role),['input-errors','api-immutability']);
  const eight=configs.find(c=>c.configurationID==='ingress-eight');assert.equal(eight.peakPlannedConcurrency,8);assert.equal(new Set(eight.tasks.map(t=>t.text)).size,8);assert.equal(new Set(eight.tasks.map(t=>t.role)).size,8);assert.equal(eight.oversubscription.possible,true);
  const review=configs.find(c=>c.configurationID==='builder-reviewer');assert.deepEqual(review.phases,[['builder'],['reviewer']]);assert.equal(review.peakPlannedConcurrency,1);assert.ok(review.tasks.every(t=>t.text.includes(review.canonicalGoal)));
});

test('returned configurations are independent copies and unknown input is explicit',()=>{
  const fixture=benchmarkFixtures[0],first=configureBenchmarkFixture(fixture,'ingress-pair'),second=configureBenchmarkFixture(fixture,'ingress-pair');first.files['currency.mjs']='changed';first.tasks[0].dependencies[0].producerPath='changed';first.criteria[0].description='changed';assert.deepEqual(second.files,fixture.files);assert.deepEqual(second.tasks[0].dependencies,fixture.tasks[0].dependencies);assert.deepEqual(second.criteria,fixture.criteria);
  assert.throws(()=>configureBenchmarkFixture(fixture,'unknown'),/unknown_benchmark_configuration/);
  assert.throws(()=>configureBenchmarkFixture({...fixture,tasks:[]},'ingress-pair'),/invalid_two_agent_benchmark/);
});
