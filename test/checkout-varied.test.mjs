import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {missionSet} from '../scripts/checkout/native-varied-missions.mjs';
const root=new URL('../fixtures/checkout-lab/',import.meta.url);
const seed=Object.fromEntries(readdirSync(new URL('src/',root)).filter(f=>f.endsWith('.mjs')).map(f=>['src/'+f,readFileSync(new URL('src/'+f,root),'utf8')]));const contracts=JSON.parse(readFileSync(new URL('contracts.json',root))),behavior=readFileSync(new URL('test/behavior.test.mjs',root),'utf8');
for(const m of missionSet(seed,contracts))test(`varied mission ${m.id}: seed preserves legacy and fails; independent reference passes`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'checkout-varied-test-'));try{const a=m.grade(m.seed,join(dir,'seed'),behavior),b=m.grade(m.reference(m.seed),join(dir,'reference'),behavior);assert.equal(a.legacyValid,true);assert.equal(a.correct,false);assert.equal(b.correct,true);assert.equal(m.roles.length,4);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('snapshot grader detects runtime policy reads and stale compiled literals',()=>{
 const m=missionSet(seed,contracts).find(m=>m.id==='policy-snapshot'),dir=mkdtempSync(join(tmpdir(),'checkout-policy-test-'));try{
  const ref=m.reference(m.seed),dynamic={...ref,'src/pricing.mjs':ref['src/pricing.mjs'].replace('percent=30','percent=orderPolicy.offerPercent')};
  const a=m.grade(dynamic,join(dir,'dynamic'),behavior);assert.equal(a.legacyValid,true);assert.equal(a.checks.find(c=>c.name==='compiled-offer-pricing').passed,true);assert.equal(a.checks.find(c=>c.name==='pricing-frozen-across-fresh-import').passed,false);
  const stale={...ref,'src/pricing.mjs':ref['src/pricing.mjs'].replace('percent=30','percent=5')};assert.equal(m.grade(stale,join(dir,'stale'),behavior).correct,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('ledger grader detects incorrect replay balances and broken sequential persistence',()=>{
 const m=missionSet(seed,contracts).find(m=>m.id==='refund-ledger'),dir=mkdtempSync(join(tmpdir(),'checkout-ledger-test-'));try{
  const ref=m.reference(m.seed),broken={...ref,'src/refunds.mjs':ref['src/refunds.mjs'].replace('return structuredClone(prior);','return {...prior,remainingCents:0};')};assert.equal(m.grade(broken,join(dir,'broken'),behavior).correct,false);
  const invalid={...ref,'src/storage.mjs':ref['src/storage.mjs'].replace('||refund.remainingCents!==order.totalPaidCents-used','')};const r=m.grade(invalid,join(dir,'bad-records'),behavior);assert.equal(r.legacyValid,true);assert.equal(r.checks.find(c=>c.name==='malformed-ledger-refusal').passed,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
