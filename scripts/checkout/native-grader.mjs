// Generated application code runs in Node 26 with no network/process/write authority.
// Expected values remain in the parent; the child returns execution observations only.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const observation=`const out={};const run=(name,fn)=>{try{out[name]={value:fn()};}catch{out[name]={error:true};}};
const {priceCart}=await import('./src/catalog.mjs');const {createOrder}=await import('./src/orders.mjs');const {reserve}=await import('./src/inventory.mjs');const {fulfillOrder}=await import('./src/fulfillment.mjs');const {encodeOrder,decodeOrder}=await import('./src/storage.mjs');const {capturePayment}=await import('./src/payments.mjs');const {checkout}=await import('./src/checkout.mjs');const {issueRefund}=await import('./src/refunds.mjs');const {format:receiptFormat}=await import('./src/notifications.mjs');const {format:reportFormat}=await import('./src/reports.mjs');
const items=[{sku:'book',quantity:2},{sku:'mug',quantity:1,taxExempt:true}],taxed=()=>createOrder('o',items,{taxBasisPoints:1000});
run('cart',()=>({taxable:priceCart(items,{includeTaxable:true}),legacy:priceCart(items)}));
run('taxed',()=>({order:taxed(),items}));
run('rounding',()=>({round:createOrder('r',[{sku:'mug',quantity:1}],{discountPercent:33,taxBasisPoints:875}),exempt:createOrder('e',[{sku:'book',quantity:1,taxExempt:true}],{taxBasisPoints:1000})}));
run('invalidRates',()=>[-1,10001,0.5,NaN,Infinity,'1000'].map(rate=>{try{createOrder('x',items,{taxBasisPoints:rate});return false;}catch{return true;}}));
run('legacy',()=>{const o=createOrder('l',items);return {order:o,receipt:capturePayment(o),decoded:decodeOrder(encodeOrder(o))};});
run('receipt',()=>{const r=capturePayment(taxed());return {receipt:r,text:receiptFormat(r)};});
run('records',()=>{const o=taxed(),bad=[{version:3},{currency:'USD'},{taxCents:-1},{taxCents:0.5},{taxBasisPoints:10001},{taxableSubtotalCents:-1}],refuse=[];for(const x of bad)for(const f of [v=>encodeOrder(v),v=>decodeOrder(JSON.stringify(v))]){try{f({...o,...x});refuse.push(false);}catch{refuse.push(true);}}const missing={...o};delete missing.taxCents;try{decodeOrder(JSON.stringify(missing));refuse.push(false);}catch{refuse.push(true);}return {order:o,decoded:decodeOrder(encodeOrder(o)),refuse};});
run('duplicateStock',()=>{const stock={book:2,mug:1};return {result:reserve(stock,[{sku:'book',quantity:1},{sku:'book',quantity:2},{sku:'mug',quantity:1}],{allowPartial:true}),stock};});
run('missingStock',()=>reserve({},[{sku:'book',quantity:2}],{allowPartial:true}));
run('invalidStock',()=>[-1,0.5,NaN].map(n=>{try{reserve({book:n},[{sku:'book',quantity:1}],{allowPartial:true});return false;}catch{return true;}}));
run('invalidQuantity',()=>[0,-1,0.5].map(n=>{try{reserve({book:1},[{sku:'book',quantity:n}],{allowPartial:true});return false;}catch{return true;}}));
run('partialFulfill',()=>{const o=taxed(),r=capturePayment(o),f=fulfillOrder(o,r,{book:1,mug:1},{allowPartial:true});let refused=false;try{fulfillOrder(o,{...r,amountCents:5809},{book:1,mug:1},{allowPartial:true});}catch{refused=true;}return {order:o,receipt:r,result:f,refused};});
run('checkout',()=>{const stock={book:1,mug:1};const c=checkout('o',items,stock,{taxBasisPoints:1000,allowPartial:true});return {result:c,stock,refund:issueRefund(c.order,c.receipt,50)};});
run('fullStock',()=>{const c=checkout('o',items,{book:3,mug:2},{taxBasisPoints:1000,allowPartial:true});return {result:c,text:reportFormat({id:'z',status:'partially-fulfilled',totalPaidCents:100,unfulfilledItems:[{sku:'book',quantity:2},{sku:'mug',quantity:3}]})};});
`;
export function executeNative(files,destination,behavior,observationCode){
  destination=resolve(destination);mkdirSync(destination,{recursive:true});destination=realpathSync(destination);
  if(Number(process.versions.node.split('.')[0])<26)throw Error('native_grading_requires_node26');
  for(const [path,text]of Object.entries(files)){mkdirSync(dirname(resolve(destination,path)),{recursive:true});writeFileSync(resolve(destination,path),text);}
  const nonce=randomUUID();let legacyValid=false;
  // The published baseline is public to all actors, independent from their changes.
  mkdirSync(resolve(destination,'checks'));writeFileSync(resolve(destination,'checks/behavior-check.mjs'),behavior);
  const args=['--permission',`--allow-fs-read=${destination}`,'--max-old-space-size=128'];
  const run=(extra,input)=>spawnSync(process.execPath,[...args,...extra],{cwd:destination,input,encoding:'utf8',timeout:15_000,maxBuffer:1024*1024,env:{LANG:'C',TZ:'UTC'}});
  const baseline=run(['--test','--test-isolation=none','checks/behavior-check.mjs']);
  writeFileSync(resolve(destination,'baseline.log'),(baseline.stdout??'')+(baseline.stderr??''));legacyValid=!baseline.error&&baseline.status===0;
  const script=observationCode+`process.stdout.write(${JSON.stringify(nonce)}+JSON.stringify(out));`;
  const result=run(['--input-type=module','-e',script]);
  writeFileSync(resolve(destination,'execution-status.json'),JSON.stringify({status:result.status,error:result.error?.code??null}));
  let out={};try{if(!result.error&&result.status===0&&result.stdout.startsWith(nonce))out=JSON.parse(result.stdout.slice(nonce.length));}catch{}
  writeFileSync(resolve(destination,'observations.json'),JSON.stringify(out,null,2));
  return {out,legacyValid,executionValid:!!Object.keys(out).length};
}
export function gradeNative(files,destination,behavior){
  const {out,legacyValid,executionValid}=executeNative(files,destination,behavior,observation);
  const checks=[];
  const value=name=>{if(!out[name]||out[name].error)throw Error('execution_failed');return out[name].value;};
  const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}};
  check('mixed-taxable-subtotal',()=>{assert.deepEqual(value('cart').taxable,{subtotalCents:5500,weightGrams:1300,taxableSubtotalCents:4000});assert.deepEqual(value('cart').legacy,{subtotalCents:5500,weightGrams:1300});});
  check('discount-before-tax',()=>{const x=value('taxed');assert.equal(x.order.version,2);assert.equal(x.order.taxCents,360);assert.equal(x.order.taxableSubtotalCents,4000);assert.equal(x.order.taxBasisPoints,1000);assert.equal(x.order.totalPaidCents,5810);assert.deepEqual(x.items,[{sku:'book',quantity:2},{sku:'mug',quantity:1,taxExempt:true}]);});
  check('rounding-and-exempt',()=>{const x=value('rounding');assert.equal(x.round.taxCents,88);assert.equal(x.round.totalPaidCents,1593);assert.equal(x.exempt.taxCents,0);assert.equal(x.exempt.totalPaidCents,2300);});
  check('invalid-rates',()=>assert.deepEqual(value('invalidRates'),Array(6).fill(true)));
  check('legacy-v1-roundtrip',()=>{const x=value('legacy');assert.equal(x.order.version,1);assert.equal(x.order.totalPaidCents,5450);assert.equal(Object.hasOwn(x.receipt,'taxCents'),false);assert.deepEqual(x.order,x.decoded);});
  check('tax-receipt',()=>{const x=value('receipt');assert.equal(x.receipt.amountCents,5810);assert.equal(x.receipt.taxCents,360);assert.equal(x.text,'Receipt o: CAD 58.10 (tax CAD 3.60)');});
  check('v2-persistence',()=>{const x=value('records');assert.deepEqual(x.decoded,x.order);assert.deepEqual(x.refuse,Array(13).fill(true));});
  check('duplicate-stock',()=>{const x=value('duplicateStock');assert.deepEqual(x.stock,{book:2,mug:1});assert.deepEqual(x.result,{stock:{book:0,mug:0},reservedItems:[{sku:'book',quantity:2},{sku:'mug',quantity:1}],backorders:[{sku:'book',quantity:1}]});});
  check('missing-stock',()=>assert.deepEqual(value('missingStock'),{stock:{},reservedItems:[],backorders:[{sku:'book',quantity:2}]}));
  check('invalid-stock',()=>assert.deepEqual(value('invalidStock'),Array(3).fill(true)));
  check('invalid-quantity',()=>assert.deepEqual(value('invalidQuantity'),Array(3).fill(true)));
  check('partial-fulfillment',()=>{const x=value('partialFulfill');assert.equal(x.order.status,'priced');assert.equal(x.receipt.amountCents,5810);assert.equal(x.refused,true);assert.equal(x.result.order.status,'partially-fulfilled');assert.deepEqual(x.result.order.unfulfilledItems,[{sku:'book',quantity:1}]);assert.deepEqual(x.result.stock,{book:0,mug:0});});
  check('integrated-checkout',()=>{const x=value('checkout'),c=x.result;assert.deepEqual(x.stock,{book:1,mug:1});assert.equal(c.order.totalPaidCents,5810);assert.equal(c.order.status,'partially-fulfilled');assert.equal(c.notification.text,'Receipt o: CAD 58.10 (tax CAD 3.60)');assert.equal(c.summary,'Order o: partially-fulfilled, CAD 58.10; backorders 1');assert.deepEqual(c.stock,{book:0,mug:0});assert.equal(x.refund.amountCents,2905);});
  check('complete-stock-report',()=>{const x=value('fullStock');assert.equal(x.result.order.status,'fulfilled');assert.deepEqual(x.result.order.unfulfilledItems,[]);assert.equal(x.result.summary,'Order o: fulfilled, CAD 58.10; backorders 0');assert.equal(x.text,'Order z: partially-fulfilled, CAD 1.00; backorders 5');});
  return {correct:legacyValid&&checks.every(c=>c.passed),legacyValid,checks,executionValid};
}
