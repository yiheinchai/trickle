/**
 * trickle/auto — Zero-config type generation.
 *
 * Add ONE LINE to your app and types appear automatically:
 *
 *   require('trickle/auto');
 *
 * This module:
 * 1. Forces local mode (no backend needed)
 * 2. Activates the observe-register hooks (instruments all user functions)
 * 3. Runs a background timer that generates .d.ts files from observations
 * 4. On process exit, does a final type generation
 *
 * No CLI. No backend. No configuration. Just types.
 */

// Force local mode BEFORE importing observe-register (which calls configure)
process.env.TRICKLE_LOCAL = '1';

// Import the observe-register hooks (instruments all functions)
import './observe-register';

// Import the auto codegen
import { generateTypes, injectTypes, generateCoverageReport } from './auto-codegen';

const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';
let lastFunctionCount = 0;
let generationCount = 0;

/**
 * Run type generation and optionally log results.
 */
function runGeneration(isFinal: boolean): void {
  try {
    const count = generateTypes();
    if (count === -1) return; // no change

    if (count > 0) {
      generationCount++;
      if (debug || (count > lastFunctionCount)) {
        const newTypes = count - lastFunctionCount;
        if (newTypes > 0 && generationCount > 1) {
          // Only log after first generation (avoid noise on startup)
          console.log(`[trickle/auto] +${newTypes} type(s) generated (${count} total)`);
        }
      }
      lastFunctionCount = count;
    }

    if (isFinal && lastFunctionCount > 0) {
      console.log(`[trickle/auto] ${lastFunctionCount} function type(s) written to .d.ts`);
      // Inject JSDoc into source files if TRICKLE_INJECT=1
      try {
        const injected = injectTypes();
        if (injected > 0) {
          console.log(`[trickle/auto] ${injected} function(s) annotated with JSDoc in source`);
        }
      } catch { /* don't crash */ }
      // Print coverage report if TRICKLE_COVERAGE=1
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

// Don't keep the process alive just for type generation
if (timer && typeof timer === 'object' && 'unref' in timer) {
  (timer as any).unref();
}

// Also do a first check after 1 second
const initialTimer = setTimeout(() => runGeneration(false), 1000);
if (initialTimer && typeof initialTimer === 'object' && 'unref' in initialTimer) {
  (initialTimer as any).unref();
}

// Final generation on exit
if (typeof process !== 'undefined' && process.on) {
  process.on('beforeExit', () => {
    runGeneration(true);
  });

  // On SIGTERM/SIGINT, do final generation
  const exitHandler = () => {
    clearInterval(timer);
    runGeneration(true);
  };
  process.on('SIGTERM', exitHandler);
  process.on('SIGINT', exitHandler);
}
