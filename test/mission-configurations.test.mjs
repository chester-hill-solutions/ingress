import test from 'node:test';
import assert from 'node:assert/strict';
import { missionFixtures, validateMission, verifyMissionFixture } from '../fixtures/missions.mjs';
import { missionConfigurations, configureMission, assignMissions } from '../fixtures/mission-configurations.mjs';

test('nine broad missions cover research, math, SaaS, map and analytics with eight real streams each',()=>{
  // The registry grew by one when Signal, the site analytics mission, was added: the counts here
  // are the fixture inventory, and a study that pre-registers its matrix names its missions with
  // --missions=, so it is unaffected by an addition it did not select.
  assert.equal(missionFixtures.length,9);
  for(const domain of ['research','math','saas'])assert.equal(missionFixtures.filter(value=>value.domain===domain).length,2);
  assert.equal(missionFixtures.filter(value=>value.domain==='map').length,1);
  assert.equal(missionFixtures.filter(value=>value.domain==='analytics').length,2);
  for(const fixture of missionFixtures){assert.equal(validateMission(fixture),fixture);assert.equal(fixture.workstreams.length,8);assert.ok(fixture.criteria.length>=8);}
});
test('same complete directive and seed at every roster size and treatment',()=>{
  for(const base of missionFixtures){let seed,directive;
    for(const config of missionConfigurations){const fixture=configureMission(base,config.id);seed??=fixture.seedHash;directive??=fixture.directiveHash;assert.equal(fixture.seedHash,seed);assert.equal(fixture.directiveHash,directive);assert.equal(fixture.canonicalGoal,base.goal);assert.equal(fixture.tasks.length,config.agentCount);assert.equal(fixture.phases.length,1);assert.equal(fixture.phases[0].length,config.agentCount);assert.ok(fixture.tasks.every(value=>Buffer.byteLength(value.text)<=4096));assert.deepEqual(new Set(fixture.tasks.flatMap(value=>value.role.split('+'))),new Set(base.workstreams.map(value=>value.id)));}
  }
});
test('stock and treated same-size rosters have identical assignments and only awareness settings differ',()=>{
  for(const base of missionFixtures)for(const size of ['two','four','eight']){const stock=configureMission(base,'stock-'+size),treated=configureMission(base,'ingress-'+size);assert.deepEqual(stock.tasks,treated.tasks);assert.deepEqual(stock.files,treated.files);assert.equal(stock.nativePlugin,false);assert.equal(treated.nativePlugin,true);}
});
test('full preregistered repeat matrix contains matched stock baselines at 2,4,8 and stock solo',()=>{
  // 9 missions x 3 repeats x 2 models x 7 configurations = 378 rows; 29 actors per
  // (mission, repeat, model) across the roster sizes (1+2+2+4+4+8+8) = 1392 actors.
  const rows=assignMissions(missionFixtures);assert.equal(rows.length,378);assert.equal(rows.reduce((n,value)=>n+value.actors.length,0),1566);
  assert.deepEqual(rows,assignMissions(missionFixtures));assert.notDeepEqual(rows,assignMissions(missionFixtures,{seed:20}));
  assert.equal(new Set(rows.map(value=>value.id)).size,378);assert.ok(rows.every(value=>value.outcome==='not-run'&&value.assigned));
});
test('unsafe or partial mission definitions are rejected',()=>{
  const base=structuredClone(missionFixtures[0]);base.workstreams.pop();assert.throws(()=>validateMission(base));assert.throws(()=>configureMission(base,'unknown'));
  assert.throws(()=>assignMissions(missionFixtures,{configs:['stock-four','stock-four']}));assert.throws(()=>verifyMissionFixture('unknown','/tmp'));
  const broken=structuredClone(missionFixtures[0]);broken.files['../private']='secret';assert.throws(()=>validateMission(broken));
});
test('a model selection narrows the matrix and keeps the assignments it keeps', () => {
  // A flight of one cheap model should not pay for a cohort nobody asked for, and the selection
  // must not quietly change what the remaining rows contain.
  const rows = assignMissions(missionFixtures, { repeats: 1, configs: ['stock-eight'], models: ['deepseek-v4-flash'] });
  assert.equal(rows.length, missionFixtures.length);
  assert.ok(rows.every(row => row.actorModels.length === 8 && row.actorModels.every(model => model.id === 'deepseek-v4-flash')));
  const both = assignMissions(missionFixtures, { repeats: 1, configs: ['stock-eight'] });
  assert.equal(both.length, missionFixtures.length * 2);
  assert.throws(() => assignMissions(missionFixtures, { models: ['gpt-5'] }), /invalid_mission_assignment/);
});
