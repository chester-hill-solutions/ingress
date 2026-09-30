import { createHash } from 'node:crypto';

export const missionConfigurations = [
  ['stock-solo', 1, false], ['stock-two', 2, false], ['gang-two', 2, true],
  ['stock-four', 4, false], ['gang-four', 4, true], ['stock-eight', 8, false], ['gang-eight', 8, true],
].map(([id, agentCount, nativePlugin]) => Object.freeze({ id, agentCount, nativePlugin }));
const guidance = 'Read protected MISSION.md first, then the public contracts and inputs it references. All requirements in MISSION.md apply to the complete result. Use native file tools; no packages, shell processes or nested agents. Preserve all protected files byte-for-byte. Work concurrently through shared source and contracts. File focus is not exclusive ownership; inspect peer changes and preserve useful work. Do not include authors, model names or team identity in deliverables.\n';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function configureMission(base, configID) {
  const config = missionConfigurations.find(value => value.id === configID);
  if (!config || base.workstreams.length !== 8) throw Error('invalid_mission_configuration');
  const perActor = 8 / config.agentCount;
  const dependencies = [...new Map(base.workstreams.flatMap(value => value.dependencies).map(edge => [JSON.stringify(edge), edge])).values()];
  if (dependencies.length > 64) throw Error('mission_dependency_bounds');
  const files = { ...base.files, 'MISSION.md': `# ${base.title}\n\n${base.goal}\n\n## Workstreams\n\n` + base.workstreams.map(stream => `### ${stream.role ?? stream.id}\n${stream.brief}\nFiles: ${stream.paths.join(', ')}\n`).join('\n') };
  const tasks = Array.from({ length: config.agentCount }, (_, index) => {
    const streams = base.workstreams.slice(index * perActor, (index + 1) * perActor);
    const text = guidance + 'Your primary focus: ' + streams.map(stream => `${stream.role ?? stream.id} (${stream.paths.join(', ')}).`).join(' ') + '\nRead the full descriptions in MISSION.md. Complete these substantial workstreams and reconcile their integration with the other assigned streams. The complete directive is identical in all configurations.';
    if (Buffer.byteLength(text) > 4096) throw Error('mission_assignment_bounds');
    return { id: 'builder-' + (index + 1), role: streams.map(stream => stream.id).join('+'), text, dependencies };
  });
  return { ...structuredClone(base), files, protectedPaths: [...base.protectedPaths, 'MISSION.md'], tasks, canonicalGoal: base.goal,
    configurationID: configID, configurationTitle: configID, nativePlugin: config.nativePlugin, awareness: config.nativePlugin,
    contextBytes: config.nativePlugin ? 32768 : 0, cacheIntervalMs: config.nativePlugin ? 100 : 0,
    phases: [tasks.map(task => task.id)], plannedAgentCount: config.agentCount, peakPlannedConcurrency: config.agentCount,
    directiveHash: digest(files['MISSION.md']), seedHash: digest(files) };
}
export function assignMissions(fixtures, { repeats = 3, configs = missionConfigurations.map(value => value.id), models = ['gpt-5-nano', 'deepseek-v4-flash'], seed = 104729 } = {}) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(seed) || !fixtures.length || new Set(configs).size !== configs.length || new Set(models).size !== models.length || !configs.length || !models.length || configs.some(id => !missionConfigurations.some(value => value.id === id)) || models.some(id => !['gpt-5-nano', 'deepseek-v4-flash'].includes(id))) throw Error('invalid_mission_assignment');
  let rng = seed >>> 0;
  const random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  const rows = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const mission of fixtures) for (const modelID of models) for (const configID of configs) {
    const fixture = configureMission(mission, configID);
    rows.push({ id: `${mission.id}-${repeat}-${modelID}-${configID}`, fixtureID: mission.id, domain: mission.domain, title: mission.title, repeat, configID,
      actorModels: fixture.tasks.map(() => ({ providerID: 'opencode', id: modelID })), condition: fixture.nativePlugin ? 'awareness-on' : 'native-stock',
      assigned: true, outcome: 'not-run', correct: false, directiveHash: fixture.directiveHash, seedHash: fixture.seedHash,
      actors: fixture.tasks.map(task => ({ id: task.id, admitted: false, outcome: 'not-run', processStopped: null })) });
  }
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows;
}
