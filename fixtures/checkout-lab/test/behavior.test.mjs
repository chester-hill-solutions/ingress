import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCents, formatMoney } from '../src/money.mjs';
import { priceCart } from '../src/catalog.mjs';
import { discountSubtotal, shippingFee } from '../src/pricing.mjs';
import { createOrder, createPromotionalOrder } from '../src/orders.mjs';
import { encodeOrder, decodeOrder } from '../src/storage.mjs';
import { capturePayment, refundableBalance } from '../src/payments.mjs';
import { issueRefund } from '../src/refunds.mjs';
import { reserve } from '../src/inventory.mjs';
import { fulfillOrder } from '../src/fulfillment.mjs';
import { sendDefaultReceipt, sendCustomReceipt } from '../src/notifier.mjs';
import { format as reportFormat } from '../src/reports.mjs';
import { selectPromotion } from '../src/promotions.mjs';
import { checkout } from '../src/checkout.mjs';

const items = [{ sku: 'book', quantity: 2 }, { sku: 'mug', quantity: 1 }];
const stock = { book: 10, mug: 5 };

test('checkout lab: full persisted/payment/fulfillment workflow has an independently calculated total', () => {
  const result = checkout('o-1', items, stock);
  assert.equal(result.order.subtotalCents, 5500);
  assert.equal(result.order.discountedSubtotalCents, 4950);
  assert.equal(result.order.shippingCents, 500);
  assert.equal(result.order.totalPaidCents, 5450);
  assert.equal(result.receipt.amountCents, 5450);
  assert.equal(result.order.status, 'fulfilled');
  assert.deepEqual(result.stock, { book: 8, mug: 4 });
  assert.deepEqual(stock, { book: 10, mug: 5 });
  assert.equal(result.notification.text, 'Receipt o-1: CAD 54.50');
  assert.equal(result.summary, 'Order o-1: fulfilled, CAD 54.50');
});

test('checkout lab: cart totals include quantities and reject invalid or overflowing carts', () => {
  assert.deepEqual(priceCart(items), { subtotalCents: 5500, weightGrams: 1300 });
  for (const cart of [[], [{ sku: 'missing', quantity: 1 }], [{ sku: 'book', quantity: 0 }], [{ sku: 'book', quantity: 1.5 }], [{ sku: 'desk', quantity: Number.MAX_SAFE_INTEGER }]]) {
    assert.throws(() => priceCart(cart));
  }
});

test('checkout lab: cents remain integers and currency formatting is deterministic', () => {
  assert.equal(formatMoney(1), 'CAD 0.01');
  assert.equal(formatMoney(5450), 'CAD 54.50');
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertCents(value));
});

test('checkout lab: discount rounds once and handles both ends of its range', () => {
  assert.equal(discountSubtotal(101, 50), 51);
  assert.equal(discountSubtotal(1000, 0), 1000);
  assert.equal(discountSubtotal(1000, 100), 0);
  for (const percent of [-1, 101, NaN, Infinity]) assert.throws(() => discountSubtotal(1000, percent));
});

test('checkout lab: independent shipping function has a precisely tested boundary', () => {
  assert.equal(shippingFee(10_000), 500);
  assert.equal(shippingFee(10_001), 2000);
  assert.throws(() => shippingFee(-1));
  assert.throws(() => shippingFee(0.5));
});

test('checkout lab: heavy order uses the re-exported pricing functions', () => {
  assert.equal(createOrder('desk-1', [{ sku: 'desk', quantity: 1 }]).totalPaidCents, 38_000);
});

test('checkout lab: mutable caller inputs cannot alter an issued order', () => {
  const cart = structuredClone(items), order = createOrder('o-1', cart);
  cart[0].quantity = 99;
  assert.equal(order.items[0].quantity, 2);
  assert.throws(() => createOrder('', items));
});

test('checkout lab: computed promotion policies work for fixed and percentage discounts', () => {
  assert.equal(createPromotionalOrder('promo', items, 'fixed', 1000).totalPaidCents, 5000);
  assert.equal(createPromotionalOrder('promo', items, 'percent', 20).totalPaidCents, 4900);
  assert.equal(selectPromotion('fixed', 500, 1000), 0);
  assert.throws(() => selectPromotion('missing', 1000, 10));
});

test('checkout lab: stored order round-trip preserves the money contract', () => {
  const order = createOrder('o-1', items), decoded = decodeOrder(encodeOrder(order));
  assert.deepEqual(decoded, order);
  assert.notEqual(decoded, order);
  assert.throws(() => decodeOrder('{'));
  assert.throws(() => encodeOrder({ ...order, totalPaidCents: 54.5 }));
  assert.throws(() => decodeOrder(JSON.stringify({ ...order, version: 2 })));
});

test('checkout lab: captured receipt preserves exactly the stored amount', () => {
  const order = createOrder('o-1', items);
  assert.deepEqual(capturePayment(order), { orderId: 'o-1', amountCents: 5450, currency: 'CAD', status: 'captured' });
  assert.throws(() => capturePayment({ ...order, currency: 'USD' }));
});

test('checkout lab: refunds use the persisted amount, round, and cannot exceed the remaining payment', () => {
  const order = createOrder('o-1', items), receipt = capturePayment(order);
  const first = issueRefund(order, receipt, 50);
  assert.equal(first.amountCents, 2725);
  assert.equal(refundableBalance(receipt, [first]), 2725);
  assert.equal(issueRefund(order, receipt, 50, [first]).amountCents, 2725);
  assert.throws(() => issueRefund(order, receipt, 51, [first]));
  assert.throws(() => refundableBalance(receipt, [{ amountCents: 5451 }]));
  for (const percent of [0, -1, 101, NaN]) assert.throws(() => issueRefund(order, receipt, percent));
});

test('checkout lab: mismatched persisted order and receipt are rejected', () => {
  const order = createOrder('o-1', items), receipt = capturePayment(order);
  for (const changed of [{ ...receipt, orderId: 'other' }, { ...receipt, currency: 'USD' }, { ...receipt, amountCents: 5451 }]) {
    assert.throws(() => issueRefund(order, changed, 50));
    assert.throws(() => fulfillOrder(order, changed, stock));
  }
});

test('checkout lab: repeated SKU reservations are atomic and cannot overdraw stock', () => {
  const before = { book: 3 };
  assert.deepEqual(reserve(before, [{ sku: 'book', quantity: 1 }, { sku: 'book', quantity: 2 }]), { book: 0 });
  assert.throws(() => reserve(before, [{ sku: 'book', quantity: 2 }, { sku: 'book', quantity: 2 }]));
  assert.deepEqual(before, { book: 3 });
});

test('checkout lab: fulfillment needs a captured payment and leaves input records untouched', () => {
  const order = createOrder('o-1', items), receipt = capturePayment(order);
  assert.throws(() => fulfillOrder(order, { ...receipt, status: 'pending' }, stock));
  fulfillOrder(order, receipt, stock);
  assert.equal(order.status, 'priced');
});

test('checkout lab: callback parameter invokes the supplied function rather than the shadowed import', () => {
  const receipt = { orderId: 'o-1', amountCents: 5450, currency: 'CAD' };
  assert.equal(sendDefaultReceipt(receipt).text, 'Receipt o-1: CAD 54.50');
  assert.equal(sendCustomReceipt(receipt, value => `custom:${value.orderId}`), 'custom:o-1');
  assert.throws(() => sendCustomReceipt(receipt, null));
});

test('checkout lab: same-named format functions have different behavior', () => {
  assert.equal(reportFormat({ id: 'o-1', status: 'priced', totalPaidCents: 5450, currency: 'CAD' }), 'Order o-1: priced, CAD 54.50');
});
