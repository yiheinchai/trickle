import { configure as configureTransport } from './transport';
import { wrapFunction } from './wrap';
import { detectEnvironment } from './env-detect';
import { GlobalOpts, TrickleOpts, WrapOptions } from './types';

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
      const match = line.match(/(?:at\s+)?(?:.*?\s+\()?(.+?)(?::\d+:\d+)?\)?$/);
      if (match) {
        let filePath = match[1];
        if (filePath.includes('node_modules')) continue;
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

export type { TypeNode, GlobalOpts, TrickleOpts, IngestPayload } from './types';
export { flush } from './transport';
export { observe, observeFn } from './observe';
export type { ObserveOpts } from './observe';
export { wrapFunction } from './wrap';
export { inferType } from './type-inference';
