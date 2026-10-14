export function available(stock, sku) {
  return stock[sku] ?? 0;
}

export function reserve(stock, items) {
  const requested = new Map();
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new RangeError('invalid_quantity');
    requested.set(item.sku, (requested.get(item.sku) ?? 0) + item.quantity);
  }
  for (const [sku, quantity] of requested) if (quantity > available(stock, sku)) throw new RangeError('out_of_stock');
  const result = { ...stock };
  for (const [sku, quantity] of requested) result[sku] -= quantity;
  return result;
}
