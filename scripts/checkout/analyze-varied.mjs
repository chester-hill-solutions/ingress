// Reporting only. Never imports or executes generated candidate source.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pendingAssignments} from './native-continuation.mjs';

const {values}=parseArgs({options:{parent:{type:'string'},continuation:{type:'string'},output:{type:'string'}}});
assert(values.parent&&values.continuation&&values.output,'Pass --parent, --continuation and --output');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceRevision=files=>digest(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([path,text])=>[path,digest(text)])));
const read=(root,path)=>readFileSync(resolve(root,path));
const parse=(root,path)=>JSON.parse(read(root,path));
const parent=resolve(values.parent),continuation=resolve(values.continuation);
const old=parse(parent,'results.json'),next=parse(continuation,'results.json');
assert.equal(next.status,'complete','Continuation must have finished');
assert.equal(next.protocol.continuation.parentRun,parent);
assert.equal(next.protocol.continuation.parentResultsHash,digest(read(parent,'results.json')));
assert.equal(next.protocol.continuation.parentProtocolHash,digest(read(parent,'protocol.json')));
const expected=pendingAssignments(old.protocol.assignments,old,next.protocol);
assert.deepEqual(next.protocol.assignments,expected);
assert.deepEqual(next.rows.map(r=>r.id),expected.map(r=>r.id),'Every pending assignment must be retained once in order');
const finished=r=>['settled','deadline-or-cancel','setup-failed'].includes(r.status)&&r.stopConfirmed;
const interruptions=old.rows.filter(r=>!finished(r));
const rows=[...old.rows.filter(finished),...next.rows];
assert.equal(rows.length,old.protocol.assignments.length);
assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
assert(rows.every(finished),'Every final cohort needs a confirmed stopped outcome');
for(const r of rows){
 const a=old.protocol.assignments.find(a=>a.id===r.id);
 for(const key of ['missionId','repeat','arm','roleOrder'])assert.deepEqual(r[key],a[key]);
 assert(r.actors.length<=4);
 if(r.status!=='setup-failed')assert.equal(r.actors.length,4);
 assert.equal(new Set(r.actors.map(a=>a.id)).size,r.actors.length);
 assert(r.actors.every(actor=>a.actors.some(expected=>expected.id===actor.id)));
 assert.equal(r.correct,!!r.grade.correct&&r.stopConfirmed);
 assert.equal(r.correctWithinBudget,r.correct&&r.status==='settled'&&r.firstCorrectMs!==null&&r.firstCorrectMs<=old.protocol.deadlineMs&&r.elapsedMs<=old.protocol.deadlineMs);
 for(const n of r.nativeDiagnostics??[])if(n.totals)assert.deepEqual(n.totals.model,old.protocol.model);
}
const audits=[];
for(const [root,protocol]of [[parent,old.protocol],[continuation,next.protocol]]){
 assert.deepEqual(parse(root,'protocol.json'),protocol);
 assert.equal(sourceRevision(parse(root,'seed.json')),protocol.seedRevision);
 for(const m of protocol.missions){
  assert.equal(sourceRevision(parse(root,'missions/'+m.id+'/seed.json')),m.seedRevision);
  assert.equal(digest(JSON.stringify(parse(root,'missions/'+m.id+'/contracts.json'))),m.contractsHash);
 }
 const snapshot=[];for(const [file,hash]of Object.entries(protocol.implementationHashes)){
  assert.equal(digest(read(root,'implementation/'+file.replaceAll('../','up-').replaceAll('/','_'))),hash,file+' snapshot changed');
  if(root===continuation)assert.equal(digest(readFileSync(resolve(import.meta.dirname,file))),hash,file+' runtime changed');
  snapshot.push(file);
 }
 audits.push({run:root,verifiedSnapshots:snapshot.length,verifiedCurrentRuntime:root===continuation?snapshot.length:0});
}
const median=xs=>{if(!xs.length)return null;const v=[...xs].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const frequencies=xs=>{const out={};for(const x of xs)out[x]=(out[x]??0)+1;return out;};
function usage(records){
 const totals=records.map(x=>x.totals).filter(Boolean),out={sessions:records.length,available:totals.length};
 for(const key of ['input','output','reasoning','cacheRead','cost']){
  const known=totals.map(x=>x[key]).filter(Number.isFinite);
  out[key]={knownTotal:sum(known),missing:records.length-known.length};
 }
 out.outcomes=frequencies(totals.map(x=>x.outcome??'unknown'));
 out.errors=records.flatMap(x=>x.errors??[]);
 return out;
}
const diagnostics=(actors,records=[])=>actors.map(actor=>records.find(record=>record.sessionID===actor.sessionID)??{sessionID:actor.sessionID});
function score(selected){
 const actors=selected.flatMap(r=>r.actors),turns=actors.flatMap(a=>a.turns);
 return {assigned:selected.length,correct:selected.filter(r=>r.correct).length,correctWithinBudget:selected.filter(r=>r.correctWithinBudget).length,
  medianSettlementMs:median(selected.map(r=>r.elapsedMs)),firstCorrectMs:selected.filter(r=>r.correctWithinBudget).map(r=>({id:r.id,ms:r.firstCorrectMs})),
  nativeTurns:turns.length,admittedNativeTurns:turns.filter(t=>t.admitted).length,publishedActors:actors.filter(a=>a.status==='published').length,
  allActorsPublishedButWrong:selected.filter(r=>!r.correct&&r.actors.every(a=>a.status==='published')).map(r=>r.id),
  actorStatuses:frequencies(actors.map(a=>a.status)),cohortStatuses:frequencies(selected.map(r=>r.status)),
  finalTurnRefusals:frequencies(turns.filter(t=>t.submission&&!t.submission.admitted).map(t=>t.submission.reason??'unspecified')),
  expansionAttempts:selected.flatMap(r=>r.decisions.filter(d=>d.phase==='expansion')).length,
  expansionsAdmitted:selected.flatMap(r=>r.decisions.filter(d=>d.phase==='expansion'&&d.expanded)).length,
  waitingActorMs:sum(actors.map(a=>a.waitingMs??0)),
  runtimeErrors:turns.filter(t=>t.error).map(t=>t.error),
  coverage:frequencies(actors.map(a=>a.coverage??'unknown')),
  sequenceGaps:sum(actors.map(a=>a.sequenceGaps)),eventOmissions:sum(actors.map(a=>a.eventOmissions)),
  closedStepMissingUsage:sum(actors.map(a=>a.usage.missing)),closedStepMissingCost:sum(actors.map(a=>a.usage.missingCost)),
  nativeDatabaseUsage:usage(selected.flatMap(r=>diagnostics(r.actors,r.nativeDiagnostics)))};
}
const arms=['current','blocks','graph'];
assert([old,next].every(run=>run.preflight.passed&&run.preflight.stopConfirmed));
const report={schema:1,campaign:'varied',model:old.protocol.model,planned:old.protocol.plannedCohorts,completed:rows.length,
 sourceRuns:[parent,continuation],audits,interruption:interruptions.map(r=>({id:r.id,status:r.status,nativeAdmissionsObserved:r.nativeAdmissionsObserved,stopConfirmed:r.stopConfirmed,artifact:resolve(parent,r.interruptionArtifact)})),
 arms:arms.map(arm=>({arm,...score(rows.filter(r=>r.arm===arm))})),
 missions:old.protocol.missions.map(m=>({id:m.id,arms:arms.map(arm=>({arm,...score(rows.filter(r=>r.missionId===m.id&&r.arm===arm))}))})),
 preflights:[old,next].map((run,i)=>({run:[parent,continuation][i],passed:run.preflight.passed,stopConfirmed:run.preflight.stopConfirmed,usage:usage(diagnostics(run.preflight.actors,run.preflight.diagnostics))})),
 rows:old.protocol.assignments.map(a=>{const r=rows.find(r=>r.id===a.id);return {id:r.id,missionId:r.missionId,arm:r.arm,repeat:r.repeat,status:r.status,correct:r.correct,correctWithinBudget:r.correctWithinBudget,firstCorrectMs:r.firstCorrectMs,elapsedMs:r.elapsedMs,peakNative:r.peakNative,legacyValid:r.grade.legacyValid,executionValid:r.grade.executionValid,failedGroups:r.grade.checks.filter(c=>!c.passed).map(c=>c.name),actors:r.actors.map(a=>({id:a.id,status:a.status,turns:a.turns.length,errors:a.turns.filter(t=>t.error).map(t=>t.error)}))};}),
 usefulBenefitQualified:false,limits:['Synthetic missions, one host/model, three repeats per mission/arm','Live-only stream and bounded grant polling; absent events are not proved absent','Settlement includes failed outcomes; first-correct is an observation bound','Database cost is provider reported, not billing; closed-step usage is a separate source','Operational continuation and pre-admission interruption retained; original completed outcomes never rerun','No durable authentication, OS privacy or arbitrary JavaScript dependency-coverage claim']};
writeFileSync(resolve(values.output),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({planned:report.planned,completed:report.completed,arms:report.arms.map(a=>({arm:a.arm,correct:a.correct,within:a.correctWithinBudget,medianSettlementMs:a.medianSettlementMs,nativeTurns:a.nativeTurns,cost:a.nativeDatabaseUsage.cost}))},null,2));
