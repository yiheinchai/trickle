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

const koaCache = new TypeCache();

interface KoaInstrumentOpts {
  enabled: boolean;
  environment: string;
  sampleRate: number;
  maxDepth: number;
}

// ── Input extraction ──

function extractKoaInput(ctx: any): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  try {
    // Koa body parsing: koa-bodyparser sets ctx.request.body
    const body = ctx.request?.body;
    if (body !== undefined && body !== null && typeof body === 'object' && Object.keys(body).length > 0) {
      input.body = body;
    }
  } catch {}

  try {
    // koa-router sets ctx.params
    if (ctx.params && typeof ctx.params === 'object' && Object.keys(ctx.params).length > 0) {
      input.params = ctx.params;
    }
  } catch {}

  try {
    if (ctx.query && typeof ctx.query === 'object' && Object.keys(ctx.query).length > 0) {
      input.query = ctx.query;
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
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${(value as Function).name || 'anonymous'}]`;

  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item, i) => sanitizeSample(item, i === 0 ? depth : depth - 1));
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

// ── Error file writing ──

function writeErrorToFile(error: unknown, input: Record<string, unknown>, routeName: string): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const defaultDir = isLambda ? '/tmp/.trickle' : pathMod.join(process.cwd(), '.trickle');
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

    const errorsFile = pathMod.join(dir, 'errors.jsonl');
    fs.appendFileSync(errorsFile, JSON.stringify(record) + '\n');
  } catch {
    // Never crash the user's app
  }
}

// ── Payload emission ──

function emitKoaPayload(
  functionName: string,
  environment: string,
  maxDepth: number,
  input: Record<string, unknown>,
  output: unknown,
  error?: unknown,
  durationMs?: number,
): void {
  try {
    const functionKey = `koa::${functionName}`;
    const argsType = inferType(input, maxDepth);
    const returnType = error ? ({ kind: 'unknown' } as TypeNode) : inferType(output, maxDepth);
    const hash = hashType(argsType, returnType);

    if (!error && !koaCache.shouldSend(functionKey, hash)) {
      return;
    }

    if (!error) {
      koaCache.markSent(functionKey, hash);
    }

    const payload: IngestPayload = {
      functionName,
      module: 'koa',
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
 * Instrument a Koa application with observability middleware.
 *
 * Usage:
 *   import Koa from 'koa';
 *   import { instrumentKoa } from 'trickle';
 *
 *   const app = new Koa();
 *   instrumentKoa(app);  // Add BEFORE routes
 *
 * Captures:
 * - Input: `{ body, params, query }` from the request context
 * - Output: `ctx.body` value set by route handlers
 * - Errors: exceptions thrown in middleware/handlers
 * - Timing: request duration in milliseconds
 *
 * Works with koa-router and @koa/router for named route paths.
 */
export function instrumentKoa(
  app: any,
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  const opts: KoaInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) return;

  // Koa middleware: runs first, wraps the entire downstream chain
  app.use(async (ctx: any, next: any) => {
    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return next();
    }

    const startTime = performance.now();
    const input = extractKoaInput(ctx);

    // Derive route name: use koa-router matched route if available, else raw URL
    function getRouteName(): string {
      try {
        // koa-router sets ctx._matchedRoute (e.g., "/api/users/:id")
        if (ctx._matchedRoute) {
          return `${ctx.method} ${ctx._matchedRoute}`;
        }
        // @koa/router may also set ctx.routerPath
        if (ctx.routerPath) {
          return `${ctx.method} ${ctx.routerPath}`;
        }
      } catch {}
      return `${ctx.method} ${ctx.path || ctx.url || '/'}`;
    }

    const callId = traceCall(`${ctx.method} ${ctx.path || ctx.url}`, 'koa');

    try {
      await next();

      const durationMs = performance.now() - startTime;
      const routeName = getRouteName();
      // Re-extract input after body parsers have run
      const latestInput = extractKoaInput(ctx);
      const finalInput = Object.keys(latestInput).length > Object.keys(input).length ? latestInput : input;

      traceReturn(callId, routeName, 'koa', durationMs);

      // Capture ctx.body as output (Koa's response mechanism)
      if (ctx.body !== undefined) {
        const output = typeof ctx.body === 'string' ? { __html: true } : ctx.body;
        emitKoaPayload(routeName, opts.environment, opts.maxDepth, finalInput, output, undefined, durationMs);
      }
    } catch (err) {
      const durationMs = performance.now() - startTime;
      const routeName = getRouteName();
      const latestInput = extractKoaInput(ctx);
      const finalInput = Object.keys(latestInput).length > Object.keys(input).length ? latestInput : input;

      traceReturn(callId, routeName, 'koa', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
      emitKoaPayload(routeName, opts.environment, opts.maxDepth, finalInput, undefined, err, durationMs);
      throw err; // Re-throw for Koa error handling
    }
  });
}

/**
 * Instrument a koa-router (or @koa/router) instance by monkey-patching route methods.
 *
 * Usage:
 *   import Router from '@koa/router';
 *   import { instrumentKoaRouter } from 'trickle';
 *
 *   const router = new Router();
 *   instrumentKoaRouter(router);
 *
 *   router.get('/api/users', async (ctx) => { ... });
 *
 * This provides more precise route names (e.g., "GET /api/users/:id")
 * compared to the middleware approach.
 */
export function instrumentKoaRouter(
  router: any,
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  const opts: KoaInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) return;

  const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'] as const;

  for (const method of methods) {
    const original = router[method];
    if (typeof original !== 'function') continue;

    router[method] = function (this: any, ...args: any[]) {
      // koa-router: .get(path, ...middleware)
      // or .get(name, path, ...middleware)
      let path: string;
      let middlewareStart: number;

      if (typeof args[0] === 'string' && typeof args[1] === 'string') {
        // Named route: .get('listUsers', '/api/users', handler)
        path = args[1];
        middlewareStart = 2;
      } else if (typeof args[0] === 'string') {
        path = args[0];
        middlewareStart = 1;
      } else {
        // Fallback
        return original.apply(this, args);
      }

      const routeName = `${method.toUpperCase()} ${path}`;

      const wrapped = args.slice(middlewareStart).map((handler: any) => {
        if (typeof handler !== 'function') return handler;

        return wrapKoaHandler(handler, routeName, opts);
      });

      return original.call(this, ...args.slice(0, middlewareStart), ...wrapped);
    };
  }
}

function wrapKoaHandler(
  handler: Function,
  routeName: string,
  opts: KoaInstrumentOpts,
): Function {
  const wrapped = async function (this: any, ctx: any, next: any) {
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return handler.call(this, ctx, next);
    }

    const input = extractKoaInput(ctx);
    const startTime = performance.now();
    const callId = traceCall(routeName, 'koa');

    try {
      const result = await handler.call(this, ctx, next);

      const durationMs = performance.now() - startTime;
      traceReturn(callId, routeName, 'koa', durationMs);

      if (ctx.body !== undefined) {
        const latestInput = extractKoaInput(ctx);
        const finalInput = Object.keys(latestInput).length > Object.keys(input).length ? latestInput : input;
        const output = typeof ctx.body === 'string' ? { __html: true } : ctx.body;
        emitKoaPayload(routeName, opts.environment, opts.maxDepth, finalInput, output, undefined, durationMs);
      }

      return result;
    } catch (err) {
      const durationMs = performance.now() - startTime;
      traceReturn(callId, routeName, 'koa', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
      emitKoaPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      throw err;
    }
  };

  Object.defineProperty(wrapped, 'name', { value: handler.name || routeName, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: handler.length, configurable: true });

  return wrapped;
}
