// End-to-end test: start backend, instrument functions, query with CLI
const { trickle, configure, flush } = require('./packages/client-js/dist/index');

configure({ backendUrl: 'http://localhost:4888', batchIntervalMs: 500, debug: true });

// Simulate an Express-style handler
const processOrder = trickle(function processOrder(order) {
  const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = total * 0.1;
  return {
    orderId: order.id,
    customer: order.customer.name,
    total,
    tax,
    grandTotal: total + tax,
    status: 'processed',
  };
});

// Simulate a function that errors
const validatePayment = trickle(function validatePayment(payment) {
  if (!payment.cardNumber) {
    throw new Error('Card number is required');
  }
  if (payment.amount <= 0) {
    throw new TypeError('Amount must be positive');
  }
  return { valid: true, method: payment.method };
});

// Simulate a user lookup
const getUser = trickle(function getUser(userId, options) {
  return {
    id: userId,
    name: 'John Doe',
    email: 'john@example.com',
    roles: ['admin', 'user'],
    metadata: {
      lastLogin: new Date().toISOString(),
      loginCount: 42,
    },
  };
});

async function run() {
  console.log('=== Running instrumented functions ===\n');

  // Happy path calls
  console.log('1. processOrder (happy path)');
  const result = processOrder({
    id: 'ORD-123',
    customer: { name: 'Alice', email: 'alice@example.com' },
    items: [
      { name: 'Widget', price: 29.99, quantity: 2 },
      { name: 'Gadget', price: 49.99, quantity: 1 },
    ],
  });
  console.log('   Result:', JSON.stringify(result));

  console.log('2. getUser (happy path)');
  const user = getUser('usr-456', { includeRoles: true });
  console.log('   Result:', JSON.stringify(user));

  // Sad path: trigger errors
  console.log('3. validatePayment (error: missing card)');
  try {
    validatePayment({ amount: 100, method: 'credit' });
  } catch (e) {
    console.log('   Caught:', e.message);
  }

  console.log('4. validatePayment (error: bad amount)');
  try {
    validatePayment({ cardNumber: '4111111111111111', amount: -5, method: 'credit' });
  } catch (e) {
    console.log('   Caught:', e.message);
  }

  console.log('5. validatePayment (happy path)');
  const valid = validatePayment({ cardNumber: '4111111111111111', amount: 50, method: 'debit' });
  console.log('   Result:', JSON.stringify(valid));

  // Explicitly flush to ensure all data reaches the backend
  console.log('\nFlushing data to backend...');
  await flush();
  console.log('Done! Now query with the CLI.\n');
}

run().catch(console.error);
