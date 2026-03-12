/**
 * E2E test: Class method observation and type generation
 *
 * Verifies that trickle/auto correctly:
 * 1. Wraps class prototype methods (JS) and class methods (Python)
 * 2. Captures runtime types with ClassName.methodName convention
 * 3. Generates proper class declarations in .d.ts (JS) and .pyi (Python)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  try {
    // Clean up any previous observations
    const trickleDir = path.join(process.cwd(), '.trickle');
    const jsonlPath = path.join(trickleDir, 'observations.jsonl');
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);

    // Clean up any previous generated files
    const jsDtsPath = path.join(process.cwd(), 'test-class-lib.d.ts');
    const pyPyiPath = path.join(process.cwd(), 'test_class_lib.pyi');
    if (fs.existsSync(jsDtsPath)) fs.unlinkSync(jsDtsPath);
    if (fs.existsSync(pyPyiPath)) fs.unlinkSync(pyPyiPath);

    // ── Step 1: Test JS class observation ──
    console.log('\n=== Step 1: JS class observation ===');

    const jsResult = execSync('node test-class-app.js', {
      encoding: 'utf8',
      env: { ...process.env, TRICKLE_LOCAL: '1' },
    });

    console.log(jsResult.trim());
    assert(jsResult.includes('add: 15'), 'JS Calculator.add returns correct result');
    assert(jsResult.includes('multiply: 12'), 'JS Calculator.multiply returns correct result');
    assert(jsResult.includes('square: 49'), 'JS Calculator.square returns correct result');
    assert(jsResult.includes('name: John Doe'), 'JS Formatter.formatName returns correct result');
    assert(jsResult.includes('currency: $99.99'), 'JS Formatter.formatCurrency returns correct result');
    assert(jsResult.includes('Done!'), 'JS app completed successfully');

    // Check .d.ts was generated
    assert(fs.existsSync(jsDtsPath), 'JS .d.ts file generated');

    const dtsContent = fs.readFileSync(jsDtsPath, 'utf8');
    console.log('\n  Generated .d.ts:');
    console.log(dtsContent.split('\n').map(l => '    ' + l).join('\n'));

    // Verify class declarations
    assert(dtsContent.includes('export declare class Calculator {'), '.d.ts has Calculator class');
    assert(dtsContent.includes('export declare class Formatter {'), '.d.ts has Formatter class');
    assert(dtsContent.includes('add(a: number, b: number)'), '.d.ts has Calculator.add method');
    assert(dtsContent.includes('multiply(a: number, b: number)'), '.d.ts has Calculator.multiply method');
    assert(dtsContent.includes('square(x: number)'), '.d.ts has Calculator.square method');
    assert(dtsContent.includes('formatName(first: string, last: string)'), '.d.ts has Formatter.formatName method');
    assert(dtsContent.includes('formatCurrency(amount: number, currency: string)'), '.d.ts has Formatter.formatCurrency method');

    // Verify no standalone function declarations (they should be class methods)
    assert(!dtsContent.includes('export declare function add'), 'No standalone add() function');
    assert(!dtsContent.includes('export declare function multiply'), 'No standalone multiply() function');

    // ── Step 2: Clean JSONL and test Python class observation ──
    console.log('\n=== Step 2: Python class observation ===');

    // Clean JSONL so Python observations don't mix with JS
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);

    const pyResult = execSync('python test_class_app.py', {
      encoding: 'utf8',
      env: { ...process.env },
    });

    console.log(pyResult.trim());
    assert(pyResult.includes('add: 15'), 'Python Calculator.add returns correct result');
    assert(pyResult.includes('multiply: 12'), 'Python Calculator.multiply returns correct result');
    assert(pyResult.includes('square: 49'), 'Python Calculator.square returns correct result');
    assert(pyResult.includes('name: John Doe'), 'Python Formatter.format_name returns correct result');
    assert(pyResult.includes('currency: $99.99'), 'Python Formatter.format_currency returns correct result');
    assert(pyResult.includes('Done!'), 'Python app completed successfully');

    // Check .pyi was generated
    assert(fs.existsSync(pyPyiPath), 'Python .pyi file generated');

    const pyiContent = fs.readFileSync(pyPyiPath, 'utf8');
    console.log('\n  Generated .pyi:');
    console.log(pyiContent.split('\n').map(l => '    ' + l).join('\n'));

    // Verify class stubs
    assert(pyiContent.includes('class Calculator:'), '.pyi has Calculator class');
    assert(pyiContent.includes('class Formatter:'), '.pyi has Formatter class');
    assert(pyiContent.includes('def add(self, a: int, b: int)'), '.pyi has Calculator.add method');
    assert(pyiContent.includes('def multiply(self, a: int, b: int)'), '.pyi has Calculator.multiply method');
    assert(pyiContent.includes('def square(self, x: int)'), '.pyi has Calculator.square method');
    assert(pyiContent.includes('def format_name(self, first: str, last: str)'), '.pyi has Formatter.format_name method');
    assert(pyiContent.includes('def format_currency(self, amount: float, currency: str)'), '.pyi has Formatter.format_currency method');

    // Verify self parameter is present in all methods
    const methodLines = pyiContent.split('\n').filter(l => l.trim().startsWith('def '));
    for (const line of methodLines) {
      assert(line.includes('self'), `Method has self parameter: ${line.trim()}`);
    }

    // ── Step 3: Verify JSONL observations have ClassName.method format ──
    console.log('\n=== Step 3: Verify observation format ===');

    const jsonlContent = fs.readFileSync(jsonlPath, 'utf8');
    const observations = jsonlContent.trim().split('\n').map(l => JSON.parse(l));

    const fnNames = observations.map(o => o.functionName);
    assert(fnNames.includes('Calculator.add'), 'Observation has Calculator.add');
    assert(fnNames.includes('Calculator.multiply'), 'Observation has Calculator.multiply');
    assert(fnNames.includes('Calculator.square'), 'Observation has Calculator.square');
    assert(fnNames.includes('Formatter.format_name'), 'Observation has Formatter.format_name');
    assert(fnNames.includes('Formatter.format_currency'), 'Observation has Formatter.format_currency');

    // Verify param names include 'self' for Python
    for (const obs of observations) {
      assert(
        obs.paramNames && obs.paramNames[0] === 'self',
        `${obs.functionName} paramNames starts with self`
      );
    }

    // ── Summary ──
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      process.exitCode = 1;
    } else {
      console.log('\nAll class observation tests passed!');
    }

  } catch (err) {
    console.error('\nTEST ERROR:', err.message);
    if (err.stdout) console.log('stdout:', err.stdout);
    if (err.stderr) console.log('stderr:', err.stderr);
    process.exitCode = 1;
  }
}

run();
