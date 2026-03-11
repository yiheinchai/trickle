/**
 * trickle/auto-esm — Zero-config type generation for ESM modules.
 *
 * Usage:
 *   node --import trickle/auto-esm app.mjs
 *
 * This module:
 * 1. Forces local mode (no backend needed)
 * 2. Registers ESM loader hooks that wrap exported functions
 * 3. Runs a background timer that generates .d.ts files from observations
 * 4. On process exit, does a final type generation
 *
 * No CLI. No backend. No configuration. Just types.
 * Works for ALL ESM modules (import/export syntax).
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Force local mode BEFORE anything else
process.env.TRICKLE_LOCAL = '1';

const hooksPath = join(__dirname, 'observe-esm-hooks.mjs');
const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';

if (debug) {
  console.log(`[trickle/auto-esm] Registering ESM observation hooks (local mode)`);
}

// Register the ESM loader hooks
register(pathToFileURL(hooksPath).href, {
  parentURL: import.meta.url,
  data: {
    wrapperPath: join(__dirname, 'dist', 'wrap.js'),
    transportPath: join(__dirname, 'dist', 'transport.js'),
    envDetectPath: join(__dirname, 'dist', 'env-detect.js'),
    backendUrl: 'http://localhost:4888', // unused in local mode but configure() needs it
    debug,
    includePatterns: process.env.TRICKLE_OBSERVE_INCLUDE
      ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
      : [],
    excludePatterns: process.env.TRICKLE_OBSERVE_EXCLUDE
      ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
      : [],
  },
});

// Also configure transport in the main thread for local mode
const { configure } = require(join(__dirname, 'dist', 'transport.js'));
configure({
  backendUrl: 'http://localhost:4888',
  batchIntervalMs: 2000,
  debug,
  enabled: true,
});

// Start background codegen
const { generateTypes, injectTypes, generateCoverageReport } = require(join(__dirname, 'dist', 'auto-codegen.js'));

let lastFunctionCount = 0;
let generationCount = 0;

function runGeneration(isFinal) {
  try {
    const count = generateTypes();
    if (count === -1) return;

    if (count > 0) {
      generationCount++;
      if (debug || (count > lastFunctionCount)) {
        const newTypes = count - lastFunctionCount;
        if (newTypes > 0 && generationCount > 1) {
          console.log(`[trickle/auto-esm] +${newTypes} type(s) generated (${count} total)`);
        }
      }
      lastFunctionCount = count;
    }

    if (isFinal && lastFunctionCount > 0) {
      console.log(`[trickle/auto-esm] ${lastFunctionCount} function type(s) written to .d.ts`);
      try {
        const injected = injectTypes();
        if (injected > 0) {
          console.log(`[trickle/auto-esm] ${injected} function(s) annotated with JSDoc in source`);
        }
      } catch { /* don't crash */ }
      try {
        const report = generateCoverageReport();
        if (report) console.log(report);
      } catch { /* don't crash */ }
    }
  } catch {
    // Never crash user's app
  }
}

// Background timer — regenerate types every 3 seconds
const timer = setInterval(() => runGeneration(false), 3000);
if (timer && typeof timer === 'object' && 'unref' in timer) {
  timer.unref();
}

// First check after 1 second
const initialTimer = setTimeout(() => runGeneration(false), 1000);
if (initialTimer && typeof initialTimer === 'object' && 'unref' in initialTimer) {
  initialTimer.unref();
}

// Final generation on exit
process.on('beforeExit', () => {
  runGeneration(true);
});

const exitHandler = () => {
  clearInterval(timer);
  runGeneration(true);
};
process.on('SIGTERM', exitHandler);
process.on('SIGINT', exitHandler);
