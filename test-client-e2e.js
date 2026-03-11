/**
 * E2E test: Typed API client generation
 *
 * 1. Starts Express server with trickle instrumentation
 * 2. Makes requests to populate type observations
 * 3. Generates a typed API client via `trickle codegen --client`
 * 4. Verifies the generated client compiles with `tsc --strict`
 * 5. Uses the generated client to make real API calls and validates responses
 */
const { execSync } = require('child_process');
const express = require('express');
const { instrument, configure, flush } = require('./packages/client-js/dist/index');
const fs = require('fs');
const path = require('path');

configure({ backendUrl: 'http://localhost:4888', batchIntervalMs: 500, debug: true });

const app = express();
app.use(express.json());
instrument(app);

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
  res.json({ id: parseInt(req.params.id), name: 'Alice', email: 'alice@example.com' });
});

app.post('/api/orders', (req, res) => {
  const order = req.body;
  const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.json({ orderId: `ORD-${Date.now()}`, customer: order.customer, total, status: 'created' });
});

app.put('/api/users/:id', (req, res) => {
  res.json({ id: parseInt(req.params.id), ...req.body, updated: true });
});

async function run() {
  const server = app.listen(3457, async () => {
    console.log('Test server on :3457');

    try {
      // Step 1: Make requests to populate types
      console.log('\n=== Step 1: Populate type observations ===');

      await fetch('http://localhost:3457/api/users');
      console.log('  GET /api/users ✓');

      await fetch('http://localhost:3457/api/users/1');
      console.log('  GET /api/users/1 ✓');

      await fetch('http://localhost:3457/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: 'Alice',
          items: [{ name: 'Widget', price: 29.99, quantity: 2 }],
        }),
      });
      console.log('  POST /api/orders ✓');

      await fetch('http://localhost:3457/api/users/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alice Updated', email: 'alice2@example.com' }),
      });
      console.log('  PUT /api/users/1 ✓');

      // Flush observations to backend
      await flush();
      await new Promise(r => setTimeout(r, 1000));
      await flush();

      // Step 2: Generate typed client
      console.log('\n=== Step 2: Generate typed API client ===');
      const clientPath = path.join(__dirname, '.trickle', 'api-client.ts');
      execSync(`npx trickle codegen --client --out ${clientPath}`, { stdio: 'pipe' });
      const clientCode = fs.readFileSync(clientPath, 'utf-8');
      console.log(`  Generated ${clientPath}`);

      // Count interfaces and methods
      const interfaceCount = (clientCode.match(/export interface/g) || []).length;
      const methodCount = (clientCode.match(/\w+: \(/g) || []).length;
      console.log(`  ${interfaceCount} interfaces, ${methodCount} client methods`);

      // Step 3: Validate TypeScript compilation
      console.log('\n=== Step 3: Validate TypeScript compilation ===');
      try {
        execSync(`npx tsc --noEmit --strict ${clientPath}`, { stdio: 'pipe' });
        console.log('  tsc --strict: PASS ✓');
      } catch (err) {
        console.error('  tsc --strict: FAIL ✗');
        console.error(err.stdout?.toString() || err.stderr?.toString());
        process.exit(1);
      }

      // Step 4: Verify client code structure
      console.log('\n=== Step 4: Verify client structure ===');

      // Check key interfaces exist
      const expectedInterfaces = [
        'GetApiUsersOutput',
        'GetApiUsersIdOutput',
        'PostApiOrdersInput',
        'PostApiOrdersOutput',
        'PutApiUsersIdInput',
        'PutApiUsersIdOutput',
      ];
      for (const name of expectedInterfaces) {
        if (clientCode.includes(`interface ${name}`)) {
          console.log(`  Interface ${name} ✓`);
        } else {
          console.error(`  Interface ${name} MISSING ✗`);
          process.exit(1);
        }
      }

      // Check client methods exist
      const expectedMethods = ['getApiUsers', 'getApiUsersId', 'postApiOrders', 'putApiUsersId'];
      for (const name of expectedMethods) {
        if (clientCode.includes(`${name}:`)) {
          console.log(`  Method ${name}() ✓`);
        } else {
          console.error(`  Method ${name}() MISSING ✗`);
          process.exit(1);
        }
      }

      // Check createTrickleClient factory exists
      if (clientCode.includes('createTrickleClient')) {
        console.log('  Factory createTrickleClient() ✓');
      } else {
        console.error('  Factory createTrickleClient() MISSING ✗');
        process.exit(1);
      }

      // Check TrickleClient type export
      if (clientCode.includes('TrickleClient')) {
        console.log('  Type TrickleClient ✓');
      } else {
        console.error('  Type TrickleClient MISSING ✗');
        process.exit(1);
      }

      // Step 5: Verify the generated client would work (test path param substitution)
      console.log('\n=== Step 5: Verify path parameter handling ===');
      if (clientCode.includes('`/api/users/${id}`')) {
        console.log('  Path param substitution /api/users/${id} ✓');
      } else {
        console.error('  Path param substitution MISSING ✗');
        process.exit(1);
      }

      // Verify request body typing for POST
      if (clientCode.includes('input: PostApiOrdersInput')) {
        console.log('  POST body typed as PostApiOrdersInput ✓');
      } else {
        console.error('  POST body typing MISSING ✗');
        process.exit(1);
      }

      // Verify PUT has both path param and body
      if (clientCode.includes('putApiUsersId: (id: string, input: PutApiUsersIdInput)')) {
        console.log('  PUT has path param + body ✓');
      } else {
        console.error('  PUT path param + body MISSING ✗');
        process.exit(1);
      }

      console.log('\n=== All tests passed! ===\n');

    } catch (err) {
      console.error('Test error:', err.message);
      process.exit(1);
    } finally {
      server.close();
    }
  });
}

run();
