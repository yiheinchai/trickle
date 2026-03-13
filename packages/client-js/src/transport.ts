import * as fs from 'fs';
import * as pathMod from 'path';
import { IngestPayload, GlobalOpts } from './types';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const DEFAULT_BATCH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 50;

let backendUrl = 'http://localhost:4888';
let batchIntervalMs = DEFAULT_BATCH_INTERVAL_MS;
let maxBatchSize = DEFAULT_MAX_BATCH_SIZE;
let enabled = true;
let debug = false;
let localMode = process.env.TRICKLE_LOCAL === '1';
let localFilePath = '';

let queue: IngestPayload[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlushing = false;

/**
 * Configure the transport layer with global options.
 */
export function configure(opts: GlobalOpts): void {
  backendUrl = opts.backendUrl || backendUrl;
  batchIntervalMs = opts.batchIntervalMs || DEFAULT_BATCH_INTERVAL_MS;
  maxBatchSize = opts.maxBatchSize || DEFAULT_MAX_BATCH_SIZE;
  enabled = opts.enabled !== false;
  debug = opts.debug === true;

  // Check for local/file-based mode
  if (process.env.TRICKLE_LOCAL === '1') {
    localMode = true;
    // Auto-detect Lambda: use /tmp/.trickle (writable) instead of cwd (read-only in Lambda)
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const defaultDir = isLambda ? '/tmp/.trickle' : pathMod.join(process.cwd(), '.trickle');
    const dir = process.env.TRICKLE_LOCAL_DIR || defaultDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    localFilePath = pathMod.join(dir, 'observations.jsonl');
    if (debug) {
      console.log(`[trickle] Local mode: writing to ${localFilePath}`);
    }
    return; // no timer needed for file mode
  }

  // Restart the flush timer with new interval
  stopTimer();
  startTimer();
}

/**
 * Enqueue a payload for batched sending.
 */
export function enqueue(payload: IngestPayload): void {
  if (!enabled) return;

  // Local file mode: append directly to JSONL file
  if (localMode && localFilePath) {
    try {
      fs.appendFileSync(localFilePath, JSON.stringify(payload) + '\n');
    } catch {
      // Never crash user's app
    }
    return;
  }

  queue.push(payload);

  // Flush immediately if batch is full
  if (queue.length >= maxBatchSize) {
    flush().catch(silentError);
  }

  // Ensure timer is running
  if (!flushTimer) {
    startTimer();
  }
}

/**
 * Flush all queued payloads to the backend.
 * Returns a promise that resolves when the flush completes.
 */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  if (isFlushing) return;

  isFlushing = true;
  const batch = queue.splice(0);

  try {
    await sendBatch(batch);
  } catch {
    // Batch is already dropped after max retries — nothing more to do
    if (debug) {
      console.warn('[trickle] Failed to flush batch, data dropped');
    }
  } finally {
    isFlushing = false;
  }
}

/**
 * Send a batch with exponential backoff retry.
 */
async function sendBatch(batch: IngestPayload[]): Promise<void> {
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${backendUrl}/api/ingest/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payloads: batch }),
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (response.ok) {
        if (debug) {
          console.log(`[trickle] Sent batch of ${batch.length} events`);
        }
        return;
      }

      // Server error — retry
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      // Client error (4xx) or final attempt — drop
      if (debug) {
        console.warn(`[trickle] Backend returned ${response.status}, dropping batch`);
      }
      return;
    } catch (err: unknown) {
      if (attempt < MAX_RETRIES) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      // Final attempt failed
      if (debug) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[trickle] Could not reach backend after ${MAX_RETRIES + 1} attempts: ${msg}`);
      }
      return;
    }
  }
}

function startTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch(silentError);
  }, batchIntervalMs);

  // Don't keep the process alive just for trickle
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
}

function stopTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function silentError(): void {
  // Intentionally empty — never crash user's app
}

// Register process exit handler to flush remaining events
if (typeof process !== 'undefined' && process.on) {
  let flushing = false;
  process.on('beforeExit', () => {
    if (flushing || queue.length === 0) return;
    flushing = true;
    flush().catch(silentError).finally(() => { flushing = false; stopTimer(); });
  });

  // SIGTERM / SIGINT: attempt a sync-ish flush
  const exitHandler = () => {
    flush().catch(silentError);
  };
  process.on('SIGTERM', exitHandler);
  process.on('SIGINT', exitHandler);
}

/**
 * Get the current queue length (for testing/debugging).
 */
export function getQueueLength(): number {
  return queue.length;
}

/**
 * Reset the transport state (for testing).
 */
export function reset(): void {
  queue = [];
  stopTimer();
  isFlushing = false;
}
