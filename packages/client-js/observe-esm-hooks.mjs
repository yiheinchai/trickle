/**
 * ESM loader hooks for trickle observation.
 *
 * Transforms user ESM modules to wrap exported functions with trickle
 * observation. Runs in a separate loader thread (Node.js >= 20.6).
 *
 * Strategy: For each user module, the `load` hook:
 * 1. Strips `export` from function/const declarations
 * 2. Appends wrapper code that wraps each exported function
 * 3. Re-exports the wrapped versions
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, sep, extname } from 'node:path';
import { readFileSync } from 'node:fs';

// Lazy esbuild loader for JSX/TSX stripping
let _esbuild = null;
async function getEsbuild() {
  if (_esbuild !== null) return _esbuild;
  try {
    _esbuild = await import('esbuild');
    return _esbuild;
  } catch {
    _esbuild = false;
    return false;
  }
}

/**
 * Strip JSX/TSX syntax using esbuild, returning plain ESM JavaScript.
 * Preserves line count as much as possible so line numbers stay accurate.
 */
async function stripJsx(source, filePath) {
  const esbuild = await getEsbuild();
  if (!esbuild) return null; // esbuild not available

  const ext = extname(filePath).slice(1); // 'jsx' | 'tsx'
  const loader = ext === 'tsx' ? 'tsx' : 'jsx';
  try {
    const result = await esbuild.transform(source, {
      loader,
      format: 'esm',
      jsx: 'automatic',
      target: 'esnext',
      sourcemap: false,
      treeShaking: false,
      minify: false,
      minifyWhitespace: false,
      minifySyntax: false,
    });
    return result.code;
  } catch (err) {
    if (config.debug) console.error('[trickle/esm] esbuild JSX transform failed:', err.message);
    return null;
  }
}

let config = {
  wrapperPath: '',
  transportPath: '',
  envDetectPath: '',
  traceVarPath: '',
  backendUrl: 'http://localhost:4888',
  debug: false,
  includePatterns: [],
  excludePatterns: [],
  initialized: false,
};

export function initialize(data) {
  config = { ...config, ...data, initialized: true };

  // Configure trickle transport from the loader thread
  try {
    const require = createRequire(import.meta.url);
    const { configure } = require(config.transportPath);
    const { detectEnvironment } = require(config.envDetectPath);
    const environment = process.env.TRICKLE_ENV || detectEnvironment();

    configure({
      backendUrl: config.backendUrl,
      batchIntervalMs: 2000,
      debug: config.debug,
      enabled: true,
      environment,
    });
  } catch (err) {
    if (config.debug) {
      console.error('[trickle/esm] Failed to configure transport:', err.message);
    }
  }
}

/**
 * Determine if a URL should be observed.
 */
function shouldObserve(url) {
  // Only file:// URLs
  if (!url.startsWith('file://')) return false;

  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }

  // Skip node_modules
  if (filePath.includes(`${sep}node_modules${sep}`)) return false;

  // Skip trickle's own modules
  if (filePath.includes(`${sep}client-js${sep}`)) return false;
  if (filePath.includes(`${sep}trickle${sep}dist${sep}`)) return false;

  // Only JS/TS files
  if (!/\.(m?js|jsx|ts|tsx)$/.test(filePath)) return false;

  // Apply include filters
  if (config.includePatterns.length > 0) {
    if (!config.includePatterns.some(p => filePath.includes(p))) return false;
  }

  // Apply exclude filters
  if (config.excludePatterns.length > 0) {
    if (config.excludePatterns.some(p => filePath.includes(p))) return false;
  }

  return true;
}

/**
 * Extract module name from a file URL.
 */
function moduleNameFromUrl(url) {
  try {
    const filePath = fileURLToPath(url);
    return basename(filePath).replace(/\.(m?js|jsx|ts|tsx)$/, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Transform ESM source to wrap exported functions.
 *
 * Handles:
 * - export function name(...) { ... }
 * - export async function name(...) { ... }
 * - export const name = (...) => ...
 * - export const name = function(...) { ... }
 * - export const name = async (...) => ...
 * - export default function name(...) { ... }
 * - export default function(...) { ... }
 * - export { name1, name2 }
 */
/**
 * Extract parameter names from a function source snippet (everything after the function name).
 */
function extractParamNamesFromSource(source, startIdx) {
  // Find the opening paren
  const openParen = source.indexOf('(', startIdx);
  if (openParen === -1) return [];
  // Find matching close paren (handles nested parens in TS type annotations)
  let depth = 1;
  let i = openParen + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  if (depth !== 0) return [];
  const closeParen = i - 1;
  const paramStr = source.slice(openParen + 1, closeParen).trim();
  if (!paramStr) return [];
  // Split on top-level commas only (skip commas inside nested parens/generics)
  const params = [];
  let current = '';
  let parenDepth = 0;
  let angleDepth = 0;
  for (let j = 0; j < paramStr.length; j++) {
    const ch = paramStr[j];
    if (ch === '(' || ch === '{' || ch === '[') parenDepth++;
    else if (ch === ')' || ch === '}' || ch === ']') parenDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>' && paramStr[j - 1] !== '=') {
      // Don't count '>' in '=>' (arrow functions) as closing a generic
      if (angleDepth > 0) angleDepth--;
    }
    else if (ch === ',' && parenDepth === 0 && angleDepth === 0) {
      params.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current);
  return params.map(p => {
    // Strip TS type annotation and default value: "name: Type = default" → "name"
    const trimmed = p.trim().split(':')[0].trim().split('=')[0].trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...')) return '';
    return trimmed;
  }).filter(Boolean);
}

/**
 * Compute the byte offset of a given line index within the full source.
 */
function lineOffset(source, lineIdx) {
  let off = 0;
  const lines = source.split('\n');
  for (let i = 0; i < lineIdx && i < lines.length; i++) {
    off += lines[i].length + 1; // +1 for \n
  }
  return off;
}

/**
 * Find variable declarations in ESM source for tracing.
 * Returns {varName, lineNo, insertAfterLine} for each declaration.
 * insertAfterLine = the line number AFTER the full statement ends (for multi-line).
 */
function findVarDeclarationsESM(source) {
  const results = [];
  // Match const/let/var <name>[: Type] = <value>
  // Also handles export const <name>[: Type] = <value>
  const varRegex = /^([ \t]*)(?:export\s+)?(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:[^=]+?)?\s*=[^=]/gm;
  let match;

  while ((match = varRegex.exec(source)) !== null) {
    const varName = match[3];
    // Skip trickle-injected vars and transpiler-generated vars (start with __ or single _)
    if (varName.startsWith('__') || varName === '_a' || varName === '_b') continue;

    // Skip require() calls
    const restOfLine = source.slice(match.index + match[0].length - 1, match.index + match[0].length + 200);
    if (/^\s*require\s*\(/.test(restOfLine)) continue;

    // Calculate line number where the declaration starts
    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    // Find the end of the statement (semicolon at depth 0 or significant newline)
    const startPos = match.index + match[0].length - 1;
    let pos = startPos;
    let depth = 0;
    let foundEnd = -1;

    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
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
        const quote = ch; pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') pos++;
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

    // Calculate line number after the statement end
    let insertAfterLine = 1;
    for (let i = 0; i <= foundEnd && i < source.length; i++) {
      if (source[i] === '\n') insertAfterLine++;
    }

    results.push({ varName, lineNo, insertAfterLine });
  }

  return results;
}

/**
 * Find destructured variable declarations in ESM source.
 */
function findDestructuredDeclarationsESM(source) {
  const results = [];
  const destructRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
  let match;

  while ((match = destructRegex.exec(source)) !== null) {
    const pattern = match[1];
    const varNames = extractDestructuredNamesESM(pattern).filter(n => !n.startsWith('__'));
    if (varNames.length === 0) continue;

    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    const startPos = match.index + match[0].length - 1;
    let pos = startPos;
    let depth = 0;
    let foundEnd = -1;

    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
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
        const quote = ch; pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') pos++;
          else if (source[pos] === quote) break;
          pos++;
        }
      }
      pos++;
    }

    if (foundEnd === -1) continue;

    let insertAfterLine = 1;
    for (let i = 0; i <= foundEnd && i < source.length; i++) {
      if (source[i] === '\n') insertAfterLine++;
    }

    results.push({ varNames, lineNo, insertAfterLine });
  }

  return results;
}

function extractDestructuredNamesESM(pattern) {
  const names = [];
  const inner = pattern.slice(1, -1).trim();
  if (!inner) return names;

  const parts = [];
  let depth = 0, current = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    if (part.startsWith('...')) {
      const n = part.slice(3).trim().split(/[\s:]/)[0];
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(n)) names.push(n);
      continue;
    }
    const colonIdx = part.indexOf(':');
    if (colonIdx !== -1) {
      const after = part.slice(colonIdx + 1).trim();
      if (after.startsWith('{') || after.startsWith('[')) {
        names.push(...extractDestructuredNamesESM(after));
      } else {
        const n = after.split(/[\s=]/)[0].trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(n)) names.push(n);
      }
    } else {
      const n = part.split(/[\s=]/)[0].trim();
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(n)) names.push(n);
    }
  }
  return names;
}

/**
 * Map a transformed line number to the original source file line.
 * Searches within ±80 lines for a `const/let/var <varName>` pattern.
 */
function findOriginalLineESM(origLines, varName, transformedLine) {
  const pattern = new RegExp(`\\b(const|let|var)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let delta = 0; delta <= 80; delta++) {
    const fwd = transformedLine - 1 + delta;
    if (fwd >= 0 && fwd < origLines.length && pattern.test(origLines[fwd])) return fwd + 1;
    if (delta > 0 && delta <= 10) {
      const bwd = transformedLine - 1 - delta;
      if (bwd >= 0 && bwd < origLines.length && pattern.test(origLines[bwd])) return bwd + 1;
    }
  }
  return -1;
}

/**
 * Map a transformed destructured declaration line to the original source.
 */
function findOriginalLineDestructuredESM(origLines, varNames, transformedLine) {
  const namePatterns = varNames.map(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!\\s*:)`));
  for (let delta = 0; delta <= 80; delta++) {
    const fwd = transformedLine - 1 + delta;
    if (fwd >= 0 && fwd < origLines.length) {
      const line = origLines[fwd];
      if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) return fwd + 1;
    }
    if (delta > 0 && delta <= 10) {
      const bwd = transformedLine - 1 - delta;
      if (bwd >= 0 && bwd < origLines.length) {
        const line = origLines[bwd];
        if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) return bwd + 1;
      }
    }
  }
  return -1;
}

function transformSource(source, url, originalSource) {
  const moduleName = moduleNameFromUrl(url);
  let filePath = url;
  try { filePath = fileURLToPath(url); } catch {}

  const lines = source.split('\n');
  const exportedFunctions = []; // { name, paramNames }
  const exportedDefaults = []; // { name, paramNames }
  const namedExports = []; // from `export { name }` statements
  const result = [];

  // Find variable declarations for tracing
  const varTraceEnabled = process.env.TRICKLE_TRACE_VARS !== '0' && config.traceVarPath;
  const varDecls = varTraceEnabled ? findVarDeclarationsESM(source) : [];
  const destructDecls = varTraceEnabled ? findDestructuredDeclarationsESM(source) : [];

  // Map transformed line numbers to original source line numbers (if original source differs)
  if (originalSource && originalSource !== source) {
    const origLines = originalSource.split('\n');
    for (const vi of varDecls) {
      const orig = findOriginalLineESM(origLines, vi.varName, vi.lineNo);
      if (orig !== -1) vi.lineNo = orig;
    }
    for (const di of destructDecls) {
      if (di.varNames.length > 0) {
        const orig = findOriginalLineDestructuredESM(origLines, di.varNames, di.lineNo);
        if (orig !== -1) di.lineNo = orig;
      }
    }
  }

  // Build a map: line number → trace calls to insert AFTER that line
  const traceAfterLine = new Map();
  for (const { varName, lineNo, insertAfterLine } of varDecls) {
    if (!traceAfterLine.has(insertAfterLine)) traceAfterLine.set(insertAfterLine, []);
    traceAfterLine.get(insertAfterLine).push(
      `try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}`
    );
  }
  for (const { varNames, lineNo, insertAfterLine } of destructDecls) {
    if (!traceAfterLine.has(insertAfterLine)) traceAfterLine.set(insertAfterLine, []);
    const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
    traceAfterLine.get(insertAfterLine).push(`try{${calls}}catch(__e){}`);
  }

  const hasVarTracing = varDecls.length > 0 || destructDecls.length > 0;

  // Prepend var tracer setup BEFORE user code.
  // In ESM, import declarations are hoisted regardless of position, so
  // `import { createRequire }` here runs before any user code even though
  // it appears before user imports in the source text.
  // The `const` declarations run in order, so they're available when
  // the inline trace calls (injected after var declarations) execute.
  if (hasVarTracing && config.traceVarPath) {
    const tvPath = config.traceVarPath.replace(/\\/g, '\\\\');
    const fpEscaped = filePath.replace(/\\/g, '\\\\');
    result.push(`import { createRequire as __cr_tv } from 'node:module';`);
    result.push(`const __require_tv = __cr_tv(import.meta.url);`);
    result.push(`const __tv_mod = __require_tv('${tvPath}');`);
    result.push(`if (typeof __tv_mod.initVarTracer === 'function') __tv_mod.initVarTracer({});`);
    result.push(`const __trickle_tv = (v, n, l) => { try { __tv_mod.traceVar(v, n, l, ${JSON.stringify(moduleName)}, '${fpEscaped}'); } catch(__e) {} };`);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip TS-only exports: export interface, export type, export enum
    if (/^export\s+(interface|type|enum|abstract|declare)\s/.test(trimmed)) {
      result.push(line);
      continue;
    }

    // Skip re-exports: export { ... } from '...' or export * from '...'
    if (/^export\s+\{[^}]*\}\s+from\s/.test(trimmed) || /^export\s+\*\s+from\s/.test(trimmed)) {
      result.push(line);
      continue;
    }

    // export function name(...) or export function name<T>(...)
    const funcMatch = trimmed.match(/^export\s+(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (funcMatch) {
      const name = funcMatch[2];
      // Use full source from this line's offset for multiline param extraction
      const srcOffset = lineOffset(source, i) + (line.length - trimmed.length);
      const parenPos = source.indexOf('(', srcOffset + funcMatch[0].indexOf('('));
      const paramNames = parenPos >= 0 ? extractParamNamesFromSource(source, parenPos) : [];
      // Remove 'export ' prefix, keep the function
      result.push(line.replace(/^(\s*)export\s+/, '$1'));
      exportedFunctions.push({ name, paramNames, wrapInPlace: true });
      continue;
    }

    // Non-exported function declarations — wrap them too for entry module coverage
    const plainFuncMatch = trimmed.match(/^(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (plainFuncMatch && !trimmed.startsWith('export')) {
      const name = plainFuncMatch[2];
      if (name !== 'require' && name !== 'exports' && name !== 'module' && !name.startsWith('__trickle')) {
        const srcOffset = lineOffset(source, i) + (line.length - trimmed.length);
        const parenPos = source.indexOf('(', srcOffset + plainFuncMatch[0].indexOf('('));
        const paramNames = parenPos >= 0 ? extractParamNamesFromSource(source, parenPos) : [];
        exportedFunctions.push({ name, paramNames, wrapInPlace: true, noExport: true });
      }
      result.push(line);
      continue;
    }

    // export const name = (...) => or export const name = function or export const name = async
    const constFuncMatch = trimmed.match(/^export\s+(const|let)\s+(\w+)\s*=\s*(async\s+)?(\(|function\b)/);
    if (constFuncMatch) {
      const name = constFuncMatch[2];
      const srcOffset = lineOffset(source, i) + (line.length - trimmed.length);
      const eqPos = source.indexOf('=', srcOffset);
      const parenPos = eqPos >= 0 ? source.indexOf('(', eqPos) : -1;
      const paramNames = parenPos >= 0 ? extractParamNamesFromSource(source, parenPos) : [];
      result.push(line.replace(/^(\s*)export\s+/, '$1'));
      exportedFunctions.push({ name, paramNames });
      continue;
    }

    // export const name = someValue (non-function — keep as-is)
    const constNonFuncMatch = trimmed.match(/^export\s+(const|let|var)\s+(\w+)\s*=/);
    if (constNonFuncMatch && !constFuncMatch) {
      // Keep the export as-is for non-function values
      result.push(line);
      continue;
    }

    // export default function name(...) or export default function name<T>(...)
    const defaultNamedMatch = trimmed.match(/^export\s+default\s+(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (defaultNamedMatch) {
      const name = defaultNamedMatch[2];
      const srcOffset = lineOffset(source, i) + (line.length - trimmed.length);
      const parenPos = source.indexOf('(', srcOffset + defaultNamedMatch[0].indexOf('('));
      const paramNames = parenPos >= 0 ? extractParamNamesFromSource(source, parenPos) : [];
      // Remove 'export default'
      result.push(line.replace(/^(\s*)export\s+default\s+/, '$1'));
      exportedDefaults.push({ name, paramNames });
      continue;
    }

    // export default function(...)  (anonymous)
    const defaultAnonMatch = trimmed.match(/^export\s+default\s+(async\s+)?function\s*\(/);
    if (defaultAnonMatch) {
      const srcOffset = lineOffset(source, i) + (line.length - trimmed.length);
      const parenPos = source.indexOf('(', srcOffset);
      const paramNames = parenPos >= 0 ? extractParamNamesFromSource(source, parenPos) : [];
      // Convert to named: const __trickle_default = function(...)
      result.push(line.replace(
        /^(\s*)export\s+default\s+(async\s+)?function\s*\(/,
        '$1const __trickle_default = $2function('
      ));
      exportedDefaults.push({ name: '__trickle_default', paramNames });
      continue;
    }

    // export { name1, name2 } (local named exports, not re-exports)
    const namedExportMatch = trimmed.match(/^export\s+\{([^}]+)\}\s*;?\s*$/);
    if (namedExportMatch) {
      const names = namedExportMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const nameSpec of names) {
        // Handle: name or name as alias
        const parts = nameSpec.split(/\s+as\s+/);
        namedExports.push({ local: parts[0].trim(), exported: (parts[1] || parts[0]).trim() });
      }
      // Remove this export statement — we'll re-export at the bottom
      result.push('// [trickle] moved export to bottom');
      continue;
    }

    // export class, export type, export interface — leave as-is
    result.push(line);

    // Inject variable trace calls after this line (if any)
    if (hasVarTracing) {
      const calls = traceAfterLine.get(i + 1); // i+1 = 1-based line number
      if (calls) {
        for (const call of calls) result.push(call);
      }
    }
  }

  // If nothing to wrap or trace, return original
  if (exportedFunctions.length === 0 && exportedDefaults.length === 0 && namedExports.length === 0 && !hasVarTracing) {
    return source;
  }

  // Add wrapper import and wrapping code
  const wrapperPathEscaped = config.wrapperPath.replace(/\\/g, '\\\\');

  // Insert wrapper setup at the top (after imports, before user code)
  // Using import + createRequire to load CJS wrapper from ESM context
  const wrapSetup = [
    '',
    '// [trickle] Auto-observation wrappers',
    `import { createRequire as __cr } from 'node:module';`,
    `const __require = __cr(import.meta.url);`,
    `const { wrapFunction: __tw } = __require('${wrapperPathEscaped}');`,
    `const __twOpts = (name, paramNames) => { const o = { functionName: name, module: '${moduleName}', trackArgs: true, trackReturn: true, sampleRate: 1, maxDepth: 5, environment: process.env.TRICKLE_ENV || 'development', enabled: true }; if (paramNames && paramNames.length) o.paramNames = paramNames; return o; };`,
  ];

  // For in-place wrapping: insert wrapper calls right after each function declaration
  // This ensures functions are wrapped BEFORE any top-level code calls them
  const inPlaceWraps = [];
  for (const fn of exportedFunctions) {
    if (fn.wrapInPlace) {
      const pn = fn.paramNames.length > 0 ? JSON.stringify(fn.paramNames) : 'null';
      inPlaceWraps.push(`try{${fn.name}=__tw(${fn.name},__twOpts('${fn.name}',${pn}))}catch(__e){}`);
    }
  }

  // Find the right position to insert the wrap setup + in-place wraps
  // Insert after the last import/function-declaration block, before top-level code
  let insertIdx = 0;
  for (let j = 0; j < result.length; j++) {
    const t = result[j].trimStart();
    if (t.startsWith('import ') || t.startsWith('// [trickle]') || t === '' ||
        t.startsWith('function ') || t.startsWith('async function ') ||
        t.startsWith('const __trickle_tv') || t.startsWith('const __require_tv') ||
        t.startsWith('const __tv_mod') || t.startsWith('if (typeof __tv_mod')) {
      insertIdx = j + 1;
    }
  }
  // But make sure we're after any function body closing braces too
  // Simple heuristic: find the last line that's just '}' before any assignment/call
  for (let j = insertIdx; j < result.length; j++) {
    const t = result[j].trim();
    if (t === '}') insertIdx = j + 1;
    else if (t && !t.startsWith('//') && !t.startsWith('function') && !t.startsWith('async function')) break;
  }

  result.splice(insertIdx, 0, ...wrapSetup, ...inPlaceWraps, '');

  // Re-export wrapped functions (for importers of this module)
  const reExports = [];
  for (const fn of exportedFunctions) {
    if (!fn.noExport) {
      reExports.push(`${fn.name}`);
    }
  }

  // Handle named exports from export { } statements
  for (const { local, exported } of namedExports) {
    const wrappedName = `__trickle_ne_${exported}`;
    result.push(`const ${wrappedName} = typeof ${local} === 'function' ? __tw(${local}, __twOpts('${exported}', null)) : ${local};`);
    reExports.push(`${wrappedName} as ${exported}`);
  }

  if (reExports.length > 0) {
    result.push(`export { ${reExports.join(', ')} };`);
  }

  // Handle default exports
  for (const { name, paramNames } of exportedDefaults) {
    const displayName = name === '__trickle_default' ? 'default' : name;
    const pn = paramNames.length > 0 ? JSON.stringify(paramNames) : 'null';
    result.push(`const __trickle_default_wrapped = typeof ${name} === 'function' ? __tw(${name}, __twOpts('${displayName}', ${pn})) : ${name};`);
    result.push(`export default __trickle_default_wrapped;`);
  }

  const transformed = result.join('\n');

  if (config.debug) {
    const fnCount = exportedFunctions.length + exportedDefaults.length + namedExports.length;
    const varCount = varDecls.length + destructDecls.length;
    console.log(`[trickle/esm] Transformed ${fnCount} exports, ${varCount} vars from ${moduleName}`);
  }

  return transformed;
}

/**
 * ESM load hook — intercepts module loading to transform user modules.
 */
export async function load(url, context, nextLoad) {
  // Handle JSX/TSX files ourselves — Node.js cannot parse JSX natively.
  // We read the file, strip JSX with esbuild, apply trickle instrumentation,
  // and return the result without calling nextLoad (which would fail for JSX).
  if (shouldObserve(url) && /\.(jsx|tsx)$/.test(url)) {
    let filePath;
    try { filePath = fileURLToPath(url); } catch { filePath = null; }

    if (filePath) {
      try {
        const rawSource = readFileSync(filePath, 'utf-8');
        const jsSource = await stripJsx(rawSource, filePath);
        if (jsSource !== null) {
          const varTraceEnabled = process.env.TRICKLE_TRACE_VARS !== '0' && config.traceVarPath;
          const hasVarDecls = varTraceEnabled && /^[ \t]*(?:export\s+)?(?:const|let|var)\s+[a-zA-Z_$]/m.test(jsSource);
          if (jsSource.includes('export ') || hasVarDecls) {
            // Pass rawSource as originalSource so line numbers map to the .jsx/.tsx file
            const transformed = transformSource(jsSource, url, rawSource);
            return { source: transformed, format: 'module', shortCircuit: true };
          }
          // No observable exports/vars — return stripped JS so Node can execute it
          return { source: jsSource, format: 'module', shortCircuit: true };
        }
      } catch (err) {
        if (config.debug) console.error(`[trickle/esm] JSX load failed for ${url}:`, err.message);
      }
    }
  }

  const result = await nextLoad(url, context);

  // Only transform ESM modules we should observe
  if (!shouldObserve(url)) return result;
  const isModule = result.format === 'module';
  const isTypeScript = result.format === 'module-typescript';
  if (!isModule && !isTypeScript) return result;

  const source = result.source;
  if (!source) return result;

  const sourceStr = typeof source === 'string'
    ? source
    : Buffer.from(source).toString('utf-8');

  // Only transform if the module has exports, function declarations, or variable declarations to trace
  const varTraceEnabled = process.env.TRICKLE_TRACE_VARS !== '0' && config.traceVarPath;
  const hasVarDecls = varTraceEnabled && /^[ \t]*(?:export\s+)?(?:const|let|var)\s+[a-zA-Z_$]/m.test(sourceStr);
  const hasFuncDecls = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+\w/m.test(sourceStr);
  if (!sourceStr.includes('export ') && !hasVarDecls && !hasFuncDecls) return result;

  try {
    const transformed = transformSource(sourceStr, url);
    return {
      ...result,
      source: transformed,
      shortCircuit: true,
    };
  } catch (err) {
    if (config.debug) {
      console.error(`[trickle/esm] Failed to transform ${url}:`, err.message);
    }
    return result;
  }
}
