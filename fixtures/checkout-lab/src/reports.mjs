import { formatMoney } from './money.mjs';

export function format(order) {
  return `Order ${order.id}: ${order.status}, ${formatMoney(order.totalPaidCents, order.currency)}`;
}
