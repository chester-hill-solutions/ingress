import { notify } from './notifications.mjs';

export function sendDefaultReceipt(receipt) {
  return notify(receipt);
}

export function sendCustomReceipt(receipt, notify) {
  return notify(receipt);
}
