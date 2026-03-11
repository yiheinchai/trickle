/**
 * E2E test: `trickle codegen --graphql` — GraphQL SDL schema generation
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest sample routes with types
 * 3. Generate GraphQL schema via CLI
 * 4. Verify schema header comment
 * 5. Verify Query type with GET routes
 * 6. Verify Mutation type with POST/PUT routes
 * 7. Verify scalar types (String, Float, Boolean)
 * 8. Verify nested object types
 * 9. Verify array types ([Type])
 * 10. Verify input types for mutations
 * 11. Verify backend API directly (format=graphql)
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

function runCli(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['packages/cli/dist/index.js', ...args], {
      env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI timeout')); }, 30000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI exit ${code}: ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
}

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Ingest sample routes
    console.log('\n=== Step 2: Ingest sample route data ===');

    // GET /api/users — list with nested array
    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          users: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
                active: { kind: 'primitive', name: 'boolean' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );

    // POST /api/users — create with body
    await ingestRoute('POST', '/api/users',
      {
        kind: 'object', properties: {
          body: {
            kind: 'object', properties: {
              name: { kind: 'primitive', name: 'string' },
              email: { kind: 'primitive', name: 'string' },
              age: { kind: 'primitive', name: 'number' },
            },
          },
        },
      },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          created: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    // GET /api/users/:id — single with nested object
    await ingestRoute('GET', '/api/users/:id',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          name: { kind: 'primitive', name: 'string' },
          profile: {
            kind: 'object', properties: {
              bio: { kind: 'primitive', name: 'string' },
              followers: { kind: 'primitive', name: 'number' },
            },
          },
        },
      },
    );

    // PUT /api/users/:id — update with body
    await ingestRoute('PUT', '/api/users/:id',
      {
        kind: 'object', properties: {
          body: {
            kind: 'object', properties: {
              name: { kind: 'primitive', name: 'string' },
              email: { kind: 'primitive', name: 'string' },
            },
          },
        },
      },
      {
        kind: 'object', properties: {
          updated: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await sleep(500);
    console.log('  4 routes ingested (2 GET, 1 POST, 1 PUT) ✓');

    // Step 3: Generate GraphQL schema via CLI
    console.log('\n=== Step 3: Generate GraphQL schema via CLI ===');
    const schemaOutput = await runCli(['codegen', '--graphql']);

    if (!schemaOutput.includes('Auto-generated GraphQL schema')) {
      throw new Error('Expected GraphQL header comment');
    }
    console.log('  GraphQL schema generated via --graphql flag ✓');

    // Step 4: Verify schema header
    console.log('\n=== Step 4: Verify schema header ===');
    if (!schemaOutput.includes('# Auto-generated GraphQL schema from runtime-observed types')) {
      throw new Error('Expected schema header comment');
    }
    if (!schemaOutput.includes('trickle')) {
      throw new Error('Expected trickle attribution');
    }
    console.log('  Schema header present ✓');

    // Step 5: Verify Query type with GET routes
    console.log('\n=== Step 5: Verify Query type ===');
    if (!schemaOutput.includes('type Query {')) {
      throw new Error('Expected type Query block');
    }
    if (!schemaOutput.includes('getApiUsers')) {
      throw new Error('Expected getApiUsers query field');
    }
    if (!schemaOutput.includes('getApiUsersId')) {
      throw new Error('Expected getApiUsersId query field');
    }
    console.log('  Query type with GET routes ✓');

    // Step 6: Verify Mutation type with POST/PUT routes
    console.log('\n=== Step 6: Verify Mutation type ===');
    if (!schemaOutput.includes('type Mutation {')) {
      throw new Error('Expected type Mutation block');
    }
    if (!schemaOutput.includes('postApiUsers')) {
      throw new Error('Expected postApiUsers mutation field');
    }
    if (!schemaOutput.includes('putApiUsersId')) {
      throw new Error('Expected putApiUsersId mutation field');
    }
    console.log('  Mutation type with POST/PUT routes ✓');

    // Step 7: Verify scalar types
    console.log('\n=== Step 7: Verify scalar types ===');
    if (!schemaOutput.includes('String')) {
      throw new Error('Expected String scalar');
    }
    if (!schemaOutput.includes('Float')) {
      throw new Error('Expected Float scalar');
    }
    if (!schemaOutput.includes('Boolean')) {
      throw new Error('Expected Boolean scalar');
    }
    console.log('  String, Float, Boolean scalars present ✓');

    // Step 8: Verify nested object types
    console.log('\n=== Step 8: Verify nested object types ===');
    // The profile nested object should create its own type
    if (!schemaOutput.includes('bio: String')) {
      throw new Error('Expected bio field in nested profile type');
    }
    if (!schemaOutput.includes('followers: Float')) {
      throw new Error('Expected followers field in nested profile type');
    }
    console.log('  Nested object types (profile with bio, followers) ✓');

    // Step 9: Verify array types
    console.log('\n=== Step 9: Verify array types ===');
    // The users field should be an array type [SomeType]
    if (!/\[.*\]/.test(schemaOutput)) {
      throw new Error('Expected array type notation [Type]');
    }
    console.log('  Array type notation present ✓');

    // Step 10: Verify input types for mutations
    console.log('\n=== Step 10: Verify input types ===');
    if (!schemaOutput.includes('input ')) {
      throw new Error('Expected input type for mutation body');
    }
    if (!schemaOutput.includes('Input')) {
      throw new Error('Expected Input suffix on input types');
    }
    console.log('  Input types for mutations ✓');

    // Step 11: Verify backend API directly
    console.log('\n=== Step 11: Verify backend API (format=graphql) ===');
    const apiRes = await fetch('http://localhost:4888/api/codegen?format=graphql');
    const apiData = await apiRes.json();
    if (!apiData.types || !apiData.types.includes('type Query')) {
      throw new Error('Backend API should return GraphQL schema');
    }
    console.log('  Backend API returns GraphQL schema correctly ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle codegen --graphql generates GraphQL SDL schema!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
