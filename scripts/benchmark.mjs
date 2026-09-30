import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { selectedProfile } from '../src/profile.mjs';
import { runBenchmarkCohort } from '../src/benchmark.mjs';
import { summarizeBenchmarks, renderBenchmarkReport } from '../src/benchmark-report.mjs';
import { benchmarkFixtures } from '../fixtures/benchmarks.mjs';
import { configureBenchmarkFixture } from '../fixtures/benchmark-configurations.mjs';
import { assignBenchmarkStudy } from '../fixtures/benchmark-study.mjs';

const args=process.argv.slice(2), keys=['--repeats=','--parallel=','--deadline-ms=','--seed='];
if(!args.includes('--real')||args.some(arg=>arg!=='--real'&&!keys.some(key=>arg.startsWith(key)))||keys.some(key=>args.filter(arg=>arg.startsWith(key)).length>1))throw Error('Usage: node scripts/benchmark.mjs --real [--repeats=3 --parallel=12 --deadline-ms=90000 --seed=104729]');
const option=(key,fallback,min,max)=>{const text=args.find(arg=>arg.startsWith(key))?.slice(key.length);if(text===undefined)return fallback;const value=Number(text);if(!/^\d+$/.test(text)||!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid benchmark option');return value;};
const repeats=option('--repeats=',3,1,10),parallel=option('--parallel=',12,1,12),deadlineMs=option('--deadline-ms=',90000,1000,360000),seed=option('--seed=',104729,0,4294967295);
const output=resolve(import.meta.dirname,'../artifacts','benchmark-'+randomUUID());await mkdir(output,{recursive:true,mode:0o700});
const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
// Freeze every assignment before reading provider credentials. The declared default model
// is the OpenCode model selected by the user for this study.
const results=structuredClone(assignBenchmarkStudy(benchmarkFixtures,{repeats,seed,mainModel:{providerID:'opencode',id:'space-bunny-free'}}));
for(const row of results)row.deadlineMs=deadlineMs;
const evidence={version:4,kind:'native-collaboration-tuning-study',date:new Date().toISOString(),status:'assigned',
 protocol:{repeats,parallelCohorts:parallel,actorsPerCohort:'1,2,4,8',concurrentWithinDeclaredPhase:true,builderReviewerSequential:true,deadlineMs,seed,conditions:['stock-solo','stock-parallel-pair','gang-pair','gang-four','gang-eight','builder-reviewer','gang-pair-small-context','gang-pair-slow-updates','mixed-pair'],models:['opencode/space-bunny-free','opencode/gpt-5-nano','opencode/deepseek-v4-flash'],
 initialGoalsAndFiles:'identical fixture seed and complete goal; role instructions differ by declared layout',inferenceDeterministic:false,rescuePrompts:0,qualification:'exploratory tuning study; small tasks and three repeats do not establish product benefit',
 timeLimitIncludesSetup:true,complexity:'lexical JavaScript indicators; not a quality score',otherProviderTraffic:'not measured'},
 environment:{node:process.version,platform:platform(),release:release(),logicalCPUs:cpus().length},results,plannedAssignments:structuredClone(results),sourceFingerprints:{},loadEvents:[],errors:[]};
const evidencePath=join(output,'evidence.json');let writer=null,pending=null,persistenceFailure=false;
function save(){pending=JSON.stringify(evidence,null,2)+'\n';if(writer)return writer;writer=(async()=>{while(pending!==null){const value=pending;pending=null;const temp=evidencePath+'.'+randomUUID()+'.tmp';await writeFile(temp,value,{mode:0o600});await rename(temp,evidencePath);}})().catch(()=>{persistenceFailure=true;abort.abort();throw Error('benchmark_evidence_persistence_failed');}).finally(()=>{writer=null;});return writer;}
console.log('Benchmark evidence: '+evidencePath);await save();
const repository=resolve(import.meta.dirname,'..');
// Fingerprint execution, scoring and report dependencies; the independently served UI
// can evolve during a run without changing the experimental treatment.
const sources=['scripts/benchmark.mjs','fixtures/benchmarks.mjs','fixtures/benchmark-configurations.mjs','fixtures/benchmark-study.mjs',...['benchmark','benchmark-plugin','benchmark-tool-paths','benchmark-metrics','benchmark-report','workspace-state','context','file-observer','opencode','process','profile'].map(name=>'src/'+name+'.mjs')];
for(const path of sources)evidence.sourceFingerprints[path]=createHash('sha256').update(await readFile(join(repository,path))).digest('hex');
let cursor=0,active=0,peak=0,finished=0;
try{
 const profile=await selectedProfile();if(profile.model.providerID!=='opencode'||profile.model.id!=='space-bunny-free')throw Error('study_requires_user_selected_space_bunny_model');
 const catalog=JSON.parse(await readFile(profile.modelCatalogPath,'utf8'));
 for(const id of ['space-bunny-free','gpt-5-nano','deepseek-v4-flash']){const model=catalog.opencode?.models?.[id];if(!model||model.tool_call!==true||!Number.isFinite(model.cost?.input)||!Number.isFinite(model.cost?.output)||model.cost.input<0||model.cost.output<0)throw Error('study_model_catalog_ineligible');}
 evidence.catalogModelPrices=Object.fromEntries(['space-bunny-free','gpt-5-nano','deepseek-v4-flash'].map(id=>[id,catalog.opencode.models[id].cost]));evidence.model={...profile.model};evidence.status='running';await save();
 console.log(`Assigned ${results.length} cohorts / ${results.reduce((n,r)=>n+r.actors.length,0)} native agents; model ${profile.model.providerID}/${profile.model.id}`);
 const workers=Array.from({length:Math.min(parallel,results.length)},async()=>{
  while(!abort.signal.aborted){const index=cursor++;if(index>=results.length)return;const assignment=structuredClone(results[index]),fixture=configureBenchmarkFixture(benchmarkFixtures.find(value=>value.id===assignment.fixtureID),assignment.configID);
   results[index].outcome='running';results[index].started=new Date().toISOString();active++;peak=Math.max(peak,active);evidence.loadEvents.push({time:new Date().toISOString(),id:assignment.id,type:'cohort.started',activeCohorts:active});
   console.log(`Start ${assignment.id} (${active} active cohorts)`);await save();
   try{const result=await runBenchmarkCohort({assignment,fixture,profile,deadlineMs,signal:abort.signal,onUpdate(value){Object.assign(results[index],value);void save().catch(()=>{});}});Object.assign(results[index],result);if(result.actors.some(actor=>actor.processStopped===false))abort.abort();}
   catch{results[index].outcome='failed';results[index].errors=[{code:'unexpected_cohort_failure'}];abort.abort();}
   results[index].ended=new Date().toISOString();active--;finished++;evidence.loadEvents.push({time:new Date().toISOString(),id:assignment.id,type:'cohort.settled',activeCohorts:active});
   console.log(JSON.stringify({finished,total:results.length,id:assignment.id,outcome:results[index].outcome,correct:results[index].correct,artifactCorrect:results[index].artifactCorrect,elapsedMs:results[index].elapsedMs,actors:results[index].actors.map(a=>({id:a.id,outcome:a.outcome,admitted:a.admitted})),errors:results[index].errors}));await save();
  }
 });
 const settledWorkers=await Promise.allSettled(workers);
 if(settledWorkers.some(row=>row.status==='rejected')){evidence.status='failed';evidence.errors.push({code:'worker_or_persistence_failure'});}else evidence.status=abort.signal.aborted?'cancelled':'complete';
}catch{evidence.status='failed';evidence.errors.push({code:persistenceFailure?'evidence_persistence_failure':'suite_runtime_or_profile_failure'});abort.abort();}
finally{
 evidence.completed=new Date().toISOString();evidence.peakConcurrentCohorts=peak;
 evidence.summary=summarizeBenchmarks(results);await save();
 await writeFile(join(output,'report.md'),renderBenchmarkReport(evidence),{mode:0o600});
 console.log(`Report: ${join(output,'report.md')}`);
 console.log(JSON.stringify({status:evidence.status,assigned:results.length,finished,correct:results.filter(r=>r.correct).length,artifactCorrect:results.filter(r=>r.artifactCorrect).length,deadline:results.filter(r=>r.outcome==='deadline').length,failed:results.filter(r=>r.outcome==='failed').length,notRun:results.filter(r=>r.outcome==='not-run').length}));
}
if(evidence.status!=='complete')process.exitCode=1;
