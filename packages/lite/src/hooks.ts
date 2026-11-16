/**
 * Node module loader hooks: instrument project TypeScript as it is imported (with or without tsx),
 * and add the Vitest plugin to Vitest configs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, shouldInstrument, toKey } from './common.js';

// TypeScript is loaded only once a project file needs instrumenting, so other node processes that inherit
// NODE_OPTIONS (scripts, tools, child processes) start as fast as before.
let compiler: Promise<[typeof import('typescript'), typeof import('./instrument.js')]> | undefined;
const loadCompiler = () => (compiler ??= Promise.all([import('typescript').then((m) => m.default), import('./instrument.js')]));

const root = findRoot();
const typeCache = new Map<string, string>();

function packageType(dir: string): string {
  const cached = typeCache.get(dir);
  if (cached) return cached;
  let type = 'commonjs';
  const pj = path.join(dir, 'package.json');
  if (fs.existsSync(pj)) {
    try { type = JSON.parse(fs.readFileSync(pj, 'utf8')).type ?? 'commonjs'; } catch { /* keep default */ }
  } else if (path.dirname(dir) !== dir) type = packageType(path.dirname(dir));
  typeCache.set(dir, type);
  return type;
}

type ResolveResult = { url: string; format?: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context?: unknown) => Promise<ResolveResult>;

const SHIM = '?trickle-vitest';

export async function resolve(specifier: string, context: { parentURL?: string }, nextResolve: NextResolve): Promise<ResolveResult> {
  let result: ResolveResult;
  try {
    result = await nextResolve(specifier, context);
  } catch (e) {
    // `import "./x.js"` written for TypeScript's NodeNext resolution: fall back to x.ts when there is no x.js.
    const parent = context.parentURL;
    if (!parent?.startsWith('file:') || !/^\.{1,2}\//.test(specifier) || !/\.[mc]?js$/.test(specifier)) throw e;
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      const candidate = new URL(specifier.replace(/\.([mc]?)js$/, (_, m: string) => (m ? `.${m}ts` : ext)), parent);
      if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    throw e;
  }
  // A Vitest config (which Vite bundles into .vite-temp) importing vitest/config gets a defineConfig that also
  // adds the trickle-lite plugin, so the project's config needs no changes.
  if (/\/\.vite-temp\/vite(st)?\.config\./.test(context.parentURL ?? '') && /\/vitest\/dist\/config\.m?js$/.test(result.url)) {
    return { url: result.url + SHIM, format: 'module', shortCircuit: true };
  }
  return result;
}

type LoadResult = { format?: string; source?: string | ArrayBuffer | Uint8Array; shortCircuit?: boolean };
type NextLoad = (url: string, context?: unknown) => Promise<LoadResult>;

async function passThrough(url: string, context: { format?: string }, nextLoad: NextLoad): Promise<LoadResult> {
  try {
    return await nextLoad(url, context);
  } catch (e) {
    // With any loader hook registered, Node sends the main script through the ESM loader, which refuses
    // extensions it does not know (`#!/usr/bin/env node` scripts named `tool` or `fake.sh`). Without hooks
    // they run as CommonJS, so do the same.
    if ((e as { code?: string }).code === 'ERR_UNKNOWN_FILE_EXTENSION') return { format: 'commonjs', shortCircuit: true };
    throw e;
  }
}

export async function load(url: string, context: { format?: string }, nextLoad: NextLoad): Promise<LoadResult> {
  if (url.endsWith(SHIM)) {
    const real = JSON.stringify(url.slice(0, -SHIM.length));
    const plugin = JSON.stringify(new URL('./vitest.js', import.meta.url).href);
    const source = `export * from ${real}; import { trickle } from ${plugin};
const add = (c) => ({ ...c, plugins: [...(c?.plugins ?? []), trickle()] });
export function defineConfig(c) {
  if (typeof c === 'function') return async (env) => add(await c(env));
  return c && typeof c.then === 'function' ? c.then(add) : add(c);
}`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (!url.startsWith('file:')) return passThrough(url, context, nextLoad);
  const file = fileURLToPath(url);
  if (!shouldInstrument(file, root)) return passThrough(url, context, nextLoad);
  try {
    const [ts, { instrument, scriptKind }] = await loadCompiler();
    const source = fs.readFileSync(file, 'utf8');
    const result = instrument(source, file, toKey(root, file));
    if (!result) return passThrough(url, context, nextLoad);
    const esm = file.endsWith('.mts') || (!file.endsWith('.cts') && packageType(path.dirname(file)) === 'module');
    const out = ts.transpileModule(result.code, {
      fileName: file,
      compilerOptions: {
        module: esm ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: scriptKind(file) === ts.ScriptKind.TSX ? ts.JsxEmit.ReactJSX : undefined,
        inlineSourceMap: true,
        inlineSources: true,
        useDefineForClassFields: true,
        experimentalDecorators: false,
      },
    });
    return { format: esm ? 'module' : 'commonjs', source: out.outputText, shortCircuit: true };
  } catch {
    return passThrough(url, context, nextLoad);
  }
}
