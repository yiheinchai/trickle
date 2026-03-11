/**
 * E2E test: `trickle capture <method> <url>` — Capture types from live API
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Start a simple test API server
 * 3. Capture GET endpoint types via CLI
 * 4. Verify types were ingested into backend
 * 5. Capture POST endpoint with body
 * 6. Verify POST route types ingested
 * 7. Capture endpoint with query params
 * 8. Verify query param types captured
 * 9. Capture endpoint with numeric ID (path normalization)
 * 10. Verify path normalization (:id replacement)
 * 11. Generate codegen from captured types
 * 12. Clean shutdown
 */
const { spawn, execSync } = require('child_process');
const http = require('http');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['packages/cli/dist/index.js', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI timeout')); }, 30000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI exit ${code}: ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
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

function startTestApi(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const method = req.method;

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');

      if (method === 'GET' && url.pathname === '/api/users') {
        res.end(JSON.stringify({
          users: [
            { id: 1, name: 'Alice', email: 'alice@test.com', active: true },
            { id: 2, name: 'Bob', email: 'bob@test.com', active: false },
          ],
          total: 2,
          page: 1,
        }));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/users') {
        const parsed = JSON.parse(body);
        res.statusCode = 201;
        res.end(JSON.stringify({
          id: 3,
          name: parsed.name,
          email: parsed.email,
          created: true,
        }));
        return;
      }

      if (method === 'GET' && /^\/api\/users\/\d+$/.test(url.pathname)) {
        const id = parseInt(url.pathname.split('/').pop());
        res.end(JSON.stringify({
          id,
          name: 'Alice',
          email: 'alice@test.com',
          active: true,
          profile: { bio: 'Hello world', joinedAt: '2024-01-01' },
        }));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q') || '';
        res.end(JSON.stringify({
          query: q,
          results: [{ id: 1, title: 'Result 1', score: 0.95 }],
          count: 1,
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

const ENV = { TRICKLE_BACKEND_URL: 'http://localhost:4888' };

async function run() {
  let backendProc = null;
  let testApi = null;
  const PORT = 9877;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Start test API
    console.log('\n=== Step 2: Start test API server ===');
    testApi = await startTestApi(PORT);
    console.log(`  Test API running on port ${PORT} ✓`);

    // Step 3: Capture GET /api/users
    console.log('\n=== Step 3: Capture GET endpoint ===');
    const captureOut1 = await runCli(['capture', 'GET', `http://localhost:${PORT}/api/users`], ENV);
    if (!captureOut1.includes('Types captured successfully')) {
      throw new Error('Expected success message for GET capture');
    }
    console.log('  GET /api/users captured ✓');

    // Step 4: Verify types ingested
    console.log('\n=== Step 4: Verify GET types in backend ===');
    await sleep(500);
    const funcsRes = await fetch('http://localhost:4888/api/functions?q=GET+/api/users');
    const funcsData = await funcsRes.json();
    const getUsersFunc = funcsData.functions.find(f => f.function_name === 'GET /api/users');
    if (!getUsersFunc) {
      throw new Error('Expected GET /api/users function in backend');
    }
    console.log('  GET /api/users found in backend ✓');

    // Step 5: Capture POST /api/users with body
    console.log('\n=== Step 5: Capture POST endpoint with body ===');
    const captureOut2 = await runCli(
      ['capture', 'POST', `http://localhost:${PORT}/api/users`, '-d', '{"name":"Charlie","email":"charlie@test.com"}'],
      ENV,
    );
    if (!captureOut2.includes('Types captured successfully')) {
      throw new Error('Expected success message for POST capture');
    }
    if (!captureOut2.includes('Request body')) {
      throw new Error('Expected request body field count');
    }
    console.log('  POST /api/users with body captured ✓');

    // Step 6: Verify POST types ingested
    console.log('\n=== Step 6: Verify POST types in backend ===');
    await sleep(500);
    const funcsRes2 = await fetch('http://localhost:4888/api/functions?q=POST+/api/users');
    const funcsData2 = await funcsRes2.json();
    const postUsersFunc = funcsData2.functions.find(f => f.function_name === 'POST /api/users');
    if (!postUsersFunc) {
      throw new Error('Expected POST /api/users function in backend');
    }
    console.log('  POST /api/users found in backend ✓');

    // Step 7: Capture endpoint with query params
    console.log('\n=== Step 7: Capture endpoint with query params ===');
    const captureOut3 = await runCli(
      ['capture', 'GET', `http://localhost:${PORT}/api/search?q=hello&limit=10`],
      ENV,
    );
    if (!captureOut3.includes('Types captured successfully')) {
      throw new Error('Expected success message for search capture');
    }
    console.log('  GET /api/search?q=... captured ✓');

    // Step 8: Verify query param types
    console.log('\n=== Step 8: Verify query param types ===');
    await sleep(500);
    const funcsRes3 = await fetch('http://localhost:4888/api/functions?q=GET+/api/search');
    const funcsData3 = await funcsRes3.json();
    const searchFunc = funcsData3.functions.find(f => f.function_name === 'GET /api/search');
    if (!searchFunc) {
      throw new Error('Expected GET /api/search function in backend');
    }
    console.log('  GET /api/search with query params found ✓');

    // Step 9: Capture endpoint with numeric ID (path normalization)
    console.log('\n=== Step 9: Capture endpoint with numeric ID ===');
    const captureOut4 = await runCli(
      ['capture', 'GET', `http://localhost:${PORT}/api/users/42`],
      ENV,
    );
    if (!captureOut4.includes('Types captured successfully')) {
      throw new Error('Expected success message for users/:id capture');
    }
    console.log('  GET /api/users/42 captured ✓');

    // Step 10: Verify path normalization
    console.log('\n=== Step 10: Verify path normalization ===');
    await sleep(500);
    const funcsRes4 = await fetch('http://localhost:4888/api/functions');
    const funcsData4 = await funcsRes4.json();
    const normalizedFunc = funcsData4.functions.find(f => f.function_name === 'GET /api/users/:id');
    if (!normalizedFunc) {
      throw new Error('Expected GET /api/users/:id (normalized) function in backend');
    }
    if (!captureOut4.includes('/api/users/:id')) {
      throw new Error('Expected normalized path in output');
    }
    console.log('  Path /api/users/42 normalized to /api/users/:id ✓');

    // Step 11: Generate codegen from captured types
    console.log('\n=== Step 11: Generate codegen from captured types ===');
    const codegenOut = await runCli(['codegen'], ENV);
    if (!codegenOut.includes('GetApiUsers')) {
      throw new Error('Expected GetApiUsers type in codegen output');
    }
    if (!codegenOut.includes('PostApiUsers')) {
      throw new Error('Expected PostApiUsers type in codegen output');
    }
    if (!codegenOut.includes('GetApiSearch')) {
      throw new Error('Expected GetApiSearch type in codegen output');
    }
    console.log('  Codegen includes types for all captured routes ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle capture works end-to-end!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (testApi) { testApi.close(); }
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
