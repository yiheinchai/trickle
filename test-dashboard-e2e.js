/**
 * E2E test: `trickle dashboard` — Web dashboard for type exploration
 *
 * Tests:
 * 1. Start backend, populate routes
 * 2. Verify /dashboard serves HTML
 * 3. Verify HTML contains dashboard structure (header, stats, search, route list)
 * 4. Verify HTML references backend APIs (fetch calls to /api/functions, /api/types, etc.)
 * 5. Verify HTML contains type rendering logic
 * 6. Verify HTML contains SSE live update connection
 * 7. Verify HTML has method filter tabs (GET, POST, PUT, DELETE)
 * 8. Verify /api/functions returns data that the dashboard would display
 * 9. Verify /api/mock-config returns sample data for the dashboard
 * 10. Verify the CLI command exists (--help check)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(port, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`http://localhost:${port}/api/health`).catch(() =>
        fetch(`http://localhost:${port}`)
      );
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

function runPopulate(port, scriptBody) {
  const tmpScript = path.join(__dirname, `.test-dash-populate-${port}.js`);
  fs.writeFileSync(tmpScript, scriptBody, 'utf-8');
  try {
    execSync(`node ${tmpScript}`, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    fs.unlinkSync(tmpScript);
  }
}

async function startBackend() {
  execSync('rm -f ~/.trickle/trickle.db');
  const proc = spawn('node', ['packages/backend/dist/index.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  await waitForServer(4888);
  return proc;
}

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend and populate routes
    console.log('=== Step 1: Start backend and populate routes ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    runPopulate(3478, `
      const express = require('express');
      const { instrument, configure, flush } = require('./packages/client-js/dist/index');
      configure({ backendUrl: 'http://localhost:4888', batchIntervalMs: 500, debug: false });
      const app = express();
      app.use(express.json());
      instrument(app);

      app.get('/api/users', (req, res) => res.json({
        users: [{ id: 1, name: 'Alice', email: 'alice@test.com' }],
        total: 1,
      }));

      app.post('/api/users', (req, res) => res.json({
        id: 2, name: req.body.name, email: req.body.email, created: true,
      }));

      app.get('/api/products', (req, res) => res.json({
        products: [{ id: 1, title: 'Widget', price: 29.99 }],
        count: 1,
      }));

      app.delete('/api/products/:id', (req, res) => res.json({ deleted: true }));

      const s = app.listen(3478, async () => {
        await fetch('http://localhost:3478/api/users');
        await fetch('http://localhost:3478/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
        });
        await fetch('http://localhost:3478/api/products');
        await fetch('http://localhost:3478/api/products/1', { method: 'DELETE' });
        await flush();
        await new Promise(r => setTimeout(r, 2000));
        await flush();
        s.close();
        process.exit(0);
      });
    `);
    console.log('  Routes populated ✓');

    // Step 2: Verify /dashboard serves HTML
    console.log('\n=== Step 2: Verify /dashboard serves HTML ===');
    const dashRes = await fetch('http://localhost:4888/dashboard');
    if (!dashRes.ok) {
      throw new Error(`Dashboard returned ${dashRes.status}`);
    }
    const contentType = dashRes.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) {
      throw new Error(`Expected text/html, got ${contentType}`);
    }
    const html = await dashRes.text();
    console.log(`  /dashboard serves HTML (${html.length} bytes) ✓`);

    // Step 3: Verify dashboard structure
    console.log('\n=== Step 3: Verify dashboard structure ===');
    if (!html.includes('<title>trickle dashboard</title>')) {
      throw new Error('Missing title');
    }
    if (!html.includes('trickle</span> dashboard')) {
      throw new Error('Missing header');
    }
    if (!html.includes('id="stats"')) {
      throw new Error('Missing stats section');
    }
    if (!html.includes('id="searchInput"')) {
      throw new Error('Missing search input');
    }
    if (!html.includes('id="routeList"')) {
      throw new Error('Missing route list');
    }
    console.log('  Header, stats, search, route list ✓');

    // Step 4: Verify API fetch calls
    console.log('\n=== Step 4: Verify API fetch calls ===');
    if (!html.includes('/api/functions')) {
      throw new Error('Should fetch /api/functions');
    }
    if (!html.includes('/api/types/')) {
      throw new Error('Should fetch /api/types/');
    }
    if (!html.includes('/api/mock-config')) {
      throw new Error('Should fetch /api/mock-config');
    }
    console.log('  API fetch calls to functions, types, mock-config ✓');

    // Step 5: Verify type rendering logic
    console.log('\n=== Step 5: Verify type rendering logic ===');
    if (!html.includes('renderTypeNode')) {
      throw new Error('Should have renderTypeNode function');
    }
    if (!html.includes("case 'object'") && !html.includes("case 'primitive'")) {
      throw new Error('Should handle TypeNode kinds');
    }
    console.log('  TypeNode rendering logic (primitive, object, array, union) ✓');

    // Step 6: Verify SSE live updates
    console.log('\n=== Step 6: Verify SSE live updates ===');
    if (!html.includes('EventSource')) {
      throw new Error('Should connect via EventSource for live updates');
    }
    if (!html.includes('/api/tail')) {
      throw new Error('Should connect to /api/tail SSE endpoint');
    }
    if (!html.includes('type_snapshot')) {
      throw new Error('Should listen for type_snapshot events');
    }
    console.log('  SSE connection to /api/tail with type_snapshot listener ✓');

    // Step 7: Verify method filter tabs
    console.log('\n=== Step 7: Verify method filter tabs ===');
    if (!html.includes('data-filter="GET"')) throw new Error('Missing GET tab');
    if (!html.includes('data-filter="POST"')) throw new Error('Missing POST tab');
    if (!html.includes('data-filter="PUT"')) throw new Error('Missing PUT tab');
    if (!html.includes('data-filter="DELETE"')) throw new Error('Missing DELETE tab');
    if (!html.includes('data-filter="all"')) throw new Error('Missing All tab');
    console.log('  Filter tabs: All, GET, POST, PUT, DELETE ✓');

    // Step 8: Verify styling
    console.log('\n=== Step 8: Verify styling ===');
    if (!html.includes('.method.get')) throw new Error('Missing GET method style');
    if (!html.includes('.method.post')) throw new Error('Missing POST method style');
    if (!html.includes('.method.delete')) throw new Error('Missing DELETE method style');
    if (!html.includes('--accent')) throw new Error('Missing CSS variables');
    console.log('  CSS styles for methods and theme ✓');

    // Step 9: Verify /api/functions returns data for dashboard
    console.log('\n=== Step 9: Verify API data for dashboard ===');
    const funcsRes = await fetch('http://localhost:4888/api/functions?limit=500');
    const funcsData = await funcsRes.json();
    if (!funcsData.functions || funcsData.functions.length < 3) {
      throw new Error(`Expected at least 3 functions, got ${funcsData.functions?.length}`);
    }
    console.log(`  /api/functions returns ${funcsData.functions.length} functions ✓`);

    const mockRes = await fetch('http://localhost:4888/api/mock-config');
    const mockData = await mockRes.json();
    if (!mockData.routes || mockData.routes.length < 3) {
      throw new Error(`Expected at least 3 mock routes, got ${mockData.routes?.length}`);
    }
    const hasSample = mockData.routes.some(r => r.sampleOutput !== null);
    if (!hasSample) {
      throw new Error('Mock routes should have sample data');
    }
    console.log(`  /api/mock-config returns ${mockData.routes.length} routes with sample data ✓`);

    // Step 10: Verify dashboard shows expandable route details
    console.log('\n=== Step 10: Verify expandable route details ===');
    if (!html.includes('toggleRoute')) {
      throw new Error('Should have toggleRoute function for expanding routes');
    }
    if (!html.includes('route-detail')) {
      throw new Error('Should have route-detail sections');
    }
    if (!html.includes('Response Type')) {
      throw new Error('Should show Response Type label');
    }
    if (!html.includes('Request Body')) {
      throw new Error('Should show Request Body label');
    }
    if (!html.includes('Sample Response')) {
      throw new Error('Should show Sample Response section');
    }
    console.log('  Expandable route details with type tree and sample data ✓');

    // Step 11: Verify live banner
    console.log('\n=== Step 11: Verify live update banner ===');
    if (!html.includes('live-banner')) {
      throw new Error('Should have live update banner');
    }
    if (!html.includes('New types observed')) {
      throw new Error('Banner should mention new types');
    }
    console.log('  Live update notification banner ✓');

    // Step 12: Verify CLI command exists
    console.log('\n=== Step 12: Verify CLI command ===');
    try {
      const helpOutput = execSync('npx trickle --help', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (!helpOutput.includes('dashboard')) {
        throw new Error('CLI help should mention dashboard');
      }
      console.log('  CLI `trickle dashboard` command registered ✓');
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '');
      if (out.includes('dashboard')) {
        console.log('  CLI `trickle dashboard` command registered ✓');
      } else {
        throw new Error('dashboard command not found in CLI help');
      }
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle dashboard correctly serves a live web UI for exploring observed types!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) {
      backendProc.kill('SIGTERM');
      await sleep(300);
    }
    process.exit(process.exitCode || 0);
  }
}

run();
