/**
 * trickle/auto-esm — runtime type capture for ESM modules.
 *
 * Usage:
 *   node --import trickle/auto-esm app.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TRICKLE_LOCAL = process.env.TRICKLE_LOCAL || '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hooksPath = join(__dirname, 'observe-esm-hooks.mjs');
const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';

if (debug) {
  console.log(`[trickle/auto-esm] Registering ESM observation hooks`);
}

register(pathToFileURL(hooksPath).href, {
  parentURL: import.meta.url,
  data: {
    wrapperPath: join(__dirname, 'dist', 'wrap.js'),
    transportPath: join(__dirname, 'dist', 'transport.js'),
    envDetectPath: join(__dirname, 'dist', 'env-detect.js'),
    traceVarPath: join(__dirname, 'dist', 'trace-var.js'),
    backendUrl: process.env.TRICKLE_BACKEND_URL || 'http://localhost:4888',
    debug,
    includePatterns: process.env.TRICKLE_OBSERVE_INCLUDE
      ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
      : [],
    excludePatterns: process.env.TRICKLE_OBSERVE_EXCLUDE
      ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
      : [],
  },
});
