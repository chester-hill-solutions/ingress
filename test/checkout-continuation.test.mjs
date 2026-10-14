import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pendingAssignments} from '../scripts/checkout/native-continuation.mjs';

function fixture(){
 const assignments=['success','wrong','deadline','setup','interrupted','unstarted'].map(id=>({id,arm:'graph'}));
 const protocol={schema:2,campaign:'varied',model:{providerID:'opencode',id:'deepseek-v4.1-flash'},deadlineMs:600000,missions:[{id:'policy'}],assignments,implementationHashes:{'native-flight.mjs':'old-driver','native-grader.mjs':'fixed-grader'}};
 const prior={status:'interrupted',protocol:structuredClone(protocol),rows:[
  {id:'success',status:'settled',correct:true,stopConfirmed:true},
  {id:'wrong',status:'settled',correct:false,stopConfirmed:true},
  {id:'deadline',status:'deadline-or-cancel',correct:false,stopConfirmed:true},
  {id:'setup',status:'setup-failed',correct:false,stopConfirmed:true},
  {id:'interrupted',status:'interrupted-before-observed-native-admission',nativeAdmissionsObserved:0,stopConfirmed:true}
 ]};
 return {assignments,prior,current:structuredClone({...protocol,implementationHashes:{...protocol.implementationHashes,'native-flight.mjs':'continuation-driver','native-continuation.mjs':'new-selector'}})};
}
test('continuation keeps completed failures and deadlines; admits only unstarted native assignments',()=>{
 const f=fixture(),before=structuredClone(f);
 assert.deepEqual(pendingAssignments(f.assignments,f.prior,f.current).map(a=>a.id),['interrupted','unstarted']);
 assert.deepEqual(f,before);
});
test('continuation refuses changed model, mission, grader, controls or assignment order',()=>{
 for(const change of [f=>f.current.model.id='other',f=>f.current.missions[0].id='other',f=>f.current.implementationHashes['native-grader.mjs']='other',f=>f.current.deadlineMs=1200000,f=>f.current.timing='other',f=>f.assignments.reverse()]){
  const f=fixture();change(f);assert.throws(()=>pendingAssignments(f.assignments,f.prior,f.current),/continuation_/);
 }
});
test('continuation refuses unknown, duplicate, unstopped and admitted interrupted outcomes',()=>{
 for(const change of [f=>f.prior.rows.push({...f.prior.rows[0]}),f=>f.prior.rows[0].id='unknown',f=>f.prior.rows[0].stopConfirmed=false,f=>f.prior.rows.at(-1).nativeAdmissionsObserved=1,f=>f.prior.rows.at(-1).status='running',f=>f.prior.rows.at(-1).stopConfirmed=false]){
  const f=fixture();change(f);assert.throws(()=>pendingAssignments(f.assignments,f.prior,f.current),/continuation_/);
 }
});
test('continuation requires the original campaign to have stopped',()=>{
 const f=fixture();f.prior.status='running';assert.throws(()=>pendingAssignments(f.assignments,f.prior,f.current),/prior_campaign_not_stopped/);
});
