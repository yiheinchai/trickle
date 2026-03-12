/**
 * E2E test: IPython/Jupyter integration for trickle.auto
 *
 * Verifies that trickle.auto works inside IPython:
 * 1. Detects IPython environment and registers cell hooks
 * 2. Observes functions from imported modules
 * 3. Observes functions defined interactively (in cells)
 * 4. Generates types after each cell execution
 * 5. Prints type summaries after cells with new types
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function cleanup() {
  const files = [
    '.trickle/observations.jsonl',
    '.trickle/type-snapshot.json',
    'test_jupyter_lib.pyi',
    '__interactive__.pyi',
  ];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function run() {
  try {
    cleanup();

    // ── Step 1: Test that trickle.auto detects IPython ──
    console.log('\n=== Step 1: Detect IPython environment ===');

    // Run a simple IPython command that imports trickle.auto
    const detectResult = execSync(
      `ipython --no-banner --colors=NoColor -c "import trickle.auto"`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: 'packages/client-python/src:.',
        },
        timeout: 30000,
      }
    );

    assert(
      detectResult.includes('[trickle.auto] Active in IPython'),
      'Detects IPython environment'
    );

    cleanup();

    // ── Step 2: Test imported module observation in IPython ──
    console.log('\n=== Step 2: Observe imported module functions ===');

    // IPython -c runs code as a single "cell" — the post_run_cell
    // hook fires after the cell completes
    const importResult = execSync(
      `ipython --no-banner --colors=NoColor -c "
import trickle.auto
from test_jupyter_lib import analyze_data, format_report
result = analyze_data([10, 20, 30, 40, 50])
report = format_report('Sales', result)
print('RESULT:', result)
print('REPORT:', report['summary'])
"`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: 'packages/client-python/src:.',
        },
        timeout: 30000,
      }
    );

    console.log('  IPython output:');
    importResult.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(importResult.includes('RESULT:'), 'analyze_data executed successfully');
    assert(importResult.includes('REPORT: Sales:'), 'format_report executed successfully');
    assert(importResult.includes('[trickle.auto] Active in IPython'), 'IPython detection message shown');

    // Check that type summary was printed (auto-enabled in IPython mode)
    assert(
      importResult.includes('Discovered types') || importResult.includes('function type(s) observed'),
      'Type summary or observation count shown after cell'
    );

    // Check .pyi was generated for the imported module
    assert(
      fs.existsSync('test_jupyter_lib.pyi'),
      'test_jupyter_lib.pyi generated for imported module'
    );

    const pyiContent = fs.readFileSync('test_jupyter_lib.pyi', 'utf8');
    console.log('\n  Generated test_jupyter_lib.pyi:');
    pyiContent.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(pyiContent.includes('def analyze_data'), '.pyi has analyze_data');
    assert(pyiContent.includes('def format_report'), '.pyi has format_report');

    cleanup();

    // ── Step 3: Test cell-defined function observation ──
    console.log('\n=== Step 3: Observe cell-defined functions ===');

    const cellResult = execSync(
      `ipython --no-banner --colors=NoColor -c "
import trickle.auto

def greet(name, greeting='Hello'):
    return {'message': greeting + ' ' + name, 'name': name}

def add_numbers(a, b):
    return {'sum': a + b, 'operands': [a, b]}

msg = greet('World')
result = add_numbers(3, 7)
print('GREET:', msg['message'])
print('SUM:', result['sum'])
"`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: 'packages/client-python/src:.',
        },
        timeout: 30000,
      }
    );

    console.log('  IPython output:');
    cellResult.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(cellResult.includes('GREET: Hello World'), 'Cell-defined greet() works');
    assert(cellResult.includes('SUM: 10'), 'Cell-defined add_numbers() works');

    // Check that observations were recorded in JSONL
    const jsonlPath = '.trickle/observations.jsonl';
    assert(fs.existsSync(jsonlPath), 'JSONL observations file exists');

    const observations = fs.readFileSync(jsonlPath, 'utf8')
      .trim().split('\n')
      .map(l => JSON.parse(l));

    const fnNames = observations.map(o => o.functionName);
    assert(fnNames.includes('greet'), 'greet observed in JSONL');
    assert(fnNames.includes('add_numbers'), 'add_numbers observed in JSONL');

    // Check module name for cell-defined functions
    const greetObs = observations.find(o => o.functionName === 'greet');
    assert(
      greetObs && greetObs.module === '__interactive__',
      'Cell-defined functions have __interactive__ module'
    );

    // Check __interactive__.pyi was generated
    assert(
      fs.existsSync('__interactive__.pyi'),
      '__interactive__.pyi generated for cell-defined functions'
    );

    const interactivePyi = fs.readFileSync('__interactive__.pyi', 'utf8');
    console.log('\n  Generated __interactive__.pyi:');
    interactivePyi.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(interactivePyi.includes('def greet'), '__interactive__.pyi has greet');
    assert(interactivePyi.includes('def add_numbers'), '__interactive__.pyi has add_numbers');

    cleanup();

    // ── Step 4: Test class method observation in IPython ──
    console.log('\n=== Step 4: Observe class methods from imported module ===');

    const classResult = execSync(
      `ipython --no-banner --colors=NoColor -c "
import trickle.auto
from test_jupyter_lib import DataProcessor
proc = DataProcessor()
norm = proc.normalize([10, 20, 30])
desc = proc.describe([5, 10, 15, 20])
print('NORMALIZED:', len(norm['normalized']), 'values')
print('RANGE:', desc['range'])
"`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: 'packages/client-python/src:.',
        },
        timeout: 30000,
      }
    );

    console.log('  IPython output:');
    classResult.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(classResult.includes('NORMALIZED: 3 values'), 'DataProcessor.normalize works');
    assert(classResult.includes('RANGE: 15'), 'DataProcessor.describe works');

    // Check .pyi has class stubs
    if (fs.existsSync('test_jupyter_lib.pyi')) {
      const classPyi = fs.readFileSync('test_jupyter_lib.pyi', 'utf8');
      assert(classPyi.includes('class DataProcessor'), '.pyi has DataProcessor class');
      assert(classPyi.includes('def normalize'), '.pyi has normalize method');
      assert(classPyi.includes('def describe'), '.pyi has describe method');
    }

    cleanup();

    // ── Step 5: Test multi-cell simulation ──
    console.log('\n=== Step 5: Multi-cell simulation (sequential -c calls) ===');

    // Simulate multiple cells by running IPython with exec'd code blocks
    const multiCellResult = execSync(
      `ipython --no-banner --colors=NoColor -c "
import trickle.auto
from test_jupyter_lib import analyze_data

# Cell 1: define and use a function
def transform(x):
    return {'doubled': x * 2, 'original': x}

r1 = transform(42)
print('CELL1:', r1['doubled'])

# Cell 2: use imported function
r2 = analyze_data([100, 200, 300])
print('CELL2:', r2['mean'])
"`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: 'packages/client-python/src:.',
        },
        timeout: 30000,
      }
    );

    console.log('  IPython output:');
    multiCellResult.trim().split('\n').forEach(l => console.log('    ' + l));

    assert(multiCellResult.includes('CELL1: 84'), 'Cell-defined transform() works');
    assert(multiCellResult.includes('CELL2: 200'), 'Imported analyze_data() works in same session');

    // Verify both interactive and module types were generated
    const jsonl2 = fs.readFileSync('.trickle/observations.jsonl', 'utf8')
      .trim().split('\n')
      .map(l => JSON.parse(l));
    const names2 = jsonl2.map(o => o.functionName);
    assert(names2.includes('transform'), 'Cell-defined transform in JSONL');
    assert(names2.includes('analyze_data'), 'Imported analyze_data in JSONL');

    cleanup();

    // ── Summary ──
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      process.exitCode = 1;
    } else {
      console.log('\nAll Jupyter/IPython integration tests passed!');
    }

  } catch (err) {
    console.error('\nTEST ERROR:', err.message);
    if (err.stdout) console.log('stdout:', err.stdout);
    if (err.stderr) console.log('stderr:', err.stderr);
    process.exitCode = 1;
  }
}

run();
