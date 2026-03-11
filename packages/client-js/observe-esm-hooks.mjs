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
import { basename, sep } from 'node:path';

let config = {
  wrapperPath: '',
  transportPath: '',
  envDetectPath: '',
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

function transformSource(source, url) {
  const moduleName = moduleNameFromUrl(url);
  const lines = source.split('\n');
  const exportedFunctions = []; // { name, paramNames }
  const exportedDefaults = []; // { name, paramNames }
  const namedExports = []; // from `export { name }` statements
  const result = [];

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
      exportedFunctions.push({ name, paramNames });
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
  }

  // If nothing to wrap, return original
  if (exportedFunctions.length === 0 && exportedDefaults.length === 0 && namedExports.length === 0) {
    return source;
  }

  // Add wrapper import and wrapping code at the bottom
  const wrapperPathEscaped = config.wrapperPath.replace(/\\/g, '\\\\');

  result.push('');
  result.push('// [trickle] Auto-observation wrappers');
  result.push(`import { createRequire as __cr } from 'node:module';`);
  result.push(`const __require = __cr(import.meta.url);`);
  result.push(`const { wrapFunction: __tw } = __require('${wrapperPathEscaped}');`);
  result.push(`const __twOpts = (name, paramNames) => { const o = { functionName: name, module: '${moduleName}', trackArgs: true, trackReturn: true, sampleRate: 1, maxDepth: 5, environment: process.env.TRICKLE_ENV || 'development', enabled: true }; if (paramNames && paramNames.length) o.paramNames = paramNames; return o; };`);

  // Wrap and re-export named functions
  const reExports = [];
  for (const { name, paramNames } of exportedFunctions) {
    const wrappedName = `__trickle_${name}`;
    const pn = paramNames.length > 0 ? JSON.stringify(paramNames) : 'null';
    result.push(`const ${wrappedName} = typeof ${name} === 'function' ? __tw(${name}, __twOpts('${name}', ${pn})) : ${name};`);
    reExports.push(`${wrappedName} as ${name}`);
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
    console.log(`[trickle/esm] Transformed ${fnCount} exports from ${moduleName} (${fileURLToPath(url)})`);
  }

  return transformed;
}

/**
 * ESM load hook — intercepts module loading to transform user modules.
 */
export async function load(url, context, nextLoad) {
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

  // Only transform if the module has exports
  if (!sourceStr.includes('export ')) return result;

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
