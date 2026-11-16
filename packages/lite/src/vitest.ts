/**
 * Vite / Vitest plugin: instrument project TypeScript before it is compiled,
 * and install the recorder in every test worker.
 *
 *   import { trickle } from 'trickle-lite/vitest';
 *   export default defineConfig({ plugins: [trickle()] });
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrument } from './instrument.js';
import { findRoot, shouldInstrument, toKey } from './common.js';

export interface TricklePluginOptions {
  /** Project root that observations are filed under (default: the repository root). */
  root?: string;
}

export function trickle(options: TricklePluginOptions = {}) {
  const root = path.resolve(options.root ?? findRoot());
  process.env.TRICKLE_ROOT ??= root; // inherited by the worker processes
  const setup = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vitest-setup.js');
  return {
    name: 'trickle-lite',
    enforce: 'pre' as const,
    config() {
      return { test: { setupFiles: [setup] } };
    },
    transform(code: string, id: string) {
      const file = id.split('?')[0]!;
      if (!shouldInstrument(file, root)) return null;
      try {
        const result = instrument(code, file, toKey(root, file));
        return result ? { code: result.code, map: result.map } : null;
      } catch {
        return null;
      }
    },
  };
}

export default trickle;
