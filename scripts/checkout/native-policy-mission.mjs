import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {executeNative} from './native-grader.mjs';
export const policyDirective=`Implement a compiled policy snapshot for pricing, fulfillment and reports, while preserving every legacy behavior.
The policy publisher owns src/config.mjs#orderPolicy and will revise the offerPercent and returnWindowDays fields. All existing currency, default discount and shipping fields remain unchanged. The publisher's exact revision is in its own task directive.
Consumer builders MUST inspect their actual issued src/config.mjs and compile the observed offerPercent/returnWindowDays into literal constants inside their assigned functions. These are archival policy snapshots: once published they must continue to return those compiled values when config fields are later changed or re-imported. Do not import/read the policy dynamically for the new behavior, infer another builder's future values, or use runtime caches that change after a fresh import. Existing legacy runtime policy behavior remains intact.
1. discountSubtotal(subtotalCents,percent,options={}) supports options.offer===true, applying the compiled offerPercent, with normal integer-cent rounding and cents validation. Ordinary calls retain their original behavior and default percent. An explicit percent argument does not override offer mode.
2. fulfillOrder(order,receipt,stock,options={}) supports options.returnable===true, attaching compiled returnWindowDays onto its returned fulfilled order. Preserve captured-payment validation, inventory conservation and input immutability. Default calls retain their exact original shape.
3. reports.format(order) for status 'offer' appends '; offer N%, returns D days' to its existing text, using both compiled values. Other statuses/text remain unchanged. No new public APIs or files.
All three consumers must agree with the policy publisher's final revision for the shared mission to be correct. If a checkout is refreshed, re-inspect its source and recompile. The frozen-output requirement remains true if config changes again after this mission. Helpers/imports within assigned paths may require explicit candidate-bound expansion. Native file tools only, no shell/packages/subagents/external calls. Public tests preserve legacy behavior; independent acceptance is held outside your copy. Only the runner publishes.
`;
export const policyRoles=[
 {id:'policy',focus:'Revise only offerPercent to 30 and returnWindowDays to 21 in orderPolicy. Preserve its other fields and frozen-object behavior.',writes:[['src/config.mjs','orderPolicy']]},
 {id:'pricing',focus:'Inspect your issued policy source and compile its observed offerPercent into discountSubtotal offer mode. Keep legacy defaults and validation.',writes:[['src/pricing.mjs','discountSubtotal']]},
 {id:'fulfillment',focus:'Inspect your issued policy source and compile its observed returnWindowDays into optional returnable fulfillment. Preserve payment checks and stock.',writes:[['src/fulfillment.mjs','fulfillOrder']]},
 {id:'report',focus:'Inspect your issued policy source and compile both observed values into offer report text. Preserve all legacy statuses.',writes:[['src/reports.mjs','format']]},
];
export function policySeed(seed){return {...seed,'src/config.mjs':seed['src/config.mjs'].replace("  currency: 'CAD',","  currency: 'CAD',\n  offerPercent: 5,\n  returnWindowDays: 14,")};}
export function policyReference(seed){
 const files={...seed};files['src/config.mjs']=files['src/config.mjs'].replace('offerPercent: 5','offerPercent: 30').replace('returnWindowDays: 14','returnWindowDays: 21');
 files['src/pricing.mjs']=files['src/pricing.mjs'].replace('percent = orderPolicy.defaultDiscountPercent)', 'percent = orderPolicy.defaultDiscountPercent, options = {})').replace('  assertCents(subtotalCents);','  if(options.offer===true)percent=30;\n  assertCents(subtotalCents);');
 files['src/fulfillment.mjs']=files['src/fulfillment.mjs'].replace('receipt, stock)', 'receipt, stock, options = {})').replace("{ ...order, status: 'fulfilled' }", "{ ...order, ...(options.returnable===true?{returnWindowDays:21}:{}), status: 'fulfilled' }");
 files['src/reports.mjs']=files['src/reports.mjs'].replace('  return `Order',"  if(order.status==='offer')return `Order ${order.id}: ${order.status}, ${formatMoney(order.totalPaidCents,order.currency)}; offer 30%, returns 21 days`;\n  return `Order");return files;
}
const observe=`const out={};const run=(name,fn)=>{try{out[name]={value:fn()};}catch{out[name]={error:true};}};const refuses=fn=>{try{fn();return false;}catch{return true;}};
const {orderPolicy}=await import('./src/config.mjs');const {discountSubtotal}=await import('./src/pricing.mjs');const {fulfillOrder}=await import('./src/fulfillment.mjs');const {createOrder}=await import('./src/orders.mjs');const {capturePayment}=await import('./src/payments.mjs');const {format}=await import('./src/reports.mjs');
run('policy',()=>({fields:orderPolicy,frozen:Object.isFrozen(orderPolicy)}));run('pricing',()=>[discountSubtotal(1000,0,{offer:true}),discountSubtotal(101,99,{offer:true}),discountSubtotal(1000),discountSubtotal(1000,20)]);
run('invalid',()=>[-1,0.5,NaN].map(n=>refuses(()=>discountSubtotal(n,0,{offer:true}))));
run('fulfillment',()=>{const order=createOrder('o',[{sku:'book',quantity:1}]),receipt=capturePayment(order),stock={book:2};return {result:fulfillOrder(order,receipt,stock,{returnable:true}),order,stock,legacy:fulfillOrder(order,receipt,stock),refused:refuses(()=>fulfillOrder(order,{...receipt,amountCents:1},stock,{returnable:true}))};});
run('report',()=>[format({id:'o',status:'offer',totalPaidCents:700,currency:'CAD'}),format({id:'o',status:'priced',totalPaidCents:700,currency:'CAD'})]);
`;
export function gradePolicy(files,destination,behavior){
 const initial=executeNative(files,resolve(destination,'published'),behavior,observe);
 // A fresh child import of a perturbed copy defeats runtime reads/caches. All
 // expected values stay in this parent. Only new fields change; legacy is intact.
 const perturbed={...files,'src/config.mjs':files['src/config.mjs']+"\n// Policy mutation for independent archival-snapshot observation\n"};
 // Replace policy export with equivalent legacy fields and deliberately different
 // offer/window fields, without depending on the generated author's formatting.
 perturbed['src/config.mjs']="export const orderPolicy = Object.freeze({currency:'CAD',defaultDiscountPercent:10,heavyParcelGrams:10000,standardShippingCents:500,heavyShippingCents:2000,offerPercent:99,returnWindowDays:2});\n";
 const changed=executeNative(perturbed,resolve(destination,'perturbed'),behavior,observe),checks=[];
 const val=(out,name)=>{if(!out[name]||out[name].error)throw Error('execution_failed');return out[name].value;};
 const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}};
 const prices=out=>assert.deepEqual(val(out,'pricing'),[700,71,900,800]);
 const fulfill=out=>{const v=val(out,'fulfillment');assert.equal(v.result.order.returnWindowDays,21);assert.equal(v.result.order.status,'fulfilled');assert.deepEqual(v.result.stock,{book:1});assert.deepEqual(v.stock,{book:2});assert.equal(v.order.status,'priced');assert.equal(Object.hasOwn(v.legacy.order,'returnWindowDays'),false);assert.equal(v.refused,true);};
 const report=out=>assert.deepEqual(val(out,'report'),['Order o: offer, CAD 7.00; offer 30%, returns 21 days','Order o: priced, CAD 7.00']);
 check('final-policy-revision',()=>{const p=val(initial.out,'policy');assert.equal(p.fields.offerPercent,30);assert.equal(p.fields.returnWindowDays,21);assert.equal(p.frozen,true);});
 check('compiled-offer-pricing',()=>prices(initial.out));check('offer-cents-validation',()=>assert.deepEqual(val(initial.out,'invalid'),[true,true,true]));
 check('compiled-return-window',()=>fulfill(initial.out));check('compiled-policy-report',()=>report(initial.out));
 check('pricing-frozen-across-fresh-import',()=>prices(changed.out));check('fulfillment-frozen-across-fresh-import',()=>fulfill(changed.out));check('report-frozen-across-fresh-import',()=>report(changed.out));
 const legacyValid=initial.legacyValid&&changed.legacyValid;return {correct:legacyValid&&checks.every(c=>c.passed),legacyValid,checks,executionValid:initial.executionValid&&changed.executionValid};
}
