// Operational continuation only: never rerun a completed failure or change controls.
export function pendingAssignments(assignments, prior, currentProtocol) {
 if(prior.status!=='interrupted')throw Error('prior_campaign_not_stopped');
 const old=prior.protocol;
 for(const key of ['schema','campaign','deadlineMs','repeats','seedRevision','missionHash','contractsHash','behaviorHash','maximumNativeTurnsPerActor','parallelCohorts','privateCopies','nativeToolPolicy','preparation','feedback','scopeExpansion','timing','usage','sourceCoverage','usefulBenefitQualified']){
  if(JSON.stringify(old[key])!==JSON.stringify(currentProtocol[key]))throw Error('continuation_control_changed:'+key);
 }
 if(JSON.stringify(old.model)!==JSON.stringify(currentProtocol.model)||JSON.stringify(old.missions)!==JSON.stringify(currentProtocol.missions))throw Error('continuation_mission_or_model_changed');
 for(const [file,digest]of Object.entries(old.implementationHashes)){
  // The driver adds this selection/recording path. All experimental mechanisms,
  // directives, graders, tool client, producers and product code must be identical.
  if(file!=='native-flight.mjs'&&currentProtocol.implementationHashes[file]!==digest)throw Error('continuation_implementation_changed:'+file);
 }
 if(JSON.stringify(assignments)!==JSON.stringify(old.assignments))throw Error('continuation_assignments_changed');
 const assigned=new Set(assignments.map(a=>a.id)),observed=new Set(),finished=new Set();for(const row of prior.rows){
  if(!assigned.has(row.id)||observed.has(row.id))throw Error('continuation_unknown_or_duplicate_row:'+row.id);
  observed.add(row.id);
  if(['settled','deadline-or-cancel','setup-failed'].includes(row.status)&&row.stopConfirmed)finished.add(row.id);
  else if(row.status!=='interrupted-before-observed-native-admission'||row.nativeAdmissionsObserved!==0||!row.stopConfirmed)throw Error('continuation_outcome_not_resolved:'+row.id);
 }
 return assignments.filter(a=>!finished.has(a.id));
}
