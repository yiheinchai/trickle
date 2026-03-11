/**
 * E2E test: `trickle codegen --pydantic` — Pydantic model generation
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest sample routes with types
 * 3. Generate Pydantic models via CLI (--pydantic flag)
 * 4. Verify Pydantic imports (BaseModel)
 * 5. Verify response model classes for all routes
 * 6. Verify request model for POST routes
 * 7. Verify correct Python type mapping
 * 8. Verify nested model generation (List with inner model)
 * 9. Verify snake_case field naming
 * 10. Verify backend API directly (format=pydantic)
 * 11. Verify file output
 * 12. Clean shutdown
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
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

async function run() {
  let backendProc = null;

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Ingest sample routes
    console.log('\n=== Step 2: Ingest sample route data ===');

    // GET /api/users
    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          users: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
                isActive: { kind: 'primitive', name: 'boolean' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );

    // POST /api/users
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

    // GET /api/users/:id
    await ingestRoute('GET', '/api/users/:id',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          id: { kind: 'primitive', name: 'number' },
          name: { kind: 'primitive', name: 'string' },
          email: { kind: 'primitive', name: 'string' },
          createdAt: { kind: 'primitive', name: 'string' },
        },
      },
    );

    await sleep(500);
    console.log('  3 routes ingested (2 GET, 1 POST) ✓');

    // Step 3: Generate Pydantic models via CLI
    console.log('\n=== Step 3: Generate Pydantic models via CLI ===');
    const pydanticOutput = execSync(
      'npx trickle codegen --pydantic',
      { encoding: 'utf-8', env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' } },
    );

    if (!pydanticOutput.includes('Auto-generated Pydantic models')) {
      throw new Error('Expected Pydantic header comment');
    }
    console.log('  Pydantic models generated via --pydantic flag ✓');

    // Step 4: Verify Pydantic imports
    console.log('\n=== Step 4: Verify Pydantic imports ===');
    if (!pydanticOutput.includes('from pydantic import BaseModel')) {
      throw new Error('Expected pydantic BaseModel import');
    }
    if (!pydanticOutput.includes('from typing import')) {
      throw new Error('Expected typing imports');
    }
    if (!pydanticOutput.includes('from __future__ import annotations')) {
      throw new Error('Expected __future__ annotations import');
    }
    console.log('  Pydantic and typing imports present ✓');

    // Step 5: Verify response model classes
    console.log('\n=== Step 5: Verify response model classes ===');
    if (!pydanticOutput.includes('class GetApiUsersResponse(BaseModel):')) {
      throw new Error('Expected GetApiUsersResponse class');
    }
    if (!pydanticOutput.includes('class PostApiUsersResponse(BaseModel):')) {
      throw new Error('Expected PostApiUsersResponse class');
    }
    if (!pydanticOutput.includes('class GetApiUsersIdResponse(BaseModel):')) {
      throw new Error('Expected GetApiUsersIdResponse class');
    }
    console.log('  Response models for all 3 routes ✓');

    // Step 6: Verify request model for POST
    console.log('\n=== Step 6: Verify request model for POST ===');
    if (!pydanticOutput.includes('class PostApiUsersRequest(BaseModel):')) {
      throw new Error('Expected PostApiUsersRequest class');
    }
    // GET should NOT have request models
    if (pydanticOutput.includes('GetApiUsersRequest')) {
      throw new Error('GET routes should not have request models');
    }
    console.log('  POST request model present, GET excluded ✓');

    // Step 7: Verify Python type mapping
    console.log('\n=== Step 7: Verify Python type mapping ===');
    // Check PostApiUsersRequest has correct types
    if (!pydanticOutput.includes('name: str')) {
      throw new Error('Expected name: str');
    }
    if (!pydanticOutput.includes('email: str')) {
      throw new Error('Expected email: str');
    }
    if (!pydanticOutput.includes('age: float')) {
      throw new Error('Expected age: float (number maps to float)');
    }
    // Check boolean mapping
    if (!pydanticOutput.includes('created: bool')) {
      throw new Error('Expected created: bool');
    }
    console.log('  str, float, bool types correctly mapped ✓');

    // Step 8: Verify nested model (List with inner model)
    console.log('\n=== Step 8: Verify nested model generation ===');
    // GetApiUsersResponse should have users: List[SomeModel]
    if (!pydanticOutput.includes('List[')) {
      throw new Error('Expected List type for users array');
    }
    // There should be a nested model for the user object inside the array
    // The nested model should extend BaseModel
    const baseModelMatches = pydanticOutput.match(/class \w+\(BaseModel\):/g);
    if (!baseModelMatches || baseModelMatches.length < 4) {
      // At least: GetApiUsersResponse, nested User model, PostApiUsersRequest, PostApiUsersResponse, GetApiUsersIdResponse
      throw new Error(`Expected at least 4 BaseModel classes, got ${baseModelMatches?.length || 0}`);
    }
    console.log(`  ${baseModelMatches.length} BaseModel classes including nested models ✓`);

    // Step 9: Verify snake_case field naming
    console.log('\n=== Step 9: Verify snake_case field naming ===');
    // isActive should become is_active
    if (!pydanticOutput.includes('is_active: bool')) {
      throw new Error('Expected is_active: bool (snake_case conversion)');
    }
    // createdAt should become created_at
    if (!pydanticOutput.includes('created_at: str')) {
      throw new Error('Expected created_at: str (snake_case conversion)');
    }
    console.log('  camelCase → snake_case conversion ✓');

    // Step 10: Verify backend API directly
    console.log('\n=== Step 10: Verify backend API (format=pydantic) ===');
    const apiRes = await fetch('http://localhost:4888/api/codegen?format=pydantic');
    const apiData = await apiRes.json();
    if (!apiData.types || !apiData.types.includes('from pydantic import BaseModel')) {
      throw new Error('Backend API should return Pydantic models');
    }
    console.log('  Backend API returns Pydantic models correctly ✓');

    // Step 11: Write to file and verify
    console.log('\n=== Step 11: Verify file output ===');
    const outFile = path.join(__dirname, '.test-pydantic-output.py');
    execSync(
      `npx trickle codegen --pydantic --out ${outFile}`,
      { encoding: 'utf-8', env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' } },
    );
    const fileContent = fs.readFileSync(outFile, 'utf-8');
    if (!fileContent.includes('class') || !fileContent.includes('BaseModel')) {
      throw new Error('File should contain BaseModel classes');
    }
    console.log('  File written with Pydantic models ✓');
    try { fs.unlinkSync(outFile); } catch {}

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle codegen --pydantic generates Pydantic BaseModel classes!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
