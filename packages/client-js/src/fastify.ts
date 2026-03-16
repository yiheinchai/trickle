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

const fastifyCache = new TypeCache();

interface FastifyInstrumentOpts {
  enabled: boolean;
  environment: string;
  sampleRate: number;
  maxDepth: number;
}

// ── Input extraction ──

function extractFastifyInput(request: any): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  try {
    if (request.body !== undefined && request.body !== null && typeof request.body === 'object' && Object.keys(request.body).length > 0) {
      input.body = request.body;
    }
  } catch {}

  try {
    if (request.params && typeof request.params === 'object' && Object.keys(request.params).length > 0) {
      input.params = request.params;
    }
  } catch {}

  try {
    if (request.query && typeof request.query === 'object' && Object.keys(request.query).length > 0) {
      input.query = request.query;
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

function emitFastifyPayload(
  functionName: string,
  environment: string,
  maxDepth: number,
  input: Record<string, unknown>,
  output: unknown,
  error?: unknown,
  durationMs?: number,
): void {
  try {
    const functionKey = `fastify::${functionName}`;
    const argsType = inferType(input, maxDepth);
    const returnType = error ? ({ kind: 'unknown' } as TypeNode) : inferType(output, maxDepth);
    const hash = hashType(argsType, returnType);

    if (!error && !fastifyCache.shouldSend(functionKey, hash)) {
      return;
    }

    if (!error) {
      fastifyCache.markSent(functionKey, hash);
    }

    const payload: IngestPayload = {
      functionName,
      module: 'fastify',
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

// ── Handler wrapping ──

function wrapFastifyHandler(
  handler: Function,
  routeName: string,
  opts: FastifyInstrumentOpts,
): Function {
  const wrapped = async function (this: any, request: any, reply: any) {
    // Sample rate check
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) {
      return handler.call(this, request, reply);
    }

    const input = extractFastifyInput(request);
    let captured = false;
    const startTime = performance.now();
    const callId = traceCall(routeName, 'fastify');

    // Intercept reply.send() to capture output
    const originalSend = reply.send;
    if (typeof originalSend === 'function') {
      reply.send = function (data: any) {
        if (!captured) {
          captured = true;
          const durationMs = performance.now() - startTime;
          traceReturn(callId, routeName, 'fastify', durationMs);
          const output = typeof data === 'string' ? { __html: true } : data;
          emitFastifyPayload(routeName, opts.environment, opts.maxDepth, input, output, undefined, durationMs);
        }
        reply.send = originalSend; // restore
        return originalSend.call(reply, data);
      };
    }

    try {
      const result = await handler.call(this, request, reply);

      // Fastify allows returning a value directly (auto-serialized)
      if (result !== undefined && !captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'fastify', durationMs);
        emitFastifyPayload(routeName, opts.environment, opts.maxDepth, input, result, undefined, durationMs);
      }

      return result;
    } catch (err) {
      if (!captured) {
        captured = true;
        const durationMs = performance.now() - startTime;
        traceReturn(callId, routeName, 'fastify', durationMs, (err instanceof Error ? err : new Error(String(err))).message);
        emitFastifyPayload(routeName, opts.environment, opts.maxDepth, input, undefined, err, durationMs);
      }
      throw err;
    }
  };

  // Preserve function metadata
  Object.defineProperty(wrapped, 'name', { value: handler.name || routeName, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: handler.length, configurable: true });

  return wrapped;
}

// ── Public API ──

/**
 * Instrument a Fastify instance by monkey-patching route registration methods.
 *
 * Must be called BEFORE routes are defined:
 *
 *   import Fastify from 'fastify';
 *   import { instrumentFastify } from 'trickle';
 *
 *   const app = Fastify();
 *   instrumentFastify(app);
 *
 *   app.get('/api/users', async (request, reply) => { ... });
 *
 * Each registered handler is wrapped to capture:
 * - Input: `{ body, params, query }` from the request
 * - Output: the data returned or passed to `reply.send()`
 * - Errors: exceptions thrown in async handlers
 */
export function instrumentFastify(
  fastify: any,
  userOpts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  const opts: FastifyInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) return;

  // Fastify shorthand methods: .get(), .post(), .put(), .delete(), .patch(), .all()
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'] as const;

  for (const method of methods) {
    const original = fastify[method];
    if (typeof original !== 'function') continue;

    fastify[method] = function (this: any, path: string, ...args: any[]) {
      const pathStr = typeof path === 'string' ? path : String(path);
      const routeName = `${method.toUpperCase()} ${pathStr}`;

      // Fastify shorthand: .get(path, opts?, handler)
      // args can be [handler] or [opts, handler]
      const wrapped = args.map((arg: any) => {
        if (typeof arg === 'function') {
          try {
            return wrapFastifyHandler(arg, routeName, opts);
          } catch {
            return arg;
          }
        }
        // If it's an options object with a handler property, wrap that
        if (arg && typeof arg === 'object' && typeof arg.handler === 'function') {
          try {
            arg.handler = wrapFastifyHandler(arg.handler, routeName, opts);
          } catch {}
        }
        return arg;
      });

      return original.call(this, path, ...wrapped);
    };
  }

  // Also wrap fastify.route({ method, url, handler })
  const originalRoute = fastify.route;
  if (typeof originalRoute === 'function') {
    fastify.route = function (this: any, routeOptions: any) {
      if (routeOptions && typeof routeOptions.handler === 'function') {
        const method = (Array.isArray(routeOptions.method) ? routeOptions.method[0] : routeOptions.method) || 'ALL';
        const url = routeOptions.url || routeOptions.path || '/';
        const routeName = `${method.toUpperCase()} ${url}`;

        try {
          routeOptions.handler = wrapFastifyHandler(routeOptions.handler, routeName, opts);
        } catch {}
      }

      return originalRoute.call(this, routeOptions);
    };
  }
}

/**
 * Fastify plugin-style instrumentation using onRequest/onResponse hooks.
 *
 * Use this as an alternative to monkey-patching:
 *
 *   import Fastify from 'fastify';
 *   import { tricklePlugin } from 'trickle';
 *
 *   const app = Fastify();
 *   app.register(tricklePlugin);
 */
export function tricklePlugin(
  fastify: any,
  userOpts: any,
  done: () => void,
): void {
  const opts: FastifyInstrumentOpts = {
    enabled: userOpts?.enabled !== false,
    environment: userOpts?.environment || detectEnvironment(),
    sampleRate: userOpts?.sampleRate ?? 1,
    maxDepth: userOpts?.maxDepth ?? 5,
  };

  if (!opts.enabled) {
    done();
    return;
  }

  // Use onRequest to start timing and onResponse to capture result
  fastify.addHook('onRequest', async (request: any, _reply: any) => {
    if (opts.sampleRate < 1 && Math.random() > opts.sampleRate) return;
    request.__trickleStart = performance.now();
    request.__trickleInput = extractFastifyInput(request);
    request.__trickleCallId = traceCall(
      `${request.method} ${request.url}`,
      'fastify',
    );
  });

  fastify.addHook('onSend', async (request: any, reply: any, payload: any) => {
    if (!request.__trickleStart) return payload;

    const durationMs = performance.now() - request.__trickleStart;
    const routeName = `${request.method} ${request.routeOptions?.url || request.url}`;
    const input = request.__trickleInput || extractFastifyInput(request);

    traceReturn(request.__trickleCallId, routeName, 'fastify', durationMs);

    // Parse payload if it's JSON string
    let output: unknown;
    if (typeof payload === 'string') {
      try {
        output = JSON.parse(payload);
      } catch {
        output = { __html: true };
      }
    } else {
      output = payload;
    }

    emitFastifyPayload(routeName, opts.environment, opts.maxDepth, input, output, undefined, durationMs);
    delete request.__trickleStart;
    delete request.__trickleInput;
    delete request.__trickleCallId;

    return payload; // Must return payload for Fastify hook chain
  });

  fastify.addHook('onError', async (request: any, _reply: any, error: any) => {
    if (!request.__trickleStart) return;

    const durationMs = performance.now() - request.__trickleStart;
    const routeName = `${request.method} ${request.routeOptions?.url || request.url}`;
    const input = request.__trickleInput || extractFastifyInput(request);

    traceReturn(request.__trickleCallId, routeName, 'fastify', durationMs, error?.message);
    emitFastifyPayload(routeName, opts.environment, opts.maxDepth, input, undefined, error, durationMs);
    delete request.__trickleStart;
  });

  done();
}
