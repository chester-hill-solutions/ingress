import { checkout } from '../src/checkout.mjs';
import { issueRefund } from '../src/refunds.mjs';

const result = checkout('demo-1', [{ sku: 'book', quantity: 2 }, { sku: 'mug', quantity: 1 }], { book: 10, mug: 5 });
const refund = issueRefund(result.order, result.receipt, 50);
console.log(JSON.stringify({ ...result, refund }, null, 2));
