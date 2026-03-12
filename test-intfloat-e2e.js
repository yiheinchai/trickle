/**
 * E2E test: Integer vs float type narrowing in Python
 *
 * Verifies that Python int values generate `int` types (not `float`)
 * in .pyi stubs, while float values correctly generate `float`.
 * JS should still use `number` for both.
 */
const { execSync } = require('child_process');
const fs = require('fs');

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
  for (const f of [
    '.trickle/observations.jsonl',
    '.trickle/type-snapshot.json',
    'test_intfloat_lib.pyi',
    'test-async-lib.d.ts',
  ]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function run() {
  try {
    cleanup();

    // ── Step 1: Python int/float narrowing ──
    console.log('\n=== Step 1: Python int vs float types ===');

    const pyResult = execSync('python test_intfloat_app.py', {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'packages/client-python/src:.' },
    });
    console.log(pyResult.trim());
    assert(pyResult.includes('Done!'), 'Python app completed');

    const pyi = fs.readFileSync('test_intfloat_lib.pyi', 'utf8');

    // paginate: items=List[str], page=int, per_page=int
    assert(
      pyi.includes('page: int'),
      '.pyi: page is int (not float)'
    );
    assert(
      pyi.includes('per_page: int'),
      '.pyi: per_page is int (not float)'
    );

    // Return type: total should be int
    assert(
      pyi.includes('total: int'),
      '.pyi: total return field is int'
    );

    // calculate_stats: precision=int, values=List[float]
    assert(
      pyi.includes('precision: int'),
      '.pyi: precision is int'
    );
    assert(
      pyi.includes('values: List[float]'),
      '.pyi: values is List[float]'
    );

    // Return type: mean=float, count=int
    assert(
      pyi.includes('mean: float'),
      '.pyi: mean return field is float'
    );
    assert(
      pyi.includes('count: int'),
      '.pyi: count return field is int'
    );

    // mixed_types: age=int, score=float
    assert(
      pyi.includes('age: int'),
      '.pyi: age is int'
    );
    assert(
      pyi.includes('score: float'),
      '.pyi: score is float'
    );

    // Class methods: user_id=int, offset=int, limit=int
    assert(
      pyi.includes('user_id: int'),
      '.pyi: UserService.get_user user_id is int'
    );
    assert(
      pyi.includes('offset: int'),
      '.pyi: UserService.list_users offset is int'
    );
    assert(
      pyi.includes('limit: int'),
      '.pyi: UserService.list_users limit is int'
    );

    // Verify no standalone function uses float where int is expected
    assert(
      !pyi.match(/page: float/),
      '.pyi: page is NOT float'
    );
    assert(
      !pyi.match(/per_page: float/),
      '.pyi: per_page is NOT float'
    );

    // Check JSONL has "integer" primitive
    const jsonl = fs.readFileSync('.trickle/observations.jsonl', 'utf8');
    const obs = jsonl.trim().split('\n').map(l => JSON.parse(l));
    const paginateObs = obs.find(o => o.functionName === 'paginate');
    assert(
      paginateObs !== undefined,
      'JSONL: paginate observation exists'
    );

    // page param should be "integer"
    const pageType = paginateObs.argsType.elements[1];
    assert(
      pageType && pageType.kind === 'primitive' && pageType.name === 'integer',
      'JSONL: page param type is primitive/integer'
    );

    // calculate_stats: values list elements should be "number" (float)
    const statsObs = obs.find(o => o.functionName === 'calculate_stats');
    const valuesType = statsObs.argsType.elements[0];
    assert(
      valuesType && valuesType.kind === 'array' && valuesType.element.name === 'number',
      'JSONL: values param element type is primitive/number (float)'
    );

    cleanup();

    // ── Step 2: JS still uses number for both ──
    console.log('\n=== Step 2: JS still uses number (no integer) ===');

    execSync('node test-async-app.js', {
      encoding: 'utf8',
      env: { ...process.env, TRICKLE_LOCAL: '1' },
    });

    const dts = fs.readFileSync('test-async-lib.d.ts', 'utf8');
    assert(
      !dts.includes('integer'),
      '.d.ts: no "integer" type leaks into JS output'
    );
    assert(
      dts.includes('number'),
      '.d.ts: uses "number" type'
    );

    cleanup();

    // ── Step 3: Mixed Python observations (JS + Python in same JSONL) ──
    console.log('\n=== Step 3: Mixed JS + Python observations ===');

    // Run JS first (generates observations with "number")
    execSync('node test-async-app.js', {
      encoding: 'utf8',
      env: { ...process.env, TRICKLE_LOCAL: '1' },
    });

    // Then run Python (appends observations with "integer")
    execSync('python test_intfloat_app.py', {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'packages/client-python/src:.' },
    });

    // Python .pyi should still be correct
    const mixedPyi = fs.readFileSync('test_intfloat_lib.pyi', 'utf8');
    assert(
      mixedPyi.includes('page: int'),
      'Mixed JSONL: Python .pyi still shows page as int'
    );

    // JS .d.ts should still be correct
    const mixedDts = fs.readFileSync('test-async-lib.d.ts', 'utf8');
    assert(
      !mixedDts.includes('integer'),
      'Mixed JSONL: JS .d.ts still has no integer'
    );

    cleanup();

    // ── Summary ──
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      process.exitCode = 1;
    } else {
      console.log('\nAll int/float type narrowing tests passed!');
    }

  } catch (err) {
    console.error('\nTEST ERROR:', err.message);
    if (err.stdout) console.log('stdout:', err.stdout);
    if (err.stderr) console.log('stderr:', err.stderr);
    process.exitCode = 1;
  }
}

run();
