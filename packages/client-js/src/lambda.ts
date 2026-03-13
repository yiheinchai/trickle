/**
 * trickle/lambda — Zero-config observability for AWS Lambda functions.
 *
 * Wraps a Lambda handler to:
 * 1. Auto-instrument all functions with type observation
 * 2. Write observations to /tmp/.trickle/ (Lambda's writable filesystem)
 *    OR send to TRICKLE_BACKEND_URL if set
 * 3. Flush all pending observations synchronously before Lambda freezes
 *
 * Usage:
 *
 *   import { wrapLambda } from 'trickle-observe/lambda';
 *
 *   export const handler = wrapLambda(async (event, context) => {
 *     const result = await processOrder(event.orderId);
 *     return { statusCode: 200, body: JSON.stringify(result) };
 *   });
 *
 * OR zero-code via NODE_OPTIONS:
 *
 *   NODE_OPTIONS="--require trickle-observe/auto-env" TRICKLE_AUTO=1
 *
 * Environment variables:
 *   TRICKLE_BACKEND_URL    — Send observations to HTTP backend (optional)
 *   TRICKLE_LOCAL_DIR      — Override local dir (default: /tmp/.trickle)
 *   TRICKLE_DEBUG          — Set to "1" for debug logging
 *   TRICKLE_OBSERVE_INCLUDE — Comma-separated substrings to observe
 *   TRICKLE_OBSERVE_EXCLUDE — Comma-separated substrings to skip
 */

import * as path from 'path';
import * as fs from 'fs';
import { configure, flush } from './transport';
import { initVarTracer } from './trace-var';
// Install Module._compile and Module._load hooks for auto-instrumentation
import './observe-register';

export type LambdaEvent = Record<string, unknown>;
export type LambdaContext = {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  awsRequestId: string;
  remainingTimeInMillis?: () => number;
  [key: string]: unknown;
};
export type LambdaHandler<E = LambdaEvent, R = unknown> = (
  event: E,
  context: LambdaContext,
) => Promise<R>;

let initialized = false;

function initOnce() {
  if (initialized) return;
  initialized = true;

  const debug = process.env.TRICKLE_DEBUG === '1';
  const dir = process.env.TRICKLE_LOCAL_DIR || '/tmp/.trickle';

  // Ensure /tmp/.trickle exists (writable in Lambda, unlike /var/task)
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  if (process.env.TRICKLE_BACKEND_URL) {
    // HTTP mode: send to developer's backend (e.g. via ngrok)
    configure({
      backendUrl: process.env.TRICKLE_BACKEND_URL,
      batchIntervalMs: 100,    // aggressive batching for Lambda
      enabled: true,
      debug,
      environment: 'node',
    });
    if (debug) console.log(`[trickle/lambda] HTTP mode → ${process.env.TRICKLE_BACKEND_URL}`);
  } else {
    // Local file mode: write to /tmp/.trickle/observations.jsonl
    process.env.TRICKLE_LOCAL = '1';
    process.env.TRICKLE_LOCAL_DIR = dir;
    configure({ backendUrl: 'http://localhost:4888', batchIntervalMs: 2000, enabled: true, debug, environment: 'node' });
    if (debug) console.log(`[trickle/lambda] Local mode → ${dir}/observations.jsonl`);
  }

  // Initialize variable tracer (writes to variables.jsonl)
  initVarTracer({ debug });
}

/**
 * Wrap a Lambda handler with trickle observability.
 *
 * Instruments all called functions automatically, writes type observations
 * to /tmp/.trickle/, and flushes before Lambda freezes the process.
 */
export function wrapLambda<E = LambdaEvent, R = unknown>(
  handler: LambdaHandler<E, R>,
): LambdaHandler<E, R> {
  return async (event: E, context: LambdaContext): Promise<R> => {
    initOnce();

    const debug = process.env.TRICKLE_DEBUG === '1';
    const startMs = Date.now();

    try {
      const result = await handler(event, context);

      // Flush pending HTTP observations before Lambda freezes the process.
      // File-mode writes are already synchronous, so no flush needed there.
      if (process.env.TRICKLE_BACKEND_URL) {
        await flush();
      }

      if (debug) {
        const dir = process.env.TRICKLE_LOCAL_DIR || '/tmp/.trickle';
        const elapsed = Date.now() - startMs;
        const varsFile = path.join(dir, 'variables.jsonl');
        try {
          const size = fs.statSync(varsFile).size;
          console.log(`[trickle/lambda] Flushed in ${elapsed}ms, observations: ${varsFile} (${size}b)`);
        } catch {}
      }

      return result;
    } catch (err) {
      // Flush even on errors so partial observations are captured
      if (process.env.TRICKLE_BACKEND_URL) {
        await flush().catch(() => {});
      }
      throw err;
    }
  };
}

/**
 * Print the contents of the local trickle observations directory to stdout
 * as newline-delimited JSON. Useful for inspecting Lambda observations in
 * CloudWatch Logs when TRICKLE_BACKEND_URL is not set.
 *
 * Call at the end of your handler to stream observations to CloudWatch:
 *
 *   export const handler = wrapLambda(async (event) => {
 *     const result = await processOrder(event.orderId);
 *     printObservations();  // → streamed to CloudWatch Logs
 *     return result;
 *   });
 */
export function printObservations(): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || '/tmp/.trickle';
  for (const file of ['variables.jsonl', 'observations.jsonl']) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) {
        for (const line of content.split('\n')) {
          if (line.trim()) {
            // Prefix so trickle CLI can grep from CloudWatch Logs
            console.log(`[trickle] ${line}`);
          }
        }
      }
    } catch { /* file may not exist yet */ }
  }
}
