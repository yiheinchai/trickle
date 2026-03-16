import * as fs from 'fs';
import * as pathMod from 'path';
import { TypeNode, IngestPayload } from './types';
import { inferType } from './type-inference';
import { hashType } from './type-hash';
import { TypeCache } from './cache';
import { enqueue } from './transport';
import { detectEnvironment } from './env-detect';
import { withRequestContext } from './request-context';
import { traceCall, traceReturn } from './call-trace';

const honoCache = new TypeCache();

interface HonoInstrumentOpts {
  enabled: boolean;
  environment: string;
  sampleRate: number;
  maxDepth: number;
}

// ── Input extraction ──

async function extractHonoInput(c: any): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {};

  try {
    // Hono body: c.req.json() / c.req.text() — need to clone to avoid consuming
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = await c.req.json();
        if (body && typeof body === 'object' && Object.keys(body).length > 0) {
          input.body = body;
        }
      } catch { /* body may not be parseable */ }
    }
  } catch {}

  try {
    // c.req.param() returns all params as an object
    const params = c.req.param();
    if (params && typeof params === 'object' && Object.keys(params).length > 0) {
      input.params = params;
    }
  } catch {}

  try {
    // c.req.query() returns all query params
    const query = c.req.query();
    if (query && typeof query === 'object' && Object.keys(query).length > 0) {
      input.query = query;
    }
  } catch {}

  return input;
}

// ── Sample sanitization (local copy) ──

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
  if (t === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`;

  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item, i) => sanitizeSample(item, i === 0 ? depth : depth - 1));
  }

  if (t === 'object') {
    if (value instanceof Date) return value.toISOString();
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

// ── Error file writing ──

function writeErrorToFile(error: unknown, input: Record<string, unknown>, routeName: string): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const defaultDir = pathMod.join(process.cwd(), '.trickle');
    const dir = process.env.TRICKLE_LOCAL_DIR || defaultDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const stackLines = (err.stack || '').split('\n');
    let errorFile: string | undefined;
    let errorLine: number | undefined;
    for (const sl of stackLines.slice(1)) {
      const m = sl.match(/\((.+):(\d+):\d+\)/) || sl.match(/at (.+):(\d+):\d+/);
      if (m && !m[1].includes('node_modules') && !m[1].includes('node:') && !m[1].includes('trickle-observe')) {
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

    fs.appendFileSync(pathMod.join(dir, 'errors.jsonl'), JSON.stringify(record) + '\n');
  } catch {
    // Never crash the user's app
  }
}

// ── Payload emission ──

function emitHonoPayload(
  functionName: string,
  environment: string,
  maxDepth: number,
  input: Record<string, unknown>,
  output: unknown,
  error?: unknown,
  durationMs?: number,
): void {
  try {
    const functionKey = `hono::${functionName}`;
    const argsType = inferType(input, maxDepth);
    const returnType = error ? ({ kind: 'unknown' } as TypeNode) : inferType(output, maxDepth);
    const hash = hashType(argsType, returnType);

    if (!error && !honoCache.shouldSend(functionKey, hash)) return;
    if (!error) honoCache.markSent(functionKey, hash);

    const payload: IngestPayload = {
      functionName,
      module: 'hono',
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
      writeErrorToFile(error, input, functionName);
    }

    enqueue(payload);
  } catch {
    // Never crash the user's app
  }
}

// ── Public API ──

/**
 * Instrument a Hono app by monkey-patching route registration methods.
 *
 * Must be called BEFORE routes are defined:
 *
 *   import { Hono } from 'hono';
 *   import { instrumentHono } from 'trickle';
 *
 *   const app = new Hono();
 *   instrumentHono(app);
 *
 *   app.get('/api/users', (c) => c.json({ users: [] }));
 *
 * Captures:
 * - Input: body (JSON), params, query from the Hono context
 * - Output: the data passed to c.json() / c.text() or returned directly
 * - Errors: exceptions thrown in handlers
 * - Timing: request duration in milliseconds
 */
export function instrumentHono(
  app: any,
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  const opts: HonoInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) return;

  const methods = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'] as const;

  for (const method of methods) {
    const original = app[method];
    if (typeof original !== 'function') continue;

    app[method] = function (this: any, path: string, ...handlers: any[]) {
      const pathStr = typeof path === 'string' ? path : String(path);
      const routeName = `${method.toUpperCase()} ${pathStr}`;

      const wrapped = handlers.map((handler: any) => {
        if (typeof handler !== 'function') return handler;

        return wrapHonoHandler(handler, routeName, opts);
      });

      return original.call(this, path, ...wrapped);
    };
  }
}

function wrapHonoHandler(
  handler: Function,
  routeName: string,
  opts: HonoInstrumentOpts,
): Function {
  const wrapped = async function (this: any, c: any, next?: any) {
    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return handler.call(this, c, next);
    }

    const startTime = performance.now();
    const callId = traceCall(routeName, 'hono');

    // Extract input (async because body parsing is async in Hono)
    let input: Record<string, unknown> = {};
    try {
      input = await extractHonoInput(c);
    } catch {}

    // Intercept c.json() to capture output
    let captured = false;
    const originalJson = c.json;
    if (typeof originalJson === 'function') {
      c.json = function (data: any, ...args: any[]) {
        if (!captured) {
          captured = true;
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'hono', durationMs);
          emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, data, undefined, durationMs);
        }
        return originalJson.call(c, data, ...args);
      };
    }

    // Intercept c.text() for text responses
    const originalText = c.text;
    if (typeof originalText === 'function') {
      c.text = function (data: any, ...args: any[]) {
        if (!captured) {
          captured = true;
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'hono', durationMs);
          emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, { __text: true }, undefined, durationMs);
        }
        return originalText.call(c, data, ...args);
      };
    }

    try {
      const result = await handler.call(this, c, next);

      // Hono handlers can return a Response object directly
      if (result && !captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'hono', durationMs);

        // Try to extract JSON from the Response
        if (result instanceof Response) {
          try {
            const cloned = result.clone();
            const ct = cloned.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
              const body = await cloned.json();
              emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, body, undefined, durationMs);
            } else {
              emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, { __response: true }, undefined, durationMs);
            }
          } catch {
            emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, { __response: true }, undefined, durationMs);
          }
        } else {
          emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, result, undefined, durationMs);
        }
      }

      return result;
    } catch (err) {
      if (!captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'hono', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
        emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      }
      throw err;
    }
  };

  Object.defineProperty(wrapped, 'name', { value: handler.name || routeName, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: handler.length, configurable: true });

  return wrapped;
}

/**
 * Hono middleware for observability. Use this as an alternative to
 * monkey-patching route methods:
 *
 *   import { Hono } from 'hono';
 *   import { trickleHonoMiddleware } from 'trickle';
 *
 *   const app = new Hono();
 *   app.use('*', trickleHonoMiddleware());
 */
export function trickleHonoMiddleware(
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): (c: any, next: () => Promise<void>) => Promise<void | Response> {
  const opts: HonoInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  return async function trickleHonoMw(c: any, next: () => Promise<void>): Promise<void | Response> {
    if (!opts.enabled) return next();
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) return next();

    const startTime = performance.now();
    const routeName = `${c.req.method} ${c.req.path}`;
    const callId = traceCall(routeName, 'hono');

    let input: Record<string, unknown> = {};
    try {
      input = await extractHonoInput(c);
    } catch {}

    try {
      await next();

      const durationMs = performance.now() - startTime;
      traceReturn(callId, routeName, 'hono', durationMs);

      // After next(), capture from c.res if available
      if (c.res) {
        try {
          const ct = c.res.headers?.get('content-type') || '';
          if (ct.includes('application/json')) {
            const cloned = c.res.clone();
            const body = await cloned.json();
            emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, body, undefined, durationMs);
          } else {
            emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, { __response: true }, undefined, durationMs);
          }
        } catch {
          emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, { __response: true }, undefined, durationMs);
        }
      }
    } catch (err) {
      const durationMs = performance.now() - startTime;
      traceReturn(callId, routeName, 'hono', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
      emitHonoPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      throw err;
    }
  };
}
