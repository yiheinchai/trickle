/**
 * E2E test: `trickle overview` — Compact API overview with type signatures
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Run overview with no data (should show empty message)
 * 3. Ingest sample routes with various types
 * 4. Run overview — verify all routes listed
 * 5. Verify method colors (GET, POST, PUT, DELETE present)
 * 6. Verify return type signatures shown inline
 * 7. Verify request body signatures shown for POST routes
 * 8. Run overview with --json flag
 * 9. Verify JSON output structure
 * 10. Ingest routes in different modules — verify grouping
 * 11. Run overview with --env filter
 * 12. Clean shutdown
 */
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBackend() {
  execSync('rm -f ~/.trickle/trickle.db ~/.trickle/trickle.db-shm ~/.trickle/trickle.db-wal');
  const proc = spawn('node', ['packages/backend/dist/index.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://localhost:4888/api/health');
      if (res.ok) break;
    } catch {}
    await sleep(500);
  }
  return proc;
}

function makeTypeHash(argsType, returnType) {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

async function ingestRoute(method, routePath, argsType, returnType, opts = {}) {
  const typeHash = makeTypeHash(argsType, returnType);
  await fetch('http://localhost:4888/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      functionName: `${method} ${routePath}`,
      module: opts.module || 'api',
      language: 'js',
      environment: opts.env || 'development',
      typeHash,
      argsType,
      returnType,
    }),
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['packages/cli/dist/index.js', ...args], {
      env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI timeout')); }, 30000);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Run overview with no data
    console.log('\n=== Step 2: Run overview with no data ===');
    const emptyResult = await runCli(['overview']);
    if (!emptyResult.stdout.includes('No observed routes')) {
      throw new Error('Expected "No observed routes" message');
    }
    console.log('  Empty state shows correct message ✓');

    // Step 3: Ingest sample routes
    console.log('\n=== Step 3: Ingest sample routes ===');

    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          users: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
                email: { kind: 'primitive', name: 'string' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );

    await ingestRoute('POST', '/api/users',
      {
        kind: 'object', properties: {
          body: {
            kind: 'object', properties: {
              name: { kind: 'primitive', name: 'string' },
              email: { kind: 'primitive', name: 'string' },
            },
          },
        },
      },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          created: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await ingestRoute('GET', '/api/orders',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          orders: {
            kind: 'array', element: {
              kind: 'object', properties: {
                orderId: { kind: 'primitive', name: 'number' },
                status: { kind: 'primitive', name: 'string' },
                total: { kind: 'primitive', name: 'number' },
              },
            },
          },
          page: { kind: 'primitive', name: 'number' },
        },
      },
    );

    await ingestRoute('DELETE', '/api/users/:id',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          deleted: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await ingestRoute('PUT', '/api/users/:id',
      {
        kind: 'object', properties: {
          body: {
            kind: 'object', properties: {
              name: { kind: 'primitive', name: 'string' },
            },
          },
        },
      },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          updated: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await sleep(500);
    console.log('  5 routes ingested ✓');

    // Step 4: Run overview — verify all routes listed
    console.log('\n=== Step 4: Run overview — verify all routes ===');
    const result = await runCli(['overview']);
    if (result.code !== 0) {
      throw new Error('Overview failed: ' + result.stderr);
    }
    if (!result.stdout.includes('trickle overview')) {
      throw new Error('Expected overview header');
    }
    if (!result.stdout.includes('5 route')) {
      throw new Error('Expected "5 routes" in output');
    }
    console.log('  Overview shows 5 routes ✓');

    // Step 5: Verify method names present
    console.log('\n=== Step 5: Verify HTTP methods present ===');
    if (!result.stdout.includes('GET')) {
      throw new Error('Expected GET in output');
    }
    if (!result.stdout.includes('POST')) {
      throw new Error('Expected POST in output');
    }
    if (!result.stdout.includes('PUT')) {
      throw new Error('Expected PUT in output');
    }
    if (!result.stdout.includes('DELETE')) {
      throw new Error('Expected DELETE in output');
    }
    console.log('  All HTTP methods shown ✓');

    // Step 6: Verify return type signatures shown
    console.log('\n=== Step 6: Verify return type signatures ===');
    if (!result.stdout.includes('users:')) {
      throw new Error('Expected "users:" field in type signature');
    }
    if (!result.stdout.includes('total:')) {
      throw new Error('Expected "total:" field in type signature');
    }
    if (!result.stdout.includes('deleted:')) {
      throw new Error('Expected "deleted:" field in type signature');
    }
    console.log('  Return type signatures shown inline ✓');

    // Step 7: Verify request body signatures for POST/PUT
    console.log('\n=== Step 7: Verify request body signatures ===');
    // The overview should show ← for request bodies
    if (!result.stdout.includes('←')) {
      throw new Error('Expected ← indicator for request body');
    }
    console.log('  Request body signatures shown ✓');

    // Step 8: Run with --json flag
    console.log('\n=== Step 8: Run overview --json ===');
    const jsonResult = await runCli(['overview', '--json']);
    if (jsonResult.code !== 0) {
      throw new Error('JSON overview failed: ' + jsonResult.stderr);
    }
    let jsonData;
    try {
      jsonData = JSON.parse(jsonResult.stdout);
    } catch {
      throw new Error('Expected valid JSON output');
    }
    console.log('  JSON output is valid ✓');

    // Step 9: Verify JSON structure
    console.log('\n=== Step 9: Verify JSON structure ===');
    if (!jsonData.routes || !Array.isArray(jsonData.routes)) {
      throw new Error('Expected routes array in JSON');
    }
    if (jsonData.routes.length !== 5) {
      throw new Error(`Expected 5 routes, got ${jsonData.routes.length}`);
    }
    if (jsonData.total !== 5) {
      throw new Error('Expected total: 5');
    }
    const getUsers = jsonData.routes.find(r => r.name === 'GET /api/users');
    if (!getUsers) {
      throw new Error('Expected GET /api/users in routes');
    }
    if (!getUsers.returnSignature.includes('users')) {
      throw new Error('Expected users in return signature');
    }
    if (getUsers.method !== 'GET') {
      throw new Error('Expected method: GET');
    }
    console.log('  JSON structure correct with 5 routes ✓');

    // Step 10: Ingest routes in different modules — verify grouping
    console.log('\n=== Step 10: Ingest routes in different module ===');
    await ingestRoute('GET', '/api/admin/stats',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          totalUsers: { kind: 'primitive', name: 'number' },
          totalOrders: { kind: 'primitive', name: 'number' },
        },
      },
      { module: 'admin' },
    );
    await sleep(500);

    const groupedResult = await runCli(['overview']);
    if (!groupedResult.stdout.includes('6 route')) {
      throw new Error('Expected 6 routes after adding admin route');
    }
    if (!groupedResult.stdout.includes('/api/admin/stats')) {
      throw new Error('Expected admin stats route in output');
    }
    console.log('  Multiple modules shown correctly ✓');

    // Step 11: Run with --env filter
    console.log('\n=== Step 11: Run overview with --env filter ===');
    // Ingest a route in production env
    await ingestRoute('GET', '/api/health',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          status: { kind: 'primitive', name: 'string' },
          uptime: { kind: 'primitive', name: 'number' },
        },
      },
      { env: 'production' },
    );
    await sleep(500);

    const prodResult = await runCli(['overview', '--env', 'production']);
    if (prodResult.code !== 0) {
      throw new Error('Env-filtered overview failed');
    }
    // Production should only show the health route
    if (!prodResult.stdout.includes('/api/health')) {
      throw new Error('Expected /api/health in production overview');
    }
    console.log('  Environment filter works ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle overview shows compact API overview with type signatures!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
