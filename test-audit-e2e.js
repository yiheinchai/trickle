/**
 * E2E test: `trickle audit` — API quality audit
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest clean routes (no issues)
 * 3. Verify clean audit (no issues)
 * 4. Ingest route with sensitive data in response
 * 5. Verify sensitive-data error detected
 * 6. Ingest route with oversized response (>15 fields)
 * 7. Verify oversized-response warning detected
 * 8. Ingest route with mixed naming (camelCase + snake_case)
 * 9. Verify inconsistent-naming warning detected
 * 10. Verify --json output format
 * 11. Verify --fail-on-error exits with code 1
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

async function ingestRoute(method, routePath, argsType, returnType) {
  const typeHash = makeTypeHash(argsType, returnType);
  await fetch('http://localhost:4888/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      functionName: `${method} ${routePath}`,
      module: 'api',
      language: 'js',
      environment: 'development',
      typeHash,
      argsType,
      returnType,
    }),
  });
}

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Ingest a clean route
    console.log('\n=== Step 2: Ingest clean route ===');
    await ingestRoute('GET', '/api/products',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          items: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
                price: { kind: 'primitive', name: 'number' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );
    await sleep(300);
    console.log('  Clean route ingested ✓');

    // Step 3: Verify clean audit
    console.log('\n=== Step 3: Verify clean audit ===');
    const cleanRes = await fetch('http://localhost:4888/api/audit');
    const cleanData = await cleanRes.json();
    if (cleanData.summary.errors !== 0) {
      throw new Error(`Expected 0 errors on clean route, got ${cleanData.summary.errors}`);
    }
    if (cleanData.summary.routesAnalyzed !== 1) {
      throw new Error(`Expected 1 route analyzed, got ${cleanData.summary.routesAnalyzed}`);
    }
    console.log('  Clean audit: 0 errors, 0 warnings ✓');

    // Step 4: Ingest route with sensitive data in response
    console.log('\n=== Step 4: Ingest route with sensitive data ===');
    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          name: { kind: 'primitive', name: 'string' },
          email: { kind: 'primitive', name: 'string' },
          password: { kind: 'primitive', name: 'string' },
          apiKey: { kind: 'primitive', name: 'string' },
        },
      },
    );
    await sleep(300);
    console.log('  Route with password and apiKey fields ingested ✓');

    // Step 5: Verify sensitive data detection
    console.log('\n=== Step 5: Verify sensitive-data errors ===');
    const sensitiveRes = await fetch('http://localhost:4888/api/audit');
    const sensitiveData = await sensitiveRes.json();
    const sensitiveIssues = sensitiveData.issues.filter(i => i.rule === 'sensitive-data');
    if (sensitiveIssues.length < 2) {
      throw new Error(`Expected at least 2 sensitive-data issues, got ${sensitiveIssues.length}`);
    }
    const hasPassword = sensitiveIssues.some(i => i.field === 'password');
    const hasApiKey = sensitiveIssues.some(i => i.field === 'apiKey');
    if (!hasPassword || !hasApiKey) {
      throw new Error('Expected password and apiKey to be flagged');
    }
    if (sensitiveIssues[0].severity !== 'error') {
      throw new Error('Sensitive data should be severity "error"');
    }
    console.log(`  ${sensitiveIssues.length} sensitive-data errors detected (password, apiKey) ✓`);

    // Step 6: Ingest oversized response
    console.log('\n=== Step 6: Ingest oversized response ===');
    const bigProps = {};
    for (let i = 0; i < 20; i++) {
      bigProps[`field${i}`] = { kind: 'primitive', name: 'string' };
    }
    await ingestRoute('GET', '/api/reports',
      { kind: 'object', properties: {} },
      { kind: 'object', properties: bigProps },
    );
    await sleep(300);
    console.log('  Route with 20 fields ingested ✓');

    // Step 7: Verify oversized response warning
    console.log('\n=== Step 7: Verify oversized-response warning ===');
    const oversizedRes = await fetch('http://localhost:4888/api/audit');
    const oversizedData = await oversizedRes.json();
    const oversizedIssues = oversizedData.issues.filter(i => i.rule === 'oversized-response');
    if (oversizedIssues.length === 0) {
      throw new Error('Expected oversized-response warning');
    }
    if (oversizedIssues[0].severity !== 'warning') {
      throw new Error('Oversized response should be severity "warning"');
    }
    if (!oversizedIssues[0].message.includes('20')) {
      throw new Error('Should mention 20 fields');
    }
    console.log('  Oversized response (20 fields) warning detected ✓');

    // Step 8: Ingest route with mixed naming
    console.log('\n=== Step 8: Ingest route with mixed naming ===');
    await ingestRoute('GET', '/api/orders',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          orderId: { kind: 'primitive', name: 'number' },
          order_status: { kind: 'primitive', name: 'string' },
          customerName: { kind: 'primitive', name: 'string' },
          delivery_date: { kind: 'primitive', name: 'string' },
        },
      },
    );
    await sleep(300);
    console.log('  Route with mixed camelCase/snake_case ingested ✓');

    // Step 9: Verify naming inconsistency
    console.log('\n=== Step 9: Verify inconsistent-naming warning ===');
    const namingRes = await fetch('http://localhost:4888/api/audit');
    const namingData = await namingRes.json();
    const namingIssues = namingData.issues.filter(i => i.rule === 'inconsistent-naming');
    if (namingIssues.length === 0) {
      throw new Error('Expected inconsistent-naming warning');
    }
    if (!namingIssues[0].message.includes('camelCase') || !namingIssues[0].message.includes('snake_case')) {
      throw new Error('Should mention camelCase and snake_case');
    }
    console.log('  Mixed naming warning detected ✓');

    // Step 10: Verify --json CLI output
    console.log('\n=== Step 10: Verify --json output format ===');
    const jsonOutput = execSync(
      'npx trickle audit --json',
      { encoding: 'utf-8', env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' } },
    );
    const parsed = JSON.parse(jsonOutput.trim());
    if (!parsed.summary || !parsed.issues || !Array.isArray(parsed.issues)) {
      throw new Error('Expected JSON with summary and issues array');
    }
    if (parsed.summary.routesAnalyzed !== 4) {
      throw new Error(`Expected 4 routes analyzed, got ${parsed.summary.routesAnalyzed}`);
    }
    if (parsed.summary.errors < 2) {
      throw new Error(`Expected at least 2 errors (sensitive data), got ${parsed.summary.errors}`);
    }
    console.log(`  JSON output: ${parsed.summary.total} issues, ${parsed.summary.routesAnalyzed} routes ✓`);

    // Step 11: Verify --fail-on-error exits with code 1
    console.log('\n=== Step 11: Verify --fail-on-error exit code ===');
    try {
      execSync(
        'npx trickle audit --json --fail-on-error',
        { encoding: 'utf-8', env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' } },
      );
      throw new Error('Should have exited with code 1');
    } catch (e) {
      if (e.message === 'Should have exited with code 1') throw e;
      if (e.status !== 1) {
        throw new Error(`Expected exit code 1, got ${e.status}`);
      }
    }
    console.log('  --fail-on-error correctly exits with code 1 ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle audit detects API quality issues from observed types!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
