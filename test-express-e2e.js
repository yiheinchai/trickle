/**
 * E2E test: Express auto-instrumentation
 *
 * Demonstrates the one-liner setup:
 *   const { instrument } = require('trickle');
 *   instrument(app);
 */
const express = require('express');
const { instrument, configure, flush } = require('./packages/client-js/dist/index');

configure({ backendUrl: 'http://localhost:4888', batchIntervalMs: 500, debug: true });

const app = express();
app.use(express.json());

// ONE LINE to instrument all routes
instrument(app);

// Define routes AFTER calling instrument()
app.get('/api/users', (req, res) => {
  res.json({
    users: [
      { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin' },
      { id: 2, name: 'Bob', email: 'bob@example.com', role: 'user' },
    ],
    total: 2,
  });
});

app.get('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 999) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    id,
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    metadata: { lastLogin: '2026-03-10T10:00:00Z', loginCount: 42 },
  });
});

app.post('/api/orders', (req, res) => {
  const order = req.body;
  if (!order.items || order.items.length === 0) {
    throw new Error('Order must have items');
  }
  const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.json({
    orderId: `ORD-${Date.now()}`,
    customer: order.customer,
    total,
    status: 'created',
  });
});

app.put('/api/users/:id', (req, res) => {
  res.json({ id: parseInt(req.params.id), ...req.body, updated: true });
});

async function run() {
  const server = app.listen(3456, async () => {
    console.log('Express test server on :3456');

    try {
      // Make requests to trigger instrumentation
      console.log('\n1. GET /api/users');
      let resp = await fetch('http://localhost:3456/api/users');
      console.log('   Status:', resp.status, '- Body:', JSON.stringify(await resp.json()).slice(0, 80));

      console.log('2. GET /api/users/1');
      resp = await fetch('http://localhost:3456/api/users/1');
      console.log('   Status:', resp.status, '- Body:', JSON.stringify(await resp.json()).slice(0, 80));

      console.log('3. POST /api/orders (happy path)');
      resp = await fetch('http://localhost:3456/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: 'Alice',
          items: [
            { name: 'Widget', price: 29.99, quantity: 2 },
            { name: 'Gadget', price: 49.99, quantity: 1 },
          ],
        }),
      });
      console.log('   Status:', resp.status, '- Body:', JSON.stringify(await resp.json()).slice(0, 80));

      console.log('4. POST /api/orders (error — empty items)');
      resp = await fetch('http://localhost:3456/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: 'Bob', items: [] }),
      });
      console.log('   Status:', resp.status);

      console.log('5. PUT /api/users/1');
      resp = await fetch('http://localhost:3456/api/users/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice Updated', email: 'alice2@example.com' }),
      });
      console.log('   Status:', resp.status, '- Body:', JSON.stringify(await resp.json()).slice(0, 80));

      console.log('\nFlushing...');
      await flush();
      // Give a moment for the batch to actually send
      await new Promise(r => setTimeout(r, 1000));
      await flush();
      console.log('Done!\n');
    } catch (err) {
      console.error('Test error:', err.message);
    } finally {
      server.close();
    }
  });
}

run();
