/**
 * E2E test: `trickle auto` — Auto-detect deps and generate relevant types
 *
 * Tests:
 * 1. Start trickle backend
 * 2. Ingest sample routes
 * 3. Create temp project with axios + zod + swr deps
 * 4. Run trickle auto in temp project
 * 5. Verify types.d.ts generated (always)
 * 6. Verify axios-client.ts generated (axios detected)
 * 7. Verify schemas.ts generated (zod detected)
 * 8. Verify swr-hooks.ts generated (swr detected)
 * 9. Verify guards.ts generated (always)
 * 10. Verify api-client.ts NOT generated (axios takes priority)
 * 11. Test with different deps (react-query + express)
 * 12. Clean shutdown
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

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

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.resolve('packages/cli/dist/index.js'), ...args], {
      cwd,
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

function createTempProject(deps) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-auto-test-'));
  const pkg = {
    name: 'test-project',
    version: '1.0.0',
    dependencies: deps,
  };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2));
  return tmpDir;
}

async function run() {
  let backendProc = null;
  const tmpDirs = [];

  try {
    // Step 1: Start backend
    console.log('=== Step 1: Start trickle backend ===');
    backendProc = await startBackend();
    console.log('  Backend running ✓');

    // Step 2: Ingest sample routes
    console.log('\n=== Step 2: Ingest sample route data ===');

    await ingestRoute('GET', '/api/users',
      { kind: 'object', properties: {} },
      {
        kind: 'object', properties: {
          users: {
            kind: 'array', element: {
              kind: 'object', properties: {
                id: { kind: 'primitive', name: 'number' },
                name: { kind: 'primitive', name: 'string' },
              },
            },
          },
          total: { kind: 'primitive', name: 'number' },
        },
      },
    );

    await ingestRoute('POST', '/api/users',
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
          id: { kind: 'primitive', name: 'number' },
          created: { kind: 'primitive', name: 'boolean' },
        },
      },
    );

    await sleep(500);
    console.log('  2 routes ingested ✓');

    // Step 3: Create temp project with axios + zod + swr
    console.log('\n=== Step 3: Create temp project (axios + zod + swr) ===');
    const tmpDir1 = createTempProject({
      axios: '^1.6.0',
      zod: '^3.22.0',
      swr: '^2.2.0',
    });
    tmpDirs.push(tmpDir1);
    console.log(`  Temp project created at ${tmpDir1} ✓`);

    // Step 4: Run trickle auto
    console.log('\n=== Step 4: Run trickle auto ===');
    const autoOut1 = await runCli(['auto'], tmpDir1);
    if (!autoOut1.includes('trickle auto')) {
      throw new Error('Expected trickle auto header');
    }
    if (!autoOut1.includes('files generated')) {
      throw new Error('Expected "files generated" summary');
    }
    console.log('  trickle auto completed ✓');

    // Step 5: Verify types.d.ts generated
    console.log('\n=== Step 5: Verify types.d.ts generated ===');
    const typesPath = path.join(tmpDir1, '.trickle', 'types.d.ts');
    if (!fs.existsSync(typesPath)) {
      throw new Error('Expected types.d.ts to be generated');
    }
    const typesContent = fs.readFileSync(typesPath, 'utf-8');
    if (!typesContent.includes('interface') && !typesContent.includes('type')) {
      throw new Error('Expected TypeScript type definitions in types.d.ts');
    }
    console.log('  types.d.ts generated with type definitions ✓');

    // Step 6: Verify axios-client.ts generated
    console.log('\n=== Step 6: Verify axios-client.ts generated ===');
    const axiosPath = path.join(tmpDir1, '.trickle', 'axios-client.ts');
    if (!fs.existsSync(axiosPath)) {
      throw new Error('Expected axios-client.ts to be generated');
    }
    const axiosContent = fs.readFileSync(axiosPath, 'utf-8');
    if (!axiosContent.includes('from "axios"')) {
      throw new Error('Expected axios import in axios-client.ts');
    }
    if (!axiosContent.includes('configureAxiosClient')) {
      throw new Error('Expected configureAxiosClient in axios-client.ts');
    }
    console.log('  axios-client.ts generated with Axios client ✓');

    // Step 7: Verify schemas.ts generated
    console.log('\n=== Step 7: Verify schemas.ts generated ===');
    const schemasPath = path.join(tmpDir1, '.trickle', 'schemas.ts');
    if (!fs.existsSync(schemasPath)) {
      throw new Error('Expected schemas.ts to be generated');
    }
    const schemasContent = fs.readFileSync(schemasPath, 'utf-8');
    if (!schemasContent.includes('from "zod"')) {
      throw new Error('Expected zod import in schemas.ts');
    }
    console.log('  schemas.ts generated with Zod schemas ✓');

    // Step 8: Verify swr-hooks.ts generated
    console.log('\n=== Step 8: Verify swr-hooks.ts generated ===');
    const swrPath = path.join(tmpDir1, '.trickle', 'swr-hooks.ts');
    if (!fs.existsSync(swrPath)) {
      throw new Error('Expected swr-hooks.ts to be generated');
    }
    const swrContent = fs.readFileSync(swrPath, 'utf-8');
    if (!swrContent.includes('swr')) {
      throw new Error('Expected SWR import in swr-hooks.ts');
    }
    console.log('  swr-hooks.ts generated with SWR hooks ✓');

    // Step 9: Verify guards.ts generated
    console.log('\n=== Step 9: Verify guards.ts generated ===');
    const guardsPath = path.join(tmpDir1, '.trickle', 'guards.ts');
    if (!fs.existsSync(guardsPath)) {
      throw new Error('Expected guards.ts to be generated');
    }
    console.log('  guards.ts generated ✓');

    // Step 10: Verify api-client.ts NOT generated (axios takes priority)
    console.log('\n=== Step 10: Verify fetch client NOT generated (axios priority) ===');
    const fetchClientPath = path.join(tmpDir1, '.trickle', 'api-client.ts');
    if (fs.existsSync(fetchClientPath)) {
      throw new Error('api-client.ts should NOT be generated when axios is present');
    }
    // Also verify react-query hooks NOT generated (not in deps)
    const hooksPath = path.join(tmpDir1, '.trickle', 'hooks.ts');
    if (fs.existsSync(hooksPath)) {
      throw new Error('hooks.ts should NOT be generated when react-query is not in deps');
    }
    console.log('  Fetch client and React Query hooks correctly skipped ✓');

    // Step 11: Test with different deps (react-query + express)
    console.log('\n=== Step 11: Test with react-query + express deps ===');
    const tmpDir2 = createTempProject({
      '@tanstack/react-query': '^5.0.0',
      express: '^4.18.0',
    });
    tmpDirs.push(tmpDir2);
    const autoOut2 = await runCli(['auto'], tmpDir2);

    // Should have hooks.ts (react-query)
    const hooksPath2 = path.join(tmpDir2, '.trickle', 'hooks.ts');
    if (!fs.existsSync(hooksPath2)) {
      throw new Error('Expected hooks.ts for react-query project');
    }
    // Should have handlers.d.ts (express)
    const handlersPath = path.join(tmpDir2, '.trickle', 'handlers.d.ts');
    if (!fs.existsSync(handlersPath)) {
      throw new Error('Expected handlers.d.ts for express project');
    }
    // Should have api-client.ts (no axios, so fetch client)
    const fetchPath2 = path.join(tmpDir2, '.trickle', 'api-client.ts');
    if (!fs.existsSync(fetchPath2)) {
      throw new Error('Expected api-client.ts for project without axios');
    }
    // Should NOT have axios-client.ts
    const axiosPath2 = path.join(tmpDir2, '.trickle', 'axios-client.ts');
    if (fs.existsSync(axiosPath2)) {
      throw new Error('axios-client.ts should NOT be generated without axios dep');
    }
    // Verify detection reasons in output
    if (!autoOut2.includes('@tanstack/react-query')) {
      throw new Error('Expected @tanstack/react-query detection reason');
    }
    if (!autoOut2.includes('express')) {
      throw new Error('Expected express detection reason');
    }
    console.log('  react-query + express project generates correct files ✓');

    // Step 12: Clean shutdown
    console.log('\n=== Step 12: Clean shutdown ===');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('trickle auto detects deps and generates relevant types!\n');

  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    // Clean up temp dirs
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true }); } catch {}
    }
    if (backendProc) { backendProc.kill('SIGTERM'); await sleep(300); }
    process.exit(process.exitCode || 0);
  }
}

run();
