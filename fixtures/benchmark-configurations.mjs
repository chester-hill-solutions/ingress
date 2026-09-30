/** Role layouts alter collaboration conditions, never the benchmark's required outcome. */
export const benchmarkConfigurations = Object.freeze([
  {id:'stock-solo',title:'Stock / one combined builder',agentCount:1,nativePlugin:false,awareness:false,contextBytes:0,cacheIntervalMs:0,mixModels:'per_actor_assignment'},
  {id:'stock-parallel-pair',title:'Stock / two specialists',agentCount:2,nativePlugin:false,awareness:false,contextBytes:0,cacheIntervalMs:0,mixModels:'per_actor_assignment'},
  {id:'gang-pair',title:'GangCode / two specialists',agentCount:2,nativePlugin:true,awareness:true,contextBytes:32768,cacheIntervalMs:100,mixModels:'per_actor_assignment'},
  {id:'gang-four',title:'GangCode / four concurrent roles',agentCount:4,nativePlugin:true,awareness:true,contextBytes:32768,cacheIntervalMs:100,mixModels:'per_actor_assignment'},
  {id:'gang-eight',title:'GangCode / eight concurrent roles',agentCount:8,nativePlugin:true,awareness:true,contextBytes:32768,cacheIntervalMs:100,mixModels:'per_actor_assignment'},
  {id:'builder-reviewer',title:'GangCode / builder then reviewer',agentCount:2,nativePlugin:true,awareness:true,contextBytes:32768,cacheIntervalMs:100,mixModels:'per_actor_assignment'},
  {id:'gang-pair-small-context',title:'GangCode / two specialists, 8KiB context',agentCount:2,nativePlugin:true,awareness:true,contextBytes:8192,cacheIntervalMs:100,mixModels:'per_actor_assignment'},
  {id:'gang-pair-slow-updates',title:'GangCode / two specialists, 500ms refresh',agentCount:2,nativePlugin:true,awareness:true,contextBytes:32768,cacheIntervalMs:500,mixModels:'per_actor_assignment'},
].map(value=>Object.freeze(value)));

const guidance='Use native file tools; no packages, shell processes or nested agents. Preserve package.json and all protected files byte-for-byte. File focus is not exclusive ownership. Preserve useful existing work and use the stated public module contracts. ';
function originalGoal(text){
  const marker='Preserve package.json and all protected files byte-for-byte. ';
  const end=text.indexOf(marker);
  return (end<0?text:text.slice(end+marker.length))
    .replace(/Peer updates ([^.]+\.mjs) to this contract\./g,'Ensure $1 follows this contract.')
    .replace(/which peer is refactoring through labels\.mjs/g,'whose shared dependency is labels.mjs')
    .replace(/\bpeer(?:'s)?\s+/gi,'');
}
const concerns=[
  ['input-errors','Review and implement only the input boundaries and typed-error behavior already specified in the goal. Check valid boundary values, malformed values and failure propagation through dependent APIs.'],
  ['api-immutability','Review and implement only the specified public exports, caller compatibility and input immutability. Preserve peer exports and verify the dependent module uses the intended contract.'],
  ['dependency-consistency','Review producer-to-consumer dependencies in the declared graph. Resolve stale imports, duplicated contract assumptions and disconnected integration against the existing goal.'],
  ['representation-edges','Review exact units, ordering, normalization, timing or output representation required by this goal. Correct boundary and empty-input behavior without adding requirements.'],
  ['failure-recovery','Review failure paths and recovery already required by this goal. Ensure invalid input or unsuccessful operations do not silently produce an apparently valid result or corrupt later valid behavior.'],
  ['end-to-end-readiness','Review the complete public workflow across the existing modules. Replace remaining stubs or partial integration only where the stated goal requires it, and preserve protected data.'],
];

export function configureBenchmarkFixture(baseFixture,configID){
  const config=benchmarkConfigurations.find(value=>value.id===configID);
  if(!config)throw new RangeError('unknown_benchmark_configuration');
  if(!baseFixture||!Array.isArray(baseFixture.tasks)||baseFixture.tasks.length!==2||baseFixture.tasks.some(task=>typeof task.id!=='string'||typeof task.text!=='string'||!Array.isArray(task.dependencies)))throw new TypeError('invalid_two_agent_benchmark');
  const original=baseFixture.tasks.map(task=>({...structuredClone(task),text:originalGoal(task.text)}));
  const canonicalGoal=original.map((task,index)=>`Original goal ${index+1}: ${task.text}`).join('\n\n');
  const dependencies=[...new Map(original.flatMap(task=>task.dependencies).map(edge=>[JSON.stringify(edge),edge])).values()];
  const makeTask=(id,role,text)=>({id,role,text:guidance+text,dependencies:structuredClone(dependencies)});
  let tasks,phases;
  if(configID==='stock-solo'){
    tasks=[makeTask('solo','combined-builder',`You are the sole assigned builder. Complete the entire unchanged benchmark goal below.\n\n${canonicalGoal}`)];
    phases=[['solo']];
  }else if(configID==='builder-reviewer'){
    tasks=[makeTask('builder','combined-builder',`Complete the entire unchanged benchmark goal below. A separate reviewer is assigned only after this stage settles.\n\n${canonicalGoal}`),makeTask('reviewer','reviewer',`The builder stage has settled. Inspect the actual resulting modules and correct omissions against the SAME complete goal below. This is a new assigned review stage. If already satisfied, finish without unnecessary edits.\n\n${canonicalGoal}`)];
    phases=[['builder'],['reviewer']];
  }else{
    tasks=original.map(task=>({...task,role:`specialist:${task.id}`,text:guidance+`Your specialist focus is the following original goal. Coordinate with the other assigned roles through actual shared source and public contracts. If your focus already satisfies the goal, finish without unnecessary edits.\n\n${task.text}`}));
    for(const[id,focus]of concerns.slice(0,config.agentCount-2))tasks.push(makeTask(id,id,`Your distinct crosscutting focus: ${focus} Other roles are working concurrently; inspect actual changes before modifying shared code. If this concern already satisfies the stated goal, finish without unnecessary edits.\n\nComplete benchmark outcome, unchanged across configurations:\n${canonicalGoal}`));
    phases=[tasks.map(task=>task.id)];
  }
  if(tasks.some(task=>Buffer.byteLength(task.text)>4096)||new Set(tasks.map(task=>task.id)).size!==tasks.length)throw new RangeError('configuration_task_bounds_exceeded');
  return {...structuredClone(baseFixture),...config,id:baseFixture.id,title:baseFixture.title,configurationTitle:config.title,fixtureID:baseFixture.id,configurationID:configID,canonicalGoal,tasks,phases,
    plannedAgentCount:tasks.length,peakPlannedConcurrency:Math.max(...phases.map(phase=>phase.length)),
    oversubscription:config.agentCount>2?{possible:true,basis:'additional_roles_share_the_same_small_goal',benefit:'unmeasured'}:{possible:false,basis:'original_two_goal_layout',benefit:'unmeasured'}};
}
