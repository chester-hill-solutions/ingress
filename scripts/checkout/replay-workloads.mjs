// Frozen edits and independently specified acceptance behavior. The extractor sees
// source only, never these labels or expected outcomes. No generated agent patches.
const task = (id, path, symbol, search, replace, extra = {}) => ({ id, path, symbol, search, replace, workTicks: 10, ...extra });
export const workloads = [
  { id: 'independent-same-file', relationship: 'independent', tasks: [
    task('percent-text', 'src/pricing.mjs', 'discountSubtotal', '  assertCents(subtotalCents);', "  if (typeof percent === 'string') percent = +percent;\n  assertCents(subtotalCents);"),
    task('weight-text', 'src/pricing.mjs', 'shippingFee', '  if (!Number.isSafeInteger(weightGrams)', "  if (typeof weightGrams === 'string') weightGrams = +weightGrams;\n  if (!Number.isSafeInteger(weightGrams)"),
  ], assertions: "assert.equal(discountSubtotal(1000, '10'), 900); assert.equal(shippingFee('300'), 500);" },
  { id: 'shared-utility-readers', relationship: 'independent', tasks: [
    task('refund-label', 'src/notifications.mjs', 'format', '  return `Receipt', "  if (receipt.channel === 'refund') return `Refund ${receipt.orderId}: ${formatMoney(receipt.amountCents, receipt.currency)}`;\n  return `Receipt"),
    task('missing-status', 'src/reports.mjs', 'format', '${order.status}', "${order.status ?? 'priced'}"),
  ], assertions: "assert.equal(receiptFormat({orderId:'o',amountCents:100,channel:'refund'}), 'Refund o: CAD 1.00'); assert.equal(reportFormat({id:'o',totalPaidCents:100}), 'Order o: priced, CAD 1.00');" },
  { id: 'overlap-same-function', relationship: 'overlap', tasks: [
    task('percent-text', 'src/pricing.mjs', 'discountSubtotal', '  assertCents(subtotalCents);', "  if (typeof percent === 'string') percent = +percent;\n  assertCents(subtotalCents);"),
    task('null-percent', 'src/pricing.mjs', 'discountSubtotal', '  assertCents(subtotalCents);', '  if (percent === null) percent = 0;\n  assertCents(subtotalCents);'),
  ], assertions: "assert.equal(discountSubtotal(1000, '10'), 900); assert.equal(discountSubtotal(1000, null), 1000);" },
  { id: 'contract-sensitive-read', relationship: 'behavioral-dependency', tasks: [
    task('offer-policy', 'src/config.mjs', 'orderPolicy', "  currency: 'CAD',", "  currency: 'CAD',\n  promotionPercent: 20,"),
    task('offer-report', 'src/reports.mjs', 'format', '  return `Order', null, { adaptive: 'read-promotion-percent' }),
  ], assertions: "assert.equal(reportFormat({id:'o',status:'offer',totalPaidCents:100}), 'Order o: offer 20%, CAD 1.00');" },
  { id: 'new-dependency', relationship: 'new-dependency', tasks: [
    task('receipt-preview', 'src/notifier.mjs', 'sendDefaultReceipt', '  return notify(receipt);', "  return { ...notify(receipt), preview: formatOrder({ id: receipt.orderId, status: 'captured', totalPaidCents: receipt.amountCents, currency: receipt.currency }) };", { prepend: "import { format as formatOrder } from './reports.mjs';\n", scopedAnchor: true, parameters: 'receipt' }),
    task('missing-status', 'src/reports.mjs', 'format', '${order.status}', "${order.status ?? 'priced'}"),
  ], assertions: "assert.equal(sendDefaultReceipt({orderId:'o',amountCents:100,currency:'CAD'}).preview, 'Order o: captured, CAD 1.00'); assert.equal(reportFormat({id:'o',totalPaidCents:100}), 'Order o: priced, CAD 1.00');" },
  { id: 'unknown-callback', relationship: 'independent-with-unknown', tasks: [
    task('receipt-priority', 'src/notifier.mjs', 'sendCustomReceipt', '  return notify(receipt);', "  if (receipt.priority === undefined) return notify(receipt);\n  return { ...notify(receipt), priority: receipt.priority };", { scopedAnchor: true }),
    task('weight-text', 'src/pricing.mjs', 'shippingFee', '  if (!Number.isSafeInteger(weightGrams)', "  if (typeof weightGrams === 'string') weightGrams = +weightGrams;\n  if (!Number.isSafeInteger(weightGrams)"),
  ], assertions: "assert.equal(sendCustomReceipt({priority:'high'}, () => ({channel:'custom'})).priority, 'high'); assert.equal(shippingFee('300'), 500);" },
];
export const acceptanceSource = workload => `import assert from 'node:assert/strict';
import {discountSubtotal,shippingFee} from '../src/pricing.mjs';
import {format as receiptFormat} from '../src/notifications.mjs';
import {format as reportFormat} from '../src/reports.mjs';
import {sendDefaultReceipt,sendCustomReceipt} from '../src/notifier.mjs';
${workload.assertions}\n`;
export function patchTask(task, base) {
  let text = base[task.path], search = task.search, replacement = task.replace;
  if (task.adaptive === 'read-promotion-percent') {
    const value = /promotionPercent:\s*(\d+)/.exec(base['src/config.mjs'])?.[1] ?? '10';
    replacement = `  if (order.status === 'offer') return \`Order \${order.id}: offer ${value}%, \${formatMoney(order.totalPaidCents, order.currency)}\`;\n  return \`Order`;
  }
  if (task.scopedAnchor) {
    search = `export function ${task.symbol}(${task.parameters ?? 'receipt, notify'}) {\n${task.search}`;
    replacement = `export function ${task.symbol}(${task.parameters ?? 'receipt, notify'}) {\n${replacement}`;
  }
  if (text.split(search).length !== 2) throw new Error('patch_anchor_ambiguous_or_missing');
  return { [task.path]: (task.prepend ?? '') + text.replace(search, replacement) };
}
