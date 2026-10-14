const products = Object.freeze({
  book: Object.freeze({ priceCents: 2000, weightGrams: 500 }),
  mug: Object.freeze({ priceCents: 1500, weightGrams: 300 }),
  desk: Object.freeze({ priceCents: 40_000, weightGrams: 15_000 }),
});

export function getProduct(sku) {
  if (!Object.hasOwn(products, sku)) throw new RangeError('unknown_sku');
  return products[sku];
}

export function priceCart(items) {
  if (!Array.isArray(items) || !items.length) throw new TypeError('empty_cart');
  let subtotalCents = 0, weightGrams = 0;
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new RangeError('invalid_quantity');
    const product = getProduct(item.sku);
    subtotalCents += product.priceCents * item.quantity;
    weightGrams += product.weightGrams * item.quantity;
  }
  if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(weightGrams)) throw new RangeError('cart_overflow');
  return { subtotalCents, weightGrams };
}
