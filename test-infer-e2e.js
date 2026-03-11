/**
 * E2E test: `trickle infer` — Infer types from JSON files or stdin
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Create temp JSON files
 * 3. Infer types from a JSON file
 * 4. Verify types were stored in backend
 * 5. Infer with --request-body option
 * 6. Verify request body types were stored
 * 7. Infer from stdin (piped input)
 * 8. Verify stdin-inferred types were stored
 * 9. Infer complex nested JSON
 * 10. Verify codegen produces types for all inferred routes
 * 11. Infer from stdin with "-" argument
 * 12. Clean shutdown
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function runCli(args, stdinData) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['packages/cli/dist/index.js', ...args], {
      env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' },
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI timeout')); }, 30000);
    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function run() {
  let backendProc = null;
  let tmpDir = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Create temp JSON files
    console.log('\n=== Step 2: Create temp JSON files ===');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-infer-test-'));

    const usersJson = {
      users: [
        { id: 1, name: 'Alice', email: 'alice@test.com' },
        { id: 2, name: 'Bob', email: 'bob@test.com' },
      ],
      total: 2,
      page: 1,
    };
    const usersFile = path.join(tmpDir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify(usersJson, null, 2));

    const orderJson = {
      orderId: 42,
      status: 'confirmed',
      items: [{ product: 'Widget', quantity: 3, price: 9.99 }],
    };
    const orderFile = path.join(tmpDir, 'order.json');
    fs.writeFileSync(orderFile, JSON.stringify(orderJson, null, 2));

    const nestedJson = {
      data: {
        organization: {
          id: 'org-1',
          name: 'Acme',
          settings: {
            theme: 'dark',
            notifications: { email: true, sms: false },
          },
          members: [
            { userId: 1, role: 'admin', joinedAt: '2024-01-15' },
          ],
        },
      },
      meta: { requestId: 'abc123', duration: 42 },
    };
    const nestedFile = path.join(tmpDir, 'nested.json');
    fs.writeFileSync(nestedFile, JSON.stringify(nestedJson, null, 2));

    console.log('  Created users.json, order.json, nested.json ✓');

    // Step 3: Infer types from JSON file
    console.log('\n=== Step 3: Infer types from JSON file ===');
    const result1 = await runCli(['infer', usersFile, '--name', 'GET /api/users']);
    if (result1.code !== 0) {
      throw new Error('Infer from file failed: ' + result1.stderr);
    }
    if (!result1.stdout.includes('Types inferred and stored successfully')) {
      throw new Error('Expected success message');
    }
    if (!result1.stdout.includes('users')) {
      throw new Error('Expected "users" in inferred shape output');
    }
    console.log('  Types inferred from users.json ✓');

    // Step 4: Verify types were stored in backend
    console.log('\n=== Step 4: Verify types stored in backend ===');
    await sleep(500);
    const funcsRes = await fetch('http://localhost:4888/api/functions?q=GET+%2Fapi%2Fusers&limit=10');
    const funcsData = await funcsRes.json();
    const userFunc = funcsData.functions.find(f => f.function_name === 'GET /api/users');
    if (!userFunc) {
      throw new Error('Expected GET /api/users in backend functions');
    }
    console.log('  GET /api/users stored in backend ✓');

    // Step 5: Infer with --request-body
    console.log('\n=== Step 5: Infer with --request-body ===');
    const result2 = await runCli([
      'infer', orderFile,
      '--name', 'POST /api/orders',
      '--request-body', '{"product":"Widget","quantity":3}',
    ]);
    if (result2.code !== 0) {
      throw new Error('Infer with request-body failed: ' + result2.stderr);
    }
    if (!result2.stdout.includes('Types inferred and stored successfully')) {
      throw new Error('Expected success message');
    }
    if (!result2.stdout.includes('Request body shape')) {
      throw new Error('Expected request body shape in output');
    }
    console.log('  Types inferred with request body ✓');

    // Step 6: Verify request body types stored
    console.log('\n=== Step 6: Verify request body types stored ===');
    await sleep(500);
    const funcsRes2 = await fetch('http://localhost:4888/api/functions?q=POST+%2Fapi%2Forders&limit=10');
    const funcsData2 = await funcsRes2.json();
    const orderFunc = funcsData2.functions.find(f => f.function_name === 'POST /api/orders');
    if (!orderFunc) {
      throw new Error('Expected POST /api/orders in backend functions');
    }
    // Fetch the type snapshot and verify it has args
    const typesRes = await fetch(`http://localhost:4888/api/types/${orderFunc.id}?limit=1`);
    const typesData = await typesRes.json();
    if (!typesData.snapshots || typesData.snapshots.length === 0) {
      throw new Error('Expected type snapshot for POST /api/orders');
    }
    const argsType = typesData.snapshots[0].args_type;
    if (!argsType || !argsType.properties || !argsType.properties.body) {
      throw new Error('Expected args_type to contain body from --request-body');
    }
    console.log('  Request body types stored with args ✓');

    // Step 7: Infer from stdin
    console.log('\n=== Step 7: Infer from stdin (piped) ===');
    const stdinJson = JSON.stringify({ status: 'healthy', uptime: 12345, version: '1.0.0' });
    const result3 = await runCli(
      ['infer', '--name', 'GET /api/health'],
      stdinJson,
    );
    if (result3.code !== 0) {
      throw new Error('Infer from stdin failed: ' + result3.stderr);
    }
    if (!result3.stdout.includes('Types inferred and stored successfully')) {
      throw new Error('Expected success message for stdin');
    }
    if (!result3.stdout.includes('stdin')) {
      throw new Error('Expected "stdin" as source in output');
    }
    console.log('  Types inferred from stdin ✓');

    // Step 8: Verify stdin-inferred types stored
    console.log('\n=== Step 8: Verify stdin types stored ===');
    await sleep(500);
    const funcsRes3 = await fetch('http://localhost:4888/api/functions?q=GET+%2Fapi%2Fhealth&limit=10');
    const funcsData3 = await funcsRes3.json();
    const healthFunc = funcsData3.functions.find(f => f.function_name === 'GET /api/health');
    if (!healthFunc) {
      throw new Error('Expected GET /api/health in backend functions');
    }
    console.log('  GET /api/health stored from stdin ✓');

    // Step 9: Infer complex nested JSON
    console.log('\n=== Step 9: Infer complex nested JSON ===');
    const result4 = await runCli(['infer', nestedFile, '--name', 'GET /api/org/:id']);
    if (result4.code !== 0) {
      throw new Error('Infer nested JSON failed: ' + result4.stderr);
    }
    if (!result4.stdout.includes('Types inferred and stored successfully')) {
      throw new Error('Expected success message for nested');
    }
    console.log('  Complex nested JSON inferred ✓');

    // Step 10: Verify codegen produces types for all inferred routes
    console.log('\n=== Step 10: Verify codegen output ===');
    await sleep(500);
    const codegenRes = await fetch('http://localhost:4888/api/codegen');
    const codegenData = await codegenRes.json();
    const types = codegenData.types;
    if (!types.includes('users') && !types.includes('Users')) {
      throw new Error('Expected users in codegen output');
    }
    if (!types.includes('orderId') && !types.includes('OrderId')) {
      throw new Error('Expected orderId in codegen output');
    }
    console.log('  Codegen includes all inferred routes ✓');

    // Step 11: Infer from stdin with explicit "-" argument
    console.log('\n=== Step 11: Infer from stdin with "-" ===');
    const stdinJson2 = JSON.stringify({ metrics: [{ name: 'cpu', value: 85.5 }] });
    const result5 = await runCli(
      ['infer', '-', '--name', 'GET /api/metrics'],
      stdinJson2,
    );
    if (result5.code !== 0) {
      throw new Error('Infer from stdin with "-" failed: ' + result5.stderr);
    }
    if (!result5.stdout.includes('Types inferred and stored successfully')) {
      throw new Error('Expected success message');
    }
    console.log('  Stdin with explicit "-" works ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle infer works with files, stdin, and complex JSON!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
