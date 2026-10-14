import { assertCents } from './money.mjs';

export function capturePayment(order) {
  assertCents(order.totalPaidCents);
  if (order.currency !== 'CAD') throw new RangeError('unsupported_currency');
  return { orderId: order.id, amountCents: order.totalPaidCents, currency: order.currency, status: 'captured' };
}

export function refundableBalance(receipt, refunds = []) {
  assertCents(receipt.amountCents);
  const used = refunds.reduce((sum, refund) => sum + assertCents(refund.amountCents), 0);
  if (used > receipt.amountCents) throw new RangeError('refunds_exceed_payment');
  return receipt.amountCents - used;
}
