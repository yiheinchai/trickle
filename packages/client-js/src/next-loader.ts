/**
 * trickle/next-loader — Webpack loader for Next.js component instrumentation.
 *
 * Applied via withTrickle() in next.config.js. Instruments .tsx/.jsx files
 * with render tracking, useState change tracking, and hook observability —
 * the same transforms the Vite plugin provides, but via webpack's loader API.
 *
 * Do not use directly. Use withTrickle() from 'trickle-observe/next-plugin' instead.
 */

import path from 'path';
import { transformEsmSource } from './vite-plugin';

interface LoaderOptions {
  backendUrl?: string;
  include?: string[];
  exclude?: string[];
  debug?: boolean;
  traceVars?: boolean;
}

// webpack loader — `this` is the LoaderContext (must not be an arrow function)
export default function trickleNextLoader(this: { resourcePath: string; getOptions(): LoaderOptions }, source: string): string {
  const options: LoaderOptions = (this.getOptions && this.getOptions()) || {};
  const resourcePath = this.resourcePath;

  // Skip node_modules and trickle internals
  if (resourcePath.includes('node_modules') || resourcePath.includes('trickle-observe')) {
    return source;
  }

  // Include/exclude filters
  if (options.include && options.include.length > 0) {
    if (!options.include.some(p => resourcePath.includes(p))) return source;
  }
  if (options.exclude && options.exclude.length > 0) {
    if (options.exclude.some(p => resourcePath.includes(p))) return source;
  }

  const backendUrl = options.backendUrl ?? process.env.TRICKLE_BACKEND_URL ?? 'http://localhost:4888';
  const debug = options.debug ?? (process.env.TRICKLE_DEBUG === '1');
  const traceVars = options.traceVars ?? true;
  const moduleName = path.basename(resourcePath).replace(/\.[jt]sx?$/, '');

  try {
    // Next.js SSR renders all components on the server, so use SSR mode (node:fs)
    const transformed = transformEsmSource(source, resourcePath, moduleName, backendUrl, debug, traceVars, source, true);
    if (debug && transformed !== source) {
      console.log(`[trickle/next] Instrumented ${resourcePath}`);
    }
    return transformed;
  } catch {
    // Never crash the build
    return source;
  }
}
