import { reserve } from './inventory.mjs';

export function fulfillOrder(order, receipt, stock) {
  if (receipt.orderId !== order.id || receipt.amountCents !== order.totalPaidCents
    || receipt.currency !== order.currency || receipt.status !== 'captured') throw new RangeError('payment_required');
  return { order: { ...order, status: 'fulfilled' }, stock: reserve(stock, order.items) };
}
