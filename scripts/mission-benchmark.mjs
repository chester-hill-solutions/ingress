import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cpus, platform } from 'node:os';
import { missionFixtures, verifyMissionFixture } from '../fixtures/missions.mjs';
import { configureMission, assignMissions } from '../fixtures/mission-configurations.mjs';
import { selectedProfile } from '../src/profile.mjs';
import { runBenchmarkCohort } from '../src/benchmark.mjs';
import { missionObserver } from '../src/mission-snapshots.mjs';
import { readMissionFile } from '../src/mission-verifier.mjs';
import { createBlindStudy, freezeBlindSample, saveBlindJSON } from '../src/blind-review.mjs';

const args = process.argv.slice(2), keys = ['--repeats=', '--parallel=', '--deadline-ms=', '--seed=', '--configs=', '--missions='];
if ((!args.includes('--real') && !args.includes('--plan')) || args.includes('--real') && args.includes('--plan') || args.some(arg => !['--real','--plan'].includes(arg) && !keys.some(key => arg.startsWith(key))) || keys.some(key => args.filter(arg => arg.startsWith(key)).length > 1)) throw Error('Usage: node scripts/mission-benchmark.mjs --plan|--real [--repeats=1 --parallel=6 --deadline-ms=900000 --configs=stock-four,gang-four]');
const option = (key, fallback, min, max) => { const text = args.find(arg => arg.startsWith(key))?.slice(key.length); if (text === undefined) return fallback; const value = Number(text); if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw Error('invalid_mission_option'); return value; };
const repeats = option('--repeats=',1,1,10), parallel = option('--parallel=',6,1,12), deadlineMs = option('--deadline-ms=',900000,1000,1800000), seed = option('--seed=',104729,0,4294967295);
const configs = args.find(arg => arg.startsWith('--configs='))?.slice(10).split(',') ?? ['stock-four','gang-four'];
const ids = args.find(arg => arg.startsWith('--missions='))?.slice(11).split(',');
if (ids && (new Set(ids).size !== ids.length || ids.some(id => !missionFixtures.some(value => value.id === id)))) throw Error('unknown_mission_selection');
const fixtures = ids ? missionFixtures.filter(value => ids.includes(value.id)) : missionFixtures;
const results = assignMissions(fixtures, { repeats, configs, seed });
const directory = resolve(import.meta.dirname, '../artifacts', 'mission-flight-' + randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const protocol = { purpose: 'Exploratory large-workflow benchmark and blind human tasting; not a product-benefit conclusion.',
  repeats, configs, models: ['opencode/gpt-5-nano','opencode/deepseek-v4-flash'], parallelCohorts: parallel, seed, deadlineMs,
  cutoffBasis: 'Operational safety cap including setup. Native completion and independent artifact correctness are separate; unfinished attempts are retained and rated. This cap is not a validated task-adequacy claim.',
  observationBandsMs: [60000,180000,600000].filter(value => value < deadlineMs), snapshotBasis: 'Double-collected stable content then immutable grading copy. Not an atomic filesystem snapshot; sampled success bounds first observed correctness, not exact time to completion.',
  directiveEquality: 'All files and the complete MISSION.md directive are identical across configurations. Stream allocation differs by 1/2/4/8-agent layout. Every roster runs concurrently with no exclusive file ownership.',
  toolPolicy: 'Stock and GangCode both retain each model native file tools. No shell, packages or nested agents. Public output invocation by independent grader only; no private oracle feedback or rescue prompts.',
  blinding: 'Random labels and independent display order; authorship and measured scores/time/usage withheld until a saved human rating and explicit reveal. All attempted outputs are preserved.',
  humanDimensions: ['usefulness','completeness','clarity','coherence','overall'], automaticQuality: 'Criterion-level behavior/calculation/support checks; prose quality is assessed by humans. Lexical complexity is descriptive, not a quality score.',
  usageBasis: 'Closed native step observations only; cache/reasoning and interrupted unreported usage are not billing reconciled.',
  plannedCohorts: results.length, plannedActors: results.reduce((n,value)=>n+value.actors.length,0) };
const evidence = { version: 1, kind: 'large-mission-blind-flight', created: new Date().toISOString(), status: 'assigned', protocol,
  environment: { node: process.version, platform: platform(), logicalCPUs: cpus().length }, plannedAssignments: structuredClone(results), results, sourceFingerprints: {}, loadEvents: [], errors: [] };
const repository = resolve(import.meta.dirname,'..');
const sources = ['scripts/mission-benchmark.mjs','fixtures/missions.mjs','fixtures/mission-configurations.mjs', ...['research','math','saas'].map(name=>'fixtures/missions/'+name+'.mjs'),
  ...['mission-verifier','mission-snapshots','benchmark','benchmark-plugin','benchmark-tool-paths','benchmark-metrics','workspace-state','context','file-observer','opencode','process','profile','blind-review'].map(name=>'src/'+name+'.mjs')];
for (const path of sources) evidence.sourceFingerprints[path] = createHash('sha256').update(await readFile(join(repository,path))).digest('hex');
const evidencePath = join(directory,'evidence-private.json');
await saveBlindJSON(evidencePath,evidence);
const study = await createBlindStudy(directory, results, fixtures.map(base=>configureMission(base,'stock-solo')), protocol);
await writeFile(join(directory,'protocol.md'), '# Large mission blind flight\n\n'+JSON.stringify(protocol,null,2)+'\n', {mode:0o600});
console.log('Blind review directory: '+directory);
console.log(JSON.stringify({assigned:results.length,actors:protocol.plannedActors,missions:fixtures.length,repeats,deadlineMs,mode:args.includes('--plan')?'plan':'real'}));
if (args.includes('--plan')) process.exit(0);
const abort = new AbortController(); process.once('SIGINT',()=>abort.abort()); process.once('SIGTERM',()=>abort.abort());
let pending = false, persistence = Promise.resolve(), persistTimer;
function save() { pending = true; if (persistTimer) return; persistTimer = setTimeout(() => { persistTimer=null; if (!pending) return; pending=false; persistence=persistence.then(()=>saveBlindJSON(evidencePath,evidence)).catch(()=>{abort.abort();evidence.errors.push({code:'evidence_persistence_failed'});}); },200); }
let reviewWriter=Promise.resolve(),cursor=0,active=0,finished=0;
async function publish(result, fixture) {
  reviewWriter = reviewWriter.catch(()=>{}).then(async()=>{
    try { await freezeBlindSample(directory,study,result,fixture); }
    catch {
      abort.abort();evidence.errors.push({code:'sample_publication_failed',id:result.id});
      const sample=study.samples.find(value=>value.assignmentID===result.id);
      sample.status='ready';sample.artifacts=fixture.editablePaths.map(name=>({name,missing:true,kind:'text',text:'This output could not be frozen for review. The allocated attempt remains in the flight.'}));
      sample.identity={models:[...new Set(result.actorModels?.map(value=>value.providerID+'/'+value.id)??[])],configuration:result.configID,agents:result.actors?.length??0,outcome:result.outcome,captureBasis:'publication_failed',automated:result.verification??null};
      try { await saveBlindJSON(join(directory,'review-private.json'),study); } catch { evidence.errors.push({code:'review_state_persistence_failed'}); }
    }
  });
  await reviewWriter;
}
try {
  const profile = await selectedProfile(), catalog = JSON.parse(await readFile(profile.modelCatalogPath,'utf8'));
  for (const id of ['gpt-5-nano','deepseek-v4-flash']) {
    const model = catalog.opencode?.models?.[id];
    if (!model || model.tool_call!==true || !Number.isFinite(model.cost?.input) || !Number.isFinite(model.cost?.output)) throw Error('mission_model_ineligible');
  }
  evidence.catalogPrices=Object.fromEntries(['gpt-5-nano','deepseek-v4-flash'].map(id=>[id,catalog.opencode.models[id].cost]));
  evidence.status=study.status='running'; await saveBlindJSON(join(directory,'review-private.json'),study);save();
  const workers=Array.from({length:Math.min(parallel,results.length)},async()=>{
    while(!abort.signal.aborted) {
      const index=cursor++;if(index>=results.length)return;
      const assignment=structuredClone(results[index]), fixture=configureMission(fixtures.find(value=>value.id===assignment.fixtureID),assignment.configID);
      const snapshots=[];let observer;
      const verifyConfigured = async(id,root)=>{
        const value=await verifyMissionFixture(id,root);let intact=false;try{intact=await readMissionFile(root,'MISSION.md')===fixture.files['MISSION.md'];}catch{}
        value.instructionChecks.push({name:'protected:MISSION.md',passed:intact});value.correct&&=intact;return value;
      };
      results[index].outcome='running';active++; evidence.loadEvents.push({time:new Date().toISOString(),type:'cohort.started',id:assignment.id,activeCohorts:active});save();
      try {
        const result=await runBenchmarkCohort({assignment,fixture,profile,deadlineMs,signal:abort.signal,onUpdate(value){Object.assign(results[index],value,{snapshots});save();},runtime:{
          observeFiles:async options=>{observer=await missionObserver(fixture,verifyConfigured,protocol.observationBandsMs,value=>{snapshots.push(value);save();})(options);return observer;},
          verifyBenchmark:verifyConfigured
        }});
        await observer?.settled();Object.assign(results[index],result,{snapshots});
        if(result.actors.some(actor=>actor.processStopped===false))abort.abort();
      } catch { results[index].outcome='failed'; results[index].errors=[{code:'unexpected_mission_runtime_failure'}];abort.abort(); }
      await publish(results[index],fixture);active--;finished++;
      evidence.loadEvents.push({time:new Date().toISOString(),type:'cohort.settled',id:assignment.id,activeCohorts:active});save();
      console.log(JSON.stringify({ready:finished,assigned:results.length,activeCohorts:active}));
    }
  });
  const settled=await Promise.allSettled(workers);
  evidence.status=settled.some(value=>value.status==='rejected')?'failed':abort.signal.aborted?'cancelled':'complete';
} catch { evidence.status='failed'; evidence.errors.push({code:'mission_profile_or_runtime_failure'});abort.abort(); }
finally {
  // Keep every allocated sample, including failed admissions and never-started attempts.
  for(const row of results) if(study.samples.find(value=>value.assignmentID===row.id).status==='pending') await publish(row,configureMission(fixtures.find(value=>value.id===row.fixtureID),row.configID));
  study.status=evidence.status;
  try { await saveBlindJSON(join(directory,'review-private.json'),study); }
  finally { evidence.ended=new Date().toISOString(); if(persistTimer)clearTimeout(persistTimer);await persistence;await saveBlindJSON(evidencePath,evidence); }
  console.log(JSON.stringify({status:evidence.status,ready:study.samples.filter(value=>value.status==='ready').length,assigned:results.length}));
}
if(evidence.status!=='complete')process.exitCode=1;
