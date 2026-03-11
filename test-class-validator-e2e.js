/**
 * E2E test: `trickle codegen --class-validator` — NestJS DTO generation
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest sample routes with types
 * 3. Generate class-validator DTOs via CLI
 * 4. Verify class-validator imports
 * 5. Verify request body DTO classes for POST/PUT
 * 6. Verify response DTO classes
 * 7. Verify decorator types (@IsString, @IsNumber, @IsBoolean)
 * 8. Verify nested object handling (@ValidateNested, @Type)
 * 9. Verify array handling (@IsArray)
 * 10. Verify GET routes excluded from body DTOs
 * 11. Verify backend API directly (format=class-validator)
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

    // PUT /api/users/:id — update with nested address
    await ingestRoute('PUT', '/api/users/:id',
      {
        kind: 'object', properties: {
          body: {
            kind: 'object', properties: {
              name: { kind: 'primitive', name: 'string' },
              address: {
                kind: 'object', properties: {
                  street: { kind: 'primitive', name: 'string' },
                  city: { kind: 'primitive', name: 'string' },
                  zip: { kind: 'primitive', name: 'string' },
                },
              },
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
    console.log('  3 routes ingested (1 GET, 1 POST, 1 PUT) ✓');

    // Step 3: Generate class-validator DTOs via CLI
    console.log('\n=== Step 3: Generate class-validator DTOs via CLI ===');
    const dtoOutput = execSync(
      'npx trickle codegen --class-validator',
      { encoding: 'utf-8', env: { ...process.env, TRICKLE_BACKEND_URL: 'http://localhost:4888' } },
    );

    if (!dtoOutput.includes('Auto-generated class-validator DTOs')) {
      throw new Error('Expected class-validator header comment');
    }
    console.log('  DTOs generated via --class-validator flag ✓');

    // Step 4: Verify class-validator imports
    console.log('\n=== Step 4: Verify class-validator imports ===');
    if (!dtoOutput.includes('from "class-validator"')) {
      throw new Error('Expected class-validator import');
    }
    if (!dtoOutput.includes('IsString')) {
      throw new Error('Expected IsString in imports');
    }
    if (!dtoOutput.includes('IsNumber')) {
      throw new Error('Expected IsNumber in imports');
    }
    if (!dtoOutput.includes('IsBoolean')) {
      throw new Error('Expected IsBoolean in imports');
    }
    console.log('  class-validator imports present ✓');

    // Step 5: Verify request body DTO classes
    console.log('\n=== Step 5: Verify request body DTOs ===');
    if (!dtoOutput.includes('export class PostApiUsersBody')) {
      throw new Error('Expected PostApiUsersBody class');
    }
    if (!dtoOutput.includes('export class PutApiUsersIdBody')) {
      throw new Error('Expected PutApiUsersIdBody class');
    }
    console.log('  POST and PUT body DTOs present ✓');

    // Step 6: Verify response DTO classes
    console.log('\n=== Step 6: Verify response DTOs ===');
    if (!dtoOutput.includes('export class GetApiUsersResponse')) {
      throw new Error('Expected GetApiUsersResponse class');
    }
    if (!dtoOutput.includes('export class PostApiUsersResponse')) {
      throw new Error('Expected PostApiUsersResponse class');
    }
    if (!dtoOutput.includes('export class PutApiUsersIdResponse')) {
      throw new Error('Expected PutApiUsersIdResponse class');
    }
    console.log('  Response DTOs for all 3 routes ✓');

    // Step 7: Verify decorator types
    console.log('\n=== Step 7: Verify decorator types ===');
    if (!dtoOutput.includes('@IsString()')) {
      throw new Error('Expected @IsString() decorator');
    }
    if (!dtoOutput.includes('@IsNumber()')) {
      throw new Error('Expected @IsNumber() decorator');
    }
    if (!dtoOutput.includes('@IsBoolean()')) {
      throw new Error('Expected @IsBoolean() decorator');
    }
    // name should have @IsString and be typed as string
    if (!dtoOutput.includes('name: string')) {
      throw new Error('Expected name: string field');
    }
    // age should have @IsNumber and be typed as number
    if (!dtoOutput.includes('age: number')) {
      throw new Error('Expected age: number field');
    }
    console.log('  @IsString, @IsNumber, @IsBoolean decorators ✓');

    // Step 8: Verify nested object handling
    console.log('\n=== Step 8: Verify nested object handling ===');
    if (!dtoOutput.includes('@ValidateNested()')) {
      throw new Error('Expected @ValidateNested() decorator for nested object');
    }
    if (!dtoOutput.includes('@Type(')) {
      throw new Error('Expected @Type() decorator for nested object');
    }
    if (!dtoOutput.includes('from "class-transformer"')) {
      throw new Error('Expected class-transformer import');
    }
    // The nested address should create its own class
    if (!dtoOutput.includes('street: string')) {
      throw new Error('Expected nested address class with street field');
    }
    console.log('  @ValidateNested, @Type, and nested class ✓');

    // Step 9: Verify array handling
    console.log('\n=== Step 9: Verify array handling ===');
    if (!dtoOutput.includes('@IsArray()')) {
      throw new Error('Expected @IsArray() decorator');
    }
    // Array of objects should have @ValidateNested({ each: true })
    if (!dtoOutput.includes('{ each: true }')) {
      throw new Error('Expected @ValidateNested({ each: true }) for array of objects');
    }
    console.log('  @IsArray with @ValidateNested({ each: true }) ✓');

    // Step 10: Verify GET routes excluded from body DTOs
    console.log('\n=== Step 10: Verify GET route body exclusion ===');
    if (dtoOutput.includes('GetApiUsersBody')) {
      throw new Error('GET routes should not have body DTOs');
    }
    console.log('  GET routes correctly excluded from body DTOs ✓');

    // Step 11: Verify backend API directly
    console.log('\n=== Step 11: Verify backend API (format=class-validator) ===');
    const apiRes = await fetch('http://localhost:4888/api/codegen?format=class-validator');
    const apiData = await apiRes.json();
    if (!apiData.types || !apiData.types.includes('class-validator')) {
      throw new Error('Backend API should return class-validator DTOs');
    }
    console.log('  Backend API returns class-validator DTOs correctly ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle codegen --class-validator generates NestJS DTOs!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
