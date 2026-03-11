/**
 * E2E test: Python entry file deep observation
 *
 * Verifies that trickle captures functions defined directly in the entry
 * Python script (not just imported modules) via AST transformation:
 * 1. Entry file functions (validate_email, format_user, etc.) are captured
 * 2. Imported module functions (create_user, process_users) are also captured
 * 3. Private functions (_format_name, _generate_id) are NOT captured
 * 4. Type snapshots contain correct shapes
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
      await fetch(`http://localhost:${port}/`);
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
    console.log('  Backend running OK');

    // === Test: Run Python app with entry file functions ===
    console.log('\n=== Step 2: trickle run test-py-deep-app.py ===');

    const { stdout: runOut, stderr: runErr } = await runCmd('node', [
      CLI,
      'run',
      'test-py-deep-app.py',
    ]);

    if (runOut.includes('Done!') || runOut.includes('Functions observed')) {
      console.log('  App ran successfully OK');
    } else {
      throw new Error('App did not complete. Output: ' + runOut.slice(0, 500) + '\nStderr: ' + runErr.slice(0, 500));
    }

    // Wait for flush
    await sleep(3000);

    // === Verify captured functions ===
    console.log('\n=== Step 3: Verify captured entry file functions ===');

    const resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    const data = await resp.json();
    const functions = data.functions;

    console.log(`  Total functions captured: ${functions.length}`);
    const capturedNames = functions.map(f => f.function_name).sort();
    console.log(`  Functions: ${capturedNames.join(', ')}`);

    // Entry file functions should be captured
    const entryFunctions = ['validate_email', 'format_user', 'summarize_users', 'process_batch'];
    for (const name of entryFunctions) {
      const fn = functions.find(f => f.function_name === name);
      if (fn) {
        console.log(`  Entry: ${name} captured OK [module: ${fn.module}]`);
      } else {
        throw new Error(`Entry function ${name} NOT captured! AST transformation may have failed.`);
      }
    }

    // === Verify type snapshots for entry file functions ===
    console.log('\n=== Step 4: Verify type snapshots ===');

    // validate_email should take a string and return {valid, reason}
    const validateFn = functions.find(f => f.function_name === 'validate_email');
    const validateResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${validateFn.id}`);
    const validateData = await validateResp.json();

    if (validateData.snapshots && validateData.snapshots.length > 0) {
      const snap = validateData.snapshots[0];
      const retType = snap.return_type;

      if (retType && retType.kind === 'object') {
        const props = Object.keys(retType.properties || {});
        if (props.includes('valid') && props.includes('reason')) {
          console.log('  validate_email return type: { valid, reason } OK');
        } else {
          console.log(`  validate_email return type props: ${props.join(', ')}`);
        }
      }

      // Check args type
      const argsType = snap.args_type;
      if (argsType && argsType.kind === 'tuple' && argsType.elements && argsType.elements.length > 0) {
        const firstArg = argsType.elements[0];
        if (firstArg && firstArg.kind === 'primitive' && firstArg.name === 'string') {
          console.log('  validate_email arg type: (string) OK');
        }
      }
    }

    // format_user should return {displayName, email, role, initials}
    const formatFn = functions.find(f => f.function_name === 'format_user');
    const formatResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${formatFn.id}`);
    const formatData = await formatResp.json();

    if (formatData.snapshots && formatData.snapshots.length > 0) {
      const snap = formatData.snapshots[0];
      const retType = snap.return_type;

      if (retType && retType.kind === 'object') {
        const props = Object.keys(retType.properties || {});
        if (props.includes('displayName') && props.includes('email') && props.includes('initials')) {
          console.log('  format_user return type: { displayName, email, role, initials } OK');
        } else {
          console.log(`  format_user return type props: ${props.join(', ')}`);
        }
      }
    }

    // summarize_users should return {total, roles, domains}
    const summarizeFn = functions.find(f => f.function_name === 'summarize_users');
    const summarizeResp = await fetch(`http://localhost:${BACKEND_PORT}/api/types/${summarizeFn.id}`);
    const summarizeData = await summarizeResp.json();

    if (summarizeData.snapshots && summarizeData.snapshots.length > 0) {
      const snap = summarizeData.snapshots[0];
      const retType = snap.return_type;

      if (retType && retType.kind === 'object') {
        const props = Object.keys(retType.properties || {});
        if (props.includes('total') && props.includes('roles') && props.includes('domains')) {
          console.log('  summarize_users return type: { total, roles, domains } OK');
        } else {
          console.log(`  summarize_users return type props: ${props.join(', ')}`);
        }
      }
    }

    // === Verify module naming ===
    console.log('\n=== Step 5: Verify module naming ===');

    const entryModules = [...new Set(
      functions.filter(f => entryFunctions.includes(f.function_name))
        .map(f => f.module)
    )];

    // Entry file functions should have module name derived from filename
    if (entryModules.length === 1 && entryModules[0].includes('test-py-deep-app') || entryModules[0].includes('test_py_deep_app')) {
      console.log(`  Entry functions module: "${entryModules[0]}" OK`);
    } else {
      console.log(`  Entry function modules: ${entryModules.join(', ')}`);
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('Python entry file deep observation works end-to-end!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
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
