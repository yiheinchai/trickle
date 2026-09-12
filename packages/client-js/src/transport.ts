import * as fs from 'fs';
import * as pathMod from 'path';
import { IngestPayload, GlobalOpts } from './types';

let enabled = true;
let debug = false;
let localFilePath = '';

/**
 * Configure the transport layer with global options.
 * Observations are always written to local `.trickle/observations.jsonl`.
 */
export function configure(opts: GlobalOpts): void {
  enabled = opts.enabled !== false;
  debug = opts.debug === true;
  ensureLocalFile();
  if (debug) {
    console.log(`[trickle] Local mode: writing to ${localFilePath}`);
  }
}

function ensureLocalFile(): string {
  if (localFilePath) return localFilePath;
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const defaultDir = isLambda ? '/tmp/.trickle' : pathMod.join(process.cwd(), '.trickle');
  const dir = process.env.TRICKLE_LOCAL_DIR || defaultDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  localFilePath = pathMod.join(dir, 'observations.jsonl');
  return localFilePath;
}

/**
 * Enqueue a payload by appending it to the local JSONL file.
 */
export function enqueue(payload: IngestPayload): void {
  if (!enabled) return;
  try {
    const file = ensureLocalFile();
    fs.appendFileSync(file, JSON.stringify(payload) + '\n');
  } catch {
    // Never crash user's app
  }
}

/**
 * Flush remaining events. Writes are synchronous, so this is a no-op
 * kept for API compatibility with `trickle.flush()`.
 */
export async function flush(): Promise<void> {
  // Local JSONL writes are synchronous — nothing to flush.
}

/**
 * Get the current queue length (for testing/debugging).
 */
export function getQueueLength(): number {
  return 0;
}

/**
 * Reset the transport state (for testing).
 */
export function reset(): void {
  localFilePath = '';
}
