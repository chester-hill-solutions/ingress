// Held native pilot specification and independent execution oracle.
export const mission = `Upgrade the order workflow while preserving every legacy behavior.
Implement these four connected capabilities across the existing modules:
1. Mixed tax: createOrder options.taxBasisPoints is an integer 0..10000 (default 0).
priceCart(items, {includeTaxable:true}) returns taxableSubtotalCents in addition to the
existing fields, excluding lines with taxExempt:true. Its ordinary call keeps the original
return shape. Apply the discount to taxable subtotal, round once to cents, then compute
Math.round(discountedTaxableCents * taxBasisPoints / 10000). Tax is on goods only.
When taxBasisPoints is nonzero, createOrder returns version 2 with taxBasisPoints,
taxableSubtotalCents and taxCents; totalPaidCents includes discounted goods, shipping and
tax. Default orders remain version 1. capturePayment copies taxCents only for v2 orders.
2. Partial stock: reserve(stock,items,{allowPartial:true}) aggregates repeated SKUs and
returns {stock,reservedItems,backorders}; both item arrays contain {sku,quantity}, omit
zero quantities, preserve first-SKU order and use the available stock. No input mutates.
Missing stock is zero; negative/fractional queried stock or invalid quantities refuse.
Without allowPartial retain the original stock-object return and all-or-nothing refusal.
fulfillOrder(order,receipt,stock,{allowPartial:true}) still verifies the full captured
payment and returns partial reservation fields; its order has unfulfilledItems and
status 'partially-fulfilled' when any are unfulfilled, else 'fulfilled'. No automatic
refund or reduction of captured payment occurs for backorders. Legacy strict fulfillment
retains its original result shape. Existing refunds continue against captured totals.
3. Persistence: encodeOrder/decodeOrder preserve v1 and v2 records. Reject unsupported
versions, wrong currency/ID, invalid cents, missing v2 fields and taxBasisPoints outside
0..10000. V2 taxCents and taxableSubtotalCents are non-negative integer cents; v1 records
remain compatible. Do not introduce another public API or change existing signatures
in incompatible ways. Optional arguments may be added as specified.
4. End-to-end: checkout passes tax options through pricing and allowPartial through
fulfillment, using the persisted order. Receipt format for receipts with taxCents is
'Receipt ID: CAD TOTAL (tax CAD TAX)' using existing money formatting. Legacy receipts
keep their text. Order report text for any order having an unfulfilledItems array appends
'; backorders N' where N sums unfulfilled quantities; legacy reports keep their text.

All four capabilities must work together, with precise integer cents, payment identity
checks, repeated-SKU handling and unchanged caller inputs. Use existing exported functions
and modules. Keep changes focused on your listed modification scopes. The runner can
request candidate-bound expansion for introduced helpers/imports and their dependencies;
existing unrelated edits remain a refusal unless explicitly granted. Expansion may
conflict or require a fresh base and another edit turn. No shell,
packages, subagents or external calls. Native file tools are available. Tests in test/
are public legacy checks; independent acceptance checks are held outside your copy.
Your directory is a private working copy. Only the runner can publish its bytes.
`;
export const roles = [
  { id: 'pricing', focus: 'Implement mixed taxable/exempt pricing and tax receipt fields. Coordinate the documented v2 contract through source, preserving default v1 behavior.', writes: [
    ['src/catalog.mjs','priceCart'], ['src/orders.mjs','createOrder'], ['src/payments.mjs','capturePayment'] ] },
  { id: 'inventory', focus: 'Implement partial reservations, repeated SKU aggregation, stock validation and fulfillment/backorder fields while preserving strict behavior.', writes: [
    ['src/inventory.mjs','available'], ['src/inventory.mjs','reserve'], ['src/fulfillment.mjs','fulfillOrder'] ] },
  { id: 'records', focus: 'Implement compatible persisted v1/v2 validation and round-trip preservation, including the documented v2 tax fields.', writes: [
    ['src/storage.mjs','encodeOrder'], ['src/storage.mjs','decodeOrder'] ] },
  { id: 'integration', focus: 'Wire tax/partial options through checkout and implement tax receipt/backorder report formatting. Preserve the full goal while implementing your scopes.', writes: [
    ['src/checkout.mjs','checkout'], ['src/notifications.mjs','format'], ['src/reports.mjs','format'] ] },
];
export const acceptance = `import assert from 'node:assert/strict';
import {priceCart} from '../src/catalog.mjs';
import {createOrder} from '../src/orders.mjs';
import {reserve,available} from '../src/inventory.mjs';
import {fulfillOrder} from '../src/fulfillment.mjs';
import {encodeOrder,decodeOrder} from '../src/storage.mjs';
import {capturePayment} from '../src/payments.mjs';
import {issueRefund} from '../src/refunds.mjs';
import {checkout} from '../src/checkout.mjs';
import {format as receiptFormat} from '../src/notifications.mjs';
import {format as reportFormat} from '../src/reports.mjs';
const checks=[]; const check=(name,run)=>{try{run();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}};
const items=[{sku:'book',quantity:2},{sku:'mug',quantity:1,taxExempt:true}], original=structuredClone(items);
const taxed=()=>createOrder('o',items,{taxBasisPoints:1000});
check('mixed taxable subtotal and legacy return shape',()=>{assert.deepEqual(priceCart(items,{includeTaxable:true}),{subtotalCents:5500,weightGrams:1300,taxableSubtotalCents:4000});assert.deepEqual(priceCart(items),{subtotalCents:5500,weightGrams:1300});});
check('discount before tax with independently calculated total',()=>{const o=taxed();assert.equal(o.version,2);assert.equal(o.taxCents,360);assert.equal(o.taxableSubtotalCents,4000);assert.equal(o.taxBasisPoints,1000);assert.equal(o.totalPaidCents,5810);assert.deepEqual(items,original);});
check('discount/tax rounding and exempt goods',()=>{const o=createOrder('r',[{sku:'mug',quantity:1}],{discountPercent:33,taxBasisPoints:875});assert.equal(o.discountedSubtotalCents,1005);assert.equal(o.taxCents,88);assert.equal(o.totalPaidCents,1593);const x=createOrder('e',[{sku:'book',quantity:1,taxExempt:true}],{taxBasisPoints:1000});assert.equal(x.taxCents,0);assert.equal(x.totalPaidCents,2300);});
check('invalid tax rates refuse',()=>{for(const rate of [-1,10001,0.5,NaN,Infinity,'1000'])assert.throws(()=>createOrder('x',items,{taxBasisPoints:rate}));});
check('legacy order remains v1 with no tax receipt field',()=>{const o=createOrder('l',items);assert.equal(o.version,1);assert.equal(o.totalPaidCents,5450);assert.equal(Object.hasOwn(capturePayment(o),'taxCents'),false);});
check('tax receipt carries exact cents',()=>{const r=capturePayment(taxed());assert.equal(r.amountCents,5810);assert.equal(r.taxCents,360);assert.equal(receiptFormat(r),'Receipt o: CAD 58.10 (tax CAD 3.60)');});
check('v2 round trip and malformed versions/fields',()=>{const o=taxed();assert.deepEqual(decodeOrder(encodeOrder(o)),o);for(const change of [{version:3},{currency:'USD'},{taxCents:-1},{taxCents:0.5},{taxBasisPoints:10001},{taxableSubtotalCents:-1}]){const bad={...o,...change};assert.throws(()=>encodeOrder(bad));assert.throws(()=>decodeOrder(JSON.stringify(bad)));}const missing={...o};delete missing.taxCents;assert.throws(()=>decodeOrder(JSON.stringify(missing)));});
check('legacy persisted order still round-trips',()=>{const o=createOrder('l',items);assert.deepEqual(decodeOrder(encodeOrder(o)),o);assert.throws(()=>decodeOrder(JSON.stringify({...o,version:2})));});
check('partial stock aggregates duplicate SKUs without mutation',()=>{const stock={book:2,mug:1},copy={...stock};const r=reserve(stock,[{sku:'book',quantity:1},{sku:'book',quantity:2},{sku:'mug',quantity:1}],{allowPartial:true});assert.deepEqual(r,{stock:{book:0,mug:0},reservedItems:[{sku:'book',quantity:2},{sku:'mug',quantity:1}],backorders:[{sku:'book',quantity:1}]});assert.deepEqual(stock,copy);});
check('partial all missing stock and strict atomic refusal',()=>{assert.deepEqual(reserve({},[{sku:'book',quantity:2}],{allowPartial:true}),{stock:{},reservedItems:[],backorders:[{sku:'book',quantity:2}]});const stock={book:1};assert.throws(()=>reserve(stock,[{sku:'book',quantity:2}]));assert.deepEqual(stock,{book:1});assert.equal(available({},'book'),0);});
check('partial invalid stock/quantity refuses',()=>{for(const n of [-1,0.5,NaN])assert.throws(()=>reserve({book:n},[{sku:'book',quantity:1}],{allowPartial:true}));for(const n of [0,-1,0.5])assert.throws(()=>reserve({book:1},[{sku:'book',quantity:n}],{allowPartial:true}));});
check('partial fulfillment retains captured full amount and status',()=>{const o=taxed(),r=capturePayment(o);const f=fulfillOrder(o,r,{book:1,mug:1},{allowPartial:true});assert.equal(f.order.status,'partially-fulfilled');assert.deepEqual(f.order.unfulfilledItems,[{sku:'book',quantity:1}]);assert.deepEqual(f.stock,{book:0,mug:0});assert.equal(r.amountCents,5810);assert.equal(o.status,'priced');assert.throws(()=>fulfillOrder(o,{...r,amountCents:5809},{book:1,mug:1},{allowPartial:true}));});
check('checkout integrates tax, persistence, partial fulfillment and text',()=>{const stock={book:1,mug:1},copy={...stock};const c=checkout('o',items,stock,{taxBasisPoints:1000,allowPartial:true});assert.equal(c.order.totalPaidCents,5810);assert.equal(c.order.status,'partially-fulfilled');assert.equal(c.notification.text,'Receipt o: CAD 58.10 (tax CAD 3.60)');assert.equal(c.summary,'Order o: partially-fulfilled, CAD 58.10; backorders 1');assert.deepEqual(c.stock,{book:0,mug:0});assert.deepEqual(stock,copy);assert.equal(issueRefund(c.order,c.receipt,50).amountCents,2905);});
check('partial complete inventory has empty backlog and sums report quantities',()=>{const c=checkout('o',items,{book:3,mug:2},{taxBasisPoints:1000,allowPartial:true});assert.equal(c.order.status,'fulfilled');assert.deepEqual(c.order.unfulfilledItems,[]);assert.equal(c.summary,'Order o: fulfilled, CAD 58.10; backorders 0');assert.equal(reportFormat({id:'z',status:'partially-fulfilled',totalPaidCents:100,unfulfilledItems:[{sku:'book',quantity:2},{sku:'mug',quantity:3}]}),'Order z: partially-fulfilled, CAD 1.00; backorders 5');});
console.log(JSON.stringify({passed:checks.every(c=>c.passed),checks})); if(checks.some(c=>!c.passed))process.exitCode=1;
`;
export function referenceFiles(seed) {
  const files = structuredClone(seed);
  files['src/catalog.mjs']=files['src/catalog.mjs'].replace('export function priceCart(items)', 'export function priceCart(items, { includeTaxable = false } = {})').replace('let subtotalCents = 0, weightGrams = 0;', 'let subtotalCents = 0, weightGrams = 0, taxableSubtotalCents = 0;').replace('    subtotalCents += product.priceCents * item.quantity;', '    subtotalCents += product.priceCents * item.quantity;\n    if (item.taxExempt !== true) taxableSubtotalCents += product.priceCents * item.quantity;').replace('  return { subtotalCents, weightGrams };','  return includeTaxable ? { subtotalCents, weightGrams, taxableSubtotalCents } : { subtotalCents, weightGrams };');
  files['src/orders.mjs']=files['src/orders.mjs'].replace('discountPercent = orderPolicy.defaultDiscountPercent }', 'discountPercent = orderPolicy.defaultDiscountPercent, taxBasisPoints = 0 }').replace('  const { subtotalCents, weightGrams } = priceCart(items);', "  if (!Number.isSafeInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 10000) throw new RangeError('invalid_tax_rate');\n  const { subtotalCents, weightGrams, taxableSubtotalCents } = priceCart(items, {includeTaxable:true});").replace('  const totalPaidCents = discountedSubtotalCents + shippingCents;', '  const taxCents = Math.round(Math.round(taxableSubtotalCents * (100 - discountPercent) / 100) * taxBasisPoints / 10000);\n  const totalPaidCents = discountedSubtotalCents + shippingCents + taxCents;').replace('  return { version: 1, id,', '  return { ...(taxBasisPoints ? { taxBasisPoints, taxableSubtotalCents, taxCents } : {}), version: taxBasisPoints ? 2 : 1, id,');
  files['src/payments.mjs']=files['src/payments.mjs'].replace("return { orderId: order.id,", "return { ...(order.version === 2 ? {taxCents:order.taxCents} : {}), orderId: order.id,");
  files['src/inventory.mjs']=`export function available(stock, sku) {\n  const value=stock[sku] ?? 0;\n  if(!Number.isSafeInteger(value)||value<0)throw new RangeError('invalid_stock');\n  return value;\n}\n\nexport function reserve(stock,items,{allowPartial=false}={}) {\n  const requested=new Map();\n  for(const item of items){if(!Number.isSafeInteger(item.quantity)||item.quantity<1)throw new RangeError('invalid_quantity');requested.set(item.sku,(requested.get(item.sku)??0)+item.quantity);}\n  const result={...stock},reservedItems=[],backorders=[];\n  for(const [sku,quantity]of requested){const count=available(stock,sku);if(!allowPartial&&quantity>count)throw new RangeError('out_of_stock');const take=Math.min(count,quantity);if(take){result[sku]=count-take;reservedItems.push({sku,quantity:take});}if(quantity>take)backorders.push({sku,quantity:quantity-take});}\n  return allowPartial?{stock:result,reservedItems,backorders}:result;\n}\n`;
  files['src/fulfillment.mjs']=files['src/fulfillment.mjs'].replace('stock) {', 'stock, {allowPartial=false}={}) {').replace("  return { order: { ...order, status: 'fulfilled' }, stock: reserve(stock, order.items) };", "  const reservation=reserve(stock,order.items,{allowPartial});\n  if(allowPartial)return {...reservation,order:{...order,status:reservation.backorders.length?'partially-fulfilled':'fulfilled',unfulfilledItems:reservation.backorders}};\n  return {order:{...order,status:'fulfilled'},stock:reservation};");
  const validate=`  assertCents(order.totalPaidCents);\n  if((order.version!==1&&order.version!==2)||typeof order.id!=='string'||order.currency!=='CAD')throw new TypeError('invalid_order_record');\n  if(order.version===2){assertCents(order.taxCents);assertCents(order.taxableSubtotalCents);if(!Number.isSafeInteger(order.taxBasisPoints)||order.taxBasisPoints<0||order.taxBasisPoints>10000)throw new RangeError('invalid_tax_rate');}\n`;
  files['src/storage.mjs']=`import {assertCents} from './money.mjs';\nexport function encodeOrder(order){\n${validate}  return JSON.stringify(order);\n}\nexport function decodeOrder(bytes){\n  const order=JSON.parse(bytes);\n${validate}  return order;\n}\n`;
  files['src/checkout.mjs']=files['src/checkout.mjs'].replace('fulfillOrder(order, receipt, stock)', 'fulfillOrder(order, receipt, stock, {allowPartial:options?.allowPartial??false})');
  files['src/notifications.mjs']=files['src/notifications.mjs'].replace('  return `Receipt', "  if(receipt.taxCents!==undefined)return `Receipt ${receipt.orderId}: ${formatMoney(receipt.amountCents,receipt.currency)} (tax ${formatMoney(receipt.taxCents,receipt.currency)})`;\n  return `Receipt");
  files['src/reports.mjs']=files['src/reports.mjs'].replace('  return `Order', "  if(Array.isArray(order.unfulfilledItems)){let count=0;for(const item of order.unfulfilledItems)count+=item.quantity;return `Order ${order.id}: ${order.status}, ${formatMoney(order.totalPaidCents,order.currency)}; backorders ${count}`;}\n  return `Order");
  return files;
}
