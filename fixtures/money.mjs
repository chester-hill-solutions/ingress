import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ORDERS = [
  { sku: 'tea', quantity: 3, unitPriceDollars: 12.5 },
  { sku: 'coffee', quantity: 2, unitPriceDollars: 18.75 },
  { sku: 'mug', quantity: 1, unitPriceDollars: 9.99 },
];

export const producerTask = 'Change producer.mjs so priceUnit is cents and priceOrders(orders) emits integer unitPrice cents. Preserve sku and quantity, input orders still have unitPriceDollars, and preserve monetary value using rounding to the nearest cent. Keep exported names stable. Do not edit consumer.mjs. Work directly in this shared workspace.';
export const consumerTask = 'Implement three exported invoice helpers in consumer.mjs using priceOrders and its exported priceUnit from producer.mjs. summarizeOrders(orders) returns {orderCount, unitCount, totalDollars}, counting input rows as orderCount and quantity as unitCount. invoiceLines(orders) returns [{sku, quantity, lineTotalDollars}] in input order. formatInvoice(orders) returns exactly "$84.99 for 6 units across 3 lines" for that summary, with a two-decimal total and the same template for any counts. All monetary results preserve domain value rounded to cents per unit before multiplying quantities; totals equal the sum of invoice lines. Handle empty orders, fractional prices, repeated SKUs, and quantities above one without mutating input. Keep summarizeOrders totalDollars and lineTotalDollars numeric. Do not edit producer.mjs. Work directly in this shared workspace; inspect the actual current producer contract as needed.';

export async function seedFixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
  await writeFile(join(root, 'orders.json'), JSON.stringify(ORDERS, null, 2) + '\n');
  await writeFile(join(root, 'producer.mjs'), `export const priceUnit = 'dollars';\nexport function priceOrders(orders) {\n  return orders.map(({ sku, quantity, unitPriceDollars }) => ({ sku, quantity, unitPrice: unitPriceDollars }));\n}\n`);
  await writeFile(join(root, 'consumer.mjs'), `import { priceOrders, priceUnit } from './producer.mjs';\n\nexport function summarizeOrders(orders) {\n  throw new Error('Implement the order summary');\n}\nexport function invoiceLines(orders) {\n  throw new Error('Implement invoice lines');\n}\nexport function formatInvoice(orders) {\n  throw new Error('Implement invoice formatting');\n}\n`);
  return {
    paths: ['producer.mjs', 'consumer.mjs', 'orders.json'],
    dependencies: [{ producerPath: 'producer.mjs', consumerPath: 'consumer.mjs' }],
    producerTask,
    consumerTask,
  };
}

// Cases and expected outcomes stay in this package, outside the agent workspace.
const CASES = [
  { orders: ORDERS, expected: { orderCount: 3, unitCount: 6, totalDollars: 84.99 } },
  { orders: [], expected: { orderCount: 0, unitCount: 0, totalDollars: 0 } },
  { orders: [{ sku: 'small', quantity: 7, unitPriceDollars: 0.1 }, { sku: 'large', quantity: 2, unitPriceDollars: 123.45 }], expected: { orderCount: 2, unitCount: 9, totalDollars: 247.6 } },
  { orders: [{ sku: 'round', quantity: 3, unitPriceDollars: 1.234 }], expected: { orderCount: 1, unitCount: 3, totalDollars: 3.69 } },
  { orders: [{ sku: 'repeated', quantity: 2, unitPriceDollars: 2.1 }, { sku: 'repeated', quantity: 4, unitPriceDollars: 2.1 }], expected: { orderCount: 2, unitCount: 6, totalDollars: 12.6 } },
];

export async function verifyFixture(root) {
  const script = `import { pathToFileURL } from 'node:url';
const root = process.argv[1];
let input = ''; for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input);
const producer = await import(pathToFileURL(root + '/producer.mjs'));
const consumer = await import(pathToFileURL(root + '/consumer.mjs'));
const checks = [{name:'producer_contract', passed:producer.priceUnit === 'cents'}];
for (let index=0; index<cases.length; index++) {
 const {orders,expected} = cases[index];
 const lines = await producer.priceOrders(structuredClone(orders));
 const expectedLines = orders.map(order=>({sku:order.sku,quantity:order.quantity,unitPrice:Math.round(order.unitPriceDollars*100)}));
 checks.push({name:'producer_case_'+index,passed:Array.isArray(lines) && lines.length===expectedLines.length && lines.every((line,i)=>line.sku===expectedLines[i].sku && line.quantity===expectedLines[i].quantity && line.unitPrice===expectedLines[i].unitPrice)});
 const input = structuredClone(orders);
 const actual = await consumer.summarizeOrders(input);
 checks.push({name:'consumer_case_'+index,passed:actual?.orderCount===expected.orderCount && actual?.unitCount===expected.unitCount && actual?.totalDollars===expected.totalDollars});
 const invoice = await consumer.invoiceLines(input);
 checks.push({name:'invoice_case_'+index,passed:Array.isArray(invoice) && invoice.length===orders.length && invoice.every((line,i)=>line.sku===orders[i].sku && line.quantity===orders[i].quantity && line.lineTotalDollars===Math.round(orders[i].unitPriceDollars*100)*orders[i].quantity/100)});
 const formatted = await consumer.formatInvoice(input);
 checks.push({name:'format_case_'+index,passed:formatted==='$'+expected.totalDollars.toFixed(2)+' for '+expected.unitCount+' units across '+expected.orderCount+' lines'});
 checks.push({name:'input_unchanged_'+index,passed:JSON.stringify(input)===JSON.stringify(orders)});
}
console.log(JSON.stringify({correct:checks.every(check=>check.passed),checks}));`;
  return await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let output = '';
    let excess = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 64 * 1024) { excess = true; child.kill('SIGKILL'); }
      else output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve({ correct: false, checks: [{ name: 'fixture_execution', passed: false }] }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || excess) return resolve({ correct: false, checks: [{ name: 'fixture_execution', passed: false }] });
      try { resolve(JSON.parse(output.trim())); }
      catch { resolve({ correct: false, checks: [{ name: 'fixture_execution', passed: false }] }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(CASES));
  });
}
