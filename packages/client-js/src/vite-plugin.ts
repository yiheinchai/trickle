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

    configureServer(server: any) {
      // Listen for variable data from browser clients via Vite's HMR WebSocket
      const hot = server.hot || server.ws;
      if (hot && hot.on) {
        const varDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
        try { fs.mkdirSync(varDir, { recursive: true }); } catch {}
        const varsFile = path.join(varDir, 'variables.jsonl');

        hot.on('trickle:vars', (data: { lines: string }, client: any) => {
          try {
            if (data && data.lines) {
              fs.appendFileSync(varsFile, data.lines);
            }
          } catch {}
        });

        if (debug) {
          console.log(`[trickle/vite] WebSocket bridge active → ${varsFile}`);
        }
      }
    },

    transform(code: string, id: string, options?: { ssr?: boolean }) {
      if (!shouldTransform(id)) return null;

      const isSSR = options?.ssr === true;

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
      const transformed = transformEsmSource(code, id, moduleName, backendUrl, debug, traceVars, originalSource, isSSR);
      if (transformed === code) return null;

      if (debug) {
        console.log(`[trickle/vite] Transformed ${moduleName} (${id}) [${isSSR ? 'SSR' : 'browser'}]`);
      }

      return { code: transformed, map: null };
    },
  };
}

/**
 * Find the opening brace of a function body, skipping the parameter list.
 * Starting from the character right after the opening `(` of the parameter list,
 * scans forward matching parens to find the closing `)`, then finds the `{` after it.
 * Returns -1 if not found.
 */
function findFunctionBodyBrace(source: string, afterOpenParen: number): number {
  let depth = 1;
  let pos = afterOpenParen;
  // Skip the parameter list (matching parens)
  while (pos < source.length && depth > 0) {
    const ch = source[pos];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
    }
    pos++;
  }
  // Now find the `{` after the closing `)`
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '{') return pos;
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== ':') {
      // Hit something unexpected (like '=>' for arrows, or type annotation chars)
      if (ch === '=' && pos + 1 < source.length && source[pos + 1] === '>') {
        // Arrow — find { after =>
        pos += 2;
        continue;
      }
      // Type annotation — keep going (`: ReturnType`)
    }
    pos++;
  }
  return -1;
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
 * Find the matching closing paren for an opening paren at openParen.
 * JSX-safe version: counts `(` and `)` depth, handles JSX curly expressions,
 * but does NOT treat `'` as a string delimiter (apostrophes in JSX text content
 * like `I'm` would incorrectly consume parens). Double-quoted strings inside
 * JSX attr values typically contain balanced parens so can be ignored safely.
 */
function findMatchingParen(source: string, openParen: number): number {
  let depth = 1;
  let pos = openParen + 1;
  while (pos < source.length && depth > 0) {
    const ch = source[pos];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return pos;
    }
    // Skip JSX expression blocks {expr} — not parens but skip curly content to avoid
    // false paren matches inside template expressions
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

export function transformEsmSource(
  source: string,
  filename: string,
  moduleName: string,
  backendUrl: string,
  debug: boolean,
  traceVars: boolean,
  originalSource?: string | null,
  isSSR?: boolean,
): string {
  // Detect React files for component render tracking
  const isReactFile = /\.(tsx|jsx)$/.test(filename);

  // Match top-level and nested function declarations (including async, export, export default)
  const funcRegex = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  const funcInsertions: Array<{ position: number; name: string; paramNames: string[] }> = [];
  // Body insertions: insert at start of function body (for React render tracking)
  // propsExpr: JS expression to evaluate as the props object at render time
  const bodyInsertions: Array<{ position: number; name: string; lineNo: number; propsExpr: string }> = [];
  let match;

  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1];
    if (name === 'require' || name === 'exports' || name === 'module') continue;

    const afterMatch = match.index + match[0].length;
    // Use findFunctionBodyBrace to correctly skip destructured params like ({ a, b }) =>
    const openBrace = findFunctionBodyBrace(source, afterMatch);
    if (openBrace === -1) continue;

    // Extract parameter names (between the opening ( and the body {)
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

    // React component render tracking: uppercase function name in .tsx/.jsx
    // function declarations have `arguments`, so arguments[0] is the raw props object
    if (isReactFile && /^[A-Z]/.test(name)) {
      let lineNo = 1;
      for (let i = 0; i < match.index; i++) {
        if (source[i] === '\n') lineNo++;
      }
      bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr: 'arguments[0]' });
    }
  }

  // Also match arrow functions assigned to const/let/var
  // Handles: const X = () => {}, const X: React.FC = () => {}, const X: React.FC<Props> = ({ a }) => {}
  // Also handles concise bodies: const X = (props) => (<div/>)
  const arrowRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+?)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=>\s*(?:\{|\()/gm;

  // Concise body insertions: for `=> (expr)`, wrap with block body for render tracking
  const conciseBodyInsertions: Array<{ beforeParen: number; afterCloseParen: number; name: string; lineNo: number; propsExpr: string }> = [];

  while ((match = arrowRegex.exec(source)) !== null) {
    const name = match[1];
    const bodyStartPos = match.index + match[0].length - 1;
    const isConcise = source[bodyStartPos] === '(';

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

    // Helper to build propsExpr from arrowParamMatch
    const buildPropsExpr = () => {
      if (!arrowParamMatch) return 'undefined';
      const rawParams = (arrowParamMatch[1] || '').trim();
      if (!rawParams) return 'undefined';
      if (rawParams.startsWith('{')) {
        let depth2 = 0, endBrace = -1;
        for (let i = 0; i < rawParams.length; i++) {
          if (rawParams[i] === '{') depth2++;
          else if (rawParams[i] === '}') { depth2--; if (depth2 === 0) { endBrace = i; break; } }
        }
        const destructPattern = endBrace !== -1 ? rawParams.slice(0, endBrace + 1) : rawParams;
        const fields = extractDestructuredNames(destructPattern);
        return fields.length > 0 ? `{ ${fields.join(', ')} }` : 'undefined';
      } else if (arrowParamMatch[2]) {
        return arrowParamMatch[2];
      } else if (paramNames.length === 1) {
        return paramNames[0];
      }
      return 'undefined';
    };

    if (isConcise) {
      // Concise body: `const X = (props) => (<div/>)` — no block body
      // Only add render tracking for React components (uppercase names in .tsx/.jsx)
      if (isReactFile && /^[A-Z]/.test(name)) {
        const closeParen = findMatchingParen(source, bodyStartPos);
        if (closeParen === -1) continue;

        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
          if (source[i] === '\n') lineNo++;
        }

        conciseBodyInsertions.push({ beforeParen: bodyStartPos, afterCloseParen: closeParen + 1, name, lineNo, propsExpr: buildPropsExpr() });
      }
    } else {
      // Block body: `const X = (props) => { ... }`
      const openBrace = bodyStartPos;

      const closeBrace = findClosingBrace(source, openBrace);
      if (closeBrace === -1) continue;

      funcInsertions.push({ position: closeBrace + 1, name, paramNames });

      // React component render tracking: uppercase arrow function in .tsx/.jsx
      if (isReactFile && /^[A-Z]/.test(name)) {
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
          if (source[i] === '\n') lineNo++;
        }

        bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr: buildPropsExpr() });
      }
    }
  }



  // Match React.memo() and React.forwardRef() wrapped components
  // Pattern: const Name = (React.)?memo(  or  const Name = (React.)?forwardRef<T,P>(
  // Then scan forward to find the inner arrow => { body
  if (isReactFile) {
    const memoRefRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Z][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+?)?\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*(?:<[^(]*>)?\s*\(/gm;
    let memoMatch;
    while ((memoMatch = memoRefRegex.exec(source)) !== null) {
      const name = memoMatch[1];
      // Position after the opening `(` of memo/forwardRef call
      const afterMemoOpen = memoMatch.index + memoMatch[0].length;

      // Scan forward to find `=> {` — the arrow body of the inner function.
      // We need to skip over the inner function's parameter list (which may contain nested parens).
      // Strategy: find the next `=>` that is followed by optional whitespace and `{`.
      let pos = afterMemoOpen;
      let arrowPos = -1;
      let parenDepth = 0;
      while (pos < source.length - 1) {
        const ch = source[pos];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        else if (ch === '=' && source[pos + 1] === '>' && parenDepth <= 0) {
          arrowPos = pos;
          break;
        }
        pos++;
      }
      if (arrowPos === -1) continue;

      // Skip `=>` and whitespace to find `{`
      let bracePos = arrowPos + 2;
      while (bracePos < source.length && /[\s]/.test(source[bracePos])) bracePos++;
      if (source[bracePos] !== '{') continue;
      const openBrace = bracePos;

      const closeBrace = findClosingBrace(source, openBrace);
      if (closeBrace === -1) continue;

      // Extract the param list: everything between memo( and arrowPos
      const innerParamStr = source.slice(afterMemoOpen, arrowPos).trim();
      // innerParamStr is like `({ item, onSelect })` or `(props, ref)` or `props`
      let propsExpr = 'undefined';
      if (innerParamStr.startsWith('(')) {
        // Peel outer parens
        const inner = innerParamStr.slice(1, innerParamStr.lastIndexOf(')')).trim();
        if (inner.startsWith('{')) {
          // Find the matching `}` of the destructuring pattern, ignoring any type annotation after it
          let depth3 = 0, destructEnd = -1;
          for (let i = 0; i < inner.length; i++) {
            if (inner[i] === '{') depth3++;
            else if (inner[i] === '}') { depth3--; if (depth3 === 0) { destructEnd = i; break; } }
          }
          const destructPart = destructEnd !== -1 ? inner.slice(0, destructEnd + 1) : inner;
          const fields = extractDestructuredNames(destructPart);
          if (fields.length > 0) propsExpr = `{ ${fields.join(', ')} }`;
        } else {
          const firstParam = inner.split(',')[0].trim().split(':')[0].trim();
          if (firstParam) propsExpr = firstParam;
        }
      } else if (innerParamStr && /^[a-zA-Z_$]/.test(innerParamStr)) {
        propsExpr = innerParamStr.split(/[\s,:(]/)[0];
      }

      let lineNo = 1;
      for (let i = 0; i < memoMatch.index; i++) {
        if (source[i] === '\n') lineNo++;
      }

      bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr });
    }
  }

  // React hook tracking — wrap the callback arg of useEffect/useMemo/useCallback
  // to count how many times each hook fires (effect ran, memo recomputed, callback invoked).
  // Each hook produces TWO insertions: wrapStart (before callback) and wrapEnd (after callback `}`).
  interface HookInsertion { wrapStart: number; wrapEnd: number; hookName: string; lineNo: number }
  const hookInsertions: HookInsertion[] = [];

  if (isReactFile) {
    // Match useEffect(, useMemo(, useCallback( — also handles React.useEffect(, etc.
    const hookCallRegex = /\b(useEffect|useMemo|useCallback)\s*\(/g;
    let hookMatch;
    while ((hookMatch = hookCallRegex.exec(source)) !== null) {
      const hookName = hookMatch[1];
      const afterParen = hookMatch.index + hookMatch[0].length;

      // Skip past optional 'async '
      let pos = afterParen;
      while (pos < source.length && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n')) pos++;
      if (source.slice(pos, pos + 6) === 'async ') {
        pos += 6;
        while (pos < source.length && (source[pos] === ' ' || source[pos] === '\t')) pos++;
      }

      // Expect a callback: arrow fn `(` or `identifier =>` or `function`
      if (source[pos] !== '(' && !/^[a-zA-Z_$]/.test(source[pos]) && source.slice(pos, pos + 8) !== 'function') continue;

      // Find the opening `{` of the callback body depending on callback form:
      // 1. Arrow with parens: (x, y) => {  — call findFunctionBodyBrace from inside the (
      // 2. Named/anon function: function() {  — find the ( first
      // 3. Single identifier: props => {  — skip identifier, find =>, find {
      let callbackBodyBrace = -1;
      if (source[pos] === '(') {
        // Arrow function with param list: () => { ... } or (x) => { ... }
        callbackBodyBrace = findFunctionBodyBrace(source, pos + 1);
      } else if (source.slice(pos, pos + 8) === 'function') {
        // function() {} or function name() {}
        let funcPos = pos + 8;
        while (funcPos < source.length && /\s/.test(source[funcPos])) funcPos++;
        if (/[a-zA-Z_$]/.test(source[funcPos])) {
          while (funcPos < source.length && /[a-zA-Z0-9_$]/.test(source[funcPos])) funcPos++;
        }
        while (funcPos < source.length && source[funcPos] !== '(') funcPos++;
        if (funcPos < source.length) {
          callbackBodyBrace = findFunctionBodyBrace(source, funcPos + 1);
        }
      } else {
        // Single identifier param: props => { ... }
        let idEnd = pos;
        while (idEnd < source.length && /[a-zA-Z0-9_$]/.test(source[idEnd])) idEnd++;
        let arrowPos = idEnd;
        while (arrowPos < source.length && (source[arrowPos] === ' ' || source[arrowPos] === '\t')) arrowPos++;
        if (source.slice(arrowPos, arrowPos + 2) === '=>') {
          arrowPos += 2;
          while (arrowPos < source.length && (source[arrowPos] === ' ' || source[arrowPos] === '\t' || source[arrowPos] === '\n')) arrowPos++;
          if (source[arrowPos] === '{') callbackBodyBrace = arrowPos;
        }
      }
      if (callbackBodyBrace === -1) continue;

      // Verify nothing suspicious between pos and the `{` (no semicolons, no other hook calls)
      const between = source.slice(pos, callbackBodyBrace);
      if (between.includes(';') || /\buseEffect\b|\buseMemo\b|\buseCallback\b/.test(between)) continue;

      const closeBrace = findClosingBrace(source, callbackBodyBrace);
      if (closeBrace === -1) continue;

      let lineNo = 1;
      for (let i = 0; i < hookMatch.index; i++) {
        if (source[i] === '\n') lineNo++;
      }

      hookInsertions.push({ wrapStart: afterParen, wrapEnd: closeBrace + 1, hookName, lineNo });
    }
  }

  // React useState tracking — rename setter to __trickle_s_X and declare tracked wrapper.
  // Detects: const [stateVar, setter] = useState(...) or useState<T>(...)
  interface StateInsertion {
    renamePos: number;   // position in source to insert '__trickle_s_' before setter name
    afterLine: number;   // position after end of useState statement to insert declaration
    stateName: string;
    setterName: string;
    lineNo: number;
  }
  const stateInsertions: StateInsertion[] = [];

  if (isReactFile) {
    const useStateRegex = /const\s+\[([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\]\s*=\s*(?:React\.)?useState\s*(?:<[^(]*>)?\s*\(/gm;
    let sm;
    while ((sm = useStateRegex.exec(source)) !== null) {
      const stateName = sm[1];
      const setterName = sm[2];

      // Find the position of setterName within the match (after the comma)
      const matchStr = sm[0];
      const commaIdx = matchStr.indexOf(',');
      const setterInMatch = matchStr.indexOf(setterName, commaIdx);
      if (setterInMatch === -1) continue;
      const renamePos = sm.index + setterInMatch;

      // Skip the useState(...) argument list to find the end of the statement
      let pos = sm.index + sm[0].length;
      let depth = 1;
      while (pos < source.length && depth > 0) {
        const ch = source[pos];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch; pos++;
          while (pos < source.length && source[pos] !== q) {
            if (source[pos] === '\\') pos++;
            pos++;
          }
        }
        pos++;
      }
      // Skip to end of line (past semicolon or newline)
      while (pos < source.length && source[pos] !== ';' && source[pos] !== '\n') pos++;
      const afterLine = pos + 1;

      let lineNo = 1;
      for (let i = 0; i < sm.index; i++) {
        if (source[i] === '\n') lineNo++;
      }

      stateInsertions.push({ renamePos, afterLine, stateName, setterName, lineNo });
    }
  }

  // Find variable declarations for tracing
  const varInsertions = traceVars ? findVarDeclarations(source) : [];

  // Find destructured variable declarations for tracing
  const destructInsertions = traceVars ? findDestructuredDeclarations(source) : [];

  if (funcInsertions.length === 0 && varInsertions.length === 0 && destructInsertions.length === 0 && bodyInsertions.length === 0 && hookInsertions.length === 0 && stateInsertions.length === 0 && conciseBodyInsertions.length === 0) return source;

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
  const needsTracing = varInsertions.length > 0 || destructInsertions.length > 0 || bodyInsertions.length > 0 || hookInsertions.length > 0 || stateInsertions.length > 0 || conciseBodyInsertions.length > 0;
  const importLines: string[] = [
    `import { wrapFunction as __trickle_wrapFn, configure as __trickle_configure } from 'trickle-observe';`,
  ];
  if (needsTracing && isSSR) {
    // SSR/Node.js — use file system for writing
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

  // Add unified __trickle_send() transport — browser uses HMR WebSocket, SSR uses fs
  if (needsTracing) {
    if (isSSR) {
      // SSR/Node.js mode — write directly to file system
      prefixLines.push(
        `let __trickle_varsFile = null;`,
        `function __trickle_send(line) {`,
        `  try {`,
        `    if (!__trickle_varsFile) {`,
        `      const dir = process.env.TRICKLE_LOCAL_DIR || __trickle_join(process.cwd(), '.trickle');`,
        `      try { __trickle_mkdirSync(dir, { recursive: true }); } catch(e) {}`,
        `      __trickle_varsFile = __trickle_join(dir, 'variables.jsonl');`,
        `    }`,
        `    __trickle_appendFileSync(__trickle_varsFile, line + '\\n');`,
        `  } catch(e) {}`,
        `}`,
      );
    } else {
      // Browser mode — buffer and send via Vite HMR WebSocket
      prefixLines.push(
        `const __trickle_sendBuf = [];`,
        `let __trickle_sendTimer = null;`,
        `function __trickle_flush() {`,
        `  if (__trickle_sendBuf.length === 0) return;`,
        `  const lines = __trickle_sendBuf.join('\\n') + '\\n';`,
        `  __trickle_sendBuf.length = 0;`,
        `  try { if (import.meta.hot) import.meta.hot.send('trickle:vars', { lines }); } catch(e) {}`,
        `}`,
        `function __trickle_send(line) {`,
        `  __trickle_sendBuf.push(line);`,
        `  if (!__trickle_sendTimer) {`,
        `    __trickle_sendTimer = setTimeout(() => { __trickle_sendTimer = null; __trickle_flush(); }, 300);`,
        `  }`,
        `}`,
      );
    }
  }

  // Add variable tracing if needed — inlined to avoid import resolution issues in Vite SSR.
  if (varInsertions.length > 0 || destructInsertions.length > 0) {
    prefixLines.push(
      `if (!globalThis.__trickle_var_tracer) {`,
      `  const _cache = new Set();`,
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
      `      const type = _inferType(v, 3);`,
      `      const th = JSON.stringify(type).substring(0, 32);`,
      `      const ck = file + ':' + l + ':' + n + ':' + th;`,
      `      if (_cache.has(ck)) return;`,
      `      _cache.add(ck);`,
      `      __trickle_send(JSON.stringify({ kind: 'variable', varName: n, line: l, module: mod, file: file, type: type, typeHash: th, sample: _sanitize(v, 2) }));`,
      `    } catch(e) {}`,
      `  };`,
      `}`,
      `function __trickle_tv(v, n, l) { try { globalThis.__trickle_var_tracer(v, n, l, ${JSON.stringify(moduleName)}, ${JSON.stringify(filename)}); } catch(e) {} }`,
    );
  }

  // Add React component render tracker if needed
  if (bodyInsertions.length > 0 || conciseBodyInsertions.length > 0) {
    prefixLines.push(
      `if (!globalThis.__trickle_react_renders) { globalThis.__trickle_react_renders = new Map(); }`,
      `if (!globalThis.__trickle_react_prev_props) { globalThis.__trickle_react_prev_props = new Map(); }`,
      `function __trickle_rc(name, line, props) {`,
      `  try {`,
      `    const key = ${JSON.stringify(filename)} + ':' + line;`,
      `    const count = (globalThis.__trickle_react_renders.get(key) || 0) + 1;`,
      `    globalThis.__trickle_react_renders.set(key, count);`,
      `    const rec = { kind: 'react_render', file: ${JSON.stringify(filename)}, line: line, component: name, renderCount: count, timestamp: Date.now() / 1000 };`,
      `    if (props !== undefined && props !== null && typeof props === 'object') {`,
      `      try {`,
      `        const propKeys = Object.keys(props).filter(k => k !== 'children');`,
      `        const propSample = {};`,
      `        for (const k of propKeys.slice(0, 10)) {`,
      `          const v = props[k];`,
      `          const t = typeof v;`,
      `          if (t === 'string') propSample[k] = v.length > 40 ? v.slice(0, 40) + '...' : v;`,
      `          else if (t === 'number' || t === 'boolean') propSample[k] = v;`,
      `          else if (v === null || v === undefined) propSample[k] = v;`,
      `          else if (Array.isArray(v)) propSample[k] = '[arr:' + v.length + ']';`,
      `          else if (t === 'function') propSample[k] = '[fn]';`,
      `          else propSample[k] = '[object]';`,
      `        }`,
      `        rec.props = propSample;`,
      `        rec.propKeys = propKeys;`,
      `        const prevProps = globalThis.__trickle_react_prev_props.get(key);`,
      `        if (prevProps && count > 1) {`,
      `          const changedProps = [];`,
      `          const allKeys = new Set([...Object.keys(prevProps), ...Object.keys(propSample)]);`,
      `          for (const k of allKeys) {`,
      `            const prev = prevProps[k];`,
      `            const curr = propSample[k];`,
      `            if (String(prev) !== String(curr)) {`,
      `              changedProps.push({ key: k, from: prev, to: curr });`,
      `            }`,
      `          }`,
      `          if (changedProps.length > 0) rec.changedProps = changedProps;`,
      `        }`,
      `        globalThis.__trickle_react_prev_props.set(key, propSample);`,
      `      } catch(e2) {}`,
      `    }`,
      `    __trickle_send(JSON.stringify(rec));`,
      `  } catch(e) {}`,
      `}`,
    );
  }

  // Add React hook tracker if needed
  if (hookInsertions.length > 0) {
    prefixLines.push(
      `if (!globalThis.__trickle_hook_counts) { globalThis.__trickle_hook_counts = new Map(); }`,
      `function __trickle_hw(hookName, line, cb) {`,
      `  return function(...args) {`,
      `    try {`,
      `      const key = ${JSON.stringify(filename)} + ':' + line + ':' + hookName;`,
      `      const n = (globalThis.__trickle_hook_counts.get(key) || 0) + 1;`,
      `      globalThis.__trickle_hook_counts.set(key, n);`,
      `      __trickle_send(JSON.stringify({ kind: 'react_hook', hookName, file: ${JSON.stringify(filename)}, line, invokeCount: n, timestamp: Date.now() / 1000 }));`,
      `    } catch(e) {}`,
      `    return cb(...args);`,
      `  };`,
      `}`,
    );
  }

  // Add useState setter tracker if needed
  if (stateInsertions.length > 0) {
    prefixLines.push(
      `if (!globalThis.__trickle_state_counts) { globalThis.__trickle_state_counts = new Map(); }`,
      `function __trickle_ss(stateName, line, origSetter) {`,
      `  return function(newVal) {`,
      `    try {`,
      `      const key = ${JSON.stringify(filename)} + ':' + line + ':' + stateName;`,
      `      const n = (globalThis.__trickle_state_counts.get(key) || 0) + 1;`,
      `      globalThis.__trickle_state_counts.set(key, n);`,
      `      const t = typeof newVal;`,
      `      let sample;`,
      `      if (t === 'function') sample = '[fn updater]';`,
      `      else if (t === 'string') sample = newVal.length > 40 ? newVal.slice(0,40)+'...' : newVal;`,
      `      else if (t === 'number' || t === 'boolean') sample = newVal;`,
      `      else if (newVal === null || newVal === undefined) sample = newVal;`,
      `      else if (Array.isArray(newVal)) sample = '[arr:'+newVal.length+']';`,
      `      else sample = '[object]';`,
      `      __trickle_send(JSON.stringify({ kind: 'react_state', file: ${JSON.stringify(filename)}, line, stateName, updateCount: n, value: sample, timestamp: Date.now()/1000 }));`,
      `    } catch(e) {}`,
      `    return origSetter(newVal);`,
      `  };`,
      `}`,
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

  for (const { position, name, lineNo, propsExpr } of bodyInsertions) {
    allInsertions.push({
      position,
      code: `\ntry{__trickle_rc(${JSON.stringify(name)},${lineNo},${propsExpr})}catch(__e){}\n`,
    });
  }

  // Hook insertions: each hook needs TWO insertions (wrapper start before callback, `)` after)
  for (const { wrapStart, wrapEnd, hookName, lineNo } of hookInsertions) {
    allInsertions.push({ position: wrapStart, code: `__trickle_hw(${JSON.stringify(hookName)},${lineNo},` });
    allInsertions.push({ position: wrapEnd, code: `)` });
  }

  // useState insertions: TWO insertions per useState
  // 1. Prefix setter name with '__trickle_s_' (rename in destructuring)
  // 2. After statement end, declare tracked wrapper: const setter = __trickle_ss(...)
  for (const { renamePos, afterLine, stateName, setterName, lineNo } of stateInsertions) {
    allInsertions.push({ position: renamePos, code: `__trickle_s_` });
    allInsertions.push({
      position: afterLine,
      code: `const ${setterName}=__trickle_ss(${JSON.stringify(stateName)},${lineNo},__trickle_s_${setterName});\n`,
    });
  }

  // Concise arrow body insertions: convert `=> (expr)` to `=> { try{__trickle_rc(...)} return (expr); }`
  // Two insertions per component: one before `(`, one after matching `)`
  for (const { beforeParen, afterCloseParen, name, lineNo, propsExpr } of conciseBodyInsertions) {
    allInsertions.push({
      position: beforeParen,
      code: `{ try{__trickle_rc(${JSON.stringify(name)},${lineNo},${propsExpr})}catch(__e){} return `,
    });
    allInsertions.push({
      position: afterCloseParen,
      code: `\n}`,
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
