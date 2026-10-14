import { assertCents } from './money.mjs';
import { discountSubtotal } from './pricing.mjs';

export function fixedDiscount(subtotalCents, amountCents) {
  assertCents(subtotalCents);
  assertCents(amountCents);
  return Math.max(0, subtotalCents - amountCents);
}

const policies = Object.freeze({ percent: discountSubtotal, fixed: fixedDiscount });

export function selectPromotion(name, subtotalCents, value) {
  if (!Object.hasOwn(policies, name)) throw new RangeError('unknown_promotion');
  return policies[name](subtotalCents, value);
}
