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
import { patchFetch } from './fetch-observer';
import { instrumentExpress, trickleMiddleware } from './express';
import { initVarTracer, traceVar } from './trace-var';
import {
  findReassignments,
  findForLoopVars,
  findCatchVars,
  findFunctionBodyBrace,
} from './vite-plugin';

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

    // Check if this is a require() call — skip those (they're imports, not interesting values)
    const restOfLine = source.slice(vmatch.index + vmatch[0].length - 1, vmatch.index + vmatch[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;

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
        const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
        if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
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

function transformCjsSource(source: string, filename: string, moduleName: string, env: string): string {
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
      // Skip constructor and private methods
      if (methodName === 'constructor' || methodName.startsWith('_')) continue;
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
  const varTraceEnabled = process.env.TRICKLE_TRACE_VARS !== '0';

  // For TypeScript files (compiled by ts-node/tsc), type declarations (interfaces, type aliases)
  // are stripped from the compiled JS, shifting line numbers. The only accurate way to get correct
  // line numbers is to read the original .ts source file and parse it directly.
  // For plain JS files, we parse the source directly.
  let varInsertions: Array<{ lineEnd: number; varName: string; lineNo: number }> = [];
  let destructInsertions: Array<{ lineEnd: number; varNames: string[]; lineNo: number }> = [];

  if (varTraceEnabled) {
    const isTsFile = /\.[mc]?tsx?$/.test(filename);
    if (isTsFile) {
      try {
        // Read original TypeScript source to get correct line numbers
        const fs = require('fs');
        const originalSource: string = fs.readFileSync(filename, 'utf8');
        const tsVarInsertions = findVarDeclarations(originalSource);
        const tsDestructInsertions = findDestructuredDeclarations(originalSource);

        // Map TypeScript variable names → correct line numbers (by occurrence order)
        // Use a counter map to handle duplicate variable names in different scopes
        const tsLineByVarAndOccurrence = new Map<string, number[]>();
        for (const { varName, lineNo } of tsVarInsertions) {
          if (!tsLineByVarAndOccurrence.has(varName)) tsLineByVarAndOccurrence.set(varName, []);
          tsLineByVarAndOccurrence.get(varName)!.push(lineNo);
        }

        // Find positions in compiled JS (for inserting trace calls),
        // but use line numbers from original TypeScript source
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
        destructInsertions = compiledDestructInsertions; // Keep compiled line numbers as fallback
        // Try to fix destructured line numbers too
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
      varInsertions = findVarDeclarations(source);
      destructInsertions = findDestructuredDeclarations(source);
    }
  }

  // Additional variable patterns: reassignments, for-loops, catch clauses
  // Note: function params are NOT traced here because observe-register already
  // wraps functions with __trickle_wrap which captures param types via wrapFunction.
  const reassignInsertions = findReassignments(source);
  const forLoopInsertions = findForLoopVars(source);
  const catchInsertions = findCatchVars(source);

  if (insertions.length === 0 && varInsertions.length === 0 && destructInsertions.length === 0 && reassignInsertions.length === 0 && forLoopInsertions.length === 0 && catchInsertions.length === 0 && classInsertions.length === 0) return source;

  // Resolve the path to the wrap helper (compiled JS)
  const wrapHelperPath = path.join(__dirname, 'wrap.js');

  // Prepend: load the wrapper and create the wrap helper
  const prefixLines = [
    `var __trickle_mod = require(${JSON.stringify(wrapHelperPath)});`,
    `var __trickle_wrap = function(fn, name, paramNames) {`,
    `  var opts = {`,
    `    functionName: name,`,
    `    module: ${JSON.stringify(moduleName)},`,
    `    trackArgs: true,`,
    `    trackReturn: true,`,
    `    sampleRate: 1,`,
    `    maxDepth: 3,`,
    `    environment: ${JSON.stringify(env)},`,
    `    enabled: true,`,
    `  };`,
    `  if (paramNames && paramNames.length) opts.paramNames = paramNames;`,
    `  return __trickle_mod.wrapFunction(fn, opts);`,
    `};`,
  ];

  // Add variable tracing helper if we have var insertions
  if (varInsertions.length > 0 || destructInsertions.length > 0 || reassignInsertions.length > 0 || forLoopInsertions.length > 0 || catchInsertions.length > 0) {
    const traceVarPath = path.join(__dirname, 'trace-var.js');
    prefixLines.push(
      `var __trickle_tv_mod = require(${JSON.stringify(traceVarPath)});`,
      `var __trickle_tv = function(v, n, l) { try { __trickle_tv_mod.traceVar(v, n, l, ${JSON.stringify(moduleName)}, ${JSON.stringify(filename)}); } catch(e){} };`,
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

  for (const { lineEnd, varName, lineNo } of varInsertions) {
    allInsertions.push({
      position: lineEnd,
      code: `\ntry{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}\n`,
    });
  }

  for (const { lineEnd, varNames, lineNo } of destructInsertions) {
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{${calls}}catch(__e){}\n`,
    });
  }

  // Reassignment insertions
  for (const { lineEnd, varName, lineNo } of reassignInsertions) {
    allInsertions.push({
      position: lineEnd,
      code: `\n;try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}\n`,
    });
  }

  // For-loop variable insertions
  for (const { bodyStart, varNames, lineNo } of forLoopInsertions) {
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
    allInsertions.push({
      position: bodyStart,
      code: `\ntry{${calls}}catch(__e){}\n`,
    });
  }

  // Catch clause insertions
  for (const { bodyStart, varNames, lineNo } of catchInsertions) {
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
    allInsertions.push({
      position: bodyStart,
      code: `\ntry{${calls}}catch(__e2){}\n`,
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
            sampleRate: 1,
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
            sampleRate: 1,
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
                sampleRate: 1,
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
        sampleRate: 1,
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
