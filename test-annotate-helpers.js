/**
 * Helper module for annotate e2e test — functions without type annotations.
 * trickle annotate should add types to these functions after observation.
 */

function parseConfig(raw) {
  return {
    host: raw.host || 'localhost',
    port: raw.port || 3000,
    debug: raw.debug || false,
  };
}

function processItems(items) {
  return items.map(item => ({
    id: item.id,
    name: item.name.toUpperCase(),
    processed: true,
  }));
}

function calculateTotal(prices, taxRate) {
  const subtotal = prices.reduce((sum, p) => sum + p, 0);
  return { subtotal, tax: subtotal * taxRate, total: subtotal * (1 + taxRate) };
}

module.exports = { parseConfig, processItems, calculateTotal };
