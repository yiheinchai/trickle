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
import fs from 'fs';
import { configure } from './transport';
import { detectEnvironment } from './env-detect';
import { wrapFunction } from './wrap';
import { WrapOptions } from './types';
import { patchFetch } from './fetch-observer';
import { instrumentExpress, trickleMiddleware } from './express';
import { initVarTracer, traceVar } from './trace-var';
import { initCallTrace } from './call-trace';
import { initLlmObserver } from './llm-observer';
import { initMcpObserver } from './mcp-observer';
import {
  findReassignments,
  findForLoopVars,
  findCatchVars,
  findFunctionBodyBrace,
} from './vite-plugin';

// ── Source map support ──
// Lightweight VLQ decoder for mapping compiled JS lines back to original TS lines

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_LOOKUP = new Map<string, number>();
for (let i = 0; i < VLQ_CHARS.length; i++) VLQ_LOOKUP.set(VLQ_CHARS[i], i);

function decodeVLQ(encoded: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const c of encoded) {
    const digit = VLQ_LOOKUP.get(c);
    if (digit === undefined) break;
    const cont = digit & 32; // continuation bit
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const isNeg = value & 1;
      value >>= 1;
      values.push(isNeg ? -value : value);
      shift = 0;
      value = 0;
    }
  }
  return values;
}

interface SourceMapData {
  /** Map from compiled 1-based line → original 1-based line */
  lineMap: Map<number, number>;
  /** Original source file path (resolved to absolute) — primary/first user source */
  originalFile: string;
  /** All source files listed in the source map */
  sources: string[];
  /** Map from compiled line → resolved source file path (for multi-source bundles) */
  lineSourceMap?: Map<number, string>;
}

/**
 * Resolve a source map source path to a real filesystem path.
 * Handles webpack:// URLs, file:// URLs, and relative paths.
 */
function resolveSourcePath(source: string, mapDir: string, sourceRoot: string, jsFilePath: string): string {
  // Handle webpack:// URLs: webpack://package-name/./src/file.ts
  if (source.startsWith('webpack://')) {
    // Strip webpack://package-name/ prefix
    const withoutProtocol = source.replace(/^webpack:\/\/[^/]*\//, '');
    // Resolve relative to the project root (parent of dist/ or the JS file's directory)
    const projectRoot = findProjectRoot(jsFilePath);
    return path.resolve(projectRoot, withoutProtocol);
  }
  // Handle file:// URLs
  if (source.startsWith('file://')) {
    return source.replace(/^file:\/\//, '');
  }
  // Regular relative path
  return path.resolve(mapDir, sourceRoot, source);
}

/**
 * Find the project root by looking for package.json or tsconfig.json
 * starting from the JS file's directory and walking up.
 */
function findProjectRoot(jsFilePath: string): string {
  let dir = path.dirname(jsFilePath);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(jsFilePath);
}

/**
 * Parse a source map JSON and build a compiled→original line mapping.
 * Supports both single-source (tsc) and multi-source (webpack/rollup) maps.
 */
function parseSourceMap(mapJson: string, mapFilePath: string, jsFilePath: string): SourceMapData | null {
  try {
    const map = JSON.parse(mapJson);
    if (!map.mappings || !map.sources || map.sources.length === 0) return null;

    const mapDir = path.dirname(mapFilePath);
    const sourceRoot = map.sourceRoot || '';

    // Resolve all source paths, filtering out non-user sources (webpack internals)
    const resolvedSources = map.sources.map((s: string) => resolveSourcePath(s, mapDir, sourceRoot, jsFilePath));

    // Find the first user source file (skip webpack bootstrap/runtime)
    let primarySourceIdx = 0;
    for (let i = 0; i < resolvedSources.length; i++) {
      const s = map.sources[i] as string;
      if (!s.includes('webpack/bootstrap') && !s.includes('webpack/runtime') && fs.existsSync(resolvedSources[i])) {
        primarySourceIdx = i;
        break;
      }
    }
    const originalFile = resolvedSources[primarySourceIdx];

    // Decode mappings: semicolons separate lines, commas separate segments
    // VLQ values are cumulative across ALL segments (not just first per line).
    // For multi-source maps, also track the source index to map lines to different files.
    const lineMap = new Map<number, number>();
    /** Map from generated line → resolved source file path */
    const lineSourceMap = new Map<number, string>();
    const lines = map.mappings.split(';');
    let sourceLine = 0;
    let sourceIdx = 0;

    for (let genLine = 0; genLine < lines.length; genLine++) {
      const line = lines[genLine];
      if (!line) continue;

      const segments = line.split(',');
      let firstSegmentMapped = false;
      for (const seg of segments) {
        if (!seg) continue;
        const decoded = decodeVLQ(seg);
        if (decoded.length >= 3) {
          if (decoded.length >= 2) sourceIdx += decoded[1]; // Update source index
          sourceLine += decoded[2];
          if (!firstSegmentMapped) {
            lineMap.set(genLine + 1, sourceLine + 1);
            // Track which source file this line belongs to
            if (sourceIdx >= 0 && sourceIdx < resolvedSources.length) {
              lineSourceMap.set(genLine + 1, resolvedSources[sourceIdx]);
            }
            firstSegmentMapped = true;
          }
        }
      }
    }

    return { lineMap, originalFile, sources: map.sources, lineSourceMap };
  } catch {
    return null;
  }
}

/**
 * Try to load a source map for a compiled JS file.
 * Checks: 1) sourceMappingURL comment, 2) .map file alongside .js
 */
function loadSourceMap(jsFilePath: string, source: string): SourceMapData | null {
  try {
    // Check for inline sourceMappingURL
    const urlMatch = source.match(/\/\/[#@]\s*sourceMappingURL=(.+?)(?:\s|$)/);
    if (urlMatch) {
      const url = urlMatch[1].trim();
      // Skip data URIs (inline source maps) — too complex for now
      if (url.startsWith('data:')) return null;
      // Resolve relative to the JS file
      const mapPath = path.resolve(path.dirname(jsFilePath), url);
      if (fs.existsSync(mapPath)) {
        const mapJson = fs.readFileSync(mapPath, 'utf8');
        return parseSourceMap(mapJson, mapPath, jsFilePath);
      }
    }

    // Fallback: check for .map file alongside .js
    const mapPath = jsFilePath + '.map';
    if (fs.existsSync(mapPath)) {
      const mapJson = fs.readFileSync(mapPath, 'utf8');
      return parseSourceMap(mapJson, mapPath, jsFilePath);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Map a compiled line number to original source line using source map data.
 * If the exact line isn't in the map, find the nearest mapped line.
 */
function mapLineToOriginal(sourceMap: SourceMapData, compiledLine: number): number {
  const exact = sourceMap.lineMap.get(compiledLine);
  if (exact !== undefined) return exact;

  // Find the nearest mapped line before this one
  let bestLine = compiledLine;
  let bestDist = Infinity;
  for (const [genLine, origLine] of sourceMap.lineMap) {
    const dist = compiledLine - genLine;
    if (dist >= 0 && dist < bestDist) {
      bestDist = dist;
      bestLine = origLine + dist; // Assume roughly 1:1 mapping for nearby lines
    }
  }
  return bestLine;
}

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
    } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] !== '/' && source[pos + 1] !== '*') {
      // Possible regex literal — check preceding context
      let p = pos - 1;
      while (p >= 0 && (source[p] === ' ' || source[p] === '\t')) p--;
      const prevCh = p >= 0 ? source[p] : '';
      if ('=(!,;:?[{&|^~+-><%'.includes(prevCh) || source.slice(Math.max(0, p - 5), p + 1).match(/\b(return|typeof|instanceof|in|of|void|delete|throw|new|case)\s*$/)) {
        pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') pos++;
          else if (source[pos] === '[') { pos++; while (pos < source.length && source[pos] !== ']') { if (source[pos] === '\\') pos++; pos++; } }
          else if (source[pos] === '/') break;
          pos++;
        }
        while (pos + 1 < source.length && /[gimsuy]/.test(source[pos + 1])) pos++;
      }
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
/**
 * Find variable declarations in source and return insertions for tracing.
 * Handles: const x = ...; let x = ...; var x = ...;
 * Skips: destructuring, for-loop vars, require() calls, imports.
 */
function findVarDeclarations(source: string, lineOffset: number = 0): Array<{ lineEnd: number; varName: string; lineNo: number }> {
  const varInsertions: Array<{ lineEnd: number; varName: string; lineNo: number }> = [];

  // Match: const/let/var <identifier>[: TypeAnnotation] = <something>
  // Handles both JS (no annotation) and TS (with annotation like `: string` or `: MyType`)
  const varRegex = /^([ \t]*)(?:export\s+)?(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:[^=]+?)?\s*=[^=]/gm;
  let vmatch;

  while ((vmatch = varRegex.exec(source)) !== null) {
    const varName = vmatch[3];

    // Skip common noise
    if (varName === '__trickle_mod' || varName === '__trickle_wrap' || varName === '__trickle_tv') continue;
    if (varName.startsWith('__trickle')) continue;
    if (varName === '_a' || varName === '_b' || varName === '_c') continue; // TS compiled vars
    // Skip TS compiler helpers and module internals
    if (varName === '__createBinding' || varName === '__setModuleDefault' || varName === '__importStar' || varName === '__importDefault') continue;
    if (varName === '__decorate' || varName === '__metadata' || varName === '__param' || varName === '__awaiter') continue;
    if (varName === 'ownKeys' || varName === 'desc' || varName === '_') continue;
    // Skip esbuild helpers
    if (varName === '__defProp' || varName === '__defNormalProp' || varName === '__publicField' || varName === '__getOwnPropNames') continue;
    if (varName === '__commonJS' || varName === '__toCommonJS' || varName === '__export' || varName === '__copyProps') continue;
    // Skip webpack internals
    if (varName.startsWith('__webpack_')) continue;
    if (varName === '__unused_webpack_module') continue;
    // Skip React Refresh / HMR internals
    if (varName === 'prevRefreshReg' || varName === 'prevRefreshSig' || varName === 'inWebWorker' || varName === 'invalidateMessage') continue;
    if (varName === '_s' || varName === '_c2' || varName === '_s2') continue;

    // Check if this is a require() call — skip those (they're imports, not interesting values)
    const restOfLine = source.slice(vmatch.index + vmatch[0].length - 1, vmatch.index + vmatch[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;

    // Skip variable declarations inside for-loop headers (for (let x = ...; ...; ...))
    // The semicolon inside for(...) is NOT a statement end
    const beforeDecl = source.slice(Math.max(0, vmatch.index - 50), vmatch.index);
    if (/\bfor\s*\(\s*$/.test(beforeDecl)) continue;

    // Calculate line number (count newlines before this position)
    // Subtract lineOffset to map compiled line numbers back to original source lines
    let lineNo = 1;
    for (let i = 0; i < vmatch.index; i++) {
      if (source[i] === '\n') lineNo++;
    }
    lineNo = Math.max(1, lineNo - lineOffset);

    // Find the end of this statement — look for the semicolon at depth 0
    // or the end of the line for semicolon-free code
    const startPos = vmatch.index + vmatch[0].length - 1; // position of the '='
    let pos = startPos;
    let depth = 0;
    let foundEnd = -1;

    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth < 0) break; // we've gone past our scope
      } else if (ch === ';' && depth === 0) {
        foundEnd = pos;
        break;
      } else if (ch === '\n' && depth === 0) {
        // For semicolon-free code, the newline is the end
        // But only if the next non-whitespace isn't a continuation (., +, etc.)
        // AND the previous non-whitespace isn't an operator expecting more (=, +, -, etc.)
        const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
        if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
          // Also check if a recent line ends with an operator that expects a value on the next line
          // Walk backwards through empty lines to find the last non-empty line
          let checkPos = pos;
          let lastChar = '';
          for (let back = 0; back < 5; back++) {
            const prevNL = source.lastIndexOf('\n', checkPos - 1);
            const prevLine = source.slice(prevNL + 1, checkPos).trimEnd();
            if (prevLine.length > 0) {
              lastChar = prevLine[prevLine.length - 1];
              break;
            }
            checkPos = prevNL;
            if (prevNL <= 0) break;
          }
          if (lastChar && '=+-*/%&|^~<>?:,({['.includes(lastChar)) {
            // Line ends with operator — this is a continuation, don't end the statement
            pos++;
            continue;
          }
          foundEnd = pos;
          break;
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        // Skip strings
        const quote = ch;
        pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') { pos++; }
          else if (source[pos] === quote) break;
          pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] !== '/' && source[pos + 1] !== '*') {
        // Possible regex literal — check if the preceding non-whitespace indicates regex context
        // (after =, (, ,, ;, !, &, |, ^, ~, ?, :, [, {, return, typeof, etc.)
        let p = pos - 1;
        while (p >= 0 && (source[p] === ' ' || source[p] === '\t')) p--;
        const prevCh = p >= 0 ? source[p] : '';
        if ('=(!,;:?[{&|^~+-><%'.includes(prevCh) || source.slice(Math.max(0, p - 5), p + 1).match(/\b(return|typeof|instanceof|in|of|void|delete|throw|new|case)\s*$/)) {
          // This is a regex literal — skip to the closing /
          pos++; // skip past opening /
          while (pos < source.length) {
            if (source[pos] === '\\') { pos++; } // skip escaped char
            else if (source[pos] === '[') {
              // Character class — skip to ]
              pos++;
              while (pos < source.length && source[pos] !== ']') {
                if (source[pos] === '\\') pos++;
                pos++;
              }
            } else if (source[pos] === '/') break;
            pos++;
          }
          // Skip regex flags
          while (pos + 1 < source.length && /[gimsuy]/.test(source[pos + 1])) pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
        // Skip line comment
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
        // Skip block comment
        pos += 2;
        while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
        pos++;
      }
      pos++;
    }

    if (foundEnd === -1) continue; // couldn't find statement end

    varInsertions.push({ lineEnd: foundEnd + 1, varName, lineNo });
  }

  return varInsertions;
}

/**
 * Find destructured variable declarations: const { a, b } = ... and const [a, b] = ...
 */
function findDestructuredDeclarations(source: string, lineOffset: number = 0): Array<{ lineEnd: number; varNames: string[]; lineNo: number }> {
  const results: Array<{ lineEnd: number; varNames: string[]; lineNo: number }> = [];

  const destructRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
  let match;

  while ((match = destructRegex.exec(source)) !== null) {
    const pattern = match[1];
    const varNames = extractDestructuredNames(pattern);
    if (varNames.length === 0) continue;

    const restOfLine = source.slice(match.index + match[0].length - 1, match.index + match[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;

    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }
    lineNo = Math.max(1, lineNo - lineOffset);

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
 * { a, b, c: d } → ['a', 'b', 'd'], [a, b, ...rest] → ['a', 'b', 'rest']
 */
function extractDestructuredNames(pattern: string): string[] {
  const names: string[] = [];
  const inner = pattern.slice(1, -1).trim();
  if (!inner) return names;

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

  for (const part of parts) {
    if (part.startsWith('...')) {
      const restName = part.slice(3).trim().split(/[\s:]/)[0];
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(restName)) names.push(restName);
      continue;
    }

    const colonIdx = part.indexOf(':');
    if (colonIdx !== -1) {
      const afterColon = part.slice(colonIdx + 1).trim();
      if (afterColon.startsWith('{') || afterColon.startsWith('[')) {
        names.push(...extractDestructuredNames(afterColon));
      } else {
        const localName = afterColon.split(/[\s=]/)[0].trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) names.push(localName);
      }
    } else {
      const name = part.split(/[\s=]/)[0].trim();
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) names.push(name);
    }
  }

  return names;
}

/**
 * Extract parameter names from a parameter string (the text between parens).
 * Handles: simple names, defaults (x = 5), type annotations (x: string),
 * rest params (...args), and destructured params ({a, b} or [a, b]).
 * Skips params starting with _ (convention for unused params).
 */
function extractParamNamesFromStr(paramStr: string): string[] {
  if (!paramStr.trim()) return [];
  // Split on commas at depth 0 (respecting nested parens, braces, brackets)
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of paramStr) {
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current.trim());

  const names: string[] = [];
  for (const p of params) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    // Rest params: ...args -> trace 'args'
    if (trimmed.startsWith('...')) {
      const restName = trimmed.slice(3).split(/[\s:=]/)[0].trim();
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(restName) && !restName.startsWith('_')) {
        names.push(restName);
      }
      continue;
    }
    // Destructured params: { name, age } or [a, b] — skip (can't trace the whole object by a single name)
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) continue;
    // Simple param: strip default value and type annotation
    const name = trimmed.split('=')[0].trim().split(':')[0].trim();
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !name.startsWith('_')) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Find all function bodies (declarations, expressions, arrow functions, methods)
 * and return insertions to trace their parameters at the top of the body.
 *
 * Returns: Array of { bodyStart: position right after '{', paramNames: string[], lineNo: line of function }
 */
function findFunctionParamInsertions(source: string, lineOffset: number = 0): Array<{ bodyStart: number; paramNames: string[]; lineNo: number }> {
  const results: Array<{ bodyStart: number; paramNames: string[]; lineNo: number }> = [];

  // Match all patterns that start a function with a parameter list followed by a body:
  // 1. function foo(...)    { ... }
  // 2. function(...)        { ... }
  // 3. (...)             => { ... }
  // 4. async (...)       => { ... }
  // 5. methodName(...)      { ... }  (inside class or object)
  // 6. single param arrow:  x => { ... }
  //
  // Strategy: find every opening paren that is part of a function parameter list,
  // then find the body brace. We use a regex to find candidate positions.

  // Pattern A: function declarations and expressions
  // Matches: [async] function [name] (
  const funcPattern = /(?:async\s+)?function\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*\(/g;
  let m;
  while ((m = funcPattern.exec(source)) !== null) {
    const openParenIdx = source.indexOf('(', m.index + 8); // skip past 'function'
    if (openParenIdx === -1) continue;
    processFunction(source, openParenIdx, m.index, results, lineOffset);
  }

  // Pattern B: arrow functions with parens: (...) =>
  // Look for ) followed by optional whitespace then =>
  // We search for => and walk backwards to find the matching (
  const arrowPattern = /\)\s*=>/g;
  while ((m = arrowPattern.exec(source)) !== null) {
    // Find the matching opening paren for the ) at m.index
    const closeParenIdx = m.index;
    const openParenIdx = findMatchingOpenParen(source, closeParenIdx);
    if (openParenIdx === -1) continue;

    // Make sure this isn't inside a string or comment (basic heuristic: check if 'function' keyword precedes)
    // If 'function' precedes, Pattern A already handled it
    const before = source.slice(Math.max(0, openParenIdx - 30), openParenIdx).trimEnd();
    if (/function\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*$/.test(before)) continue;

    // Find the arrow and body
    const arrowIdx = source.indexOf('=>', closeParenIdx + 1);
    if (arrowIdx === -1) continue;
    const afterArrow = arrowIdx + 2;
    // Skip whitespace after =>
    let bodyPos = afterArrow;
    while (bodyPos < source.length && (source[bodyPos] === ' ' || source[bodyPos] === '\t' || source[bodyPos] === '\n' || source[bodyPos] === '\r')) bodyPos++;
    // Only handle block bodies (with {), not expression bodies
    if (bodyPos >= source.length || source[bodyPos] !== '{') continue;

    // Extract params
    const paramStr = source.slice(openParenIdx + 1, closeParenIdx);
    const paramNames = extractParamNamesFromStr(paramStr);
    if (paramNames.length === 0) continue;

    // Calculate line number
    let lineNo = 1;
    for (let i = 0; i < openParenIdx; i++) {
      if (source[i] === '\n') lineNo++;
    }
    lineNo = Math.max(1, lineNo - lineOffset);

    results.push({ bodyStart: bodyPos + 1, paramNames, lineNo });
  }

  return results;
}

/**
 * Process a function whose opening paren is at openParenIdx.
 * Finds params, body brace, and adds to results.
 */
function processFunction(
  source: string,
  openParenIdx: number,
  funcStartIdx: number,
  results: Array<{ bodyStart: number; paramNames: string[]; lineNo: number }>,
  lineOffset: number,
): void {
  // Find closing paren using findFunctionBodyBrace approach: it expects the position after '('
  const afterOpenParen = openParenIdx + 1;
  const openBrace = findFunctionBodyBrace(source, afterOpenParen);
  if (openBrace === -1) return;

  // Extract param string between ( and the closing )
  // findFunctionBodyBrace skips parens then finds {, so we need to find the closing ) ourselves
  let parenDepth = 1;
  let closeParenIdx = afterOpenParen;
  while (closeParenIdx < source.length && parenDepth > 0) {
    const ch = source[closeParenIdx];
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth === 0) break; }
    else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      closeParenIdx++;
      while (closeParenIdx < source.length && source[closeParenIdx] !== q) {
        if (source[closeParenIdx] === '\\') closeParenIdx++;
        closeParenIdx++;
      }
    }
    closeParenIdx++;
  }

  const paramStr = source.slice(afterOpenParen, closeParenIdx);
  const paramNames = extractParamNamesFromStr(paramStr);
  if (paramNames.length === 0) return;

  // Calculate line number of the function
  let lineNo = 1;
  for (let i = 0; i < funcStartIdx; i++) {
    if (source[i] === '\n') lineNo++;
  }
  lineNo = Math.max(1, lineNo - lineOffset);

  results.push({ bodyStart: openBrace + 1, paramNames, lineNo });
}

/**
 * Find the matching opening paren for a closing paren at closeIdx.
 * Walks backward respecting nesting, strings, etc. (simplified).
 */
function findMatchingOpenParen(source: string, closeIdx: number): number {
  let depth = 1;
  let pos = closeIdx - 1;
  while (pos >= 0 && depth > 0) {
    const ch = source[pos];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return pos;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // Walk backward through string (simplified — won't handle all edge cases but good enough)
      const q = ch;
      pos--;
      while (pos >= 0 && source[pos] !== q) {
        if (pos > 0 && source[pos - 1] === '\\') pos--;
        pos--;
      }
    }
    pos--;
  }
  return -1;
}

function transformCjsSource(source: string, filename: string, moduleName: string, env: string, sourceMap?: SourceMapData | null): string {
  const funcRegex = /^[ \t]*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
  const insertions: Array<{ position: number; name: string; paramNames: string[] }> = [];
  let match;

  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1];
    // Skip common false positives
    if (name === 'require' || name === 'exports' || name === 'module') continue;

    // Find the opening brace of the function body, correctly skipping
    // default parameter values like `headers = {}` which contain braces
    const afterMatch = match.index + match[0].length;
    const openBrace = findFunctionBodyBrace(source, afterMatch);
    if (openBrace === -1) continue;

    // Extract parameter names from the source between ( and {
    const paramStr = source.slice(afterMatch, openBrace).replace(/[()]/g, '').trim();
    const paramNames = paramStr
      ? paramStr.split(',').map(p => {
          // Handle default values: "x = 5" → "x", destructuring: "{a, b}" → skip
          const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
          // Skip destructuring patterns and rest params
          if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
          return trimmed;
        }).filter(Boolean)
      : [];

    // Find the matching closing brace
    const closeBrace = findClosingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    insertions.push({ position: closeBrace + 1, name, paramNames });
  }

  // Find class declarations and wrap their methods
  const classRegex = /^[ \t]*class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:extends\s+[a-zA-Z_$.]+\s*)?\{/gm;
  const classInsertions: Array<{ position: number; code: string }> = [];
  let classMatch;
  while ((classMatch = classRegex.exec(source)) !== null) {
    const className = classMatch[1];
    const classOpenBrace = source.indexOf('{', classMatch.index + classMatch[0].length - 1);
    if (classOpenBrace === -1) continue;
    const classCloseBrace = findClosingBrace(source, classOpenBrace);
    if (classCloseBrace === -1) continue;

    // Extract methods from the class body
    const classBody = source.slice(classOpenBrace + 1, classCloseBrace);
    // Match: methodName(params) { or async methodName(params) { or static methodName(params) {
    const methodRegex = /^[ \t]*(static\s+)?(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)\s*\{/gm;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      const isStatic = !!methodMatch[1];
      const methodName = methodMatch[2];
      // Skip constructor, private methods, and JS keywords that look like method calls
      if (methodName === 'constructor' || methodName.startsWith('_')) continue;
      if (['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'throw',
           'try', 'catch', 'finally', 'with', 'new', 'delete', 'typeof', 'void',
           'yield', 'await', 'import', 'export', 'super', 'this', 'class',
           'break', 'continue', 'debugger', 'in', 'of', 'instanceof'].includes(methodName)) continue;
      // Extract param names
      const mParamStr = methodMatch[3].trim();
      const mParamNames = mParamStr
        ? mParamStr.split(',').map((p: string) => {
            const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
            return trimmed;
          }).filter(Boolean)
        : [];
      const target = isStatic ? className : `${className}.prototype`;
      const obsName = `${className}.${methodName}`;
      const paramNamesArg = mParamNames.length > 0 ? JSON.stringify(mParamNames) : 'null';
      classInsertions.push({
        position: classCloseBrace + 1,
        code: `\ntry{${target}.${methodName}=__trickle_wrap(${target}.${methodName},'${obsName}',${paramNamesArg})}catch(__e){}\n`,
      });
    }
  }

  // Also find variable declarations for tracing
  // In production mode, disable variable tracing by default
  const isProduction = process.env.TRICKLE_PRODUCTION === '1' || process.env.TRICKLE_PRODUCTION === 'true';
  const varTraceDefault = isProduction ? '0' : '1';
  const varTraceEnabled = (process.env.TRICKLE_TRACE_VARS || varTraceDefault) !== '0';

  // For TypeScript files (compiled by ts-node/tsc), type declarations (interfaces, type aliases)
  // are stripped from the compiled JS, shifting line numbers. The only accurate way to get correct
  // line numbers is to read the original .ts source file and parse it directly.
  // For plain JS files, we parse the source directly.
  let varInsertions: Array<{ lineEnd: number; varName: string; lineNo: number; sourceFile?: string }> = [];
  let destructInsertions: Array<{ lineEnd: number; varNames: string[]; lineNo: number; sourceFile?: string }> = [];

  // Helper: remap line numbers using source map if available
  const remapLine = sourceMap
    ? (line: number) => mapLineToOriginal(sourceMap, line)
    : (line: number) => line;

  // Helper: get source file for a compiled line (for multi-source bundles)
  const hasMultiSource = sourceMap?.lineSourceMap && sourceMap.lineSourceMap.size > 0;
  const getSourceFile = hasMultiSource
    ? (compiledLine: number) => {
        const file = sourceMap!.lineSourceMap!.get(compiledLine);
        return file && !file.includes('webpack/bootstrap') && !file.includes('webpack/runtime') ? file : undefined;
      }
    : (_: number) => undefined as string | undefined;

  if (varTraceEnabled) {
    const isTsFile = /\.[mc]?tsx?$/.test(filename);
    if (isTsFile && !sourceMap) {
      // ts-node / tsx path: read original .ts file and match by occurrence
      try {
        const originalSource: string = fs.readFileSync(filename, 'utf8');
        const tsVarInsertions = findVarDeclarations(originalSource);
        const tsDestructInsertions = findDestructuredDeclarations(originalSource);

        const tsLineByVarAndOccurrence = new Map<string, number[]>();
        for (const { varName, lineNo } of tsVarInsertions) {
          if (!tsLineByVarAndOccurrence.has(varName)) tsLineByVarAndOccurrence.set(varName, []);
          tsLineByVarAndOccurrence.get(varName)!.push(lineNo);
        }

        const compiledInsertions = findVarDeclarations(source);
        const varOccurrenceCounter = new Map<string, number>();
        for (const ins of compiledInsertions) {
          const occCount = (varOccurrenceCounter.get(ins.varName) || 0);
          varOccurrenceCounter.set(ins.varName, occCount + 1);
          const tsLines = tsLineByVarAndOccurrence.get(ins.varName);
          const correctLineNo = tsLines ? (tsLines[occCount] ?? tsLines[tsLines.length - 1]) : undefined;
          varInsertions.push({ ...ins, lineNo: correctLineNo ?? ins.lineNo });
        }

        const compiledDestructInsertions = findDestructuredDeclarations(source);
        destructInsertions = compiledDestructInsertions;
        const tsDestructByKey = new Map<string, number[]>();
        for (const { varNames, lineNo } of tsDestructInsertions) {
          const key = varNames.join(',');
          if (!tsDestructByKey.has(key)) tsDestructByKey.set(key, []);
          tsDestructByKey.get(key)!.push(lineNo);
        }
        const destructOccCounter = new Map<string, number>();
        destructInsertions = compiledDestructInsertions.map(ins => {
          const key = ins.varNames.join(',');
          const occ = destructOccCounter.get(key) || 0;
          destructOccCounter.set(key, occ + 1);
          const tsLines = tsDestructByKey.get(key);
          const correctLineNo = tsLines ? (tsLines[occ] ?? tsLines[tsLines.length - 1]) : undefined;
          return { ...ins, lineNo: correctLineNo ?? ins.lineNo };
        });
      } catch {
        // Fallback: use compiled line numbers with prologue offset
        let lineOffset = 0;
        const lines = source.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '"use strict";' || trimmed === "'use strict';" || trimmed === '') {
            lineOffset++;
          } else {
            break;
          }
        }
        varInsertions = findVarDeclarations(source, lineOffset);
        destructInsertions = findDestructuredDeclarations(source, lineOffset);
      }
    } else {
      // Plain JS or source-map-assisted: parse compiled source, then remap lines
      varInsertions = findVarDeclarations(source).map(ins => ({
        ...ins,
        sourceFile: getSourceFile(ins.lineNo),
        lineNo: remapLine(ins.lineNo),
      }));
      destructInsertions = findDestructuredDeclarations(source).map(ins => ({
        ...ins,
        sourceFile: getSourceFile(ins.lineNo),
        lineNo: remapLine(ins.lineNo),
      }));
    }
  }

  // Additional variable patterns: reassignments, for-loops, catch clauses
  // Apply source map remapping to these too.
  const reassignInsertions = findReassignments(source).map(ins => ({
    ...ins,
    sourceFile: getSourceFile(ins.lineNo),
    lineNo: remapLine(ins.lineNo),
  }));
  const forLoopInsertions = findForLoopVars(source).map(ins => ({
    ...ins,
    sourceFile: getSourceFile(ins.lineNo),
    lineNo: remapLine(ins.lineNo),
  }));
  const catchInsertions = findCatchVars(source).map(ins => ({
    ...ins,
    sourceFile: getSourceFile(ins.lineNo),
    lineNo: remapLine(ins.lineNo),
  }));

  // Function parameter tracing: inject __trickle_tv() calls at the top of function bodies
  // for each parameter. This covers function declarations, expressions, arrow functions,
  // and method definitions (including Express-style callbacks like (req, res) => {}).
  let funcParamInsertions: Array<{ bodyStart: number; paramNames: string[]; lineNo: number; sourceFile?: string }> = [];
  if (varTraceEnabled) {
    funcParamInsertions = findFunctionParamInsertions(source).map(ins => ({
      ...ins,
      sourceFile: getSourceFile(ins.lineNo),
      lineNo: remapLine(ins.lineNo),
    }));
    if (debug && funcParamInsertions.length > 0) {
      console.log(`[trickle/observe] Tracing ${funcParamInsertions.length} function param sites in ${moduleName}`);
    }
  }

  if (insertions.length === 0 && varInsertions.length === 0 && destructInsertions.length === 0 && reassignInsertions.length === 0 && forLoopInsertions.length === 0 && catchInsertions.length === 0 && classInsertions.length === 0 && funcParamInsertions.length === 0) return source;

  // Resolve the path to the wrap helper (compiled JS)
  const wrapHelperPath = path.join(__dirname, 'wrap.js');

  // When source map is available, use original module name for tracing
  const effectiveModuleName = sourceMap
    ? path.basename(sourceMap.originalFile).replace(/\.[jt]sx?$/, '')
    : moduleName;

  // Prepend: load the wrapper and create the wrap helper
  const prefixLines = [
    `var __trickle_mod = require(${JSON.stringify(wrapHelperPath)});`,
    `var __trickle_wrap = function(fn, name, paramNames) {`,
    `  var opts = {`,
    `    functionName: name,`,
    `    module: ${JSON.stringify(effectiveModuleName)},`,
    `    trackArgs: true,`,
    `    trackReturn: true,`,
    `    sampleRate: parseFloat(process.env.TRICKLE_SAMPLE_RATE || '1'),`,
    `    maxDepth: 3,`,
    `    environment: ${JSON.stringify(env)},`,
    `    enabled: true,`,
    `  };`,
    `  if (paramNames && paramNames.length) opts.paramNames = paramNames;`,
    `  return __trickle_mod.wrapFunction(fn, opts);`,
    `};`,
  ];

  // Add variable tracing helper if we have var insertions or function param insertions
  if (varInsertions.length > 0 || destructInsertions.length > 0 || reassignInsertions.length > 0 || forLoopInsertions.length > 0 || catchInsertions.length > 0 || funcParamInsertions.length > 0) {
    const traceVarPath = path.join(__dirname, 'trace-var.js');
    // When source map is available, trace variables against the original source file
    const traceFilePath = sourceMap ? sourceMap.originalFile : filename;
    const traceModuleName = sourceMap
      ? path.basename(sourceMap.originalFile).replace(/\.[jt]sx?$/, '')
      : moduleName;

    prefixLines.push(
      `var __trickle_tv_mod = require(${JSON.stringify(traceVarPath)});`,
      `var __trickle_tv = function(v, n, l, m, f) { try { __trickle_tv_mod.traceVar(v, n, l, m || ${JSON.stringify(traceModuleName)}, f || ${JSON.stringify(traceFilePath)}); } catch(e){} };`,
    );
  }

  prefixLines.push('');
  const prefix = prefixLines.join('\n');

  // Merge all insertions (function wraps + variable traces) and sort by position descending
  type Insertion = { position: number; code: string };
  const allInsertions: Insertion[] = [];

  for (const { position, name, paramNames } of insertions) {
    const paramNamesArg = paramNames.length > 0 ? JSON.stringify(paramNames) : 'null';
    allInsertions.push({
      position,
      code: `\ntry{${name}=__trickle_wrap(${name},'${name}',${paramNamesArg})}catch(__e){}\n`,
    });
  }

  // Helper to generate source file args for __trickle_tv calls (for multi-source bundles)
  const sfArgs = (sourceFile?: string) => {
    if (!sourceFile) return '';
    const mod = path.basename(sourceFile).replace(/\.[jt]sx?$/, '');
    return `,${JSON.stringify(mod)},${JSON.stringify(sourceFile)}`;
  };

  for (const { lineEnd, varName, lineNo, sourceFile } of varInsertions) {
    allInsertions.push({
      position: lineEnd,
      code: `\ntry{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo}${sfArgs(sourceFile)})}catch(__e){}\n`,
    });
  }

  for (const { lineEnd, varNames, lineNo, sourceFile } of destructInsertions) {
    const sf = sfArgs(sourceFile);
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo}${sf})`).join(';');
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{${calls}}catch(__e){}\n`,
    });
  }

  // Reassignment insertions
  for (const { lineEnd, varName, lineNo, sourceFile } of reassignInsertions) {
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo}${sfArgs(sourceFile)})}catch(__e){}\n`,
    });
  }

  // For-loop variable insertions
  for (const { bodyStart, varNames, lineNo, sourceFile } of forLoopInsertions) {
    const sf = sfArgs(sourceFile);
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo}${sf})`).join(';');
    allInsertions.push({
      position: bodyStart,
      code: `\ntry{${calls}}catch(__e){}\n`,
    });
  }

  // Catch clause insertions
  for (const { bodyStart, varNames, lineNo, sourceFile } of catchInsertions) {
    const sf = sfArgs(sourceFile);
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo}${sf})`).join(';');
    allInsertions.push({
      position: bodyStart,
      code: `\ntry{${calls}}catch(__e2){}\n`,
    });
  }

  // Function parameter insertions — inject __trickle_tv() at top of function bodies
  for (const { bodyStart, paramNames, lineNo, sourceFile } of funcParamInsertions) {
    const sf = sfArgs(sourceFile);
    const calls = paramNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo}${sf})`).join(';');
    allInsertions.push({
      position: bodyStart,
      code: `\ntry{${calls}}catch(__e3){}\n`,
    });
  }

  // Add class method wrappings
  for (const ci of classInsertions) {
    allInsertions.push(ci);
  }

  // Sort by position descending (insert from end to preserve earlier positions)
  allInsertions.sort((a, b) => b.position - a.position);

  let result = source;
  for (const { position, code } of allInsertions) {
    result = result.slice(0, position) + code + result.slice(position);
  }

  return prefix + result;
}

/**
 * Extract parameter names from a function using fn.toString().
 */
function extractParamNames(fn: Function): string[] {
  try {
    const src = fn.toString();
    const parenMatch = src.match(/^(?:async\s+)?(?:function\s*\w*|\w+)\s*\(([^)]*)\)/);
    if (!parenMatch) return [];
    const paramStr = parenMatch[1].trim();
    if (!paramStr) return [];
    return paramStr.split(',').map(p => {
      const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
      return trimmed;
    }).filter(Boolean);
  } catch {
    return [];
  }
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

  // ── Hook 0a: Patch global.fetch to capture HTTP response types ──
  patchFetch(environment, debug);

  // ── Hook 0b: Initialize variable tracer ──
  if (process.env.TRICKLE_TRACE_VARS !== '0') {
    initVarTracer({ debug });
  }

  // ── Hook 0b2: Initialize call trace ──
  initCallTrace();

  // ── Hook 0b3: Initialize LLM observer ──
  initLlmObserver();

  // ── Hook 0b4: Initialize MCP observer ──
  initMcpObserver();

  // ── Hook 0c: Capture environment snapshot ──
  try {
    const envDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
    fs.mkdirSync(envDir, { recursive: true });
    const SENSITIVE = ['KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'AUTH', 'CREDENTIAL', 'PRIVATE'];
    const isSensitive = (k: string) => SENSITIVE.some(s => k.toUpperCase().includes(s));
    const redact = (k: string, v: string) => isSensitive(k) ? (v.length <= 4 ? '****' : v.slice(0, 2) + '*'.repeat(v.length - 4) + v.slice(-2)) : v;
    const skip = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LOGNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR']);
    const trickleVars: Record<string, string> = {};
    const appVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!v || k.startsWith('_')) continue;
      if (k.startsWith('TRICKLE_')) trickleVars[k] = v;
      else if (!skip.has(k)) appVars[k] = redact(k, v);
    }
    const envSnapshot = {
      kind: 'environment',
      timestamp: Date.now(),
      node: { version: process.version, platform: process.platform, arch: process.arch },
      cwd: process.cwd(),
      argv: process.argv.slice(0, 10),
      trickle: trickleVars,
      env: appVars,
    };
    fs.writeFileSync(path.join(envDir, 'environment.json'), JSON.stringify(envSnapshot, null, 2));
  } catch {}

  // ── Hook 0d: Memory profiling ──
  try {
    const profileDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
    fs.mkdirSync(profileDir, { recursive: true });
    const profileFile = path.join(profileDir, 'profile.jsonl');
    fs.writeFileSync(profileFile, '');
    const mem = process.memoryUsage();
    const startProfile = { kind: 'profile', event: 'start', rssKb: Math.round(mem.rss / 1024), heapKb: Math.round(mem.heapUsed / 1024), peakHeapKb: Math.round(mem.heapTotal / 1024), timestamp: Date.now() };
    fs.appendFileSync(profileFile, JSON.stringify(startProfile) + '\n');
    process.on('exit', () => {
      try {
        const endMem = process.memoryUsage();
        const endProfile = { kind: 'profile', event: 'end', rssKb: Math.round(endMem.rss / 1024), heapKb: Math.round(endMem.heapUsed / 1024), peakHeapKb: Math.round(endMem.heapTotal / 1024), timestamp: Date.now() };
        fs.appendFileSync(profileFile, JSON.stringify(endProfile) + '\n');
      } catch {}
    });
  } catch {}

  // ── Hook 1: Module._compile — transform source to wrap function declarations ──
  // This catches ALL functions including entry file and non-exported helpers.

  M.prototype._compile = function hookedCompile(content: string, filename: string): any {
    if (shouldObserve(filename)) {
      const moduleName = path.basename(filename).replace(/\.[jt]sx?$/, '');
      try {
        // Try to load source map for compiled JS files (e.g., tsc output)
        const sourceMap = loadSourceMap(filename, content);
        if (debug && sourceMap) {
          console.log(`[trickle/observe] Source map found for ${filename} → ${sourceMap.originalFile}`);
        }
        const transformed = transformCjsSource(content, filename, moduleName, environment, sourceMap);
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

  // Track whether we've already patched Express to avoid double-patching
  const expressPatched = new Set<string>();

  M._load = function hookedLoad(request: string, parent: any, isMain: boolean): any {
    const exports = originalLoad.apply(this, arguments);

    // ── Express auto-detection: wrap Express factory to capture route types ──
    // When someone requires 'express', wrap the factory so every app.get/post/etc
    // automatically captures { body, params, query } → res.json() type data.
    if (request === 'express' && !expressPatched.has('express')) {
      expressPatched.add('express');
      try {
        const origExpress = exports;
        const wrappedExpress = function (this: any, ...args: any[]): any {
          const app = origExpress.apply(this, args);
          // Tag the app so we can verify the middleware was injected
          (app as any).__trickle_instrumented = true;
          try {
            // Wrap route methods for future route definitions
            instrumentExpress(app, { environment });
            // Also inject middleware to capture routes defined BEFORE instrumentation
            // (common in DI/class-based architectures where routes are defined in constructors)
            if (typeof app.use === 'function') {
              app.use(trickleMiddleware({ environment }));
              if (debug) {
                console.log('[trickle/observe] Injected trickleMiddleware into Express app');
              }
            }
            if (debug) {
              console.log('[trickle/observe] Auto-instrumented Express app (route types will be captured)');
            }
          } catch (e: unknown) {
            if (debug) {
              console.log('[trickle/observe] Express instrumentation error:', (e as Error).message);
            }
          }
          return app;
        };
        // Copy all static properties (express.json, express.static, express.Router, etc.)
        for (const key of Object.keys(origExpress)) {
          (wrappedExpress as any)[key] = origExpress[key];
        }
        Object.setPrototypeOf(wrappedExpress, Object.getPrototypeOf(origExpress));

        // Also wrap express.Router() to instrument route handlers on Router instances.
        // Most real Express apps define routes on Routers, not directly on the app.
        if (typeof origExpress.Router === 'function') {
          const origRouter = origExpress.Router;
          (wrappedExpress as any).Router = function (this: any, ...rArgs: any[]): any {
            const router = origRouter.apply(this, rArgs);
            try {
              instrumentExpress(router, { environment });
              if (debug) {
                console.log('[trickle/observe] Auto-instrumented Express Router');
              }
            } catch { /* don't crash */ }
            return router;
          };
        }

        // Update require cache
        try {
          const resolvedPath = M._resolveFilename(request, parent);
          if (require.cache[resolvedPath]) {
            require.cache[resolvedPath]!.exports = wrappedExpress;
          }
        } catch { /* non-critical */ }
        return wrappedExpress;
      } catch { /* fall through to normal processing */ }
    }

    // ── Database auto-detection: patch database drivers to capture SQL queries ──
    if (request === 'pg' && !expressPatched.has('pg')) {
      expressPatched.add('pg');
      try {
        const { patchPg } = require(path.join(__dirname, 'db-observer.js'));
        patchPg(exports, debug);
      } catch { /* not critical */ }
    }
    if ((request === 'mysql2' || request === 'mysql2/promise') && !expressPatched.has('mysql2')) {
      expressPatched.add('mysql2');
      try {
        const { patchMysql2 } = require(path.join(__dirname, 'db-observer.js'));
        patchMysql2(exports, debug);
      } catch { /* not critical */ }
    }
    if (request === 'better-sqlite3' && !expressPatched.has('better-sqlite3')) {
      expressPatched.add('better-sqlite3');
      try {
        const { patchBetterSqlite3 } = require(path.join(__dirname, 'db-observer.js'));
        patchBetterSqlite3(exports, debug);
      } catch { /* not critical */ }
    }

    // Prisma ORM
    if (request === '@prisma/client' && !expressPatched.has('@prisma/client')) {
      expressPatched.add('@prisma/client');
      try {
        const { patchPrisma } = require(path.join(__dirname, 'db-observer.js'));
        patchPrisma(exports, debug);
      } catch { /* not critical */ }
    }

    // Drizzle ORM
    if (request.startsWith('drizzle-orm') && !expressPatched.has('drizzle-orm')) {
      expressPatched.add('drizzle-orm');
      try {
        const { patchDrizzle } = require(path.join(__dirname, 'db-observer.js'));
        patchDrizzle(exports, debug);
      } catch { /* not critical */ }
    }

    // Knex query builder
    if (request === 'knex' && !expressPatched.has('knex')) {
      expressPatched.add('knex');
      try {
        const { patchKnex } = require(path.join(__dirname, 'db-observer.js'));
        patchKnex(exports, debug);
      } catch { /* not critical */ }
    }

    // TypeORM
    if (request === 'typeorm' && !expressPatched.has('typeorm')) {
      expressPatched.add('typeorm');
      try {
        const { patchTypeORM } = require(path.join(__dirname, 'db-observer.js'));
        patchTypeORM(exports, debug);
      } catch { /* not critical */ }
    }

    // Sequelize
    if (request === 'sequelize' && !expressPatched.has('sequelize')) {
      expressPatched.add('sequelize');
      try {
        const { patchSequelize } = require(path.join(__dirname, 'db-observer.js'));
        patchSequelize(exports, debug);
      } catch { /* not critical */ }
    }

    // Winston logger
    if (request === 'winston' && !expressPatched.has('winston')) {
      expressPatched.add('winston');
      try {
        const { patchWinston } = require(path.join(__dirname, 'log-observer.js'));
        patchWinston(exports, debug);
      } catch { /* not critical */ }
    }

    // Pino logger
    if (request === 'pino' && !expressPatched.has('pino')) {
      expressPatched.add('pino');
      try {
        const { patchPino } = require(path.join(__dirname, 'log-observer.js'));
        patchPino(exports, debug);
      } catch { /* not critical */ }
    }

    // Bunyan logger
    if (request === 'bunyan' && !expressPatched.has('bunyan')) {
      expressPatched.add('bunyan');
      try {
        const { patchBunyan } = require(path.join(__dirname, 'log-observer.js'));
        patchBunyan(exports, debug);
      } catch { /* not critical */ }
    }

    // Redis (ioredis)
    if (request === 'ioredis' && !expressPatched.has('ioredis')) {
      expressPatched.add('ioredis');
      try {
        const { patchIoredis } = require(path.join(__dirname, 'db-observer.js'));
        patchIoredis(exports, debug);
      } catch { /* not critical */ }
    }

    // MongoDB (mongoose)
    if (request === 'mongoose' && !expressPatched.has('mongoose')) {
      expressPatched.add('mongoose');
      try {
        const { patchMongoose } = require(path.join(__dirname, 'db-observer.js'));
        patchMongoose(exports, debug);
      } catch { /* not critical */ }
    }

    // WebSocket (ws)
    if (request === 'ws' && !expressPatched.has('ws')) {
      expressPatched.add('ws');
      try {
        const { patchWs } = require(path.join(__dirname, 'ws-observer.js'));
        patchWs(exports, debug);
      } catch { /* not critical */ }
    }

    // socket.io-client
    if (request === 'socket.io-client' && !expressPatched.has('socket.io-client')) {
      expressPatched.add('socket.io-client');
      try {
        const { patchSocketIo } = require(path.join(__dirname, 'ws-observer.js'));
        patchSocketIo(exports, debug);
      } catch { /* not critical */ }
    }

    // OpenAI SDK
    if (request === 'openai' && !expressPatched.has('openai')) {
      expressPatched.add('openai');
      try {
        const { patchOpenAI } = require(path.join(__dirname, 'llm-observer.js'));
        patchOpenAI(exports, debug);
      } catch { /* not critical */ }
    }

    // Anthropic SDK
    if ((request === '@anthropic-ai/sdk' || request === 'anthropic') && !expressPatched.has('anthropic')) {
      expressPatched.add('anthropic');
      try {
        const { patchAnthropic } = require(path.join(__dirname, 'llm-observer.js'));
        patchAnthropic(exports, debug);
      } catch { /* not critical */ }
    }

    // MCP SDK (client + server) — match any subpath import
    if (request.includes('@modelcontextprotocol/sdk') && !expressPatched.has('mcp-client') && exports.Client) {
      expressPatched.add('mcp-client');
      try {
        const { patchMcpClient } = require(path.join(__dirname, 'mcp-observer.js'));
        patchMcpClient(exports, debug);
      } catch { /* not critical */ }
    }
    if (request.includes('@modelcontextprotocol/sdk') && !expressPatched.has('mcp-server') && (exports.Server || exports.McpServer)) {
      expressPatched.add('mcp-server');
      try {
        const { patchMcpServer } = require(path.join(__dirname, 'mcp-observer.js'));
        patchMcpServer(exports, debug);
      } catch { /* not critical */ }
    }

    // Claude Agent SDK
    if (request.includes('claude-agent-sdk') && !expressPatched.has('claude-agent-sdk')) {
      expressPatched.add('claude-agent-sdk');
      try {
        // The Claude Agent SDK uses hooks config — we can't easily patch
        // from Module._load since it's ESM-only. Log detection for now.
        if (debug) console.log('[trickle] Claude Agent SDK detected — use hooks for tracing');
      } catch { /* not critical */ }
    }

    // Google Gemini SDK
    if (request === '@google/genai' && !expressPatched.has('@google/genai')) {
      expressPatched.add('@google/genai');
      try {
        const { patchGemini } = require(path.join(__dirname, 'llm-observer.js'));
        patchGemini(exports, debug);
      } catch { /* not critical */ }
    }

    // Resolve to absolute path for dedup — do this FIRST since bundlers like
    // tsx/esbuild may use path aliases (e.g., @config/env) that don't start
    // with './' or '/'. We need the resolved path to decide if it's user code.
    let resolvedPath: string;
    try {
      resolvedPath = M._resolveFilename(request, parent);
    } catch {
      return exports;
    }

    // Skip built-in modules (they resolve to names like 'fs', 'path', not absolute paths)
    if (!resolvedPath.startsWith('/')) return exports;

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
          // Skip classes — wrapping them breaks DI containers (tsyringe, inversify, etc.)
          // and decorator metadata. Detect via toString() for ES2015+ classes,
          // and via prototype check for classes with prototype methods.
          // Wrapped in try-catch because some prototype property access can throw
          // (e.g., Node.js stream classes with getter-only properties).
          let isClass = false;
          try {
            const fnStr = Function.prototype.toString.call(fn);
            isClass = fnStr.startsWith('class ') ||
              (fn.prototype && fn.prototype.constructor === fn &&
                Object.getOwnPropertyNames(fn.prototype).some(m => {
                  try { return m !== 'constructor' && typeof fn.prototype[m] === 'function'; }
                  catch { return false; }
                }));
          } catch { /* assume not a class */ }
          if (isClass) continue;
          const paramNames = extractParamNames(fn);
          const wrapOpts: WrapOptions = {
            functionName: key,
            module: moduleName,
            trackArgs: true,
            trackReturn: true,
            sampleRate: parseFloat(process.env.TRICKLE_SAMPLE_RATE || '1'),
            maxDepth: 3,
            environment,
            enabled: true,
            paramNames: paramNames.length > 0 ? paramNames : undefined,
          };
          const wrapped = wrapFunction(fn, wrapOpts);
          try {
            exports[key] = wrapped;
          } catch {
            // Property might be getter-only (tsx/esbuild uses getter exports).
            // Redefine with Object.defineProperty.
            try {
              Object.defineProperty(exports, key, {
                value: wrapped,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            } catch { continue; /* truly read-only, skip */ }
          }
          count++;
        }
      }

      // Handle default export if it's a function (but not a class)
      if (typeof exports.default === 'function') {
        const fn = exports.default;
        let defaultIsClass = false;
        try {
          const defaultFnStr = Function.prototype.toString.call(fn);
          defaultIsClass = defaultFnStr.startsWith('class ') ||
            (fn.prototype && fn.prototype.constructor === fn &&
              Object.getOwnPropertyNames(fn.prototype).some(m => {
                try { return m !== 'constructor' && typeof fn.prototype[m] === 'function'; }
                catch { return false; }
              }));
        } catch { /* assume not a class */ }
        if (!defaultIsClass) {
          const paramNames = extractParamNames(fn);
          const wrapOpts: WrapOptions = {
            functionName: fn.name || 'default',
            module: moduleName,
            trackArgs: true,
            trackReturn: true,
            sampleRate: parseFloat(process.env.TRICKLE_SAMPLE_RATE || '1'),
            maxDepth: 3,
            environment,
            enabled: true,
            paramNames: paramNames.length > 0 ? paramNames : undefined,
          };
          const wrapped = wrapFunction(fn, wrapOpts);
          try {
            exports.default = wrapped;
          } catch {
            try {
              Object.defineProperty(exports, 'default', {
                value: wrapped, enumerable: true, configurable: true, writable: true,
              });
            } catch { /* skip */ }
          }
          count++;
        }
      }

      // Wrap class prototype methods for exported classes
      for (const key of Object.keys(exports)) {
        const val = exports[key];
        if (typeof val === 'function' && val.prototype && val.prototype.constructor === val) {
          let protoNames: string[];
          try {
            protoNames = Object.getOwnPropertyNames(val.prototype)
              .filter(m => { try { return m !== 'constructor' && typeof val.prototype[m] === 'function'; } catch { return false; } });
          } catch { continue; }
          // Use the class's actual name, not the export key (avoids "default.method")
          const className = val.name || key;
          for (const method of protoNames) {
            if (method.startsWith('_')) continue;
            try {
              const origMethod = val.prototype[method];
              if ((origMethod as any)[Symbol.for('__trickle_wrapped')]) continue;
              const methodParamNames = extractParamNames(origMethod);
              const methodOpts: WrapOptions = {
                functionName: `${className}.${method}`,
                module: moduleName,
                trackArgs: true,
                trackReturn: true,
                sampleRate: parseFloat(process.env.TRICKLE_SAMPLE_RATE || '1'),
                maxDepth: 3,
                environment,
                enabled: true,
                paramNames: methodParamNames.length > 0 ? methodParamNames : undefined,
              };
              val.prototype[method] = wrapFunction(origMethod, methodOpts);
              count++;
            } catch { /* skip methods that can't be wrapped */ }
          }
        }
      }

      if (debug && count > 0) {
        console.log(`[trickle/observe] Wrapped ${count} exports from ${moduleName} (${resolvedPath})`);
      }
    } else if (typeof exports === 'function') {
      // Module exports a single function (e.g. module.exports = fn)
      // But skip classes — wrapping them breaks DI, decorators, and instanceof
      const fn = exports;
      const singleFnStr = Function.prototype.toString.call(fn);
      const singleIsClass = singleFnStr.startsWith('class ') ||
        (fn.prototype && fn.prototype.constructor === fn &&
          Object.getOwnPropertyNames(fn.prototype).some(m => m !== 'constructor' && typeof fn.prototype[m] === 'function'));
      if (singleIsClass) return exports;
      const fnParamNames = extractParamNames(fn);
      const wrapOpts: WrapOptions = {
        functionName: fn.name || moduleName,
        module: moduleName,
        trackArgs: true,
        trackReturn: true,
        sampleRate: parseFloat(process.env.TRICKLE_SAMPLE_RATE || '1'),
        maxDepth: 3,
        environment,
        enabled: true,
        paramNames: fnParamNames.length > 0 ? fnParamNames : undefined,
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
