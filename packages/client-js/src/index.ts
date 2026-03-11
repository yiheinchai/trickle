import { configure as configureTransport, flush } from './transport';
import { wrapFunction } from './wrap';
import { detectEnvironment } from './env-detect';
import { GlobalOpts, TrickleOpts, WrapOptions } from './types';
import { instrumentExpress, trickleMiddleware } from './express';

let globalOpts: GlobalOpts = {
  backendUrl: 'http://localhost:4888',
  batchIntervalMs: 2000,
  enabled: true,
  environment: undefined,
};

/**
 * Configure trickle global options.
 * Call this before wrapping any functions if you need non-default settings.
 */
export function configure(opts: Partial<GlobalOpts>): void {
  Object.assign(globalOpts, opts);
  configureTransport(globalOpts as GlobalOpts);
}

/**
 * Wrap a function to capture runtime type information.
 *
 * Usage:
 *   const wrapped = trickle(myFunction);
 *   const wrapped = trickle(myFunction, { name: 'myFn', module: 'api' });
 *   const wrapped = trickle('myFunction', myFunction);
 *   const wrapped = trickle('myFunction', myFunction, { module: 'api' });
 */
export function trickle<T extends (...args: any[]) => any>(fn: T, opts?: TrickleOpts): T;
export function trickle<T extends (...args: any[]) => any>(name: string, fn: T, opts?: TrickleOpts): T;
export function trickle(...args: any[]): any {
  let fn: (...args: any[]) => any;
  let opts: TrickleOpts = {};
  let explicitName: string | undefined;

  if (typeof args[0] === 'string') {
    explicitName = args[0];
    fn = args[1];
    opts = args[2] || {};
  } else {
    fn = args[0];
    opts = args[1] || {};
  }

  if (typeof fn !== 'function') {
    throw new TypeError('trickle: expected a function argument');
  }

  const functionName = explicitName || opts.name || fn.name || 'anonymous';
  const module = opts.module || inferModule();
  const environment = globalOpts.environment || detectEnvironment();

  const wrapOpts: WrapOptions = {
    functionName,
    module,
    trackArgs: opts.trackArgs !== false,
    trackReturn: opts.trackReturn !== false,
    sampleRate: opts.sampleRate ?? 1,
    maxDepth: opts.maxDepth ?? 5,
    environment,
    enabled: globalOpts.enabled,
  };

  return wrapFunction(fn, wrapOpts);
}

/**
 * Wrap a Lambda handler function.
 * Same as trickle() but automatically flushes the transport after each invocation,
 * since Lambda may freeze the process between invocations.
 */
export function trickleHandler<T extends (...args: any[]) => any>(handler: T, opts?: TrickleOpts): T {
  const wrapped = trickle(handler, {
    ...opts,
    name: opts?.name || handler.name || 'handler',
  });

  const flushing = function (this: any, ...args: any[]): any {
    const result = wrapped.apply(this, args);

    // If the handler returns a promise, flush after it resolves
    if (result !== null && result !== undefined && typeof result === 'object' && typeof result.then === 'function') {
      return result.then(
        async (resolved: unknown) => {
          await flush().catch(() => {});
          return resolved;
        },
        async (err: unknown) => {
          await flush().catch(() => {});
          throw err;
        },
      );
    }

    // Synchronous handler — flush and return
    flush().catch(() => {});
    return result;
  };

  Object.defineProperty(flushing, 'name', { value: handler.name || 'handler', configurable: true });
  Object.defineProperty(flushing, 'length', { value: handler.length, configurable: true });

  return flushing as unknown as T;
}

/**
 * Instrument an Express app by monkey-patching route methods to capture types.
 *
 * Must be called BEFORE defining routes:
 *
 *   const app = express();
 *   trickleExpress(app);
 *   app.get('/api/users', (req, res) => { ... });
 *
 * Each handler is wrapped to capture:
 * - Input: `{ body, params, query }` from the request
 * - Output: data passed to `res.json()` or `res.send()`
 * - Errors: thrown exceptions or `next(err)` calls
 */
export function trickleExpress(
  app: any,
  opts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  instrumentExpress(app, {
    enabled: opts?.enabled ?? globalOpts.enabled,
    environment: opts?.environment ?? globalOpts.environment ?? detectEnvironment(),
    sampleRate: opts?.sampleRate ?? 1,
    maxDepth: opts?.maxDepth ?? 5,
  });
}

/**
 * Auto-instrument a framework app. Currently supports Express.
 *
 * Usage:
 *   import { instrument } from 'trickle';
 *   const app = express();
 *   instrument(app);
 *
 * Detects Express by checking for `app.listen` and `app.get` (function) on the object.
 */
export function instrument(
  app: any,
  opts?: { enabled?: boolean; environment?: string; sampleRate?: number; maxDepth?: number },
): void {
  // Detect Express-like app
  if (app && typeof app.listen === 'function' && typeof app.get === 'function' && typeof app.use === 'function') {
    trickleExpress(app, opts);
    return;
  }

  // Future: detect other frameworks here (Koa, Fastify, etc.)
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[trickle] instrument(): could not detect a supported framework on the provided object');
  }
}

/**
 * Attempt to infer the module name from the call stack.
 * Falls back to 'unknown' if we can't determine it.
 */
function inferModule(): string {
  try {
    const stack = new Error().stack;
    if (!stack) return 'unknown';

    const lines = stack.split('\n');
    // Skip first 3 lines: "Error", trickle internals
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      // Look for a file path
      const match = line.match(/(?:at\s+)?(?:.*?\s+\()?(.+?)(?::\d+:\d+)?\)?$/);
      if (match) {
        let filePath = match[1];
        // Strip node_modules paths
        if (filePath.includes('node_modules')) continue;
        // Extract just the filename or relative path
        const parts = filePath.split('/');
        const filename = parts[parts.length - 1];
        if (filename && !filename.startsWith('<')) {
          return filename.replace(/\.[jt]sx?$/, '');
        }
      }
    }
  } catch {
    // Don't crash on stack inspection failure
  }
  return 'unknown';
}

// Re-export public types
export type { TypeNode, GlobalOpts, TrickleOpts, IngestPayload } from './types';
export { flush } from './transport';
export { instrumentExpress, trickleMiddleware } from './express';
