import { formatMoney } from './money.mjs';

export function format(receipt) {
  return `Receipt ${receipt.orderId}: ${formatMoney(receipt.amountCents, receipt.currency)}`;
}

export function notify(receipt) {
  return { channel: 'receipt', text: format(receipt) };
}
