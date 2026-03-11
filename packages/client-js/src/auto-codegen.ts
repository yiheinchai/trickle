/**
 * Lightweight inline codegen for `trickle/auto`.
 *
 * Reads .trickle/observations.jsonl and generates .d.ts sidecar files
 * next to source files. Runs entirely inside the user's process —
 * no CLI or backend required.
 */

import * as fs from 'fs';
import * as path from 'path';

interface TypeNode {
  kind: string;
  name?: string;
  element?: TypeNode;
  elements?: TypeNode[];
  properties?: Record<string, TypeNode>;
  members?: TypeNode[];
  params?: TypeNode[];
  returnType?: TypeNode;
  resolved?: TypeNode;
  key?: TypeNode;
  value?: TypeNode;
}

interface Observation {
  functionName: string;
  module: string;
  language: string;
  typeHash: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

interface FunctionData {
  name: string;
  argsType: TypeNode;
  returnType: TypeNode;
  module: string;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

// ── Type merging (same logic as CLI local-codegen) ──

function typeNodeKey(node: TypeNode): string {
  switch (node.kind) {
    case 'primitive': return `p:${node.name}`;
    case 'unknown': return 'unknown';
    case 'array': return `a:${typeNodeKey(node.element!)}`;
    case 'tuple': return `t:[${(node.elements || []).map(typeNodeKey).join(',')}]`;
    case 'object': {
      const props = node.properties || {};
      const entries = Object.keys(props).sort().map(k => `${k}:${typeNodeKey(props[k])}`);
      return `o:{${entries.join(',')}}`;
    }
    case 'union': return `u:(${(node.members || []).map(typeNodeKey).sort().join('|')})`;
    default: return JSON.stringify(node);
  }
}

function mergeTypeNodes(a: TypeNode, b: TypeNode): TypeNode {
  if (typeNodeKey(a) === typeNodeKey(b)) return a;

  if (a.kind === 'object' && b.kind === 'object') {
    const aP = a.properties || {}, bP = b.properties || {};
    const allKeys = new Set([...Object.keys(aP), ...Object.keys(bP)]);
    const merged: Record<string, TypeNode> = {};
    for (const k of allKeys) {
      const inA = k in aP, inB = k in bP;
      if (inA && inB) merged[k] = mergeTypeNodes(aP[k], bP[k]);
      else if (inA) merged[k] = makeOptional(aP[k]);
      else merged[k] = makeOptional(bP[k]);
    }
    return { kind: 'object', properties: merged };
  }

  if (a.kind === 'array' && b.kind === 'array' && a.element && b.element) {
    return { kind: 'array', element: mergeTypeNodes(a.element, b.element) };
  }

  if (a.kind === 'tuple' && b.kind === 'tuple') {
    const aE = a.elements || [], bE = b.elements || [];
    if (aE.length === bE.length) {
      return { kind: 'tuple', elements: aE.map((el, i) => mergeTypeNodes(el, bE[i])) };
    }
  }

  return deduplicateUnion([
    ...(a.kind === 'union' ? (a.members || []) : [a]),
    ...(b.kind === 'union' ? (b.members || []) : [b]),
  ]);
}

function makeOptional(node: TypeNode): TypeNode {
  if (node.kind === 'primitive' && node.name === 'undefined') return node;
  if (node.kind === 'union') {
    const members = node.members || [];
    if (members.some(m => m.kind === 'primitive' && m.name === 'undefined')) return node;
    return { kind: 'union', members: [...members, { kind: 'primitive', name: 'undefined' }] };
  }
  return { kind: 'union', members: [node, { kind: 'primitive', name: 'undefined' }] };
}

function deduplicateUnion(members: TypeNode[]): TypeNode {
  const seen = new Set<string>();
  const unique: TypeNode[] = [];
  for (const m of members) {
    if (m.kind === 'union') {
      for (const inner of m.members || []) {
        const k = typeNodeKey(inner);
        if (!seen.has(k)) { seen.add(k); unique.push(inner); }
      }
    } else {
      const k = typeNodeKey(m);
      if (!seen.has(k)) { seen.add(k); unique.push(m); }
    }
  }
  return unique.length === 1 ? unique[0] : { kind: 'union', members: unique };
}

// ── Read + merge observations ──

function readAndMerge(jsonlPath: string): FunctionData[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const byFunc = new Map<string, Observation[]>();
  for (const line of lines) {
    try {
      const obs = JSON.parse(line) as Observation;
      if (obs.functionName && obs.argsType && obs.returnType) {
        if (!byFunc.has(obs.functionName)) byFunc.set(obs.functionName, []);
        byFunc.get(obs.functionName)!.push(obs);
      }
    } catch { /* skip */ }
  }

  const results: FunctionData[] = [];
  for (const [name, observations] of byFunc) {
    let args = observations[0].argsType;
    let ret = observations[0].returnType;
    for (let i = 1; i < observations.length; i++) {
      if (observations[i].typeHash !== observations[0].typeHash) {
        args = mergeTypeNodes(args, observations[i].argsType);
        ret = mergeTypeNodes(ret, observations[i].returnType);
      }
    }
    // Use paramNames from the latest observation that has them
    const paramNames = observations.reduce<string[] | undefined>(
      (acc, obs) => obs.paramNames && obs.paramNames.length > 0 ? obs.paramNames : acc,
      undefined,
    );
    // Use sample data from the first observation that has it
    const sampleObs = observations.find(obs => obs.sampleInput != null || obs.sampleOutput != null);
    results.push({
      name, argsType: args, returnType: ret,
      module: observations[observations.length - 1].module,
      paramNames,
      sampleInput: sampleObs?.sampleInput,
      sampleOutput: sampleObs?.sampleOutput,
    });
  }
  return results;
}

// ── TypeScript generation ──

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim().split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function extractOptional(node: TypeNode): { isOptional: boolean; innerType: TypeNode } {
  if (node.kind !== 'union') return { isOptional: false, innerType: node };
  const members = node.members || [];
  const hasUndef = members.some(m => m.kind === 'primitive' && m.name === 'undefined');
  if (!hasUndef) return { isOptional: false, innerType: node };
  const without = members.filter(m => !(m.kind === 'primitive' && m.name === 'undefined'));
  if (without.length === 0) return { isOptional: true, innerType: { kind: 'primitive', name: 'undefined' } };
  if (without.length === 1) return { isOptional: true, innerType: without[0] };
  return { isOptional: true, innerType: { kind: 'union', members: without } };
}

interface Extracted { name: string; node: TypeNode; }

function typeToTS(node: TypeNode, ext: Extracted[], parent: string, prop: string | undefined, indent: number): string {
  switch (node.kind) {
    case 'primitive': return node.name || 'unknown';
    case 'unknown': return 'unknown';
    case 'array': {
      const inner = typeToTS(node.element!, ext, parent, prop, indent);
      return node.element!.kind === 'union' ? `Array<${inner}>` : `${inner}[]`;
    }
    case 'tuple':
      return `[${(node.elements || []).map((e, i) => typeToTS(e, ext, parent, `${prop || 'el'}${i}`, indent)).join(', ')}]`;
    case 'union':
      return (node.members || []).map(m => typeToTS(m, ext, parent, prop, indent)).join(' | ');
    case 'map': return `Map<${typeToTS(node.key!, ext, parent, 'key', indent)}, ${typeToTS(node.value!, ext, parent, 'value', indent)}>`;
    case 'set': return `Set<${typeToTS(node.element!, ext, parent, prop, indent)}>`;
    case 'promise': return `Promise<${typeToTS(node.resolved!, ext, parent, prop, indent)}>`;
    case 'function': {
      const params = (node.params || []).map((p, i) => `arg${i}: ${typeToTS(p, ext, parent, `p${i}`, indent)}`);
      return `(${params.join(', ')}) => ${typeToTS(node.returnType!, ext, parent, 'ret', indent)}`;
    }
    case 'object': {
      const keys = Object.keys(node.properties || {});
      if (keys.length === 0) return 'Record<string, never>';
      if (keys.length > 2 && prop) {
        const iName = toPascalCase(parent) + toPascalCase(prop);
        if (!ext.some(e => e.name === iName)) ext.push({ name: iName, node });
        return iName;
      }
      const pad = '  '.repeat(indent + 1), close = '  '.repeat(indent);
      const entries = keys.map(k => {
        const { isOptional, innerType } = extractOptional(node.properties![k]);
        const val = typeToTS(innerType, ext, parent, k, indent + 1);
        return isOptional ? `${pad}${k}?: ${val};` : `${pad}${k}: ${val};`;
      });
      return `{\n${entries.join('\n')}\n${close}}`;
    }
    default: return 'unknown';
  }
}

function renderInterface(name: string, node: TypeNode, ext: Extracted[]): string {
  const keys = Object.keys(node.properties || {});
  const lines = [`export interface ${name} {`];
  for (const k of keys) {
    const { isOptional, innerType } = extractOptional(node.properties![k]);
    const val = typeToTS(innerType, ext, name, k, 1);
    lines.push(isOptional ? `  ${k}?: ${val};` : `  ${k}: ${val};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function formatSampleValue(val: unknown, depth = 0): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val === 'string') return depth === 0 && val.length > 60 ? `"${val.slice(0, 57)}..."` : `"${val}"`;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    if (depth > 1) return '[...]';
    const items = val.slice(0, 5).map(v => formatSampleValue(v, depth + 1));
    return val.length > 5 ? `[${items.join(', ')}, ...]` : `[${items.join(', ')}]`;
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    if (depth > 1) return '{...}';
    const items = entries.slice(0, 6).map(([k, v]) => `${k}: ${formatSampleValue(v, depth + 1)}`);
    return entries.length > 6 ? `{ ${items.join(', ')}, ... }` : `{ ${items.join(', ')} }`;
  }
  return String(val);
}

function buildExampleComment(fn: FunctionData): string[] {
  if (fn.sampleInput == null && fn.sampleOutput == null) return [];

  const paramNames = fn.paramNames || [];
  const lines: string[] = [];

  // Format args
  let argsStr = '';
  if (Array.isArray(fn.sampleInput)) {
    argsStr = fn.sampleInput.map(v => formatSampleValue(v)).join(', ');
  } else if (fn.sampleInput != null) {
    argsStr = formatSampleValue(fn.sampleInput);
  }

  // Format return value
  const retStr = fn.sampleOutput != null ? formatSampleValue(fn.sampleOutput) : undefined;

  lines.push('/**');
  lines.push(` * @example`);
  if (retStr) {
    lines.push(` * ${fn.name}(${argsStr})`);
    lines.push(` * // => ${retStr}`);
  } else {
    lines.push(` * ${fn.name}(${argsStr})`);
  }
  lines.push(' */');
  return lines;
}

function generateDts(functions: FunctionData[]): string {
  const sections: string[] = [
    '// Auto-generated by trickle/auto from runtime observations',
    `// Generated at ${new Date().toISOString()}`,
    '// Do not edit — types update automatically as your code runs',
    '',
  ];

  for (const fn of functions) {
    const base = toPascalCase(fn.name);
    const ext: Extracted[] = [];
    const lines: string[] = [];

    // Args
    let argEntries: Array<{ paramName: string; typeNode: TypeNode }> = [];
    if (fn.argsType.kind === 'tuple') {
      const names = fn.paramNames || [];
      argEntries = (fn.argsType.elements || []).map((el, i) => ({
        paramName: names[i] || `arg${i}`,
        typeNode: el,
      }));
    } else if (fn.argsType.kind === 'object') {
      argEntries = Object.keys(fn.argsType.properties || {}).map(k => ({ paramName: k, typeNode: fn.argsType.properties![k] }));
    } else {
      argEntries = [{ paramName: 'input', typeNode: fn.argsType }];
    }

    const singleObj = argEntries.length === 1 && argEntries[0].typeNode.kind === 'object';
    if (singleObj) {
      lines.push(renderInterface(`${base}Input`, argEntries[0].typeNode, ext));
      lines.push('');
    }

    // Return
    const outName = `${base}Output`;
    if (fn.returnType.kind === 'object' && Object.keys(fn.returnType.properties || {}).length > 0) {
      lines.push(renderInterface(outName, fn.returnType, ext));
      lines.push('');
    } else {
      lines.push(`export type ${outName} = ${typeToTS(fn.returnType, ext, base, undefined, 0)};`);
      lines.push('');
    }

    // Extracted interfaces
    const emitted = new Set<string>();
    const extLines: string[] = [];
    let cursor = 0;
    while (cursor < ext.length) {
      const iface = ext[cursor++];
      if (emitted.has(iface.name)) continue;
      emitted.add(iface.name);
      extLines.push(renderInterface(iface.name, iface.node, ext));
      extLines.push('');
    }

    // Function declaration
    const ident = base.charAt(0).toLowerCase() + base.slice(1);
    let decl: string;
    if (singleObj) {
      decl = `export declare function ${ident}(input: ${base}Input): ${outName};`;
    } else {
      const params = argEntries.map(e => {
        if (e.typeNode.kind === 'object' && Object.keys(e.typeNode.properties || {}).length > 0)
          return `${e.paramName}: ${base}${toPascalCase(e.paramName)}`;
        return `${e.paramName}: ${typeToTS(e.typeNode, ext, base, e.paramName, 0)}`;
      });
      decl = `export declare function ${ident}(${params.join(', ')}): ${outName};`;
    }

    if (extLines.length > 0) sections.push(...extLines);
    sections.push(...lines);

    // Add @example JSDoc if sample data is available
    const exampleLines = buildExampleComment(fn);
    if (exampleLines.length > 0) sections.push(...exampleLines);

    sections.push(decl);
    sections.push('');
  }

  return sections.join('\n').trimEnd() + '\n';
}

// ── JSDoc type formatting ──

function typeToJSDoc(node: TypeNode): string {
  switch (node.kind) {
    case 'primitive': return node.name || '*';
    case 'unknown': return '*';
    case 'array': {
      const inner = typeToJSDoc(node.element!);
      return `${inner}[]`;
    }
    case 'tuple':
      return `[${(node.elements || []).map(typeToJSDoc).join(', ')}]`;
    case 'union':
      return (node.members || []).map(typeToJSDoc).join(' | ');
    case 'map': return `Map<${typeToJSDoc(node.key!)}, ${typeToJSDoc(node.value!)}>`;
    case 'set': return `Set<${typeToJSDoc(node.element!)}>`;
    case 'promise': return `Promise<${typeToJSDoc(node.resolved!)}>`;
    case 'function': {
      const params = (node.params || []).map((p, i) => `arg${i}: ${typeToJSDoc(p)}`);
      return `function(${params.join(', ')}): ${typeToJSDoc(node.returnType!)}`;
    }
    case 'object': {
      const props = node.properties || {};
      const keys = Object.keys(props);
      if (keys.length === 0) return 'Object';
      const entries = keys.map(k => {
        const { isOptional, innerType } = extractOptional(props[k]);
        return isOptional ? `${k}?: ${typeToJSDoc(innerType)}` : `${k}: ${typeToJSDoc(innerType)}`;
      });
      return `{ ${entries.join(', ')} }`;
    }
    default: return '*';
  }
}

// ── JSDoc injection into source files ──

const funcDeclRe = /^(\s*(?:export\s+)?(?:async\s+)?function\s+)(\w+)\s*(?:<[^>]*>)?\s*\(/;
const arrowRe = /^(\s*(?:export\s+)?(?:const|let|var)\s+)(\w+)\s*=\s*(?:async\s+)?\(/;
const methodRe = /^(\s+)(\w+)\s*\(([^)]*)\)\s*\{/;

function injectJSDocIntoFile(filePath: string, functions: FunctionData[]): boolean {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lines = source.split('\n');
  const fnMap = new Map(functions.map(f => [f.name, f]));
  const result: string[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Try to match a function declaration
    let fnName: string | null = null;
    let m = trimmed.match(funcDeclRe);
    if (m) fnName = m[2];
    if (!fnName) {
      m = trimmed.match(arrowRe);
      if (m) fnName = m[2];
    }
    if (!fnName) {
      m = trimmed.match(methodRe);
      if (m) fnName = m[2];
    }

    if (!fnName || !fnMap.has(fnName)) {
      result.push(line);
      continue;
    }

    // Check if there's already a JSDoc comment above
    const prevIdx = result.length - 1;
    if (prevIdx >= 0) {
      const prev = result[prevIdx].trim();
      if (prev === '*/' || prev.endsWith('*/')) {
        let j = prevIdx;
        while (j >= 0 && !result[j].trim().startsWith('/**')) j--;
        if (j >= 0) {
          const block = result.slice(j, prevIdx + 1).join('\n');
          if (block.includes('@param') || block.includes('@returns') || block.includes('@trickle')) {
            result.push(line);
            continue;
          }
        }
      }
    }

    const fn = fnMap.get(fnName)!;
    const indent = line.match(/^(\s*)/)?.[1] || '';

    // Build JSDoc
    const jsdocLines: string[] = [`${indent}/** @trickle — auto-generated from runtime observations`];

    // Params
    const argElements = fn.argsType.kind === 'tuple' ? (fn.argsType.elements || []) : [];
    const paramNames = fn.paramNames || [];
    for (let pi = 0; pi < argElements.length; pi++) {
      const pName = paramNames[pi] || `arg${pi}`;
      const pType = typeToJSDoc(argElements[pi]);
      jsdocLines.push(`${indent} * @param {${pType}} ${pName}`);
    }

    // Return type
    const retType = typeToJSDoc(fn.returnType);
    if (retType !== 'undefined' && retType !== 'void') {
      jsdocLines.push(`${indent} * @returns {${retType}}`);
    }

    jsdocLines.push(`${indent} */`);

    if (jsdocLines.length > 2) {
      result.push(...jsdocLines);
      changed = true;
    }

    result.push(line);
  }

  if (changed) {
    fs.writeFileSync(filePath, result.join('\n'), 'utf-8');
  }
  return changed;
}

/**
 * Inject JSDoc comments into JS source files based on observations.
 * Only runs when TRICKLE_INJECT=1.
 */
export function injectTypes(): number {
  if (process.env.TRICKLE_INJECT !== '1') return 0;

  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const jsonlPath = path.join(trickleDir, 'observations.jsonl');
  if (!fs.existsSync(jsonlPath)) return 0;

  const functions = readAndMerge(jsonlPath);
  if (functions.length === 0) return 0;

  const byModule = new Map<string, FunctionData[]>();
  for (const fn of functions) {
    const mod = fn.module || '_default';
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(fn);
  }

  let injected = 0;
  for (const [mod, fns] of byModule) {
    if (mod.includes('.') && !mod.includes('/') && !mod.includes('\\')) continue;

    const sourceFile = findSourceFile(mod);
    if (!sourceFile) continue;

    const ext = path.extname(sourceFile);
    // Only inject into JS files (not .ts — those already have types)
    if (!['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;

    try {
      if (injectJSDocIntoFile(sourceFile, fns)) {
        injected += fns.length;
      }
    } catch { /* don't crash user's app */ }
  }

  return injected;
}

// ── Public API ──

let lastSize = 0;
let lastContent = '';

/**
 * Read observations and generate .d.ts files next to source files.
 * Returns the number of functions typed.
 */
export function generateTypes(): number {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const jsonlPath = path.join(trickleDir, 'observations.jsonl');

  if (!fs.existsSync(jsonlPath)) return 0;

  // Skip if file hasn't changed
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size === lastSize) return -1; // -1 = no change
    lastSize = stat.size;
  } catch { return 0; }

  const functions = readAndMerge(jsonlPath);
  if (functions.length === 0) return 0;

  // Group by module and generate .d.ts next to source files
  const byModule = new Map<string, FunctionData[]>();
  for (const fn of functions) {
    const mod = fn.module || '_default';
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(fn);
  }

  let totalFunctions = 0;
  for (const [mod, fns] of byModule) {
    // Skip HTTP route observations (module is hostname like "localhost")
    if (mod.includes('.') && !mod.includes('/') && !mod.includes('\\')) continue;

    const dts = generateDts(fns);
    if (dts === lastContent) continue;

    // Find source file for this module
    const sourceFile = findSourceFile(mod);
    if (!sourceFile) continue;

    const ext = path.extname(sourceFile);
    const dir = path.dirname(sourceFile);
    const baseName = path.basename(sourceFile, ext);
    // For .ts/.tsx files, use .trickle.d.ts to avoid conflicts (TS ignores .d.ts next to .ts)
    const isTs = ext === '.ts' || ext === '.tsx';
    const dtsPath = path.join(dir, `${baseName}${isTs ? '.trickle' : ''}.d.ts`);

    try {
      fs.writeFileSync(dtsPath, dts, 'utf-8');
      lastContent = dts;
      totalFunctions += fns.length;
    } catch { /* don't crash user's app */ }
  }

  return totalFunctions;
}

/**
 * Try to find the source file for a given module name.
 */
function findSourceFile(moduleName: string): string | null {
  const cwd = process.cwd();
  const exts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

  // Try direct match in cwd
  for (const ext of exts) {
    const candidate = path.join(cwd, moduleName + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try with dashes/underscores replaced
  const normalized = moduleName.replace(/[-_]/g, '');
  for (const ext of exts) {
    const candidate = path.join(cwd, normalized + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try as subdirectory/index
  for (const ext of exts) {
    const candidate = path.join(cwd, moduleName, `index${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}
