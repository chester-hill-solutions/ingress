import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFixture, verifyFixture, producerTask, consumerTask } from './money.mjs';

test('seed has declared contract and goals, independent checks are absent from workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'money-fixture-'));
  try {
    const fixture = await seedFixture(root);
    assert.equal(fixture.producerTask, producerTask);
    assert.equal(fixture.consumerTask, consumerTask);
    assert.match(await readFile(join(root, 'producer.mjs'), 'utf8'), /priceUnit = 'dollars'/);
    assert.equal((await verifyFixture(root)).correct, false);
    assert.deepEqual(fixture.dependencies, [{ producerPath: 'producer.mjs', consumerPath: 'consumer.mjs' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('independent verifier detects migrated producer with stale dollar consumer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'money-fixture-'));
  try {
    await seedFixture(root);
    await writeFile(join(root, 'producer.mjs'), `export const priceUnit='cents'; export function priceOrders(orders) { return orders.map(o=>({unitPrice:Math.round(o.unitPriceDollars*100),quantity:o.quantity,sku:o.sku})); }`);
    await writeFile(join(root, 'consumer.mjs'), `import {priceOrders} from './producer.mjs'; export function summarizeOrders(orders) { const rows=priceOrders(orders); return {orderCount:rows.length,unitCount:rows.reduce((n,o)=>n+o.quantity,0),totalDollars:rows.reduce((n,o)=>n+o.quantity*o.unitPrice,0)}; } export function invoiceLines(){return [];} export function formatInvoice(){return '';}`);
    const stale = await verifyFixture(root);
    assert.equal(stale.correct, false);
    assert.equal(stale.checks.find(check => check.name === 'producer_contract').passed, true);
    assert.equal(stale.checks.find(check => check.name === 'consumer_case_0').passed, false);
    await writeFile(join(root, 'consumer.mjs'), `import {priceOrders,priceUnit} from './producer.mjs'; export function summarizeOrders(orders) { const rows=priceOrders(orders); const factor=priceUnit==='cents'?1:100; const cents=rows.reduce((n,o)=>n+o.quantity*Math.round(o.unitPrice*factor),0); return {orderCount:rows.length,unitCount:rows.reduce((n,o)=>n+o.quantity,0),totalDollars:cents/100}; } export function invoiceLines(orders){return priceOrders(orders).map(row=>({sku:row.sku,quantity:row.quantity,lineTotalDollars:Math.round(row.unitPrice*(priceUnit==='cents'?1:100))*row.quantity/100}));} export function formatInvoice(orders){const s=summarizeOrders(orders);return '$'+s.totalDollars.toFixed(2)+' for '+s.unitCount+' units across '+s.orderCount+' lines';}`);
    const correct = await verifyFixture(root);
    assert.equal(correct.correct, true);
    assert.equal(correct.checks.length, 26);
  } finally { await rm(root, { recursive: true, force: true }); }
});
