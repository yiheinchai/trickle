/**
 * Auto-observation register — patches Node's module loader to automatically
 * wrap ALL functions in user code (not just exports).
 *
 * Uses two complementary hooks:
 * 1. Module._compile: Transforms source code to wrap function declarations
 *    IMMEDIATELY after each function body. This catches:
 *    - Entry file functions (previously invisible)
 *    - Non-exported helper functions inside modules
 *    - All function declarations in user code
 * 2. Module._load: Wraps exported functions on the exports object
 *    (covers module.exports patterns like { foo, bar })
 *
 * A double-wrap guard in wrapFunction prevents the same function being
 * wrapped by both hooks.
 *
 * Usage:
 *
 *   node -r trickle/observe app.js
 *
 * Environment variables:
 *   TRICKLE_BACKEND_URL     — Backend URL (default: http://localhost:4888)
 *   TRICKLE_ENABLED         — Set to "0" or "false" to disable
 *   TRICKLE_DEBUG           — Set to "1" for debug logging
 *   TRICKLE_ENV             — Override detected environment
 *   TRICKLE_OBSERVE_INCLUDE — Comma-separated substrings to include (default: all user code)
 *   TRICKLE_OBSERVE_EXCLUDE — Comma-separated substrings to exclude (default: none)
 */

import Module from 'module';
import path from 'path';
import { configure } from './transport';
import { detectEnvironment } from './env-detect';
import { wrapFunction } from './wrap';
import { WrapOptions } from './types';

const M = Module as any;
const originalLoad = M._load;
const originalCompile = M.prototype._compile;

// Read config from environment
const backendUrl = process.env.TRICKLE_BACKEND_URL || 'http://localhost:4888';
const enabled = process.env.TRICKLE_ENABLED !== '0' && process.env.TRICKLE_ENABLED !== 'false';
const debug = process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true';
const envOverride = process.env.TRICKLE_ENV || undefined;

const includePatterns = process.env.TRICKLE_OBSERVE_INCLUDE
  ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
  : [];
const excludePatterns = process.env.TRICKLE_OBSERVE_EXCLUDE
  ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
  : [];

const wrapped = new Set<string>();

/**
 * Check if a file path should be observed (user code, not node_modules/trickle internals).
 */
function shouldObserve(filename: string): boolean {
  if (!filename || !filename.startsWith('/')) return false;
  if (filename.includes('node_modules')) return false;
  // Don't transform trickle's own code
  if (filename.includes('client-js/') || filename.includes('trickle-client/') || filename.includes('trickle/dist/')) return false;

  // Apply include/exclude filters
  if (includePatterns.length > 0) {
    if (!includePatterns.some(p => filename.includes(p))) return false;
  }
  if (excludePatterns.length > 0) {
    if (excludePatterns.some(p => filename.includes(p))) return false;
  }

  // Only transform JS/TS files
  const ext = path.extname(filename).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs'].includes(ext)) return false;

  return true;
}

/**
 * Find the closing brace position for a function body starting at `openBrace`.
 * Handles nested braces, strings, template literals, and comments.
 */
function findClosingBrace(source: string, openBrace: number): number {
  let depth = 1;
  let pos = openBrace + 1;
  while (pos < source.length && depth > 0) {
    const ch = source[pos];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return pos;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string/template literal
      const quote = ch;
      pos++;
      while (pos < source.length) {
        if (source[pos] === '\\') { pos++; } // skip escaped char
        else if (source[pos] === quote) break;
        else if (quote === '`' && source[pos] === '$' && pos + 1 < source.length && source[pos + 1] === '{') {
          // Template literal expression — skip nested content
          pos += 2;
          let tDepth = 1;
          while (pos < source.length && tDepth > 0) {
            if (source[pos] === '{') tDepth++;
            else if (source[pos] === '}') tDepth--;
            else if (source[pos] === '"' || source[pos] === "'" || source[pos] === '`') {
              const q = source[pos]; pos++;
              while (pos < source.length && source[pos] !== q) {
                if (source[pos] === '\\') pos++;
                pos++;
              }
            }
            pos++;
          }
          continue;
        }
        pos++;
      }
    } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
      // Line comment — skip to end of line
      while (pos < source.length && source[pos] !== '\n') pos++;
    } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
      // Block comment — skip to */
      pos += 2;
      while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
      pos++; // skip past /
    }
    pos++;
  }
  return -1; // not found
}

/**
 * Transform CJS source code to wrap function declarations with trickle observation.
 *
 * For each `function foo(...) { ... }` found, inserts a wrapper call
 * IMMEDIATELY AFTER the function body closes:
 *
 *   function foo(a) { return a; }
 *   foo = __trickle_wrap(foo, 'foo');
 *
 * This ensures functions are wrapped before subsequent code calls them,
 * which is critical for entry files where functions are defined and used
 * in the same top-level scope.
 */
function transformCjsSource(source: string, filename: string, moduleName: string, env: string): string {
  const funcRegex = /^[ \t]*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  const insertions: Array<{ position: number; name: string }> = [];
  let match;

  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1];
    // Skip common false positives
    if (name === 'require' || name === 'exports' || name === 'module') continue;

    // Find the opening brace of the function body
    const afterMatch = match.index + match[0].length;
    const openBrace = source.indexOf('{', afterMatch);
    if (openBrace === -1) continue;

    // Find the matching closing brace
    const closeBrace = findClosingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    insertions.push({ position: closeBrace + 1, name });
  }

  if (insertions.length === 0) return source;

  // Resolve the path to the wrap helper (compiled JS)
  const wrapHelperPath = path.join(__dirname, 'wrap.js');

  // Prepend: load the wrapper and create the wrap helper
  const prefix = [
    `var __trickle_mod = require(${JSON.stringify(wrapHelperPath)});`,
    `var __trickle_wrap = function(fn, name) {`,
    `  return __trickle_mod.wrapFunction(fn, {`,
    `    functionName: name,`,
    `    module: ${JSON.stringify(moduleName)},`,
    `    trackArgs: true,`,
    `    trackReturn: true,`,
    `    sampleRate: 1,`,
    `    maxDepth: 5,`,
    `    environment: ${JSON.stringify(env)},`,
    `    enabled: true,`,
    `  });`,
    `};`,
    '',
  ].join('\n');

  // Insert wrapper calls immediately after each function body (reverse order to preserve positions)
  let result = source;
  for (let i = insertions.length - 1; i >= 0; i--) {
    const { position, name } = insertions[i];
    const wrapperCall = `\ntry{${name}=__trickle_wrap(${name},'${name}')}catch(__e){}\n`;
    result = result.slice(0, position) + wrapperCall + result.slice(position);
  }

  return prefix + result;
}

if (enabled) {
  const environment = envOverride || detectEnvironment();

  configure({
    backendUrl,
    batchIntervalMs: 2000,
    debug,
    enabled: true,
    environment,
  });

  if (debug) {
    console.log(`[trickle/observe] Auto-observation enabled (backend: ${backendUrl})`);
  }

  // ── Hook 1: Module._compile — transform source to wrap function declarations ──
  // This catches ALL functions including entry file and non-exported helpers.

  M.prototype._compile = function hookedCompile(content: string, filename: string): any {
    if (shouldObserve(filename)) {
      const moduleName = path.basename(filename).replace(/\.[jt]sx?$/, '');
      try {
        const transformed = transformCjsSource(content, filename, moduleName, environment);
        if (transformed !== content) {
          // Count how many functions were wrapped (from insertions)
          const funcRegex = /^[ \t]*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
          let count = 0;
          let m;
          while ((m = funcRegex.exec(content)) !== null) {
            if (m[1] !== 'require' && m[1] !== 'exports' && m[1] !== 'module') count++;
          }
          if (debug && count > 0) {
            console.log(`[trickle/observe] Deep-wrapped ${count} functions in ${moduleName} (${filename})`);
          }
          return originalCompile.call(this, transformed, filename);
        }
      } catch (err) {
        // If transform fails, fall through to original compilation
        if (debug) {
          console.log(`[trickle/observe] Transform failed for ${filename}: ${err}`);
        }
      }
    }
    return originalCompile.call(this, content, filename);
  };

  // ── Hook 2: Module._load — wrap exports object (catches module.exports patterns) ──
  // Still useful for wrapping exports that use inline function expressions
  // (e.g. module.exports = { foo: function() {} }).
  // The double-wrap guard in wrapFunction prevents redundant wrapping.

  M._load = function hookedLoad(request: string, parent: any, isMain: boolean): any {
    const exports = originalLoad.apply(this, arguments);

    // Only process user modules (relative paths)
    if (!request.startsWith('.') && !request.startsWith('/')) {
      return exports;
    }

    // Resolve to absolute path for dedup
    let resolvedPath: string;
    try {
      resolvedPath = M._resolveFilename(request, parent);
    } catch {
      return exports;
    }

    // Skip node_modules and trickle internals
    if (resolvedPath.includes('node_modules')) return exports;
    if (resolvedPath.includes('client-js/') || resolvedPath.includes('trickle-client/') || resolvedPath.includes('trickle/dist/')) return exports;

    // Skip already-wrapped modules
    if (wrapped.has(resolvedPath)) return exports;

    // Apply include/exclude filters
    if (includePatterns.length > 0) {
      const matches = includePatterns.some(p => resolvedPath.includes(p));
      if (!matches) return exports;
    }
    if (excludePatterns.length > 0) {
      const excluded = excludePatterns.some(p => resolvedPath.includes(p));
      if (excluded) return exports;
    }

    wrapped.add(resolvedPath);

    // Derive module name from file path
    const moduleName = path.basename(resolvedPath).replace(/\.[jt]sx?$/, '');

    // Wrap exported functions
    if (exports && typeof exports === 'object') {
      let count = 0;
      for (const key of Object.keys(exports)) {
        if (typeof exports[key] === 'function' && key !== 'default') {
          const fn = exports[key];
          const wrapOpts: WrapOptions = {
            functionName: key,
            module: moduleName,
            trackArgs: true,
            trackReturn: true,
            sampleRate: 1,
            maxDepth: 5,
            environment,
            enabled: true,
          };
          exports[key] = wrapFunction(fn, wrapOpts);
          count++;
        }
      }

      // Handle default export if it's a function
      if (typeof exports.default === 'function') {
        const fn = exports.default;
        const wrapOpts: WrapOptions = {
          functionName: fn.name || 'default',
          module: moduleName,
          trackArgs: true,
          trackReturn: true,
          sampleRate: 1,
          maxDepth: 5,
          environment,
          enabled: true,
        };
        exports.default = wrapFunction(fn, wrapOpts);
        count++;
      }

      if (debug && count > 0) {
        console.log(`[trickle/observe] Wrapped ${count} exports from ${moduleName} (${resolvedPath})`);
      }
    } else if (typeof exports === 'function') {
      // Module exports a single function (e.g. module.exports = fn)
      const fn = exports;
      const wrapOpts: WrapOptions = {
        functionName: fn.name || moduleName,
        module: moduleName,
        trackArgs: true,
        trackReturn: true,
        sampleRate: 1,
        maxDepth: 5,
        environment,
        enabled: true,
      };
      const wrappedFn = wrapFunction(fn, wrapOpts);

      // Copy static properties
      for (const key of Object.keys(fn)) {
        (wrappedFn as any)[key] = fn[key];
      }

      // Update require cache
      try {
        if (require.cache[resolvedPath]) {
          require.cache[resolvedPath]!.exports = wrappedFn;
        }
      } catch {
        // Cache update failed — non-critical
      }

      if (debug) {
        console.log(`[trickle/observe] Wrapped default export from ${moduleName}`);
      }

      return wrappedFn;
    }

    return exports;
  };
} else if (debug) {
  console.log('[trickle/observe] Auto-observation disabled (TRICKLE_ENABLED=false)');
}
