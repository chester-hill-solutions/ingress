import { assertCents } from './money.mjs';
import { refundableBalance } from './payments.mjs';

export function issueRefund(order, receipt, percent, previousRefunds = []) {
  assertCents(order.totalPaidCents);
  if (order.id !== receipt.orderId || order.currency !== receipt.currency
    || order.totalPaidCents !== receipt.amountCents) throw new RangeError('payment_contract_mismatch');
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new RangeError('invalid_refund_percent');
  const amountCents = Math.round(order.totalPaidCents * percent / 100);
  if (amountCents > refundableBalance(receipt, previousRefunds)) throw new RangeError('refund_exceeds_balance');
  return { orderId: order.id, amountCents, currency: order.currency, status: 'refunded' };
}
