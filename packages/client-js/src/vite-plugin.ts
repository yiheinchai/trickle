/**
 * Vite plugin for trickle observation.
 *
 * Integrates into Vite's (and Vitest's) transform pipeline to wrap
 * user functions with trickle observation AND trace variable assignments —
 * the same thing observe-register.ts does for Node's Module._compile,
 * but for Vite/Vitest.
 *
 * Usage in vitest.config.ts:
 *
 *   import { tricklePlugin } from 'trickle-observe/vite-plugin';
 *   export default defineConfig({
 *     plugins: [tricklePlugin()],
 *   });
 *
 * Or via CLI:
 *
 *   trickle run vitest run tests/
 */

import path from 'path';
import fs from 'fs';

export interface TricklePluginOptions {
  /** Substrings — only observe files whose paths contain one of these */
  include?: string[];
  /** Substrings — skip files whose paths contain one of these */
  exclude?: string[];
  /** Backend URL (default: http://localhost:4888) */
  backendUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Disable variable tracing (default: enabled) */
  traceVars?: boolean;
}

export function tricklePlugin(options: TricklePluginOptions = {}) {
  const include = options.include
    ?? (process.env.TRICKLE_OBSERVE_INCLUDE
      ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
      : []);
  const exclude = options.exclude
    ?? (process.env.TRICKLE_OBSERVE_EXCLUDE
      ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
      : []);
  const backendUrl = options.backendUrl
    ?? process.env.TRICKLE_BACKEND_URL
    ?? 'http://localhost:4888';
  const debug = options.debug
    ?? (process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true');
  const traceVars = options.traceVars ?? (process.env.TRICKLE_TRACE_VARS !== '0');

  function shouldTransform(id: string): boolean {
    // Only JS/TS files
    const ext = path.extname(id).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts'].includes(ext)) return false;

    // Skip node_modules
    if (id.includes('node_modules')) return false;

    // Skip trickle internals
    if (id.includes('trickle-observe') || id.includes('client-js/')) return false;

    // Include filter
    if (include.length > 0) {
      if (!include.some(p => id.includes(p))) return false;
    }

    // Exclude filter
    if (exclude.length > 0) {
      if (exclude.some(p => id.includes(p))) return false;
    }

    return true;
  }

  return {
    name: 'trickle-observe',
    enforce: 'post' as const,

    transform(code: string, id: string) {
      if (!shouldTransform(id)) return null;

      // Read the original source file to get accurate line numbers.
      // Vite transforms the code before our plugin (enforce: 'post'),
      // so line numbers from `code` don't match the original .ts file.
      let originalSource: string | null = null;
      try {
        originalSource = fs.readFileSync(id, 'utf-8');
      } catch {
        // If we can't read the original, we'll use transformed line numbers
      }

      const moduleName = path.basename(id).replace(/\.[jt]sx?$/, '');
      const transformed = transformEsmSource(code, id, moduleName, backendUrl, debug, traceVars, originalSource);
      if (transformed === code) return null;

      if (debug) {
        console.log(`[trickle/vite] Transformed ${moduleName} (${id})`);
      }

      return { code: transformed, map: null };
    },
  };
}

/**
 * Find the closing brace position for a function body starting at `openBrace`.
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
      const quote = ch;
      pos++;
      while (pos < source.length) {
        if (source[pos] === '\\') { pos++; }
        else if (source[pos] === quote) break;
        else if (quote === '`' && source[pos] === '$' && pos + 1 < source.length && source[pos + 1] === '{') {
          pos += 2;
          let tDepth = 1;
          while (pos < source.length && tDepth > 0) {
            if (source[pos] === '{') tDepth++;
            else if (source[pos] === '}') tDepth--;
            pos++;
          }
          continue;
        }
        pos++;
      }
    } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n') pos++;
    } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
      pos += 2;
      while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
      pos++;
    }
    pos++;
  }
  return -1;
}

/**
 * Find variable declarations in source and return insertions for tracing.
 * Handles: const x = ...; let x = ...; var x = ...;
 * Skips: destructuring, for-loop vars, require() calls, imports, type annotations.
 */
function findVarDeclarations(source: string): Array<{ lineEnd: number; varName: string; lineNo: number }> {
  const varInsertions: Array<{ lineEnd: number; varName: string; lineNo: number }> = [];

  // Match: const/let/var <identifier> = <something>
  const varRegex = /^([ \t]*)(export\s+)?(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
  let vmatch;

  while ((vmatch = varRegex.exec(source)) !== null) {
    const varName = vmatch[4];

    // Skip trickle internals
    if (varName.startsWith('__trickle')) continue;
    // Skip TS compiled vars
    if (varName === '_a' || varName === '_b' || varName === '_c') continue;

    // Check if this is a require() call or import — skip those
    const restOfLine = source.slice(vmatch.index + vmatch[0].length - 1, vmatch.index + vmatch[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;
    // Skip function/class assignments (those are handled by function wrapping)
    if (/^\s*(?:async\s+)?(?:function\s|\([^)]*\)\s*(?::\s*[^=]+?)?\s*=>|\w+\s*=>)/.test(restOfLine)) continue;

    // Calculate line number
    let lineNo = 1;
    for (let i = 0; i < vmatch.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    // Find the end of this statement
    const startPos = vmatch.index + vmatch[0].length - 1;
    let pos = startPos;
    let depth = 0;
    let foundEnd = -1;

    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth < 0) break;
      } else if (ch === ';' && depth === 0) {
        foundEnd = pos;
        break;
      } else if (ch === '\n' && depth === 0) {
        const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
        if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
          foundEnd = pos;
          break;
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') { pos++; }
          else if (source[pos] === quote) break;
          pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
        pos += 2;
        while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
        pos++;
      }
      pos++;
    }

    if (foundEnd === -1) continue;

    varInsertions.push({ lineEnd: foundEnd + 1, varName, lineNo });
  }

  return varInsertions;
}

/**
 * Find destructured variable declarations: const { a, b } = ... and const [a, b] = ...
 * Extracts the individual variable names from the destructuring pattern.
 */
function findDestructuredDeclarations(source: string): Array<{ lineEnd: number; varNames: string[]; lineNo: number }> {
  const results: Array<{ lineEnd: number; varNames: string[]; lineNo: number }> = [];

  // Match: const/let/var { ... } = ... or const/let/var [ ... ] = ...
  const destructRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
  let match;

  while ((match = destructRegex.exec(source)) !== null) {
    const pattern = match[1];

    // Extract variable names from the destructuring pattern
    const varNames = extractDestructuredNames(pattern);
    if (varNames.length === 0) continue;

    // Skip if it's a require() call
    const restOfLine = source.slice(match.index + match[0].length - 1, match.index + match[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;

    // Calculate line number
    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    // Find the end of this statement (same logic as findVarDeclarations)
    const startPos = match.index + match[0].length - 1;
    let pos = startPos;
    let depth = 0;
    let foundEnd = -1;

    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth < 0) break;
      } else if (ch === ';' && depth === 0) {
        foundEnd = pos;
        break;
      } else if (ch === '\n' && depth === 0) {
        const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
        if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
          foundEnd = pos;
          break;
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') { pos++; }
          else if (source[pos] === quote) break;
          pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
        pos += 2;
        while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
        pos++;
      }
      pos++;
    }

    if (foundEnd === -1) continue;
    results.push({ lineEnd: foundEnd + 1, varNames, lineNo });
  }

  return results;
}

/**
 * Extract variable names from a destructuring pattern.
 * Handles: { a, b, c: d } → ['a', 'b', 'd']  (renamed vars use the local name)
 * Handles: [a, b, ...rest] → ['a', 'b', 'rest']
 * Handles: { a: { b, c } } → ['b', 'c']  (nested destructuring)
 */
function extractDestructuredNames(pattern: string): string[] {
  const names: string[] = [];
  // Remove outer braces/brackets
  const inner = pattern.slice(1, -1).trim();
  if (!inner) return names;

  // Split by commas at depth 0
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (let part of parts) {
    // Remove type annotations: `a: Type` vs `a: b` (rename)
    // Skip rest elements for now: ...rest → rest
    if (part.startsWith('...')) {
      const restName = part.slice(3).trim().split(/[\s:]/)[0];
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(restName)) {
        names.push(restName);
      }
      continue;
    }

    // Check for rename pattern: key: localName or key: { nested }
    const colonIdx = part.indexOf(':');
    if (colonIdx !== -1) {
      const afterColon = part.slice(colonIdx + 1).trim();
      // Nested destructuring: key: { a, b } or key: [a, b]
      if (afterColon.startsWith('{') || afterColon.startsWith('[')) {
        const nestedNames = extractDestructuredNames(afterColon);
        names.push(...nestedNames);
      } else {
        // Rename: key: localName — extract localName (skip if it has another colon for type annotation)
        const localName = afterColon.split(/[\s=]/)[0].trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
          names.push(localName);
        }
      }
    } else {
      // Simple: just the identifier (possibly with default: `a = defaultVal`)
      const name = part.split(/[\s=]/)[0].trim();
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
        names.push(name);
      }
    }
  }

  return names;
}

/**
 * Transform ESM source code to wrap function declarations and trace variables.
 *
 * Prepends imports of the wrap/trace helpers, then inserts wrapper calls after
 * each function declaration body and trace calls after variable declarations.
 */
/**
 * Find the original line number for a simple variable declaration.
 * Searches the original source lines for `const/let/var <varName>` near the expected position.
 * Vite transforms typically remove lines (types, imports), so the original line is usually
 * >= the transformed line. We search forward-biased (up to +80) but also a bit backward (-10).
 */
function findOriginalLine(origLines: string[], varName: string, transformedLine: number): number {
  const pattern = new RegExp(`\\b(const|let|var)\\s+${escapeRegexStr(varName)}\\b`);

  // Search: first try exact, then expand forward (more likely) and a bit backward
  for (let delta = 0; delta <= 80; delta++) {
    // Forward first (original line is usually after transformed line due to removed TS types)
    const fwd = transformedLine - 1 + delta;
    if (fwd >= 0 && fwd < origLines.length && pattern.test(origLines[fwd])) {
      return fwd + 1;
    }
    // Also check backward (small range)
    if (delta > 0 && delta <= 10) {
      const bwd = transformedLine - 1 - delta;
      if (bwd >= 0 && bwd < origLines.length && pattern.test(origLines[bwd])) {
        return bwd + 1;
      }
    }
  }
  return -1;
}

/**
 * Find the original line number for a destructured declaration.
 * Searches for const/let/var { or [ patterns containing at least one of the variable names.
 */
function findOriginalLineDestructured(origLines: string[], varNames: string[], transformedLine: number): number {
  // Match names as actual bindings (not renamed property keys).
  // In `{ data: customer }`, 'data' is a key (followed by ':'), 'customer' is the binding.
  // In `{ data, error }`, 'data' is a binding (followed by ',' or '}').
  // We check: name followed by comma, }, ], =, whitespace, or end — NOT followed by ':' (rename).
  const namePatterns = varNames.map(n => new RegExp(`\\b${escapeRegexStr(n)}\\b(?!\\s*:)`));

  for (let delta = 0; delta <= 80; delta++) {
    const fwd = transformedLine - 1 + delta;
    if (fwd >= 0 && fwd < origLines.length) {
      const line = origLines[fwd];
      if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) {
        return fwd + 1;
      }
    }
    if (delta > 0 && delta <= 10) {
      const bwd = transformedLine - 1 - delta;
      if (bwd >= 0 && bwd < origLines.length) {
        const line = origLines[bwd];
        if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) {
          return bwd + 1;
        }
      }
    }
  }
  return -1;
}

function escapeRegexStr(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transformEsmSource(
  source: string,
  filename: string,
  moduleName: string,
  backendUrl: string,
  debug: boolean,
  traceVars: boolean,
  originalSource?: string | null,
): string {
  // Match top-level and nested function declarations (including async, export)
  const funcRegex = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  const funcInsertions: Array<{ position: number; name: string; paramNames: string[] }> = [];
  let match;

  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1];
    if (name === 'require' || name === 'exports' || name === 'module') continue;

    const afterMatch = match.index + match[0].length;
    const openBrace = source.indexOf('{', afterMatch);
    if (openBrace === -1) continue;

    // Extract parameter names
    const paramStr = source.slice(afterMatch, openBrace).replace(/[()]/g, '').trim();
    const paramNames = paramStr
      ? paramStr.split(',').map(p => {
          const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
          return trimmed;
        }).filter(Boolean)
      : [];

    const closeBrace = findClosingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    funcInsertions.push({ position: closeBrace + 1, name, paramNames });
  }

  // Also match arrow functions assigned to const/let/var
  const arrowRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=>\s*\{/gm;

  while ((match = arrowRegex.exec(source)) !== null) {
    const name = match[1];
    const openBrace = source.indexOf('{', match.index + match[0].length - 1);
    if (openBrace === -1) continue;

    const arrowStr = match[0];
    const arrowParamMatch = arrowStr.match(/=\s*(?:async\s+)?(?:\(([^)]*)\)|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*(?::\s*[^=]+?)?\s*=>/);
    let paramNames: string[] = [];
    if (arrowParamMatch) {
      const paramStr = (arrowParamMatch[1] || arrowParamMatch[2] || '').trim();
      if (paramStr) {
        paramNames = paramStr.split(',').map(p => {
          const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
          return trimmed;
        }).filter(Boolean);
      }
    }

    const closeBrace = findClosingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    funcInsertions.push({ position: closeBrace + 1, name, paramNames });
  }

  // Find variable declarations for tracing
  const varInsertions = traceVars ? findVarDeclarations(source) : [];

  // Find destructured variable declarations for tracing
  const destructInsertions = traceVars ? findDestructuredDeclarations(source) : [];

  if (funcInsertions.length === 0 && varInsertions.length === 0 && destructInsertions.length === 0) return source;

  // Fix line numbers: Vite transforms (TypeScript stripping) may change line numbers.
  // Map transformed line numbers to original source line numbers.
  if (originalSource && originalSource !== source) {
    const origLines = originalSource.split('\n');

    // For each variable insertion, find the declaration in the original source
    for (const vi of varInsertions) {
      const origLine = findOriginalLine(origLines, vi.varName, vi.lineNo);
      if (origLine !== -1) vi.lineNo = origLine;
    }
    for (const di of destructInsertions) {
      // Use the first variable name to locate the line
      if (di.varNames.length > 0) {
        const origLine = findOriginalLineDestructured(origLines, di.varNames, di.lineNo);
        if (origLine !== -1) di.lineNo = origLine;
      }
    }
  }

  // Build prefix — ALL imports first (ESM requires imports before any statements)
  const importLines: string[] = [
    `import { wrapFunction as __trickle_wrapFn, configure as __trickle_configure } from 'trickle-observe';`,
  ];
  if (varInsertions.length > 0 || destructInsertions.length > 0) {
    importLines.push(
      `import { mkdirSync as __trickle_mkdirSync, appendFileSync as __trickle_appendFileSync } from 'node:fs';`,
      `import { join as __trickle_join } from 'node:path';`,
    );
  }

  const prefixLines = [
    ...importLines,
    `__trickle_configure({ backendUrl: ${JSON.stringify(backendUrl)}, batchIntervalMs: 2000, debug: ${debug}, enabled: true, environment: 'node' });`,
    `function __trickle_wrap(fn, name, paramNames) {`,
    `  const opts = {`,
    `    functionName: name,`,
    `    module: ${JSON.stringify(moduleName)},`,
    `    trackArgs: true,`,
    `    trackReturn: true,`,
    `    sampleRate: 1,`,
    `    maxDepth: 5,`,
    `    environment: 'node',`,
    `    enabled: true,`,
    `  };`,
    `  if (paramNames && paramNames.length) opts.paramNames = paramNames;`,
    `  return __trickle_wrapFn(fn, opts);`,
    `}`,
  ];

  // Add variable tracing if needed — inlined to avoid import resolution issues in Vite SSR.
  // Uses synchronous writes (appendFileSync) to guarantee data persists even if Vitest
  // kills the worker abruptly without firing exit events.
  if (varInsertions.length > 0 || destructInsertions.length > 0) {
    prefixLines.push(
      `if (!globalThis.__trickle_var_tracer) {`,
      `  const _cache = new Set();`,
      `  let _varsFile = null;`,
      `  function _inferType(v, d) {`,
      `    if (d <= 0) return { kind: 'primitive', name: 'unknown' };`,
      `    if (v === null) return { kind: 'primitive', name: 'null' };`,
      `    if (v === undefined) return { kind: 'primitive', name: 'undefined' };`,
      `    const t = typeof v;`,
      `    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return { kind: 'primitive', name: t };`,
      `    if (t === 'function') return { kind: 'function' };`,
      `    if (Array.isArray(v)) { return v.length === 0 ? { kind: 'array', element: { kind: 'primitive', name: 'unknown' } } : { kind: 'array', element: _inferType(v[0], d-1) }; }`,
      `    if (t === 'object') {`,
      `      if (v instanceof Date) return { kind: 'object', properties: { __date: { kind: 'primitive', name: 'string' } } };`,
      `      if (v instanceof RegExp) return { kind: 'object', properties: { __regexp: { kind: 'primitive', name: 'string' } } };`,
      `      if (v instanceof Error) return { kind: 'object', properties: { __error: { kind: 'primitive', name: 'string' } } };`,
      `      if (v instanceof Promise) return { kind: 'promise', resolved: { kind: 'primitive', name: 'unknown' } };`,
      `      const props = {}; const keys = Object.keys(v).slice(0, 20);`,
      `      for (const k of keys) { try { props[k] = _inferType(v[k], d-1); } catch(e) { props[k] = { kind: 'primitive', name: 'unknown' }; } }`,
      `      return { kind: 'object', properties: props };`,
      `    }`,
      `    return { kind: 'primitive', name: 'unknown' };`,
      `  }`,
      `  function _sanitize(v, d) {`,
      `    if (d <= 0) return '[truncated]'; if (v === null || v === undefined) return v; const t = typeof v;`,
      `    if (t === 'string') return v.length > 100 ? v.substring(0, 100) + '...' : v;`,
      `    if (t === 'number' || t === 'boolean') return v; if (t === 'bigint') return String(v);`,
      `    if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';`,
      `    if (Array.isArray(v)) return v.slice(0, 3).map(i => _sanitize(i, d-1));`,
      `    if (t === 'object') { if (v instanceof Date) return v.toISOString(); if (v instanceof RegExp) return String(v); if (v instanceof Error) return { error: v.message }; if (v instanceof Promise) return '[Promise]';`,
      `      const r = {}; const keys = Object.keys(v).slice(0, 10); for (const k of keys) { try { r[k] = _sanitize(v[k], d-1); } catch(e) { r[k] = '[unreadable]'; } } return r; }`,
      `    return String(v);`,
      `  }`,
      `  globalThis.__trickle_var_tracer = function(v, n, l, mod, file) {`,
      `    try {`,
      `      if (!_varsFile) {`,
      `        const dir = process.env.TRICKLE_LOCAL_DIR || __trickle_join(process.cwd(), '.trickle');`,
      `        try { __trickle_mkdirSync(dir, { recursive: true }); } catch(e) {}`,
      `        _varsFile = __trickle_join(dir, 'variables.jsonl');`,
      `      }`,
      `      const type = _inferType(v, 3);`,
      `      const th = JSON.stringify(type).substring(0, 32);`,
      `      const ck = file + ':' + l + ':' + n + ':' + th;`,
      `      if (_cache.has(ck)) return;`,
      `      _cache.add(ck);`,
      `      __trickle_appendFileSync(_varsFile, JSON.stringify({ kind: 'variable', varName: n, line: l, module: mod, file: file, type: type, typeHash: th, sample: _sanitize(v, 2) }) + '\\n');`,
      `    } catch(e) {}`,
      `  };`,
      `}`,
      `function __trickle_tv(v, n, l) { try { globalThis.__trickle_var_tracer(v, n, l, ${JSON.stringify(moduleName)}, ${JSON.stringify(filename)}); } catch(e) {} }`,
    );
  }

  prefixLines.push('');
  const prefix = prefixLines.join('\n');

  // Merge all insertions and sort by position descending
  type Insertion = { position: number; code: string };
  const allInsertions: Insertion[] = [];

  for (const { position, name, paramNames } of funcInsertions) {
    const paramNamesArg = paramNames.length > 0 ? JSON.stringify(paramNames) : 'null';
    allInsertions.push({
      position,
      code: `\ntry{${name}=__trickle_wrap(${name},'${name}',${paramNamesArg})}catch(__e){}\n`,
    });
  }

  for (const { lineEnd, varName, lineNo } of varInsertions) {
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}\n`,
    });
  }

  for (const { lineEnd, varNames, lineNo } of destructInsertions) {
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{${calls}}catch(__e){}\n`,
    });
  }

  // Sort by position descending (insert from end to preserve earlier positions)
  allInsertions.sort((a, b) => b.position - a.position);

  let result = source;
  for (const { position, code } of allInsertions) {
    result = result.slice(0, position) + code + result.slice(position);
  }

  return prefix + result;
}

export default tricklePlugin;
