/**
 * Library for testing runtime examples in generated types.
 * These functions produce predictable output for easy verification.
 */

function calculateDiscount(price, percentage) {
  const discount = price * (percentage / 100);
  return {
    original: price,
    discount: discount,
    final: price - discount,
  };
}

function formatAddress(street, city, zip) {
  return {
    line1: street,
    line2: `${city}, ${zip}`,
    full: `${street}, ${city}, ${zip}`,
  };
}

function sumArray(items) {
  return {
    items: items,
    total: items.reduce((a, b) => a + b, 0),
    count: items.length,
  };
}

module.exports = { calculateDiscount, formatAddress, sumArray };
