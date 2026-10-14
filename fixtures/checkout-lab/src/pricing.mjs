import { assertCents } from './money.mjs';
import { orderPolicy } from './config.mjs';

export function discountSubtotal(subtotalCents, percent = orderPolicy.defaultDiscountPercent) {
  assertCents(subtotalCents);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('invalid_percent');
  return Math.round(subtotalCents * (100 - percent) / 100);
}

export function shippingFee(weightGrams) {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) throw new RangeError('invalid_weight');
  return weightGrams > orderPolicy.heavyParcelGrams
    ? orderPolicy.heavyShippingCents
    : orderPolicy.standardShippingCents;
}
