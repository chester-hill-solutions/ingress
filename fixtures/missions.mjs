import { researchMissions, verifyResearchMission } from './missions/research.mjs';
import { mathMissions, verifyMathMission } from './missions/math.mjs';
import { saasMissions, verifySaasMission } from './missions/saas.mjs';
import { missionPath, missionBounds } from '../src/mission-verifier.mjs';

export const missionFixtures = [...researchMissions, ...mathMissions, ...saasMissions];
export function validateMission(fixture) {
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(fixture.id) || !['research', 'math', 'saas'].includes(fixture.domain) || typeof fixture.title !== 'string' || typeof fixture.goal !== 'string' || Buffer.byteLength(fixture.goal) > 7000 || !Array.isArray(fixture.workstreams) || fixture.workstreams.length !== 8) throw Error('invalid_mission');
  const paths = Object.keys(fixture.files), protectedPaths = new Set(fixture.protectedPaths), editablePaths = new Set(fixture.editablePaths);
  if (paths.length > missionBounds.files || protectedPaths.size !== fixture.protectedPaths.length || editablePaths.size !== fixture.editablePaths.length || paths.some(path => !protectedPaths.has(path) && !editablePaths.has(path)) || [...protectedPaths, ...editablePaths].some(path => !paths.includes(path)) || [...protectedPaths].some(path => editablePaths.has(path))) throw Error('invalid_mission_scope');
  let bytes = 0;
  for (const path of paths) {
    missionPath(path);
    if (typeof fixture.files[path] !== 'string' || Buffer.byteLength(fixture.files[path]) > missionBounds.fileBytes) throw Error('invalid_mission_seed');
    bytes += Buffer.byteLength(fixture.files[path]);
  }
  if (bytes > missionBounds.totalBytes || new Set(fixture.criteria.map(c => c.id)).size !== fixture.criteria.length || !fixture.criteria.length) throw Error('invalid_mission_bounds');
  const streams = new Set();
  for (const stream of fixture.workstreams) {
    if (!/^[a-z][a-z0-9-]{1,80}$/.test(stream.id) || streams.has(stream.id) || typeof stream.brief !== 'string' || Buffer.byteLength(stream.brief) > 1200 || !Array.isArray(stream.paths) || !stream.paths.length || stream.paths.some(path => !editablePaths.has(path)) || !Array.isArray(stream.dependencies)) throw Error('invalid_mission_stream');
    streams.add(stream.id);
    for (const edge of stream.dependencies) if (!paths.includes(edge.producerPath) || !paths.includes(edge.consumerPath)) throw Error('invalid_mission_dependency');
  }
  if ([...editablePaths].some(path => !fixture.workstreams.some(stream => stream.paths.includes(path)))) throw Error('unassigned_mission_output');
  return fixture;
}
missionFixtures.forEach(validateMission);
if (new Set(missionFixtures.map(value => value.id)).size !== missionFixtures.length) throw Error('duplicate_mission');
export function verifyMissionFixture(id, root) {
  const fixture = missionFixtures.find(value => value.id === id);
  if (!fixture) throw Error('unknown_mission');
  return ({ research: verifyResearchMission, math: verifyMathMission, saas: verifySaasMission })[fixture.domain](id, root);
}
