import test from 'node:test';
import assert from 'node:assert/strict';
import { missionFixtures, validateMission, verifyMissionFixture } from '../fixtures/missions.mjs';
import { missionConfigurations, configureMission, assignMissions } from '../fixtures/mission-configurations.mjs';

test('six broad missions cover research, math and SaaS with eight real streams each',()=>{
  assert.equal(missionFixtures.length,6);
  for(const domain of ['research','math','saas'])assert.equal(missionFixtures.filter(value=>value.domain===domain).length,2);
  for(const fixture of missionFixtures){assert.equal(validateMission(fixture),fixture);assert.equal(fixture.workstreams.length,8);assert.ok(fixture.criteria.length>=8);}
});
test('same complete directive and seed at every roster size and treatment',()=>{
  for(const base of missionFixtures){let seed,directive;
    for(const config of missionConfigurations){const fixture=configureMission(base,config.id);seed??=fixture.seedHash;directive??=fixture.directiveHash;assert.equal(fixture.seedHash,seed);assert.equal(fixture.directiveHash,directive);assert.equal(fixture.canonicalGoal,base.goal);assert.equal(fixture.tasks.length,config.agentCount);assert.equal(fixture.phases.length,1);assert.equal(fixture.phases[0].length,config.agentCount);assert.ok(fixture.tasks.every(value=>Buffer.byteLength(value.text)<=4096));assert.deepEqual(new Set(fixture.tasks.flatMap(value=>value.role.split('+'))),new Set(base.workstreams.map(value=>value.id)));}
  }
});
test('stock and treated same-size rosters have identical assignments and only awareness settings differ',()=>{
  for(const base of missionFixtures)for(const size of ['two','four','eight']){const stock=configureMission(base,'stock-'+size),gang=configureMission(base,'gang-'+size);assert.deepEqual(stock.tasks,gang.tasks);assert.deepEqual(stock.files,gang.files);assert.equal(stock.nativePlugin,false);assert.equal(gang.nativePlugin,true);}
});
test('full preregistered repeat matrix contains matched stock baselines at 2,4,8 and stock solo',()=>{
  const rows=assignMissions(missionFixtures);assert.equal(rows.length,252);assert.equal(rows.reduce((n,value)=>n+value.actors.length,0),1044);
  assert.deepEqual(rows,assignMissions(missionFixtures));assert.notDeepEqual(rows,assignMissions(missionFixtures,{seed:20}));
  assert.equal(new Set(rows.map(value=>value.id)).size,252);assert.ok(rows.every(value=>value.outcome==='not-run'&&value.assigned));
});
test('unsafe or partial mission definitions are rejected',()=>{
  const base=structuredClone(missionFixtures[0]);base.workstreams.pop();assert.throws(()=>validateMission(base));assert.throws(()=>configureMission(base,'unknown'));
  assert.throws(()=>assignMissions(missionFixtures,{configs:['stock-four','stock-four']}));assert.throws(()=>verifyMissionFixture('unknown','/tmp'));
  const broken=structuredClone(missionFixtures[0]);broken.files['../private']='secret';assert.throws(()=>validateMission(broken));
});
