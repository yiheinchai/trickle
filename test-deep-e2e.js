/**
 * E2E test: Deep function observation
 *
 * Verifies that trickle observes ALL functions in user code:
 * 1. Functions defined in the entry file (not in any module)
 * 2. Non-exported helper functions inside modules
 * 3. Exported functions (existing behavior)
 *
 * Previously, trickle only observed functions that were exported via
 * module.exports. Now it also patches Module._compile to transform source
 * code and wrap function declarations.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACKEND_PORT = 4888;
const CLI = path.resolve('packages/cli/dist/index.js');

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

function runCmd(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (process.env.TRICKLE_DEBUG) process.stdout.write(`[out] ${d}`);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (process.env.TRICKLE_DEBUG) process.stderr.write(`[err] ${d}`);
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    setTimeout(() => reject(new Error('Timed out')), 60000);
  });
}

async function resetDb() {
  const dbPath = path.join(os.homedir(), '.trickle', 'trickle.db');
  try { fs.unlinkSync(dbPath); } catch {}
  await sleep(1000);
}

async function run() {
  let backendProc = null;

  try {
    // === Setup ===
    console.log('=== Step 1: Start backend ===');
    await resetDb();

    backendProc = spawn('node', ['packages/backend/dist/index.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProc.stdout.on('data', (d) => {
      if (process.env.TRICKLE_DEBUG) process.stdout.write(`[backend] ${d}`);
    });
    backendProc.stderr.on('data', () => {});
    await waitForServer(BACKEND_PORT);
    console.log('  Backend running ✓');

    // === Test: Run the deep observation app ===
    console.log('\n=== Step 2: trickle run test-deep-app.js ===');

    const { stdout: runOut } = await runCmd('node', [
      CLI,
      'run',
      'test-deep-app.js',
    ]);

    // Verify the app ran
    if (runOut.includes('Done!') || runOut.includes('Functions observed')) {
      console.log('  App ran successfully ✓');
    } else {
      throw new Error('App did not complete');
    }

    // Wait for flush
    await sleep(2000);

    // === Verify: Check captured functions ===
    console.log('\n=== Step 3: Verify captured functions ===');

    const resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    const data = await resp.json();
    const functions = data.functions;

    console.log(`  Total functions captured: ${functions.length}`);

    if (functions.length === 0) {
      throw new Error('No functions captured!');
    }

    // List all captured function names for debugging
    const capturedNames = functions.map(f => `${f.function_name} [${f.module}]`);
    console.log(`  Functions: ${capturedNames.join(', ')}`);

    // === Verify entry file functions ===
    console.log('\n=== Step 4: Verify entry file functions ===');

    const validateEmail = functions.find(f => f.function_name === 'validateEmail');
    if (validateEmail) {
      console.log(`  validateEmail (entry file) captured ✓ [module: ${validateEmail.module}]`);
    } else {
      throw new Error('Entry file function "validateEmail" NOT captured! Deep observation may have failed.');
    }

    const summarizeUsers = functions.find(f => f.function_name === 'summarizeUsers');
    if (summarizeUsers) {
      console.log(`  summarizeUsers (entry file) captured ✓ [module: ${summarizeUsers.module}]`);
    } else {
      throw new Error('Entry file function "summarizeUsers" NOT captured!');
    }

    // === Verify non-exported helper functions ===
    console.log('\n=== Step 5: Verify non-exported helper functions ===');

    const formatName = functions.find(f => f.function_name === 'formatName');
    if (formatName) {
      console.log(`  formatName (non-exported) captured ✓ [module: ${formatName.module}]`);
    } else {
      throw new Error('Non-exported function "formatName" NOT captured! Deep observation may have failed.');
    }

    const clampAge = functions.find(f => f.function_name === 'clampAge');
    if (clampAge) {
      console.log(`  clampAge (non-exported) captured ✓ [module: ${clampAge.module}]`);
    } else {
      throw new Error('Non-exported function "clampAge" NOT captured!');
    }

    // === Verify exported functions still work ===
    console.log('\n=== Step 6: Verify exported functions still captured ===');

    const createUser = functions.find(f => f.function_name === 'createUser');
    if (createUser) {
      console.log(`  createUser (exported) captured ✓`);
    } else {
      throw new Error('Exported function "createUser" NOT captured!');
    }

    const processUsers = functions.find(f => f.function_name === 'processUsers');
    if (processUsers) {
      console.log(`  processUsers (exported) captured ✓`);
    } else {
      throw new Error('Exported function "processUsers" NOT captured!');
    }

    // === Verify type data for entry file function ===
    console.log('\n=== Step 7: Verify type snapshots ===');

    const typeResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${validateEmail.id}`);
    const typeData = await typeResp.json();

    if (typeData.snapshots && typeData.snapshots.length > 0) {
      const snap = typeData.snapshots[0];
      const retType = snap.return_type;
      if (retType && retType.kind === 'object') {
        const props = Object.keys(retType.properties || {});
        if (props.includes('valid') && props.includes('local') && props.includes('domain')) {
          console.log('  validateEmail return type: { valid, local, domain } ✓');
        } else {
          console.log(`  validateEmail return type props: ${props.join(', ')}`);
        }
      }
    } else {
      throw new Error('No type snapshots for validateEmail!');
    }

    // Verify formatName type (non-exported)
    const fmtResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${formatName.id}`);
    const fmtData = await fmtResp.json();

    if (fmtData.snapshots && fmtData.snapshots.length > 0) {
      const snap = fmtData.snapshots[0];
      if (snap.return_type && snap.return_type.kind === 'string') {
        console.log('  formatName return type: string ✓');
      }
    }

    // === Verify summary shows inline type signatures ===
    console.log('\n=== Step 8: Verify summary output ===');

    if (runOut.includes('validateEmail') || runOut.includes('summarizeUsers')) {
      console.log('  Summary shows entry file functions ✓');
    }

    if (runOut.includes('formatName') || runOut.includes('clampAge')) {
      console.log('  Summary shows non-exported functions ✓');
    }

    if (runOut.includes('→') || runOut.includes('->')) {
      console.log('  Summary shows inline type signatures ✓');
    }

    // === Verify existing tests still pass ===
    console.log('\n=== Step 9: Verify backward compatibility ===');

    // Reset DB
    backendProc.kill('SIGTERM');
    await sleep(1000);
    await resetDb();
    backendProc = spawn('node', ['packages/backend/dist/index.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProc.stdout.on('data', () => {});
    backendProc.stderr.on('data', () => {});
    await waitForServer(BACKEND_PORT);

    // Run existing test-annotate-app.js
    const { stdout: compatOut } = await runCmd('node', [
      CLI,
      'run',
      'test-annotate-app.js',
    ]);

    if (compatOut.includes('Done!')) {
      console.log('  Existing test-annotate-app.js still works ✓');
    } else {
      throw new Error('Backward compatibility broken!');
    }

    // Verify it captured the expected functions
    if (compatOut.includes('parseConfig')) {
      console.log('  parseConfig still captured ✓');
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('Deep function observation works end-to-end!\n');

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
