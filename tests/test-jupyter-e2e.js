/**
 * E2E test: `%load_ext trickle` in IPython/Jupyter.
 *
 * Verifies that loading the trickle IPython extension traces variable
 * assignments (including imported helpers) into .trickle/variables.jsonl.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

async function run() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-jupyter-'));
  const trickleDir = path.join(testDir, '.trickle');
  const notebook = path.join(testDir, 'session.ipy');
  const varsFile = path.join(trickleDir, 'variables.jsonl');

  fs.writeFileSync(notebook, `%load_ext trickle
from test_jupyter_lib import analyze_data, format_report, DataProcessor

result = analyze_data([10, 20, 30, 40, 50])
report = format_report('Sales', result)
count = result['count']
items = [1, 2, 3]
proc = DataProcessor()
norm = proc.normalize([10, 20, 30])
print('RESULT_COUNT', count)
print('REPORT', report['summary'])
print('NORM', len(norm['normalized']))
`);

  try {
    console.log('\n=== %load_ext trickle traces notebook variables ===');

    const output = execSync(
      `ipython --no-banner --colors=NoColor ${notebook}`,
      {
        encoding: 'utf8',
        cwd: __dirname,
        env: {
          ...process.env,
          PYTHONPATH: path.join(__dirname, '../packages/client-python/src') + path.delimiter + __dirname,
          TRICKLE_LOCAL_DIR: trickleDir,
          TRICKLE_TRACE_VARS: '1',
        },
        timeout: 30000,
      }
    );

    console.log('  IPython output:');
    output.trim().split('\n').forEach((l) => console.log('    ' + l));

    assert(output.includes('RESULT_COUNT 5'), 'analyze_data executed');
    assert(output.includes('REPORT Sales:'), 'format_report executed');
    assert(output.includes('NORM 3'), 'DataProcessor.normalize executed');

    assert(fs.existsSync(varsFile), 'variables.jsonl created');

    const observations = fs.readFileSync(varsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const varNames = observations.map((o) => o.varName || o.name);
    console.log('  Captured variables:', [...new Set(varNames)].join(', '));

    assert(varNames.includes('result'), 'result traced');
    assert(varNames.includes('count'), 'count traced');
    assert(varNames.includes('items'), 'items traced');

    const itemsObs = observations.find((o) => (o.varName || o.name) === 'items');
    assert(
      itemsObs && (itemsObs.type?.kind === 'array' || itemsObs.type?.kind === 'list'),
      'items has array/list type'
    );

    const countObs = observations.find((o) => (o.varName || o.name) === 'count');
    assert(
      countObs && countObs.type?.kind === 'primitive',
      'count has primitive type'
    );
  } catch (err) {
    console.error('\nTEST ERROR:', err.message);
    if (err.stdout) console.log('stdout:', err.stdout);
    if (err.stderr) console.log('stderr:', err.stderr);
    process.exitCode = 1;
    return;
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log('\nAll Jupyter/IPython %load_ext trickle tests passed!');
  }
}

run();
