/**
 * E2E test: `trickle codegen --axios` — Typed Axios client generation
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest sample routes with types
 * 3. Generate Axios client via CLI
 * 4. Verify Axios imports
 * 5. Verify configureAxiosClient function
 * 6. Verify typed GET function
 * 7. Verify typed POST function with body param
 * 8. Verify typed PUT function with path params
 * 9. Verify response type interfaces
 * 10. Verify body type interfaces for mutations
 * 11. Verify backend API directly (format=axios)
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

    // GET /api/users — list
    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          users: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
                email: { kind: 'primitive', name: 'string' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );

    // POST /api/users — create
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

    // PUT /api/users/:id — update with path param
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

    // DELETE /api/users/:id — delete
    await ingestRoute('DELETE', '/api/users/:id',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          deleted: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await sleep(500);
    console.log('  4 routes ingested (1 GET, 1 POST, 1 PUT, 1 DELETE) ✓');

    // Step 3: Generate Axios client via CLI
    console.log('\n=== Step 3: Generate Axios client via CLI ===');
    const axiosOutput = await runCli(['codegen', '--axios']);

    if (!axiosOutput.includes('Auto-generated typed Axios client')) {
      throw new Error('Expected Axios client header comment');
    }
    console.log('  Axios client generated via --axios flag ✓');

    // Step 4: Verify Axios imports
    console.log('\n=== Step 4: Verify Axios imports ===');
    if (!axiosOutput.includes('from "axios"')) {
      throw new Error('Expected axios import');
    }
    if (!axiosOutput.includes('AxiosInstance')) {
      throw new Error('Expected AxiosInstance import');
    }
    if (!axiosOutput.includes('AxiosRequestConfig')) {
      throw new Error('Expected AxiosRequestConfig import');
    }
    console.log('  axios, AxiosInstance, AxiosRequestConfig imports ✓');

    // Step 5: Verify configureAxiosClient
    console.log('\n=== Step 5: Verify configureAxiosClient ===');
    if (!axiosOutput.includes('export function configureAxiosClient')) {
      throw new Error('Expected configureAxiosClient function');
    }
    if (!axiosOutput.includes('axios.create(')) {
      throw new Error('Expected axios.create call');
    }
    console.log('  configureAxiosClient with axios.create ✓');

    // Step 6: Verify typed GET function
    console.log('\n=== Step 6: Verify typed GET function ===');
    if (!axiosOutput.includes('export async function getApiUsers')) {
      throw new Error('Expected getApiUsers function');
    }
    if (!axiosOutput.includes('GetApiUsersResponse')) {
      throw new Error('Expected GetApiUsersResponse return type');
    }
    if (!axiosOutput.includes('.get<')) {
      throw new Error('Expected _instance.get<> call');
    }
    console.log('  getApiUsers with .get<GetApiUsersResponse> ✓');

    // Step 7: Verify typed POST function with body
    console.log('\n=== Step 7: Verify typed POST function with body ===');
    if (!axiosOutput.includes('export async function postApiUsers')) {
      throw new Error('Expected postApiUsers function');
    }
    if (!axiosOutput.includes('PostApiUsersBody')) {
      throw new Error('Expected PostApiUsersBody parameter type');
    }
    if (!axiosOutput.includes('.post<')) {
      throw new Error('Expected _instance.post<> call');
    }
    // Should accept body as parameter
    if (!axiosOutput.includes('body: PostApiUsersBody')) {
      throw new Error('Expected body parameter of type PostApiUsersBody');
    }
    console.log('  postApiUsers with body: PostApiUsersBody ✓');

    // Step 8: Verify typed PUT function with path params
    console.log('\n=== Step 8: Verify PUT with path params ===');
    if (!axiosOutput.includes('export async function putApiUsersId')) {
      throw new Error('Expected putApiUsersId function');
    }
    if (!axiosOutput.includes('id: string')) {
      throw new Error('Expected id: string path parameter');
    }
    if (!axiosOutput.includes('.put<')) {
      throw new Error('Expected _instance.put<> call');
    }
    // Path should use template literal with ${id}
    if (!axiosOutput.includes('${id}')) {
      throw new Error('Expected path parameter interpolation ${id}');
    }
    console.log('  putApiUsersId with id: string path param ✓');

    // Step 9: Verify response type interfaces
    console.log('\n=== Step 9: Verify response interfaces ===');
    if (!axiosOutput.includes('export interface GetApiUsersResponse')) {
      throw new Error('Expected GetApiUsersResponse interface');
    }
    if (!axiosOutput.includes('export interface PostApiUsersResponse')) {
      throw new Error('Expected PostApiUsersResponse interface');
    }
    if (!axiosOutput.includes('export interface PutApiUsersIdResponse')) {
      throw new Error('Expected PutApiUsersIdResponse interface');
    }
    console.log('  Response interfaces for all routes ✓');

    // Step 10: Verify body type interfaces
    console.log('\n=== Step 10: Verify body interfaces ===');
    if (!axiosOutput.includes('export interface PostApiUsersBody')) {
      throw new Error('Expected PostApiUsersBody interface');
    }
    if (!axiosOutput.includes('export interface PutApiUsersIdBody')) {
      throw new Error('Expected PutApiUsersIdBody interface');
    }
    // Body should have name, email fields
    if (!axiosOutput.includes('name: string')) {
      throw new Error('Expected name: string in body interface');
    }
    console.log('  Body interfaces for POST/PUT routes ✓');

    // Step 11: Verify backend API directly
    console.log('\n=== Step 11: Verify backend API (format=axios) ===');
    const apiRes = await fetch('http://localhost:4888/api/codegen?format=axios');
    const apiData = await apiRes.json();
    if (!apiData.types || !apiData.types.includes('configureAxiosClient')) {
      throw new Error('Backend API should return Axios client');
    }
    console.log('  Backend API returns Axios client correctly ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle codegen --axios generates typed Axios client!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
