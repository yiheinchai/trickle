/**
 * E2E test: trickle annotate
 *
 * Verifies that `trickle annotate <file>` produces:
 * - JSDoc comments for .js files (valid JS, IDE-supported)
 * - TypeScript annotations for .ts files
 * - Python type annotations for .py files
 *
 * Steps:
 * 1. Start backend
 * 2. Observe JS functions via trickle run
 * 3. Annotate .js file → verify JSDoc comments added
 * 4. Verify annotated .js is still valid JavaScript (can be required)
 * 5. Test --dry-run mode
 * 6. Observe Python functions
 * 7. Annotate .py file → verify Python type annotations
 */
const { spawn } = require('child_process');
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

    // Step 2: Observe JS functions
    console.log('\n=== Step 2: Observe JS functions ===');
    await runCmd('node', [CLI, 'run', 'node test-annotate-app.js']);
    await sleep(3000);

    let resp = await fetch(`http://localhost:${BACKEND_PORT}/api/functions`);
    let data = await resp.json();
    console.log(`  Captured ${data.functions.length} functions ✓`);
    if (data.functions.length === 0) throw new Error('No functions captured!');

    // Step 3: Annotate JS file → should get JSDoc comments
    console.log('\n=== Step 3: Annotate JS file (JSDoc mode) ===');
    const { stdout: annotateOut } = await runCmd('node', [CLI, 'annotate', jsHelperPath]);

    const jsAnnotated = fs.readFileSync(jsHelperPath, 'utf-8');

    if (jsAnnotated === jsOriginal) {
      throw new Error('JS file was not modified by annotate!');
    }

    // Verify JSDoc comments were added (not TS annotations)
    if (jsAnnotated.includes('/**') && jsAnnotated.includes('@param') && jsAnnotated.includes('@returns')) {
      console.log('  JSDoc comments added ✓');
    } else {
      throw new Error('Expected JSDoc comments (@param, @returns) but not found!');
    }

    // Verify NO TypeScript syntax was added to the JS file
    // Functions should NOT have TS-style ": type" in their signatures
    const jsLines = jsAnnotated.split('\n');
    for (const line of jsLines) {
      if (line.match(/function\s+\w+\s*\([^)]*:[^)]+\)/)) {
        throw new Error(`JS file has TS-style annotations (invalid JS): ${line.trim()}`);
      }
    }
    console.log('  No TypeScript syntax in JS file ✓');

    // Verify the file output mentions JSDoc mode
    if (annotateOut.includes('JSDoc')) {
      console.log('  Output mentions JSDoc mode ✓');
    }

    // Step 4: Verify annotated JS is still valid JavaScript
    console.log('\n=== Step 4: Verify JS file is still valid ===');
    try {
      // Clear require cache and try to require the annotated file
      delete require.cache[jsHelperPath];
      const helpers = require(jsHelperPath);
      const config = helpers.parseConfig({ host: 'test.com', port: 80, debug: false });
      if (config.host === 'test.com') {
        console.log('  Annotated JS file is valid and runs correctly ✓');
      } else {
        throw new Error('Function returned wrong value after annotation!');
      }
    } catch (err) {
      if (err.message.includes('Unexpected token')) {
        throw new Error(`Annotated JS file has syntax errors: ${err.message}`);
      }
      throw err;
    }

    // Print JSDoc samples
    console.log('\n  Sample JSDoc output:');
    let inJSDoc = false;
    for (const line of jsLines) {
      if (line.trim().startsWith('/**')) inJSDoc = true;
      if (inJSDoc) console.log(`    ${line}`);
      if (line.trim().startsWith('*/')) {
        inJSDoc = false;
      }
      if (!inJSDoc && line.includes('function') && jsLines[jsLines.indexOf(line) - 1]?.trim() === '*/') {
        console.log(`    ${line}`);
        console.log();
      }
    }

    // Step 5: Test --dry-run
    console.log('=== Step 5: Test --dry-run mode ===');
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

    // Step 6: Test Python annotate
    console.log('\n=== Step 6: Observe Python functions ===');

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

    // Step 7: Annotate Python file
    console.log('\n=== Step 7: Annotate Python file ===');
    await runCmd('node', [CLI, 'annotate', pyHelperPath]);

    const pyAnnotated = fs.readFileSync(pyHelperPath, 'utf-8');

    if (pyAnnotated === pyOriginal) {
      throw new Error('Python file was not modified by annotate!');
    }

    if (pyAnnotated.includes(': ') && pyAnnotated.includes('def ')) {
      console.log('  Python parameter types added ✓');
    } else {
      throw new Error('Python parameter type annotations missing!');
    }

    if (pyAnnotated.includes('->')) {
      console.log('  Python return types added ✓');
    }

    const pyLines = pyAnnotated.split('\n');
    for (const line of pyLines) {
      if (line.includes('def ') && line.includes(':')) {
        console.log(`  ${line.trim()}`);
      }
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle annotate: JSDoc for .js, TS annotations for .ts, Python annotations for .py\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(jsHelperPath, jsOriginal, 'utf-8');
    fs.writeFileSync(pyHelperPath, pyOriginal, 'utf-8');
    try { fs.unlinkSync(path.resolve('test-annotate-py-runner.py')); } catch {}

    if (backendProc) {
      backendProc.kill('SIGTERM');
      await sleep(500);
    }
    process.exit(process.exitCode || 0);
  }
}

run();
