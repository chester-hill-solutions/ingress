import { createHash } from 'node:crypto';
import { configureBenchmarkFixture } from './benchmark-configurations.mjs';

const fixtureIDs=['money','shared-features','dependency-refactor','cache-ttl','strict-format','human-priority'];
const representativeIDs=['shared-features','dependency-refactor','strict-format'];
const coreConfigs=['stock-solo','stock-parallel-pair','gang-pair'];
const tunedConfigs=['gang-four','gang-eight','builder-reviewer','gang-pair-small-context','gang-pair-slow-updates'];
const defaultAdditionalModels=[{providerID:'opencode',id:'gpt-5-nano'},{providerID:'opencode',id:'deepseek-v4-flash'}];
const hash=value=>createHash('sha256').update(value).digest('hex');
const modelName=model=>`${model.providerID}/${model.id}`;
function modelRef(value){
  if(!value||typeof value.providerID!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.providerID)||typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.id))throw new TypeError('invalid_study_model');
  return {providerID:value.providerID,id:value.id};
}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Preassign the entire finite protocol; execution and outcomes belong to separate mutable evidence. */
export function assignBenchmarkStudy(fixtures,{repeats=3,seed=104729,mainModel={providerID:'opencode',id:'space-bunny-free'},additionalModels=defaultAdditionalModels}={}){
  if(!Array.isArray(fixtures)||fixtures.length!==6||new Set(fixtures.map(value=>value?.id)).size!==6||fixtures.some(value=>!fixtureIDs.includes(value?.id))||!Number.isSafeInteger(repeats)||repeats<1||repeats>10||!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw new RangeError('invalid_benchmark_study');
  const main=modelRef(mainModel);
  if(!Array.isArray(additionalModels)||additionalModels.length!==2)throw new RangeError('invalid_additional_study_models');
  const candidates=additionalModels.map(modelRef);
  if(new Set(candidates.map(modelName)).size!==2)throw new RangeError('duplicate_additional_study_model');
  if(candidates.some(candidate=>modelName(candidate)===modelName(main)))throw new RangeError('main_model_duplicates_additional_study_candidate');
  const byID=new Map(fixtures.map(value=>[value.id,value]));
  const prepared=new Map();
  for(const fixtureID of fixtureIDs){const fixture=byID.get(fixtureID);for(const configID of [...coreConfigs,...tunedConfigs])prepared.set(`${fixtureID}:${configID}`,configureBenchmarkFixture(fixture,configID));}
  let rng=seed>>>0;
  const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;};
  const assigned=[];
  function assignment(fixtureID,configID,repeat,studyVariant,models){
    const base=byID.get(fixtureID),configured=prepared.get(`${fixtureID}:${configID}`);
    const actorModels=configured.tasks.map((_,index)=>modelRef(models[index%models.length]));
    const modelSet=[...new Set(actorModels.map(modelName))].sort().join('+');
    const identity=`${fixtureID}:${configID}:${repeat}:${studyVariant}:${modelSet}`;
    const slug=modelSet.toLowerCase().replace(/[^a-z0-9-]+/g,'-').slice(0,40);
    const id=`${fixtureID}-${configID}-${studyVariant}-r${repeat}-${slug}-${hash(identity).slice(0,12)}`;
    const stock=!configured.nativePlugin;
    const baselineConfigID=stock?null:configID==='builder-reviewer'||configured.agentCount>2?'stock-solo':'stock-parallel-pair';
    return {id,fixtureID,configID,repeat,studyVariant,condition:configured.awareness?'awareness-on':'awareness-off',system:stock?'stock':'gangcode',modelSet,actorModels,
      workGoalHash:hash(configured.canonicalGoal),seedHash:hash(JSON.stringify(base.files)),baselineConfigID,
      baselineKind:stock?null:baselineConfigID==='stock-solo'?'practical-stock-alternative-not-equal-compute':'same-model-two-specialist-stock',
      comparisonRole:stock?'baseline':'candidate',nativePlugin:configured.nativePlugin,awareness:configured.awareness,contextBytes:configured.contextBytes,cacheIntervalMs:configured.cacheIntervalMs,
      phases:structuredClone(configured.phases),plannedAgentCount:configured.plannedAgentCount,peakPlannedConcurrency:configured.peakPlannedConcurrency,deadlineMs:90000,
      assigned:true,outcome:'not-run',correct:false,
      actors:configured.tasks.map((task,index)=>({id:task.id,role:task.role,model:{...actorModels[index]},assigned:true,admitted:false,outcome:'not-run',processStopped:null}))};
  }
  for(let repeat=1;repeat<=repeats;repeat++){
    const block=[];
    for(const fixtureID of fixtureIDs)for(const configID of coreConfigs)block.push(assignment(fixtureID,configID,repeat,'core',[main]));
    for(const fixtureID of representativeIDs)for(const configID of tunedConfigs)block.push(assignment(fixtureID,configID,repeat,'role-context-tuning',[main]));
    for(const model of candidates)for(const fixtureID of representativeIDs)for(const configID of ['stock-solo','stock-parallel-pair','gang-pair'])block.push(assignment(fixtureID,configID,repeat,'additional-model',[model]));
    for(const[fixtureIndex,fixtureID]of representativeIDs.entries())block.push(assignment(fixtureID,'gang-pair',repeat,'mixed-pair',(repeat+fixtureIndex)%2?[candidates[0],candidates[1]]:[candidates[1],candidates[0]]));
    for(const row of block)row.baselineAvailable=row.baselineConfigID===null?null:block.some(candidate=>candidate.fixtureID===row.fixtureID&&candidate.configID===row.baselineConfigID&&candidate.modelSet===row.modelSet);
    for(let i=block.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[block[i],block[j]]=[block[j],block[i]];}
    assigned.push(...block);
  }
  if(new Set(assigned.map(value=>value.id)).size!==assigned.length)throw new Error('duplicate_benchmark_study_assignment');
  return freeze(assigned);
}
