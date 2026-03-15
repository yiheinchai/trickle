import * as fs from 'fs';
import * as pathMod from 'path';
import { TypeNode, IngestPayload, WrapOptions } from './types';
import { inferType } from './type-inference';
import { hashType } from './type-hash';
import { TypeCache } from './cache';
import { enqueue } from './transport';
import { detectEnvironment } from './env-detect';
import { withRequestContext } from './request-context';
import { traceCall, traceReturn } from './call-trace';

const expressCache = new TypeCache();

/** Options shared across Express instrumentation. */
interface ExpressInstrumentOpts {
  enabled: boolean;
  environment: string;
  sampleRate: number;
  maxDepth: number;
}

/**
 * Extract the interesting parts of an Express request as a plain object
 * suitable for type inference. We deliberately avoid the full req object
 * because it is enormous and contains circular references.
 */
function extractRequestInput(req: any): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  try {
    if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
      input.body = req.body;
    }
  } catch {
    // body might not be readable
  }

  try {
    if (req.params && Object.keys(req.params).length > 0) {
      input.params = req.params;
    }
  } catch {
    // ignore
  }

  try {
    if (req.query && Object.keys(req.query).length > 0) {
      input.query = req.query;
    }
  } catch {
    // ignore
  }

  return input;
}

/**
 * Sanitize a sample value for safe serialization (local copy to avoid circular import).
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
    return value.slice(0, 5).map(item => sanitizeSample(item, depth - 1));
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

/**
 * Write an error record to .trickle/errors.jsonl so that `trickle monitor`
 * and `trickle heal` can detect runtime errors from Express handlers.
 */
function writeErrorToFile(error: unknown, input: Record<string, unknown>, routeName: string): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const defaultDir = isLambda ? '/tmp/.trickle' : pathMod.join(process.cwd(), '.trickle');
    const dir = process.env.TRICKLE_LOCAL_DIR || defaultDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    // Extract file and line from stack trace
    const stackLines = (err.stack || '').split('\n');
    let errorFile: string | undefined;
    let errorLine: number | undefined;
    for (const sl of stackLines.slice(1)) {
      const m = sl.match(/\((.+):(\d+):\d+\)/) || sl.match(/at (.+):(\d+):\d+/);
      if (m && !m[1].includes('node_modules') && !m[1].includes('node:') && !m[1].includes('trickle')) {
        errorFile = m[1];
        errorLine = parseInt(m[2]);
        break;
      }
    }

    const record = {
      kind: 'error',
      error: err.message,
      type: err.constructor?.name || 'Error',
      message: err.message,
      file: errorFile,
      line: errorLine,
      stack: stackLines.slice(0, 6).join('\n'),
      route: routeName,
      request: input,
      timestamp: new Date().toISOString(),
    };

    const errorsFile = pathMod.join(dir, 'errors.jsonl');
    fs.appendFileSync(errorsFile, JSON.stringify(record) + '\n');
  } catch {
    // Never crash the user's app
  }
}

/**
 * Emit a type payload for a single Express route invocation.
 */
function emitExpressPayload(
  functionName: string,
  environment: string,
  maxDepth: number,
  input: Record<string, unknown>,
  output: unknown,
  error?: unknown,
  durationMs?: number,
): void {
  try {
    const functionKey = `express::${functionName}`;
    const argsType = inferType(input, maxDepth);
    const returnType = error ? ({ kind: 'unknown' } as TypeNode) : inferType(output, maxDepth);
    const hash = hashType(argsType, returnType);

    // For errors, always send. For success, use cache.
    if (!error && !expressCache.shouldSend(functionKey, hash)) {
      return;
    }

    if (!error) {
      expressCache.markSent(functionKey, hash);
    }

    const payload: IngestPayload = {
      functionName,
      module: 'express',
      language: 'js',
      environment,
      typeHash: hash,
      argsType,
      returnType,
      sampleInput: sanitizeSample(input),
      sampleOutput: error ? undefined : sanitizeSample(output),
    };

    if (durationMs !== undefined) {
      payload.durationMs = Math.round(durationMs * 100) / 100;
    }

    if (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      payload.error = {
        type: err.constructor?.name || 'Error',
        message: err.message,
        stackTrace: err.stack,
        argsSnapshot: sanitizeSample(input),
      };
      // Also write to errors.jsonl for monitor/heal detection
      writeErrorToFile(error, input, functionName);
    }

    enqueue(payload);
  } catch {
    // Never crash the user's app
  }
}

/**
 * Wrap a single Express route handler so that it captures request input
 * (body, params, query) and response output (json/send payloads) as type data.
 */
function wrapExpressHandler(
  handler: Function,
  routeName: string,
  opts: ExpressInstrumentOpts,
): Function {
  const wrapped = function (this: any, req: any, res: any, next: any) {
    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return handler.call(this, req, res, next);
    }

    const self = this;

    // Wrap entire handler execution in request context so downstream calls get a request ID
    let returnValue: any;
    withRequestContext(req, () => {
      returnValue = _executeHandler(self, handler, req, res, next, routeName, opts);
    });
    return returnValue;
  };

  function _executeHandler(
    self: any,
    handler: Function,
    req: any,
    res: any,
    next: any,
    routeName: string,
    opts: ExpressInstrumentOpts,
  ): any {
    const input = extractRequestInput(req);
    let captured = false;
    const startTime = performance.now();
    const callId = traceCall(routeName, 'express');

    // Intercept res.json()
    const originalJson = res.json;
    if (typeof originalJson === 'function') {
      res.json = function (data: any) {
        if (!captured) {
          captured = true;
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'express', durationMs);
          emitExpressPayload(routeName, opts.environment, opts.maxDepth, input, data, undefined, durationMs);
        }
        res.json = originalJson; // restore
        return originalJson.call(res, data);
      };
    }

    // Intercept res.send()
    const originalSend = res.send;
    if (typeof originalSend === 'function') {
      res.send = function (data: any) {
        if (!captured) {
          captured = true;
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'express', durationMs);
          // Only capture non-string data as typed output; strings are usually HTML
          const output = typeof data === 'string' ? { __html: true } : data;
          emitExpressPayload(routeName, opts.environment, opts.maxDepth, input, output, undefined, durationMs);
        }
        res.send = originalSend; // restore
        return originalSend.call(res, data);
      };
    }

    // Wrap next to capture errors passed via next(err)
    const wrappedNext = function (err?: any) {
      if (err && !captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'express', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
        emitExpressPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      }
      if (typeof next === 'function') {
        return next(err);
      }
    };

    try {
      const result = handler.call(self, req, res, wrappedNext);

      // Handle async handlers that return a promise
      if (result && typeof result === 'object' && typeof result.then === 'function') {
        return result.catch((err: unknown) => {
          if (!captured) {
            captured = true;
            const durationMs = performance.now() - startTime;
            traceReturn(callId, routeName, 'express', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
            emitExpressPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
          }
          // Re-throw so Express error handling picks it up
          throw err;
        });
      }

      return result;
    } catch (err) {
      if (!captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'express', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
        emitExpressPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      }
      throw err;
    }
  }

  // Preserve function metadata
  Object.defineProperty(wrapped, 'name', { value: handler.name || routeName, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: handler.length, configurable: true });

  return wrapped;
}

/**
 * Instrument an Express application by monkey-patching route registration methods.
 *
 * Must be called BEFORE routes are defined:
 *
 *   import express from 'express';
 *   import { instrumentExpress } from 'trickle';
 *
 *   const app = express();
 *   instrumentExpress(app);
 *
 *   app.get('/api/users', (req, res) => { ... });
 *
 * Each registered handler is wrapped to capture:
 * - Input: `{ body, params, query }` from the request
 * - Output: the data passed to `res.json()` or `res.send()`
 * - Errors: exceptions or `next(err)` calls
 */
export function instrumentExpress(
  app: any,
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  const opts: ExpressInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) return;

  const methods = ['get', 'post', 'put', 'delete', 'patch', 'all'] as const;

  for (const method of methods) {
    const original = app[method];
    if (typeof original !== 'function') continue;

    app[method] = function (this: any, path: string | RegExp, ...handlers: any[]) {
      // Express allows non-string first args (RegExp, array of paths, etc.)
      // We only label with a string path; otherwise fall back to the method name.
      const pathStr = typeof path === 'string' ? path : String(path);
      const routeName = `${method.toUpperCase()} ${pathStr}`;

      const wrapped = handlers.map((handler: any) => {
        if (typeof handler !== 'function') return handler;

        try {
          return wrapExpressHandler(handler, routeName, opts);
        } catch {
          // If wrapping fails for any reason, return the original handler
          return handler;
        }
      });

      return original.call(this, path, ...wrapped);
    };
  }
}

/**
 * Express middleware that intercepts responses to capture type information.
 *
 * Use this when you prefer middleware over monkey-patching:
 *
 *   import express from 'express';
 *   import { trickleMiddleware } from 'trickle';
 *
 *   const app = express();
 *   app.use(trickleMiddleware());
 *
 * The middleware captures the route `METHOD /path` once the response is sent,
 * by intercepting `res.json()` and `res.send()`.
 */
export function trickleMiddleware(
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): (req: any, res: any, next: (...args: any[]) => void) => void {
  const opts: ExpressInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';

  return function trickleMiddlewareHandler(req: any, res: any, next: (...args: any[]) => void): void {
    if (!opts.enabled) {
      next();
      return;
    }

    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      next();
      return;
    }

    // Wrap in request context for per-request correlation
    withRequestContext(req, () => {
      _handleRequest(req, res, next, opts, debug);
    });
  };
}

function _handleRequest(req: any, res: any, next: any, opts: any, debug: boolean): void {
    if (debug) {
      console.log(`[trickle/middleware] Intercepting ${req.method} ${req.originalUrl || req.url}`);
    }

    let captured = false;
    const startTime = performance.now();
    const prelimRouteName = `${req.method || 'UNKNOWN'} ${req.originalUrl || req.url || '/'}`;
    const callId = traceCall(prelimRouteName, 'express');

    // We derive the route name lazily once the response is being sent,
    // because req.route is only populated after the handler matches.
    function getRouteName(): string {
      try {
        if (req.route && req.route.path) {
          return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
        }
      } catch {
        // ignore
      }
      return prelimRouteName;
    }

    const input = extractRequestInput(req);

    // Intercept res.json()
    const originalJson = res.json;
    if (typeof originalJson === 'function') {
      res.json = function (data: any) {
        if (!captured) {
          captured = true;
          const routeName = getRouteName();
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'express', durationMs);
          if (debug) {
            console.log(`[trickle/middleware] Captured res.json for ${routeName}`);
          }
          // Re-extract input here because body parsers may have run since middleware was entered
          const latestInput = extractRequestInput(req);
          emitExpressPayload(routeName, opts.environment, opts.maxDepth, latestInput, data, undefined, durationMs);
        }
        res.json = originalJson;
        return originalJson.call(res, data);
      };
    } else if (debug) {
      console.log(`[trickle/middleware] res.json is not a function: ${typeof originalJson}`);
    }

    // Intercept res.send()
    const originalSend = res.send;
    if (typeof originalSend === 'function') {
      res.send = function (data: any) {
        if (!captured) {
          captured = true;
          const routeName = getRouteName();
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'express', durationMs);
          if (debug) {
            console.log(`[trickle/middleware] Captured res.send for ${routeName}`);
          }
          const latestInput = extractRequestInput(req);
          const output = typeof data === 'string' ? { __html: true } : data;
          emitExpressPayload(routeName, opts.environment, opts.maxDepth, latestInput, output, undefined, durationMs);
        }
        res.send = originalSend;
        return originalSend.call(res, data);
      };
    }

    next();
}
