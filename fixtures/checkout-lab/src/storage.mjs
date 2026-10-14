import { assertCents } from './money.mjs';

export function encodeOrder(order) {
  assertCents(order.totalPaidCents);
  if (order.version !== 1 || typeof order.id !== 'string' || order.currency !== 'CAD') throw new TypeError('invalid_order_record');
  return JSON.stringify(order);
}

export function decodeOrder(bytes) {
  const order = JSON.parse(bytes);
  assertCents(order.totalPaidCents);
  if (order.version !== 1 || typeof order.id !== 'string' || order.currency !== 'CAD') throw new TypeError('invalid_order_record');
  return order;
}
