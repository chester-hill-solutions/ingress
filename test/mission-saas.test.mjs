import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {saasMissions,verifySaasMission} from '../fixtures/missions/saas.mjs';
import {verifyMission} from '../src/mission-verifier.mjs';

// Reference implementations are test apparatus only, never part of fixture seeds.
function authorize({actor,tenantID,action,record=null}){
 if(!actor||actor.tenantID!==tenantID)return false;
 const reads=['get','list','search','analytics','audit','availability'];
 if(KIND==='incident'){if(!['admin','operator','viewer'].includes(actor.role))return false;if(reads.includes(action))return true;if(action==='reopen')return actor.role==='admin';return['open','comment','link','transition'].includes(action)&&['admin','operator'].includes(actor.role);}
 if(!['admin','staff','customer'].includes(actor.role))return false;if(record&&actor.role==='customer'&&record.customerID!==actor.id)return false;
 if(action==='refund')return actor.role==='admin';return[...reads,'reserve','pay','confirm','cancel'].includes(action);
}
function transitionIncident(incident,{status,at}){if({open:'triaged',triaged:'mitigated',mitigated:'resolved'}[incident.status]!==status)fail('INVALID_TRANSITION');return{...structuredClone(incident),status,version:incident.version+1,resolvedAt:status==='resolved'?at:incident.resolvedAt};}
function capacityAvailable(bookings,{resourceID,start,end,seats,capacity}){
 const active=bookings.filter(b=>b.resourceID===resourceID&&b.status!=='cancelled'&&b.start<end&&b.end>start),cuts=[start,...active.flatMap(b=>[b.start,b.end]).filter(t=>t>start&&t<end)];
 return cuts.every(t=>seats+active.filter(b=>b.start<=t&&b.end>t).reduce((n,b)=>n+b.seats,0)<=capacity);
}
function transitionBooking(booking,{status}){if(!((booking.status==='held'&&['confirmed','cancelled'].includes(status))||(booking.status==='confirmed'&&status==='cancelled')))fail('BOOKING_STATE');return{...structuredClone(booking),status,version:booking.version+1};}
function invoiceFor(booking,ledger){const rows=ledger.filter(r=>r.bookingID===booking.id),paidCents=rows.filter(r=>r.kind==='charge').reduce((n,r)=>n+r.amountCents,0),refundedCents=rows.filter(r=>r.kind==='refund').reduce((n,r)=>n+r.amountCents,0);return{bookingID:booking.id,totalCents:booking.amountCents,paidCents,refundedCents,balanceCents:Math.max(booking.amountCents-paidCents,0),status:refundedCents===paidCents&&paidCents>0?'refunded':refundedCents>0?'partially-refunded':paidCents===booking.amountCents?'paid':'unpaid'};}
function createRepository(initial){
 let state=structuredClone(initial),queue=Promise.resolve();
 return{snapshot:()=>structuredClone(state),transact(spec,mutate){const task=queue.then(async()=>{
  const receipt=state.receipts[spec.requestID];if(receipt){if(receipt.fingerprint!==spec.fingerprint)fail('REQUEST_CONFLICT');return structuredClone(receipt.response);}
  if(spec.expectedRevision!==undefined&&spec.expectedRevision!==state.revision)fail('CONFLICT');
  const next=structuredClone(state),data=await mutate(next);next.revision++;const response={id:spec.requestID,ok:true,data};next.receipts[spec.requestID]={fingerprint:spec.fingerprint,response:structuredClone(response)};state=next;return structuredClone(response);
 });queue=task.catch(()=>{});return task;}};
}
function appendAudit(rows,event){return[...structuredClone(rows),structuredClone(event)];}
function queryAudit(rows,{tenantID,entityID,customerID,bookings=[]}){return structuredClone(rows.filter(r=>r.tenantID===tenantID&&(!entityID||r.entityID===entityID)&&(!customerID||bookings.some(b=>b.id===r.entityID&&b.customerID===customerID))));}
function searchIncidents(rows,{tenantID,query=''}){const q=query.trim().toLowerCase();return structuredClone(rows.filter(r=>r.tenantID===tenantID&&[r.title,...r.comments.map(c=>c.text)].some(t=>t.toLowerCase().includes(q))).sort((a,b)=>a.id.localeCompare(b.id)));}
function summarizeIncidents(rows,{tenantID}){const own=rows.filter(r=>r.tenantID===tenantID),done=own.filter(r=>r.status==='resolved'),activeBySeverity={low:0,medium:0,high:0,critical:0};for(const r of own.filter(r=>r.status!=='resolved'))activeBySeverity[r.severity]++;return{total:own.length,resolved:done.length,activeBySeverity,meanResolutionMs:done.length?done.reduce((n,r)=>n+r.resolvedAt-r.createdAt,0)/done.length:null};}
function searchBookings(rows,{tenantID,customerID=null,query=''}){return structuredClone(rows.filter(r=>r.tenantID===tenantID&&(!customerID||r.customerID===customerID)&&r.title.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id)));}
function summarizeBookings(rows,ledger,{tenantID,customerID=null}){const own=rows.filter(r=>r.tenantID===tenantID&&(!customerID||r.customerID===customerID)),entries=ledger.filter(r=>r.tenantID===tenantID&&own.some(b=>b.id===r.bookingID)),capturedCents=entries.filter(r=>r.kind==='charge').reduce((n,r)=>n+r.amountCents,0),refundedCents=entries.filter(r=>r.kind==='refund').reduce((n,r)=>n+r.amountCents,0);return{bookings:own.length,active:own.filter(r=>r.status!=='cancelled').length,capturedCents,refundedCents,netCents:capturedCents-refundedCents};}

function createService({repository,seed}){
 const domain=KIND==='incident'?'incidents':'bookings';
 const summarize=(snapshot,actor,tenantID)=>KIND==='incident'?summarizeIncidents(snapshot.incidents,{tenantID}):summarizeBookings(snapshot.bookings,snapshot.ledger,{tenantID,customerID:actor.role==='customer'?actor.id:null});
 const text=(value,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_INPUT');return value;};
 const find=(snapshot,id,actor,tenantID)=>{const record=snapshot[domain].find(r=>r.id===id&&r.tenantID===tenantID);if(!record||KIND==='booking'&&actor.role==='customer'&&record.customerID!==actor.id)fail('NOT_FOUND');return record;};
 return{summarize,async execute(command,{actor,tenantID,at}){
  if(!authorize({actor,tenantID,action:command.op}))fail('FORBIDDEN');const snapshot=repository.snapshot(),op=command.op,id=KIND==='incident'?command.incidentID:command.bookingID;
  if(op==='get'){const record=find(snapshot,id,actor,tenantID);return{id:command.id,ok:true,data:KIND==='incident'?record:{booking:record,invoice:invoiceFor(record,snapshot.ledger)}};}
  if(['list','search','analytics','audit','availability'].includes(op)){
   const filter={tenantID,customerID:KIND==='booking'&&actor.role==='customer'?actor.id:null,query:op==='search'?command.query:''};let data;
   if(op==='analytics')data=summarize(snapshot,actor,tenantID);else if(op==='audit')data=queryAudit(snapshot.audit,{...filter,bookings:snapshot.bookings});else if(op==='availability'){const resource=seed.resources.find(r=>r.id===command.resourceID&&r.tenantID===tenantID);if(!resource)fail('NOT_FOUND');data={available:capacityAvailable(snapshot.bookings,{...command,capacity:resource.capacity})};}else data=KIND==='incident'?searchIncidents(snapshot.incidents,filter):searchBookings(snapshot.bookings,filter);
   return{id:command.id,ok:true,data};
  }
  if(op!=='open'&&op!=='reserve')find(snapshot,id,actor,tenantID);
  const fingerprint=JSON.stringify({...command,actorID:actor.id,tenantID});
  return repository.transact({requestID:command.id,fingerprint,expectedRevision:command.expectedRevision},state=>{
   let record;
   if(op==='open'||op==='reserve'){
    text(id);text(command.title);if(state[domain].some(r=>r.id===id))fail('ALREADY_EXISTS');
    if(KIND==='incident'){
     if(!['low','medium','high','critical'].includes(command.severity)||!seed.actors.some(a=>a.id===command.ownerID&&a.tenantID===tenantID&&['admin','operator'].includes(a.role)))fail('INVALID_INPUT');
     record={id,tenantID,title:command.title,severity:command.severity,ownerID:command.ownerID,status:'open',version:1,createdAt:at,resolvedAt:null,comments:[],links:[]};
    }else{
     const resource=seed.resources.find(r=>r.id===command.resourceID&&r.tenantID===tenantID);if(!resource)fail('NOT_FOUND');if(actor.role==='customer'&&actor.id!==command.customerID)fail('FORBIDDEN');if(!seed.actors.some(a=>a.id===command.customerID&&a.tenantID===tenantID&&a.role==='customer'))fail('INVALID_INPUT');
     const amountCents=(command.end-command.start)*command.seats*resource.rateCents;if(![command.start,command.end,command.seats].every(Number.isSafeInteger)||command.start>=command.end||command.seats<1||command.seats>resource.capacity||!Number.isSafeInteger(amountCents)||amountCents<=0)fail('INVALID_INPUT');
     if(!capacityAvailable(state.bookings,{...command,capacity:resource.capacity}))fail('CAPACITY');
     record={id,tenantID,resourceID:command.resourceID,customerID:command.customerID,title:command.title,start:command.start,end:command.end,seats:command.seats,amountCents,status:'held',version:1,createdAt:at};
    }
    state[domain].push(record);
   }else{
    record=find(state,id,actor,tenantID);if(command.expectedVersion!==record.version)fail('CONFLICT');
    if(KIND==='incident'){
     if(op==='transition')Object.assign(record,transitionIncident(record,{status:command.status,actorID:actor.id,at}));
     else if(op==='reopen'){if(record.status!=='resolved')fail('INVALID_TRANSITION');record.status='open';record.resolvedAt=null;record.version++;}
     else if(op==='comment'){text(command.text,2000);record.comments.push({actorID:actor.id,text:command.text,at});record.version++;}
     else if(op==='link'){const target=state.incidents.find(r=>r.id===command.targetID&&r.tenantID===tenantID);if(!target)fail('NOT_FOUND');if(target.id===id||record.links.includes(target.id))fail('INVALID_INPUT');record.links.push(target.id);record.version++;}else fail('FORBIDDEN');
    }else{
     const invoice=invoiceFor(record,state.ledger),ledger=(kind,amountCents,paymentReference=null)=>state.ledger.push({id:command.id+'-'+kind,tenantID,bookingID:id,kind,amountCents,paymentReference,at});
     if(op==='pay'){if(record.status==='cancelled')fail('BOOKING_STATE');text(command.paymentReference);if(state.ledger.some(r=>r.tenantID===tenantID&&r.kind==='charge'&&r.paymentReference===command.paymentReference))fail('PAYMENT_REFERENCE_CONFLICT');if(!Number.isSafeInteger(command.amountCents)||command.amountCents<=0||command.amountCents>invoice.balanceCents)fail('PAYMENT_AMOUNT');ledger('charge',command.amountCents,command.paymentReference);record.version++;}
     else if(op==='confirm'){if(invoice.balanceCents!==0)fail('UNPAID');Object.assign(record,transitionBooking(record,{status:'confirmed'}));}
     else if(op==='refund'){if(!Number.isSafeInteger(command.amountCents)||command.amountCents<=0||command.amountCents>invoice.paidCents-invoice.refundedCents)fail('REFUND_LIMIT');ledger('refund',command.amountCents);record.version++;}
     else if(op==='cancel'){Object.assign(record,transitionBooking(record,{status:'cancelled'}));const balance=invoice.paidCents-invoice.refundedCents;if(balance>0)ledger('refund',balance);}else fail('FORBIDDEN');
    }
   }
   state.audit=appendAudit(state.audit,{id:command.id+'-audit',tenantID,actorID:actor.id,entityID:id,action:op,at,revision:state.revision+1});return structuredClone(record);
  });
 }};
}

function renderWorkspace({seed,actor,tenantID,snapshot,analytics}){
 const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
 const control=(name,type='text',value='')=>`<label for="${name}">${name}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" required>`;
 const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${esc(value)}">`;
 const form=(op,body,id='')=>`<form method="post" action="/command" data-op="${op}" ${id?'data-record-id="'+esc(id)+'"':''}>${hidden('op',op)}${body}<button type="submit">${op}</button></form>`;
 let content='';
 if(KIND==='incident'){
  if(authorize({actor,tenantID,action:'open'}))content+=form('open',control('title')+control('severity','text','medium')+control('ownerID','text',actor.id)+hidden('incidentID','new-incident'));
  for(const record of snapshot.incidents.filter(r=>r.tenantID===tenantID)){
   content+=`<article><h2>${esc(record.title)}</h2><p>${esc(record.status)} · ${esc(record.severity)} · ${esc(record.ownerID)}</p>${record.comments.map(c=>'<p>'+esc(c.text)+'</p>').join('')}<p>${record.links.map(esc).join(', ')}</p>`;
   const next={open:'triaged',triaged:'mitigated',mitigated:'resolved'}[record.status],fields=hidden('incidentID',record.id)+hidden('expectedVersion',record.version);
   if(next&&authorize({actor,tenantID,action:'transition'}))content+=form('transition',fields+hidden('status',next),record.id);
   if(authorize({actor,tenantID,action:'comment'}))content+=form('comment',fields+control('text'),record.id);
   if(record.status==='resolved'&&authorize({actor,tenantID,action:'reopen'}))content+=form('reopen',fields,record.id);content+='</article>';
  }
 }else{
  content+=form('reserve',control('title')+control('resourceID','text',seed.resources.find(r=>r.tenantID===tenantID)?.id)+control('start','number',60)+control('end','number',90)+control('seats','number',1)+(actor.role==='customer'?hidden('customerID',actor.id):control('customerID'))+hidden('bookingID','new-booking'));
  for(const record of snapshot.bookings.filter(r=>r.tenantID===tenantID&&(actor.role!=='customer'||r.customerID===actor.id))){
   const invoice=invoiceFor(record,snapshot.ledger),fields=hidden('bookingID',record.id)+hidden('expectedVersion',record.version);content+=`<article><h2>${esc(record.title)}</h2><p>${esc(record.status)} · ${esc(record.resourceID)} · ${record.start}–${record.end} · ${record.seats} seats</p><p>Total ${invoice.totalCents}; paid ${invoice.paidCents}; refunded ${invoice.refundedCents}</p>`;
   if(record.status!=='cancelled'&&invoice.balanceCents>0)content+=form('pay',fields+control('amountCents','number',invoice.balanceCents)+control('paymentReference'),record.id);
   if(record.status==='held'&&invoice.balanceCents===0)content+=form('confirm',fields,record.id);
   if(record.status!=='cancelled')content+=form('cancel',fields,record.id);
   if(actor.role==='admin'&&invoice.paidCents>invoice.refundedCents)content+=form('refund',fields+control('amountCents','number'),record.id);content+='</article>';
  }
 }
 return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="public/product.css"><title>Workspace</title></head><body><main><h1>${KIND==='incident'?'Operations Desk':'Reservation Ledger'}</h1><section aria-label="Summary"><pre>${esc(JSON.stringify(analytics))}</pre></section>${content}</main></body></html>`;
}
async function runScenario({seed,initial=null,tenantID,actorID,timeBase=1000,commands=[]}){
 let repository=createRepository(initial??{schemaVersion:1,revision:0,...(KIND==='incident'?{incidents:[]}:{bookings:[],ledger:[]}),audit:[],receipts:{}}),service=createService({repository,seed}),index=0;
 const execute=async command=>{
  const at=command.at??timeBase+index++,actor=seed.actors.find(a=>a.id===(command.actorID??actorID)),tenant=command.tenantID??tenantID;
  try{
   if(command.op==='parallel')return{id:command.id,ok:true,data:await Promise.all(command.commands.map(execute))};
   if(command.op==='reload'){repository=createRepository(repository.snapshot());service=createService({repository,seed});return{id:command.id,ok:true,data:{revision:repository.snapshot().revision}};}
   return await service.execute(command,{actor,tenantID:tenant,at});
  }catch(error){return{id:command.id,ok:false,error:{code:error.code??'INVALID_INPUT'}};}
 };
 const responses=[];for(const command of commands)responses.push(await execute(command));const snapshot=repository.snapshot(),actor=seed.actors.find(a=>a.id===actorID),analytics=service.summarize(snapshot,actor,tenantID);return{responses,snapshot,analytics,html:renderWorkspace({seed,actor,tenantID,snapshot,analytics})};
}

function referenceFiles(kind){
 const common=`const KIND=${JSON.stringify(kind)};const fail=code=>{throw Object.assign(new Error(code),{code});};\n`,definition=fn=>'export '+fn.toString()+'\n';
 const files={'access.mjs':common+definition(authorize),'repository.mjs':common+definition(createRepository)};
 if(kind==='incident'){files['workflow.mjs']=common+definition(transitionIncident);files['audit.mjs']=definition(appendAudit)+definition(queryAudit);files['insights.mjs']=definition(searchIncidents)+definition(summarizeIncidents);}
 else{files['calendar.mjs']=common+definition(capacityAvailable)+definition(transitionBooking);files['billing.mjs']=definition(invoiceFor);files['reporting.mjs']=definition(searchBookings)+definition(summarizeBookings)+definition(appendAudit)+definition(queryAudit);}
 const imports=kind==='incident'?`import {transitionIncident} from './workflow.mjs';import {appendAudit,queryAudit} from './audit.mjs';import {searchIncidents,summarizeIncidents} from './insights.mjs';`:`import {capacityAvailable,transitionBooking} from './calendar.mjs';import {invoiceFor} from './billing.mjs';import {appendAudit,queryAudit,searchBookings,summarizeBookings} from './reporting.mjs';`;
 files[kind==='incident'?'incidents.mjs':'reservations.mjs']=common+`import {authorize} from './access.mjs';`+imports+definition(createService)+`export const ${kind==='incident'?'createIncidentService':'createReservationService'}=createService;`;
 files['views.mjs']=common+`import {authorize} from './access.mjs';`+(kind==='booking'?`import {invoiceFor} from './billing.mjs';`:'')+definition(renderWorkspace);
 files['app.mjs']=common+`import {createRepository} from './repository.mjs';import {createService} from './${kind==='incident'?'incidents':'reservations'}.mjs';import {renderWorkspace} from './views.mjs';`+definition(runScenario);
 return files;
}
async function seeded(fixture,reference=false,mutate=null){const root=await mkdtemp(join(tmpdir(),'mission-saas-'));const files={...fixture.files,...(reference?referenceFiles(fixture.id==='operations-desk'?'incident':'booking'):{})};mutate?.(files);for(const[path,content]of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}return root;}

test('both coherent product missions have eight substantial streams, bounded public specs and fail unimplemented seeds',async()=>{
 for(const fixture of saasMissions){assert.equal(fixture.workstreams.length,8);assert.ok(Buffer.byteLength(fixture.goal)<=7000);assert.ok(fixture.workstreams.every(w=>Buffer.byteLength(w.brief)<=1200&&w.paths.length));const root=await seeded(fixture);try{const result=await verifySaasMission(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.checks.some(c=>!c.passed));assert.ok(result.instructionChecks.every(c=>c.passed));}finally{await rm(root,{recursive:true,force:true});}}
});
for(const fixture of saasMissions)test(`${fixture.title}: complete test-only reference satisfies hidden integrated scenarios`,async()=>{const root=await seeded(fixture,true);try{const result=await verifySaasMission(fixture.id,root);assert.equal(result.correct,true,JSON.stringify(result.checks));assert.equal(fixture.reviewInvocation.exportName,'runScenario');assert.equal(fixture.reviewInvocation.path,'app.mjs');assert.ok(Array.isArray(fixture.reviewInvocation.args)&&fixture.reviewInvocation.args.length===1);const reviewSeed=JSON.parse(fixture.files['data/seed.json']);assert.deepEqual(fixture.reviewInvocation.args[0].seed,reviewSeed);assert.ok(!Object.hasOwn(fixture.reviewInvocation,'expected'));
 const smoke=await verifyMission({...fixture,criteria:[{id:'public-review-smoke'}]},root,async({invoke,check})=>{await check('public-review-smoke',async()=>{const invocation=fixture.reviewInvocation,view=await invoke(invocation.path,invocation.exportName,invocation.args);assert.ok(view.responses.every(row=>row.ok));assert.equal((view.snapshot.incidents??view.snapshot.bookings).length,2);assert.ok(view.html.includes(invocation.args[0].commands[0].title));assert.match(view.html,/<main\b/);});});assert.equal(smoke.correct,true,'public review invocation produces usable records and HTML');
 }finally{await rm(root,{recursive:true,force:true});}});
test('incident grader rejects cross-tenant authorization and unescaped rendered data',async()=>{
 const fixture=saasMissions[0];for(const mutate of [files=>{files['access.mjs']=files['access.mjs'].replace('actor.tenantID!==tenantID','false');},files=>{files['views.mjs']=files['views.mjs'].replace(".replaceAll('<','&lt;')",'');}]){const root=await seeded(fixture,true,mutate);try{const result=await verifySaasMission(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.checks.some(c=>!c.passed));}finally{await rm(root,{recursive:true,force:true});}}
});
test('booking grader rejects unlimited capacity and over-refunding',async()=>{
 const fixture=saasMissions[1];for(const mutate of [files=>{files['calendar.mjs']=`export function capacityAvailable(){return true;}\n`+transitionBooking.toString().replace('function transitionBooking','export function transitionBooking')+`;const fail=code=>{throw Object.assign(new Error(code),{code})};`;},files=>{files['reservations.mjs']=files['reservations.mjs'].replace('||command.amountCents>invoice.paidCents-invoice.refundedCents','');}]){const root=await seeded(fixture,true,mutate);try{const result=await verifySaasMission(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.checks.some(c=>!c.passed));}finally{await rm(root,{recursive:true,force:true});}}
});
