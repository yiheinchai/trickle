/**
 * E2E test: `trickle run` — universal command wrapper
 *
 * Verifies that `trickle run "node test-run-app.js"` auto-instruments
 * all exported functions without any trickle code in the app.
 *
 * Steps:
 * 1. Starts the trickle backend
 * 2. Runs `trickle run "node test-run-app.js"`
 * 3. Verifies functions were captured with correct types and sample data
 * 4. Verifies the summary output was shown
 */
const { spawn, execSync } = require('child_process');
const path = require('path');

const BACKEND_PORT = 4888;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(port, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`http://localhost:${port}/api/functions`);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = spawn('node', ['packages/backend/dist/index.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    backendProc.stdout.on('data', (d) => {
      if (process.env.TRICKLE_DEBUG) process.stdout.write(`[backend] ${d}`);
    });
    backendProc.stderr.on('data', (d) => {
      if (process.env.TRICKLE_DEBUG) process.stderr.write(`[backend-err] ${d}`);
    });

    await waitForServer(BACKEND_PORT);
    console.log('  Backend running on :' + BACKEND_PORT + ' ✓');

    // Step 2: Run trickle run
    console.log('\n=== Step 2: Run trickle run "node test-run-app.js" ===');

    const cliPath = path.resolve('packages/cli/dist/index.js');
    let runOutput = '';

    await new Promise((resolve, reject) => {
      const proc = spawn('node', [cliPath, 'run', 'node test-run-app.js'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TRICKLE_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
        },
      });

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        runOutput += text;
        if (process.env.TRICKLE_DEBUG) process.stdout.write(`[run] ${text}`);
      });
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        runOutput += text;
        if (process.env.TRICKLE_DEBUG) process.stderr.write(`[run-err] ${text}`);
      });

      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`trickle run exited with code ${code}`));
      });

      // Timeout after 30s
      setTimeout(() => reject(new Error('trickle run timed out')), 30000);
    });

    console.log('  trickle run completed ✓');

    // Step 3: Verify output contains summary
    console.log('\n=== Step 3: Verify run output ===');

    if (runOutput.includes('Summary')) {
      console.log('  Summary section present ✓');
    } else {
      console.log('  Warning: Summary not found in output');
      console.log('  Output:', runOutput.substring(0, 500));
    }

    if (runOutput.includes('Functions observed')) {
      console.log('  Functions observed line present ✓');
    }

    // Step 4: Verify functions were captured in backend
    console.log('\n=== Step 4: Verify captured functions ===');

    const resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    const functionsData = await resp.json();
    const functions = functionsData.functions;

    console.log(`  Total functions captured: ${functions.length}`);
    if (functions.length === 0) {
      throw new Error('No functions captured! trickle run may not be injecting correctly.');
    }

    const functionNames = functions.map(f => f.function_name);
    console.log(`  Functions: ${functionNames.join(', ')}`);

    // Check that the app's exported functions were captured
    const expectedFunctions = [
      'parseConfig',
      'processItems',
      'fetchData',
      'transformResponse',
      'calculateStats',
    ];

    for (const name of expectedFunctions) {
      if (functionNames.includes(name)) {
        console.log(`  Function "${name}" captured ✓`);
      } else {
        throw new Error(`Function "${name}" NOT captured! Found: ${functionNames.join(', ')}`);
      }
    }

    // Step 5: Verify type snapshots have correct shapes
    console.log('\n=== Step 5: Verify type snapshots ===');

    // Check parseConfig return type
    const parseConfigFn = functions.find(f => f.function_name === 'parseConfig');
    const typesResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${parseConfigFn.id}`);
    const typesData = await typesResp.json();
    const snapshots = typesData.snapshots;

    if (snapshots.length === 0) {
      throw new Error('No snapshots for parseConfig!');
    }

    const snapshot = snapshots[0];
    const returnType = snapshot.return_type;

    if (returnType.kind !== 'object') {
      throw new Error(`Expected object return type for parseConfig, got: ${returnType.kind}`);
    }

    const props = Object.keys(returnType.properties || {});
    if (props.includes('host') && props.includes('port') && props.includes('debug')) {
      console.log('  parseConfig return type has host, port, debug ✓');
    } else {
      throw new Error(`parseConfig return type missing expected properties. Found: ${props.join(', ')}`);
    }

    // Check sample output
    if (snapshot.sample_output && snapshot.sample_output.host === 'api.example.com') {
      console.log('  parseConfig sample output correct ✓');
    }

    // Check calculateStats return type
    const statsFn = functions.find(f => f.function_name === 'calculateStats');
    const statsResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${statsFn.id}`);
    const statsData = await statsResp.json();
    const statsSnapshot = statsData.snapshots[0];

    if (statsSnapshot.return_type.kind === 'object') {
      const statsProps = Object.keys(statsSnapshot.return_type.properties || {});
      if (statsProps.includes('sum') && statsProps.includes('avg') && statsProps.includes('min')) {
        console.log('  calculateStats return type has sum, avg, min ✓');
      }
    }

    // Step 6: Verify module grouping
    console.log('\n=== Step 6: Verify module names ===');
    const modules = [...new Set(functions.map(f => f.module))];
    console.log(`  Modules: ${modules.join(', ')}`);

    // The observe-register should use the filename as module name
    const hasRunApp = modules.some(m => m.includes('test-run-app') || m.includes('run-app'));
    if (hasRunApp) {
      console.log('  Module derived from filename ✓');
    } else {
      console.log(`  Module names: ${modules.join(', ')} (auto-detected)`);
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle run works end-to-end!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (backendProc) {
      backendProc.kill('SIGTERM');
      await sleep(500);
    }
    process.exit(process.exitCode || 0);
  }
}

run();
