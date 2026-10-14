export function assertCents(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid_cents');
  return value;
}

export function formatMoney(cents, currency = 'CAD') {
  assertCents(cents);
  return `${currency} ${(cents / 100).toFixed(2)}`;
}
