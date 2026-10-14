import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GraphCheckout} from '../src/prototypes/checkout/graph-checkout.mjs';
import {normalizeGraph,sourceRevision} from '../src/prototypes/checkout/graph-index.mjs';
import {CheckoutArbiter} from '../src/prototypes/checkout/arbiter.mjs';
const cases=JSON.parse(readFileSync(new URL('../fixtures/checkout-graph/expansion.json',import.meta.url)));
const build=files=>{const row=Object.values(cases).find(c=>sourceRevision(c.files)===sourceRevision(files));if(!row)throw Error('unqualified_test_source');return normalizeGraph({files,ast:row.ast});};
const request=(participantId,blockId)=>({participantId,writes:[{blockId}],leaseMs:100});
const setup=validate=>new GraphCheckout({files:cases.seed.files,buildIndex:build,validate:validate??(()=>true)});
const submission=grant=>({checkoutId:grant.checkoutId,participantId:grant.participantId,files:{'main.mjs':cases.helper.files['main.mjs']}});
const expansion=grant=>({...submission(grant),additionalWrites:[{blockId:'main.mjs#helper'}]});

test('explicit helper expansion grants without publication, then exact candidate publishes',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0);
 assert.equal(s.submit(submission(a),1).reason,'scope_expansion_required');
 const expanded=s.expand(expansion(a),2);assert.equal(expanded.expanded,true);
 assert.deepEqual(s.snapshot(2).files,cases.seed.files);
 assert.equal(s.checkout(request('b','provider.mjs#target'),3).reason,'checkout_conflict');
 assert.equal(s.submit(submission(a),4).admitted,true);assert.deepEqual(s.snapshot(4).files,cases.helper.files);
 assert.equal(s.snapshot(4).grants.length,0);
});

test('new dependency expansion requires no modification right to its provider',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0);
 const patch={...submission(a),files:{'main.mjs':cases.dependency.files['main.mjs']}};
 assert.equal(s.submit(patch,1).reason,'scope_expansion_required');
 assert.equal(s.expand(patch,2).expanded,true);
 assert.equal(s.submit(patch,3).admitted,true);
 assert.deepEqual(s.snapshot(3).files,cases.dependency.files);
});

test('conflicting expansion is atomic, original grant survives, release allows retry',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0),b=s.checkout(request('b','provider.mjs#target'),0);
 const before=s.snapshot(1);
 const denied=s.expand(expansion(a),1);assert.equal(denied.reason,'checkout_conflict');
 assert.ok(denied.conflicts.some(c=>c.participantId==='b'));
 assert.deepEqual(s.snapshot(1),before);
 s.release(b,2);assert.equal(s.expand(expansion(a),3).expanded,true);
});

test('same-file coordinate changes conflict conservatively; independent path coexists',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0),b=s.checkout(request('b','main.mjs#second'),0);
 assert.equal(s.expand(expansion(a),1).reason,'checkout_conflict');s.release(b,2);
 assert.equal(s.checkout(request('c','free.mjs#free'),2).granted,true);
 assert.equal(s.expand(expansion(a),3).expanded,true);
});

test('helper permission cannot authorize an unrelated existing-body edit',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0);
 assert.equal(s.expand({...expansion(a),files:{'main.mjs':cases.outside.files['main.mjs']}},1).reason,'outside_modification_scope');
 assert.equal(s.snapshot(1).grants.length,1);assert.deepEqual(s.snapshot(1).files,cases.seed.files);
});

test('expired, wrong owner, unknown calls and invalid requests cannot expand',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0);
 assert.equal(s.expand({...expansion(a),participantId:'b'},1).reason,'checkout_not_live');
 assert.equal(s.expand({...expansion(a),additionalWrites:null},1).reason,'invalid_expansion');
 assert.equal(s.expand({...expansion(a),files:{'main.mjs':cases.unknown.files['main.mjs']},additionalWrites:[]},1).reason,'unresolved_dependency');
 assert.equal(s.expand(expansion(a),100).reason,'checkout_not_live');assert.equal(s.snapshot(100).grants.length,0);
});

test('expanded authority is candidate-bound and still requires synchronous validation',()=>{
 const s=setup(()=>false),a=s.checkout(request('a','main.mjs#first'),0);
 assert.equal(s.expand(expansion(a),1).expanded,true);
 assert.equal(s.submit(submission(a),2).reason,'validation_failed');assert.deepEqual(s.snapshot(2).files,cases.seed.files);
 const core=new CheckoutArbiter({files:cases.seed.files,blocks:build(cases.seed.files).blocks});
 const g=core.checkout(request('a','main.mjs#first'),0);
 const expanded=core.expand({...g,candidate:cases.helper.files,blocks:build(cases.helper.files).blocks,edges:build(cases.helper.files).edges,writes:[{blockId:'main.mjs#first'},{blockId:'main.mjs#helper'}]},1);
 assert.equal(expanded.expanded,true);
 assert.equal(core.submit({...submission(g),files:{'main.mjs':cases.outside.files['main.mjs']},validate:()=>true},2).reason,'expansion_candidate_moved');
 assert.equal(core.submit({...submission(g),validate:()=>true},3).admitted,true);
});

test('core refuses expansion that drops original writes or broadens a line-only grant',()=>{
 const core=new CheckoutArbiter({files:{'x.mjs':'function first() {\n return 1;\n}\n'},blocks:[{id:'x.mjs#first',path:'x.mjs',startLine:1,endLine:3}]});
 const g=core.checkout({participantId:'a',writes:[{blockId:'x.mjs#first',startLine:2,endLine:2}]},0);
 assert.equal(core.expand({...g,candidate:core.snapshot(0).files,blocks:[{id:'x.mjs#first',path:'x.mjs',startLine:1,endLine:3}],writes:[{blockId:'x.mjs#first'}]},1).reason,'expansion_subranges_unsupported');
 const c=setup(),a=c.checkout(request('a','main.mjs#first'),0);assert.equal(c.expand({...expansion(a),additionalWrites:[{blockId:'absent'}]},1).reason,'invalid_expansion');
});

test('unrelated publication requires a fresh base before expansion; no stale relabeling',()=>{
 const s=setup(),a=s.checkout(request('a','main.mjs#first'),0),b=s.checkout(request('b','free.mjs#free'),0);
 assert.equal(s.submit({...b,files:{'free.mjs':cases.moved.files['free.mjs']}},1).admitted,true);
 assert.equal(s.expand(expansion(a),2).reason,'expansion_base_moved');
 assert.deepEqual(s.snapshot(2).files,cases.moved.files);assert.equal(s.snapshot(2).grants.length,1);
});

test('native bridge exposes explicit expansion without silently publishing or refreshing edits',async()=>{
 const {NativeBridge}=await import('../scripts/checkout/native-bridge.mjs');const s=setup();
 const bridge=new NativeBridge({system:s,arm:'graph',roles:[{id:'a',writes:[['main.mjs','first']]}]});
 await bridge.begin('a',0);assert.equal((await bridge.submit('a',cases.helper.files,1)).reason,'scope_expansion_required');
 assert.equal((await bridge.expand('a',cases.helper.files,[{blockId:'main.mjs#helper'}],2)).expanded,true);
 assert.deepEqual((await bridge.snapshot(2)).files,cases.seed.files);
 assert.equal((await bridge.submit('a',cases.helper.files,3)).admitted,true);
});

test('runner explicitly requests introduced helpers in both scoped arms',async()=>{
 const {NativeBridge}=await import('../scripts/checkout/native-bridge.mjs');
 for(const arm of ['graph','blocks']){
  const system=arm==='graph'?setup():new CheckoutArbiter({files:cases.seed.files,blocks:build(cases.seed.files).blocks});
  const bridge=new NativeBridge({system,arm,buildIndex:build,validate:()=>true,roles:[{id:'a',writes:[['main.mjs','first']]}]});
  await bridge.begin('a',0);const proposal=await bridge.requestExpansion('a',cases.helper.files,1);
  assert.equal(proposal.expanded,true);assert.deepEqual(proposal.requestedAdditionalWrites,[{blockId:'main.mjs#helper'}]);
  assert.deepEqual((await bridge.snapshot(1)).files,cases.seed.files);assert.equal((await bridge.submit('a',cases.helper.files,2)).admitted,true);
 }
});

test('core rejects dropped writes, new paths and partial additional rights without altering the grant',()=>{
 const core=new CheckoutArbiter({files:cases.seed.files,blocks:build(cases.seed.files).blocks});const g=core.checkout(request('a','main.mjs#first'),0);
 const wanted={...g,candidate:cases.helper.files,blocks:build(cases.helper.files).blocks,edges:build(cases.helper.files).edges};
 const before=core.snapshot(1);
 assert.equal(core.expand({...wanted,writes:[{blockId:'main.mjs#helper'}]},1).reason,'expansion_cannot_drop_writes');
 assert.equal(core.expand({...wanted,writes:[{blockId:'main.mjs#first'},{blockId:'main.mjs#helper',startLine:4,endLine:4}]},1).reason,'expansion_subranges_unsupported');
 assert.equal(core.expand({...wanted,candidate:{...cases.helper.files,'new.mjs':'export const extra=1;\n'},writes:[{blockId:'main.mjs#first'},{blockId:'main.mjs#helper'}]},1).reason,'unknown_submission_path');
 assert.deepEqual(core.snapshot(1),before);
});

test('blank insertion in an unrelated template literal is an unauthorized data edit',()=>{
 const files={'x.mjs':'function first() { return 1; }\nfunction second() {\n return `a\nb`;\n}\n'};
 const candidate={'x.mjs':'function first() { return helper(); }\nfunction second() {\n return `a\n\nb`;\n}\n\nfunction helper() { return 2; }\n'};
 const core=new CheckoutArbiter({files,blocks:[{id:'x.mjs#first',path:'x.mjs',startLine:1,endLine:1},{id:'x.mjs#second',path:'x.mjs',startLine:2,endLine:5}]});
 const g=core.checkout(request('a','x.mjs#first'),0);
 const denied=core.expand({...g,candidate,blocks:[{id:'x.mjs#first',path:'x.mjs',startLine:1,endLine:1},{id:'x.mjs#second',path:'x.mjs',startLine:2,endLine:6},{id:'x.mjs#helper',path:'x.mjs',startLine:8,endLine:8}],writes:[{blockId:'x.mjs#first'},{blockId:'x.mjs#helper'}]},1);
 assert.equal(denied.reason,'outside_modification_scope');assert.deepEqual(core.snapshot(1).files,files);
});

test('runner refuses expired expansion before invoking its producer',async()=>{
 const {NativeBridge}=await import('../scripts/checkout/native-bridge.mjs');let builds=0;
 const system=new CheckoutArbiter({files:cases.seed.files,blocks:build(cases.seed.files).blocks});
 const bridge=new NativeBridge({system,arm:'blocks',buildIndex:files=>{builds++;return build(files);},roles:[{id:'a',writes:[['main.mjs','first']]}]});
 await bridge.begin('a',0);assert.equal((await bridge.requestExpansion('a',cases.helper.files,900000)).reason,'checkout_not_live');assert.equal(builds,0);
});

test('runner returns candidate producer failures as refusals and retains its grant',async()=>{
 const {NativeBridge}=await import('../scripts/checkout/native-bridge.mjs');
 const system=new CheckoutArbiter({files:cases.seed.files,blocks:build(cases.seed.files).blocks});
 const bridge=new NativeBridge({system,arm:'blocks',buildIndex:()=>{throw Error('parse_error');},roles:[{id:'a',writes:[['main.mjs','first']]}]});
 await bridge.begin('a',0);const denied=await bridge.requestExpansion('a',cases.helper.files,1);assert.equal(denied.reason,'invalid_expansion');assert.equal(denied.detail,'parse_error');assert.equal((await bridge.snapshot(1)).grants.length,1);
});

test('runner cannot implicitly expand modification authority into another assigned path',async()=>{
 const {NativeBridge}=await import('../scripts/checkout/native-bridge.mjs');const blocks=build(cases.seed.files).blocks;
 const candidate={...cases.seed.files,'free.mjs':cases.seed.files['free.mjs']+'function helper() { return 5; }\n'};
 const producer=files=>({revision:sourceRevision(files),blocks:[...blocks,...(files['free.mjs']===candidate['free.mjs']?[{id:'free.mjs#helper',path:'free.mjs',startLine:2,endLine:2}]:[])]});
 const system=new CheckoutArbiter({files:cases.seed.files,blocks});
 const bridge=new NativeBridge({system,arm:'blocks',buildIndex:producer,roles:[{id:'a',writes:[['main.mjs','first']]}]});
 await bridge.begin('a',0);const denied=await bridge.requestExpansion('a',candidate,1);assert.equal(denied.reason,'outside_modification_scope');assert.deepEqual(denied.requestedAdditionalWrites,[]);assert.deepEqual((await bridge.snapshot(1)).files,cases.seed.files);
});
