import { priceCart } from './catalog.mjs';
import { discountedTotal as netSubtotal, shippingFee } from './pricing-index.mjs';
import { selectPromotion } from './promotions.mjs';
import { orderPolicy } from './config.mjs';

export function createOrder(id, items, { discountPercent = orderPolicy.defaultDiscountPercent } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('invalid_order_id');
  const { subtotalCents, weightGrams } = priceCart(items);
  const discountedSubtotalCents = netSubtotal(subtotalCents, discountPercent);
  const shippingCents = shippingFee(weightGrams);
  const totalPaidCents = discountedSubtotalCents + shippingCents;
  if (!Number.isSafeInteger(totalPaidCents)) throw new RangeError('order_overflow');
  return { version: 1, id, currency: orderPolicy.currency, items: structuredClone(items),
    subtotalCents, discountedSubtotalCents, shippingCents, totalPaidCents, status: 'priced' };
}

export function createPromotionalOrder(id, items, promotion, value) {
  const order = createOrder(id, items, { discountPercent: 0 });
  const discountedSubtotalCents = selectPromotion(promotion, order.subtotalCents, value);
  return { ...order, discountedSubtotalCents, totalPaidCents: discountedSubtotalCents + order.shippingCents };
}
