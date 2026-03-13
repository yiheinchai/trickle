/**
 * ESM auto-observation registration script.
 *
 * Usage:
 *   node --import trickle/observe-esm app.mjs
 *
 * Registers ESM loader hooks that wrap exported functions from user modules
 * with trickle observation — capturing types and sample data for every call.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksPath = join(__dirname, 'observe-esm-hooks.mjs');

const backendUrl = process.env.TRICKLE_BACKEND_URL || 'http://localhost:4888';
const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';

if (debug) {
  console.log(`[trickle/esm] Registering ESM observation hooks (backend: ${backendUrl})`);
}

register(pathToFileURL(hooksPath).href, {
  parentURL: import.meta.url,
  data: {
    wrapperPath: join(__dirname, 'dist', 'wrap.js'),
    transportPath: join(__dirname, 'dist', 'transport.js'),
    envDetectPath: join(__dirname, 'dist', 'env-detect.js'),
    traceVarPath: join(__dirname, 'dist', 'trace-var.js'),
    backendUrl,
    debug,
    includePatterns: process.env.TRICKLE_OBSERVE_INCLUDE
      ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
      : [],
    excludePatterns: process.env.TRICKLE_OBSERVE_EXCLUDE
      ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
      : [],
  },
});
