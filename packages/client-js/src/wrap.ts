import { TypeNode, IngestPayload, WrapOptions } from './types';
import { inferType } from './type-inference';
import { hashType } from './type-hash';
import { createTracker } from './proxy-tracker';
import { TypeCache } from './cache';
import { enqueue } from './transport';
import { traceCall, traceReturn } from './call-trace';

const typeCache = new TypeCache();

/** Symbol to mark already-wrapped functions, preventing double-wrap. */
const TRICKLE_WRAPPED = Symbol.for('__trickle_wrapped');

/**
 * Wrap a function to capture runtime type information on each call.
 * The wrapper is completely transparent: same name, same length, same behavior.
 * Errors are always re-thrown after capturing type context.
 */
export function wrapFunction<T extends (...args: any[]) => any>(fn: T, opts: WrapOptions): T {
  if (!opts.enabled) return fn;

  // Prevent double-wrapping (compile hook + load hook may both see the same function)
  if ((fn as any)[TRICKLE_WRAPPED]) return fn;

  const functionKey = `${opts.module}::${opts.functionName}`;

  // Create wrapper with same length using a dynamic approach
  const wrapper = function (this: any, ...args: any[]): any {
    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return fn.apply(this, args);
    }

    let result: any;
    let threwError = false;
    let caughtError: unknown;
    const trackers: Array<{ proxy: unknown; getAccessedPaths: () => Map<string, TypeNode> }> = [];
    const startTime = performance.now();
    const callId = traceCall(opts.functionName, opts.module);

    try {
      // Always pass ORIGINAL args to the function — never proxied ones.
      // Proxied args can break framework internals (Express Router, DI containers, etc.)
      result = fn.apply(this, args);
    } catch (err) {
      threwError = true;
      caughtError = err;

      // Capture error context with timing
      try {
        const durationMs = performance.now() - startTime;
        captureErrorPayload(functionKey, opts, args, trackers, err, durationMs);
        traceReturn(callId, opts.functionName, opts.module, durationMs, (err as Error)?.message);
      } catch {
        // Never let our instrumentation interfere
      }

      // CRITICAL: always re-throw
      throw err;
    }

    // Handle async functions (Promise return)
    if (result !== null && result !== undefined && typeof result === 'object' && typeof result.then === 'function') {
      return result.then(
        (resolved: unknown) => {
          try {
            const durationMs = performance.now() - startTime;
            capturePayload(functionKey, opts, args, trackers, resolved, true, durationMs);
            traceReturn(callId, opts.functionName, opts.module, durationMs);
          } catch {
            // Never let our instrumentation interfere
          }
          return resolved;
        },
        (err: unknown) => {
          try {
            const durationMs = performance.now() - startTime;
            captureErrorPayload(functionKey, opts, args, trackers, err, durationMs);
            traceReturn(callId, opts.functionName, opts.module, durationMs, (err as Error)?.message);
          } catch {
            // Never let our instrumentation interfere
          }
          // Re-throw the original rejection
          throw err;
        },
      );
    }

    // Synchronous return
    try {
      const durationMs = performance.now() - startTime;
      capturePayload(functionKey, opts, args, trackers, result, false, durationMs);
      traceReturn(callId, opts.functionName, opts.module, durationMs);
    } catch {
      // Never let our instrumentation interfere
    }

    return result;
  };

  // Preserve function name and length
  Object.defineProperty(wrapper, 'name', { value: fn.name || opts.functionName, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: fn.length, configurable: true });

  // Copy all own properties from original function to wrapper.
  // This is critical for Express apps (app.get, app.listen, etc.),
  // class constructors with static methods, and other functions with properties.
  for (const key of Object.getOwnPropertyNames(fn)) {
    if (key === 'name' || key === 'length' || key === 'prototype' || key === 'caller' || key === 'arguments') continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(fn, key);
      if (desc) Object.defineProperty(wrapper, key, desc);
    } catch {
      // Some properties may not be configurable
    }
  }
  // Also copy symbol properties
  for (const sym of Object.getOwnPropertySymbols(fn)) {
    try {
      const desc = Object.getOwnPropertyDescriptor(fn, sym);
      if (desc) Object.defineProperty(wrapper, sym, desc);
    } catch {}
  }
  // Copy prototype for constructor functions
  if (fn.prototype && fn.prototype !== Object.prototype) {
    wrapper.prototype = fn.prototype;
  }

  // Mark as wrapped to prevent double-wrapping
  (wrapper as any)[TRICKLE_WRAPPED] = true;

  return wrapper as unknown as T;
}

/**
 * Capture and enqueue a successful invocation's type data.
 */
function capturePayload(
  functionKey: string,
  opts: WrapOptions,
  originalArgs: unknown[],
  trackers: Array<{ proxy: unknown; getAccessedPaths: () => Map<string, TypeNode> }>,
  returnValue: unknown,
  isAsync: boolean = false,
  durationMs?: number,
): void {
  // Build args type as a tuple
  const argsType = buildArgsType(originalArgs, trackers, opts.maxDepth);
  const returnType = inferType(returnValue, opts.maxDepth);

  const hash = hashType(argsType, returnType);

  // Check cache
  if (!typeCache.shouldSend(functionKey, hash)) {
    return;
  }

  typeCache.markSent(functionKey, hash);

  const payload: IngestPayload = {
    functionName: opts.functionName,
    module: opts.module,
    language: 'js',
    environment: opts.environment,
    typeHash: hash,
    argsType,
    returnType,
    sampleInput: sanitizeSample(originalArgs),
    sampleOutput: sanitizeSample(returnValue),
  };

  if (isAsync) {
    payload.isAsync = true;
  }

  if (opts.paramNames && opts.paramNames.length > 0) {
    payload.paramNames = opts.paramNames;
  }

  if (durationMs !== undefined) {
    payload.durationMs = Math.round(durationMs * 100) / 100;
  }

  enqueue(payload);
}

/**
 * Capture type context for a failed invocation.
 */
function captureErrorPayload(
  functionKey: string,
  opts: WrapOptions,
  originalArgs: unknown[],
  trackers: Array<{ proxy: unknown; getAccessedPaths: () => Map<string, TypeNode> }>,
  error: unknown,
  durationMs?: number,
): void {
  const argsType = buildArgsType(originalArgs, trackers, opts.maxDepth);
  const returnType: TypeNode = { kind: 'unknown' };
  const hash = hashType(argsType, returnType);

  // Always send error payloads (don't cache-skip them)

  const errorInfo = extractErrorInfo(error);

  // Collect accessed paths from trackers as "variable" context
  const accessedPaths: Record<string, TypeNode> = {};
  for (const tracker of trackers) {
    const paths = tracker.getAccessedPaths();
    for (const [path, type] of paths) {
      accessedPaths[path] = type;
    }
  }

  const payload: IngestPayload = {
    functionName: opts.functionName,
    module: opts.module,
    language: 'js',
    environment: opts.environment,
    typeHash: hash,
    argsType,
    returnType,
    sampleInput: sanitizeSample(originalArgs),
    error: {
      type: errorInfo.type,
      message: errorInfo.message,
      stackTrace: errorInfo.stack,
      argsSnapshot: sanitizeSample(originalArgs),
    },
  };

  enqueue(payload);
}

/**
 * Build a tuple TypeNode for the args array.
 * Uses tracker data for objects/arrays that were proxied (captures the "shape" actually used),
 * and falls back to full inference for primitives and untracked args.
 */
function buildArgsType(
  originalArgs: unknown[],
  trackers: Array<{ proxy: unknown; getAccessedPaths: () => Map<string, TypeNode> }>,
  maxDepth: number,
): TypeNode {
  const elements: TypeNode[] = originalArgs.map(arg => inferType(arg, maxDepth));

  if (elements.length === 0) {
    return { kind: 'tuple', elements: [] };
  }

  return { kind: 'tuple', elements };
}

/**
 * Extract error information safely.
 */
function extractErrorInfo(err: unknown): { type: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      type: err.constructor.name || 'Error',
      message: err.message,
      stack: err.stack,
    };
  }

  if (typeof err === 'string') {
    return { type: 'String', message: err };
  }

  return {
    type: typeof err,
    message: String(err),
  };
}

/**
 * Sanitize a sample value for safe serialization.
 * Truncates large strings, limits array lengths, strips functions.
 */
function sanitizeSample(value: unknown, depth: number = 3): unknown {
  if (depth <= 0) return '[truncated]';
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > 200 ? s.substring(0, 200) + '...' : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`;

  if (Array.isArray(value)) {
    const sample = value.slice(0, 5);
    return sample.map(item => sanitizeSample(item, depth - 1));
  }

  if (t === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return { error: value.message };
    if (value instanceof Map) return `[Map: ${value.size} entries]`;
    if (value instanceof Set) return `[Set: ${value.size} items]`;

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = Object.keys(obj).slice(0, 20);
    for (const key of keys) {
      try {
        result[key] = sanitizeSample(obj[key], depth - 1);
      } catch {
        result[key] = '[unreadable]';
      }
    }
    return result;
  }

  return String(value);
}

export { typeCache };
