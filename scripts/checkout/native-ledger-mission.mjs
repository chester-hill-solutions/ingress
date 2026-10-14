import assert from 'node:assert/strict';
import {executeNative} from './native-grader.mjs';
export const ledgerDirective=`Upgrade the order workflow with an auditable, idempotent refund ledger while preserving all public legacy behavior.
1. capturePayment(order,{paymentKey}={}) optionally copies a nonempty string paymentKey onto its captured receipt. With no key its shape stays unchanged. refundableBalance(receipt,refunds=[]) validates nonnegative safe cents, rejects overdraw, mismatched orderId/currency when present, and duplicate or invalid refundId when present. For ID-bearing records require positive amount, refunded status and remainingCents consistent with sequential cumulative balance. Legacy amount-only history is supported. Inputs never mutate.
2. issueRefund(order,receipt,percent,history=[],options={}) keeps legacy percentage behavior and shape when options.refundId is absent. With a nonempty string refundId, options.amountCents may specify positive safe integer cents; otherwise compute the percentage as before. Return {orderId,amountCents,currency,status:'refunded',refundId,remainingCents} and copy receipt.paymentKey when present. remainingCents is the captured amount minus all prior refunds and this refund. A prior identical refundId with the same identity and amount returns a detached copy of that prior record, even when the balance is now exhausted. Reusing the ID for a different amount refuses. Validate the whole history before replay, and refuse malformed/duplicate IDs, identity mismatches, zero/invalid amounts, overdraw, and captured-payment mismatches. No mutation or double counting.
3. encodeOrder/decodeOrder keep version 1 only and validate optional order.refunds. The ledger must be an array of unique, nonempty refundId records with matching order ID/currency, positive safe amountCents, status 'refunded', nonnegative safe remainingCents, and cumulative amount no larger than totalPaidCents. Optional paymentKey must be a nonempty string. Empty ledgers and legacy records round-trip. Ledger remainingCents must match the sequential cumulative balance.
4. checkout accepts optional options.paymentKey and options.refundRequests. If refundRequests is present, it must be an array; fulfill normally, apply each request {refundId,percent} or {refundId,amountCents} sequentially via issueRefund, retain each ID once, attach refunds to the returned fulfilled order and expose refunds on the result. Repeated identical requests do not consume balance twice. Persist/decode the final ledger-bearing order before reporting. Returned captured receipt retains its full amount. The notification adds '; refunded CAD X' using a receipt copy with refundedCents; report adds '; refunded CAD X; balance CAD Y' whenever order.refunds is an array. Default checkout/text shapes remain unchanged. Unsupported versions remain rejected.
All new capabilities must integrate through existing exported functions. Helpers/imports may be introduced only in your assigned file paths and requested through candidate-bound expansion. Native file tools only: no shell, packages, subagents or external calls. Public tests are legacy checks; acceptance is held outside your copy. Only the runner publishes. Conflicts or changed checkout bases may require another edit turn.
`;
export const ledgerRoles=[
 {id:'payments',focus:'Implement optional captured payment key and validated refundable balance, preserving amount-only legacy histories.',writes:[['src/payments.mjs','capturePayment'],['src/payments.mjs','refundableBalance']]},
 {id:'refunds',focus:'Implement the ledger refund API, idempotent replay and balance/identity validation.',writes:[['src/refunds.mjs','issueRefund']]},
 {id:'records',focus:'Persist and independently validate sequential v1 refund ledgers, rejecting malformed and overdrawn records.',writes:[['src/storage.mjs','encodeOrder'],['src/storage.mjs','decodeOrder']]},
 {id:'integration',focus:'Integrate refund requests and payment keys through checkout, final persistence, receipt and report text.',writes:[['src/checkout.mjs','checkout'],['src/notifications.mjs','format'],['src/reports.mjs','format']]},
];
const idGuard="if(typeof value!=='string'||!value.trim())throw new TypeError('invalid_id');";
export function ledgerSeed(seed){return {...seed,'src/payments.mjs':seed['src/payments.mjs'].replace('  const used = refunds.reduce((sum, refund) => sum + assertCents(refund.amountCents), 0);','  let used = 0;\n  for (const refund of refunds) used += assertCents(refund.amountCents);')};}
export function ledgerReference(seed){
 const files={...seed};
 files['src/payments.mjs']=`import {assertCents} from './money.mjs';
function validId(value){${idGuard}}
export function capturePayment(order,{paymentKey}={}){
 assertCents(order.totalPaidCents);if(order.currency!=='CAD')throw new RangeError('unsupported_currency');
 const receipt={orderId:order.id,amountCents:order.totalPaidCents,currency:order.currency,status:'captured'};
 if(paymentKey!==undefined){validId(paymentKey);receipt.paymentKey=paymentKey;}return receipt;
}
export function refundableBalance(receipt,refunds=[]){
 assertCents(receipt.amountCents);if(!Array.isArray(refunds))throw new TypeError('invalid_history');
 let used=0;const ids=new Map();for(const refund of refunds){assertCents(refund.amountCents);
 if(refund.orderId!==undefined&&refund.orderId!==receipt.orderId||refund.currency!==undefined&&refund.currency!==receipt.currency)throw new RangeError('identity_mismatch');
 if(refund.refundId!==undefined){validId(refund.refundId);if(ids.get(refund.refundId))throw new RangeError('duplicate_id');ids.set(refund.refundId,true);}
 used+=refund.amountCents;if(!Number.isSafeInteger(used)||used>receipt.amountCents)throw new RangeError('refunds_exceed_payment');if(refund.refundId!==undefined&&(!refund.amountCents||refund.status!=='refunded'||!Number.isSafeInteger(refund.remainingCents)||refund.remainingCents!==receipt.amountCents-used))throw new RangeError('invalid_ledger_balance');}return receipt.amountCents-used;
}
`;
 files['src/refunds.mjs']=`import {assertCents} from './money.mjs';import {refundableBalance} from './payments.mjs';
function validId(value){${idGuard}}
export function issueRefund(order,receipt,percent,previousRefunds=[],options={}){
 assertCents(order.totalPaidCents);if(order.id!==receipt.orderId||order.currency!==receipt.currency||order.totalPaidCents!==receipt.amountCents||receipt.status!=='captured')throw new RangeError('payment_contract_mismatch');
 let amountCents;if(options.refundId!==undefined&&options.amountCents!==undefined){amountCents=assertCents(options.amountCents);if(amountCents===0)throw new RangeError('invalid_amount');}
 else{if(!Number.isFinite(percent)||percent<=0||percent>100)throw new RangeError('invalid_percent');amountCents=Math.round(order.totalPaidCents*percent/100);}
 const balance=refundableBalance(receipt,previousRefunds);if(options.refundId!==undefined){validId(options.refundId);if(amountCents<=0)throw new RangeError('invalid_amount');
 for(const prior of previousRefunds)if(prior.refundId===options.refundId){if(prior.amountCents!==amountCents||prior.orderId!==order.id||prior.currency!==order.currency)throw new RangeError('id_conflict');return structuredClone(prior);}}
 if(amountCents>balance)throw new RangeError('refund_exceeds_balance');const refund={orderId:order.id,amountCents,currency:order.currency,status:'refunded'};
 if(options.refundId!==undefined){refund.refundId=options.refundId;refund.remainingCents=balance-amountCents;if(receipt.paymentKey!==undefined)refund.paymentKey=receipt.paymentKey;}return refund;
}
`;
 files['src/storage.mjs']=`import {assertCents} from './money.mjs';
function validId(value){${idGuard}}
function validate(order){assertCents(order.totalPaidCents);if(order.version!==1||typeof order.id!=='string'||order.currency!=='CAD')throw new TypeError('invalid_order_record');
 if(order.refunds!==undefined){if(!Array.isArray(order.refunds))throw new TypeError('invalid_ledger');let used=0;const ids=new Map();
 for(const refund of order.refunds){validId(refund.refundId);assertCents(refund.amountCents);assertCents(refund.remainingCents);
 if(!refund.amountCents||refund.orderId!==order.id||refund.currency!==order.currency||refund.status!=='refunded'||ids.get(refund.refundId))throw new RangeError('invalid_refund');
 ids.set(refund.refundId,true);used+=refund.amountCents;if(!Number.isSafeInteger(used)||used>order.totalPaidCents||refund.remainingCents!==order.totalPaidCents-used)throw new RangeError('invalid_balance');if(refund.paymentKey!==undefined)validId(refund.paymentKey);}}
}
export function encodeOrder(order){validate(order);return JSON.stringify(order);}
export function decodeOrder(bytes){const order=JSON.parse(bytes);validate(order);return order;}
`;
 files['src/checkout.mjs']=files['src/checkout.mjs'].replace("import { createOrder }", "import {issueRefund} from './refunds.mjs';\nimport { createOrder }")
 .replace('capturePayment(order)','capturePayment(order,{paymentKey:options?.paymentKey})')
 .replace('  return { ...fulfilled, receipt, notification: sendDefaultReceipt(receipt), summary: renderOrder(fulfilled.order) };',`  if(options?.refundRequests!==undefined){if(!Array.isArray(options.refundRequests))throw new TypeError('invalid_requests');const refunds=[];let refundedCents=0;
 for(const request of options.refundRequests){const result=issueRefund(fulfilled.order,receipt,request.percent,refunds,{refundId:request.refundId,amountCents:request.amountCents});let found=false;for(const prior of refunds)if(prior.refundId===result.refundId)found=true;if(!found){refunds[refunds.length]=result;refundedCents+=result.amountCents;}}
 const savedOrder=decodeOrder(encodeOrder({...fulfilled.order,refunds}));return {...fulfilled,order:savedOrder,receipt,refunds,notification:sendDefaultReceipt({...receipt,refundedCents}),summary:renderOrder(savedOrder)};}
  return { ...fulfilled, receipt, notification: sendDefaultReceipt(receipt), summary: renderOrder(fulfilled.order) };`);
 files['src/notifications.mjs']=files['src/notifications.mjs'].replace('  return `Receipt',"  if(receipt.refundedCents!==undefined)return `Receipt ${receipt.orderId}: ${formatMoney(receipt.amountCents,receipt.currency)}; refunded ${formatMoney(receipt.refundedCents,receipt.currency)}`;\n  return `Receipt");
 files['src/reports.mjs']=files['src/reports.mjs'].replace('  return `Order',"  if(Array.isArray(order.refunds)){let total=0;for(const refund of order.refunds)total+=refund.amountCents;return `Order ${order.id}: ${order.status}, ${formatMoney(order.totalPaidCents,order.currency)}; refunded ${formatMoney(total,order.currency)}; balance ${formatMoney(order.totalPaidCents-total,order.currency)}`;}\n  return `Order");
 return files;
}
const observe=`const out={};const run=(name,fn)=>{try{out[name]={value:fn()};}catch{out[name]={error:true};}};const refuses=fn=>{try{fn();return false;}catch{return true;}};
const {createOrder}=await import('./src/orders.mjs');const {capturePayment,refundableBalance}=await import('./src/payments.mjs');const {issueRefund}=await import('./src/refunds.mjs');const {encodeOrder,decodeOrder}=await import('./src/storage.mjs');const {checkout}=await import('./src/checkout.mjs');const {format:report}=await import('./src/reports.mjs');const {format:notice}=await import('./src/notifications.mjs');
const items=[{sku:'book',quantity:2},{sku:'mug',quantity:1}],order=createOrder('o',items),receipt=capturePayment(order,{paymentKey:'pay-o'});
const a=()=>issueRefund(order,receipt,50,[],{refundId:'a'});const b=()=>issueRefund(order,receipt,undefined,[a()],{refundId:'b',amountCents:725});
run('key',()=>({receipt,bad:['',null,7].map(paymentKey=>refuses(()=>capturePayment(order,{paymentKey})))}));
run('first',()=>a());run('second',()=>b());
run('replay',()=>{const history=[a(),b()],copy=structuredClone(history),replayed=issueRefund(order,receipt,undefined,history,{refundId:'b',amountCents:725});replayed.amountCents=1;return {history,copy,original:issueRefund(order,receipt,undefined,history,{refundId:'b',amountCents:725}),balance:refundableBalance(receipt,history)};});
run('conflicts',()=>[refuses(()=>issueRefund(order,receipt,undefined,[a(),b()],{refundId:'b',amountCents:726})),refuses(()=>issueRefund(order,receipt,undefined,[a(),b()],{refundId:'c',amountCents:2001})),...['',null,3].map(refundId=>refuses(()=>issueRefund(order,receipt,10,[],{refundId}))),...[0,-1,0.5,NaN].map(amountCents=>refuses(()=>issueRefund(order,receipt,undefined,[],{refundId:'c',amountCents})))]);
run('history',()=>[refuses(()=>refundableBalance(receipt,[a(),a()])),refuses(()=>refundableBalance(receipt,[{...a(),orderId:'wrong'}])),refuses(()=>refundableBalance(receipt,[{...a(),currency:'USD'}])),refuses(()=>refundableBalance(receipt,[{amountCents:6000}])),refuses(()=>refundableBalance(receipt,[{...a(),remainingCents:1}])),refuses(()=>refundableBalance(receipt,[{...a(),status:'pending'}])),refundableBalance(receipt,[{amountCents:450}])]);
run('exhausted',()=>{const r=issueRefund(order,receipt,100,[],{refundId:'all'});return {refund:r,replay:issueRefund(order,receipt,100,[r],{refundId:'all'}),refused:refuses(()=>issueRefund(order,receipt,10,[r],{refundId:'other'}))};});
run('records',()=>{const value={...order,refunds:[a(),b()]};return {value,decoded:decodeOrder(encodeOrder(value)),empty:decodeOrder(encodeOrder({...order,refunds:[]}))};});
run('badRecords',()=>{const bad=[{...order,refunds:{}},{...order,refunds:[a(),a()]},{...order,refunds:[{...a(),refundId:''}]},{...order,refunds:[{...a(),currency:'USD'}]},{...order,refunds:[{...a(),amountCents:0}]},{...order,refunds:[{...a(),remainingCents:3}]},{...order,refunds:[{...a(),amountCents:6000,remainingCents:0}]},{...order,version:2,refunds:[]}];return bad.flatMap(v=>[refuses(()=>encodeOrder(v)),refuses(()=>decodeOrder(JSON.stringify(v)))]);});
run('integrated',()=>{const stock={book:3,mug:2},requests=[{refundId:'a',percent:50},{refundId:'b',amountCents:725},{refundId:'b',amountCents:725}],copy=structuredClone(requests);return {result:checkout('o',items,stock,{paymentKey:'pay-o',refundRequests:requests}),stock,requests,copy};});
run('empty',()=>checkout('o',items,{book:3,mug:2},{refundRequests:[]}));
run('format',()=>({report:report({...order,status:'fulfilled',refunds:[a(),b()]}),notice:notice({...receipt,refundedCents:3450})}));
run('identity',()=>['orderId','currency','amountCents','status'].map(key=>refuses(()=>issueRefund(order,{...receipt,[key]:key==='amountCents'?5451:'wrong'},50,[],{refundId:'c'}))));
`;
export function gradeLedger(files,destination,behavior){
 const {out,legacyValid,executionValid}=executeNative(files,destination,behavior,observe),checks=[];
 const value=name=>{if(!out[name]||out[name].error)throw Error('execution_failed');return out[name].value;};
 const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}};
 const expectedA={orderId:'o',amountCents:2725,currency:'CAD',status:'refunded',refundId:'a',remainingCents:2725,paymentKey:'pay-o'},expectedB={...expectedA,refundId:'b',amountCents:725,remainingCents:2000};
 check('payment-key',()=>{assert.equal(value('key').receipt.paymentKey,'pay-o');assert.equal(value('key').receipt.amountCents,5450);assert.deepEqual(value('key').bad,[true,true,true]);});
 check('percentage-ledger',()=>assert.deepEqual(value('first'),expectedA));check('amount-ledger',()=>assert.deepEqual(value('second'),expectedB));
 check('detached-idempotent-replay',()=>{const v=value('replay');assert.deepEqual(v.history,v.copy);assert.deepEqual(v.original,expectedB);assert.equal(v.balance,2000);});
 check('id-conflict-and-overdraw',()=>assert.deepEqual(value('conflicts'),Array(9).fill(true)));
 check('validated-history',()=>assert.deepEqual(value('history'),[true,true,true,true,true,true,5000]));
 check('exhausted-replay',()=>{const v=value('exhausted');assert.equal(v.refund.remainingCents,0);assert.deepEqual(v.replay,v.refund);assert.equal(v.refused,true);});
 check('ledger-persistence',()=>{const v=value('records');assert.deepEqual(v.decoded,v.value);assert.deepEqual(v.empty.refunds,[]);});
 check('malformed-ledger-refusal',()=>assert.deepEqual(value('badRecords'),Array(16).fill(true)));
 check('integrated-refund-checkout',()=>{const v=value('integrated'),r=v.result;assert.deepEqual(r.refunds,[expectedA,expectedB]);assert.deepEqual(r.order.refunds,r.refunds);assert.equal(r.receipt.amountCents,5450);assert.equal(r.receipt.paymentKey,'pay-o');assert.deepEqual(r.stock,{book:1,mug:1});assert.deepEqual(v.stock,{book:3,mug:2});assert.deepEqual(v.requests,v.copy);assert.equal(r.summary,'Order o: fulfilled, CAD 54.50; refunded CAD 34.50; balance CAD 20.00');assert.equal(r.notification.text,'Receipt o: CAD 54.50; refunded CAD 34.50');});
 check('empty-ledger-checkout',()=>{const v=value('empty');assert.deepEqual(v.refunds,[]);assert.equal(v.summary,'Order o: fulfilled, CAD 54.50; refunded CAD 0.00; balance CAD 54.50');});
 check('ledger-text',()=>assert.deepEqual(value('format'),{report:'Order o: fulfilled, CAD 54.50; refunded CAD 34.50; balance CAD 20.00',notice:'Receipt o: CAD 54.50; refunded CAD 34.50'}));
 check('payment-identity',()=>assert.deepEqual(value('identity'),[true,true,true,true]));
 return {correct:legacyValid&&checks.every(c=>c.passed),legacyValid,checks,executionValid};
}
