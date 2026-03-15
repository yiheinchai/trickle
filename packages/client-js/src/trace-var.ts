/**
 * Variable-level tracing — captures the runtime type and sample value
 * of variable assignments within function bodies.
 *
 * This is injected by the Module._compile source transform. After each
 * `const/let/var x = expr;` statement, the transform inserts:
 *
 *   __trickle_tv(x, 'x', 42, 'my-module', '/path/to/file.ts');
 *
 * The traceVar function:
 * 1. Infers the TypeNode from the runtime value
 * 2. Captures a sanitized sample value
 * 3. Appends to .trickle/variables.jsonl
 * 4. Caches by (file:line:varName + typeHash) to avoid duplicates
 */

import * as fs from 'fs';
import * as path from 'path';
import { TypeNode } from './types';
import { inferType } from './type-inference';
import { hashType } from './type-hash';

/** Where to write variable observations */
let varsFilePath = '';
let debugMode = false;

/** Cache: "file:line:varName" → { fingerprint, timestamp } for value-aware dedup */
const varCache = new Map<string, { fp: string; ts: number }>();
/** Per-line sample count to avoid loop variable spam */
const sampleCount = new Map<string, number>();
const MAX_SAMPLES_PER_LINE = 5;

/** Batch buffer for writing — avoids one fs.appendFileSync per variable */
let varBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER_SIZE = 100;

export interface VariableObservation {
  kind: 'variable';
  varName: string;
  line: number;
  module: string;
  file: string;
  type: TypeNode;
  typeHash: string;
  sample: unknown;
}

/**
 * Initialize the variable tracer.
 * Called once during observe-register setup.
 */
export function initVarTracer(opts: { debug?: boolean } = {}): void {
  debugMode = opts.debug === true;
  // Auto-detect Lambda: use /tmp/.trickle (writable) instead of cwd (read-only in Lambda)
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const defaultDir = isLambda ? '/tmp/.trickle' : path.join(process.cwd(), '.trickle');
  const dir = process.env.TRICKLE_LOCAL_DIR || defaultDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  varsFilePath = path.join(dir, 'variables.jsonl');

  if (debugMode) {
    console.log(`[trickle/vars] Variable tracing enabled → ${varsFilePath}`);
  }
}

/**
 * Trace a variable's runtime value.
 * Called by injected code after each variable declaration.
 *
 * @param value - The variable's current value (already computed)
 * @param varName - The variable name in source
 * @param line - Line number in source file
 * @param moduleName - Module name (derived from filename)
 * @param filePath - Absolute path to source file
 */
export function traceVar(
  value: unknown,
  varName: string,
  line: number,
  moduleName: string,
  filePath: string,
): void {
  // Auto-initialize if not yet done (needed for Vite/Vitest worker processes)
  if (!varsFilePath) {
    initVarTracer();
    if (!varsFilePath) return;
  }

  try {
    const type = inferType(value, 3);

    // Create a stable hash for dedup
    const dummyArgs: TypeNode = { kind: 'tuple', elements: [] };
    const typeHash = hashType(dummyArgs, type);

    // Per-line sample count limit: stop after N samples to avoid loop spam
    const cacheKey = `${filePath}:${line}:${varName}`;
    const cnt = sampleCount.get(cacheKey) || 0;
    if (cnt >= MAX_SAMPLES_PER_LINE) return;

    // Value-aware dedup: re-send if value changed or 10s elapsed
    const t = typeof value;
    const fp = (t === 'string' || t === 'number' || t === 'boolean' || value === null || value === undefined)
      ? String(value).substring(0, 60)
      : typeHash;
    const now = Date.now();
    const prev = varCache.get(cacheKey);
    if (prev && prev.fp === fp && (now - prev.ts) < 10000) return;
    varCache.set(cacheKey, { fp, ts: now });
    sampleCount.set(cacheKey, cnt + 1);

    const sample = sanitizeVarSample(value);

    const observation: VariableObservation = {
      kind: 'variable',
      varName,
      line,
      module: moduleName,
      file: filePath,
      type,
      typeHash,
      sample,
    };

    // Buffer the write
    varBuffer.push(JSON.stringify(observation));

    if (varBuffer.length >= MAX_BUFFER_SIZE) {
      flushVarBuffer();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushVarBuffer();
      }, FLUSH_INTERVAL_MS);
      if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
        flushTimer.unref();
      }
    }
  } catch {
    // Never crash user's app
  }
}

/**
 * Flush buffered variable observations to disk.
 */
function flushVarBuffer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (varBuffer.length === 0) return;

  const lines = varBuffer.join('\n') + '\n';
  varBuffer = [];

  try {
    fs.appendFileSync(varsFilePath, lines);
  } catch {
    // Never crash user's app
  }
}

/**
 * Sanitize a variable value for safe serialization.
 * More aggressive truncation than function samples since there are many more variables.
 */
function sanitizeVarSample(value: unknown, depth: number = 3): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  // Primitives are always safe to return at any depth
  if (t === 'string') {
    const s = value as string;
    return s.length > 60 ? s.substring(0, 60) + '...' : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`;

  if (depth <= 0) return '[...]';

  if (Array.isArray(value)) {
    return value.slice(0, 3).map(item => sanitizeVarSample(item, depth - 1));
  }

  if (t === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return { error: value.message };
    if (value instanceof Map) return `[Map: ${value.size} entries]`;
    if (value instanceof Set) return `[Set: ${value.size} items]`;
    if (value instanceof Promise) return '[Promise]';

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = Object.keys(obj).slice(0, 10);
    for (const key of keys) {
      try {
        result[key] = sanitizeVarSample(obj[key], depth - 1);
      } catch {
        result[key] = '[unreadable]';
      }
    }
    return result;
  }

  return String(value);
}

// Flush on process exit — use 'exit' event (synchronous, fires even on process.exit())
// because Vitest workers and forked processes may exit without 'beforeExit'.
// flushVarBuffer uses fs.appendFileSync so it's safe in the 'exit' handler.
if (typeof process !== 'undefined' && process.on) {
  const exitFlush = () => { flushVarBuffer(); };
  process.on('exit', exitFlush);
  process.on('beforeExit', exitFlush);
  process.on('SIGTERM', exitFlush);
  process.on('SIGINT', exitFlush);
}
