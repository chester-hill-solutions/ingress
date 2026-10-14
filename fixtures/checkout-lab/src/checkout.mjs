import { createOrder } from './orders.mjs';
import { encodeOrder, decodeOrder } from './storage.mjs';
import { capturePayment } from './payments.mjs';
import { fulfillOrder } from './fulfillment.mjs';
import { sendDefaultReceipt } from './notifier.mjs';
import { format as renderOrder } from './reports.mjs';

export function checkout(id, items, stock, options) {
  const saved = encodeOrder(createOrder(id, items, options));
  const order = decodeOrder(saved);
  const receipt = capturePayment(order);
  const fulfilled = fulfillOrder(order, receipt, stock);
  return { ...fulfilled, receipt, notification: sendDefaultReceipt(receipt), summary: renderOrder(fulfilled.order) };
}
