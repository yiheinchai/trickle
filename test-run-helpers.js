/**
 * Helper functions used by test-run-app.js
 * Has ZERO trickle imports — relies on trickle run for instrumentation.
 */

function parseConfig(raw) {
  return {
    host: raw.host || 'localhost',
    port: raw.port || 3000,
    debug: raw.debug === true,
    retries: raw.retries || 3,
  };
}

function processItems(items) {
  return items.map(item => ({
    id: item.id,
    name: item.name.toUpperCase(),
    processed: true,
    timestamp: new Date().toISOString(),
  }));
}

async function fetchData(url) {
  // Simulate an async API call
  return {
    status: 200,
    data: { users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] },
    headers: { 'content-type': 'application/json' },
  };
}

async function transformResponse(response) {
  const users = response.data.users;
  return {
    count: users.length,
    names: users.map(u => u.name),
    fetchedAt: new Date().toISOString(),
  };
}

function calculateStats(numbers) {
  const sum = numbers.reduce((a, b) => a + b, 0);
  return {
    sum,
    avg: sum / numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    count: numbers.length,
  };
}

module.exports = { parseConfig, processItems, fetchData, transformResponse, calculateStats };
