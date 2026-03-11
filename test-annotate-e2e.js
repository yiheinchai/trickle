/**
 * E2E test: trickle annotate
 *
 * Verifies that `trickle annotate <file>` adds runtime-observed type
 * annotations directly into source files for both JS and Python.
 *
 * Steps:
 * 1. Start backend
 * 2. Run JS app via trickle run to observe types
 * 3. Run trickle annotate on JS helper file — verify types inserted
 * 4. Run Python app via trickle run to observe types
 * 5. Run trickle annotate on Python helper file — verify types inserted
 * 6. Test --dry-run mode
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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
      else reject(new Error(`Command exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });

    setTimeout(() => reject(new Error('Command timed out')), 30000);
  });
}

async function resetDb() {
  const dbPath = path.join(require('os').homedir(), '.trickle', 'trickle.db');
  try { fs.unlinkSync(dbPath); } catch {}
  await sleep(1000);
}

async function run() {
  let backendProc = null;

  // Save original files for restoration
  const jsHelperPath = path.resolve('test-annotate-helpers.js');
  const pyHelperPath = path.resolve('test-annotate-helpers.py');
  const jsOriginal = fs.readFileSync(jsHelperPath, 'utf-8');
  const pyOriginal = fs.readFileSync(pyHelperPath, 'utf-8');

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = spawn('node', ['packages/backend/dist/index.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProc.stdout.on('data', (d) => {
      if (process.env.TRICKLE_DEBUG) process.stdout.write(`[backend] ${d}`);
    });
    backendProc.stderr.on('data', (d) => {
      if (process.env.TRICKLE_DEBUG) process.stderr.write(`[backend-err] ${d}`);
    });

    await waitForServer(BACKEND_PORT);
    console.log('  Backend running ✓');

    // Step 2: Observe JS functions via trickle run
    console.log('\n=== Step 2: Observe JS functions ===');
    await runCmd('node', [CLI, 'run', 'node test-annotate-app.js']);
    await sleep(3000);

    // Verify functions captured
    let resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    let data = await resp.json();
    console.log(`  Captured ${data.functions.length} functions ✓`);

    if (data.functions.length === 0) {
      throw new Error('No functions captured!');
    }

    // Step 3: Annotate JS file
    console.log('\n=== Step 3: Annotate JS file ===');
    await runCmd('node', [CLI, 'annotate', jsHelperPath]);

    const jsAnnotated = fs.readFileSync(jsHelperPath, 'utf-8');

    // Verify JS annotations added
    if (jsAnnotated === jsOriginal) {
      throw new Error('JS file was not modified by annotate!');
    }

    // Check that type annotations were added to at least one function
    const jsHasTypes = jsAnnotated.includes(':') && (
      jsAnnotated.includes('function parseConfig') ||
      jsAnnotated.includes('function processItems') ||
      jsAnnotated.includes('function calculateTotal')
    );
    if (jsHasTypes) {
      console.log('  JS type annotations added ✓');
    } else {
      throw new Error('JS annotations missing type information!');
    }

    // Check return types
    if (jsAnnotated.includes('):')) {
      console.log('  JS return types added ✓');
    }

    // Print sample of annotated functions
    const jsLines = jsAnnotated.split('\n');
    for (const line of jsLines) {
      if (line.includes('function') && line.includes(':')) {
        console.log(`  ${line.trim()}`);
      }
    }

    // Step 4: Test --dry-run (restore file first, then dry-run)
    console.log('\n=== Step 4: Test --dry-run mode ===');
    fs.writeFileSync(jsHelperPath, jsOriginal, 'utf-8');

    const { stdout: dryOut } = await runCmd('node', [CLI, 'annotate', jsHelperPath, '--dry-run']);
    const jsAfterDryRun = fs.readFileSync(jsHelperPath, 'utf-8');

    if (jsAfterDryRun === jsOriginal) {
      console.log('  --dry-run did not modify file ✓');
    } else {
      throw new Error('--dry-run modified the file!');
    }

    if (dryOut.includes('Dry run') || dryOut.includes('would be annotated')) {
      console.log('  --dry-run output correct ✓');
    }

    // Step 5: Test Python annotate
    console.log('\n=== Step 5: Observe Python functions ===');

    // Reset DB and restart backend for clean Python test
    backendProc.kill('SIGTERM');
    await sleep(1000);
    await resetDb();

    backendProc = spawn('node', ['packages/backend/dist/index.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProc.stdout.on('data', () => {});
    backendProc.stderr.on('data', () => {});
    await waitForServer(BACKEND_PORT);
    console.log('  Backend restarted with clean DB ✓');

    // Run Python app with explicit observe
    const pyExplicitScript = `
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname("${path.resolve('.')}"), "packages", "client-python", "src"))
sys.path.insert(0, "${path.resolve('.')}")
from trickle import observe, configure
configure(backend_url="http://localhost:${BACKEND_PORT}")
import test_annotate_helpers as raw
helpers = observe(raw, module="annotate-test")
config = helpers.parse_config({"host": "api.example.com", "port": 8080, "debug": True})
items = helpers.process_items([{"id": 1, "name": "foo"}, {"id": 2, "name": "bar"}])
totals = helpers.calculate_total([10.5, 20.0, 5.25], 0.1)
import time; time.sleep(3)
print("Done!")
`;

    const pyScriptPath = path.resolve('test-annotate-py-runner.py');
    fs.writeFileSync(pyScriptPath, pyExplicitScript, 'utf-8');

    const PYTHONPATH = [
      path.resolve('packages/client-python/src'),
      path.resolve('.'),
    ].join(':');

    await runCmd('python3', [pyScriptPath], {
      PYTHONPATH,
      TRICKLE_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
    });
    await sleep(3000);

    resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    data = await resp.json();
    console.log(`  Captured ${data.functions.length} Python functions ✓`);

    // Step 6: Annotate Python file
    console.log('\n=== Step 6: Annotate Python file ===');
    await runCmd('node', [CLI, 'annotate', pyHelperPath]);

    const pyAnnotated = fs.readFileSync(pyHelperPath, 'utf-8');

    if (pyAnnotated === pyOriginal) {
      throw new Error('Python file was not modified by annotate!');
    }

    // Check Python type annotations
    const pyHasParamTypes = pyAnnotated.includes(': ') && pyAnnotated.includes('def ');
    const pyHasReturnTypes = pyAnnotated.includes('->');

    if (pyHasParamTypes) {
      console.log('  Python parameter types added ✓');
    } else {
      throw new Error('Python parameter type annotations missing!');
    }

    if (pyHasReturnTypes) {
      console.log('  Python return types added ✓');
    }

    // Print sample
    const pyLines = pyAnnotated.split('\n');
    for (const line of pyLines) {
      if (line.includes('def ') && line.includes(':')) {
        console.log(`  ${line.trim()}`);
      }
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle annotate works end-to-end for JS and Python!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    // Restore original files
    fs.writeFileSync(jsHelperPath, jsOriginal, 'utf-8');
    fs.writeFileSync(pyHelperPath, pyOriginal, 'utf-8');
    // Clean up runner script
    try { fs.unlinkSync(path.resolve('test-annotate-py-runner.py')); } catch {}

    if (backendProc) {
      backendProc.kill('SIGTERM');
      await sleep(500);
    }
    process.exit(process.exitCode || 0);
  }
}

run();
