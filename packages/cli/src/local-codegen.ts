/**
 * Local codegen: reads .trickle/observations.jsonl and generates
 * type stubs without needing the backend running.
 *
 * Used by `trickle run` in offline/local mode.
 */

import * as fs from "fs";
import * as path from "path";

export interface TypeNode {
  kind: string;
  name?: string;
  class_name?: string;
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

interface IngestPayload {
  functionName: string;
  module: string;
  language: string;
  environment: string;
  typeHash: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

interface TypeVariant {
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
}

export interface FunctionTypeData {
  name: string;
  argsType: TypeNode;
  returnType: TypeNode;
  module?: string;
  paramNames?: string[];
  variants?: TypeVariant[];
  isAsync?: boolean;
}

// ── Type merging ──

/**
 * Merge two TypeNodes into a single type that represents both.
 *
 * - Same primitive → keep as-is
 * - Different primitives → union
 * - Two objects → merge properties (missing props become optional via union with undefined)
 * - Two arrays → merge element types
 * - Two tuples with same length → merge positionally
 * - Anything else → union
 */
function mergeTypeNodes(a: TypeNode, b: TypeNode): TypeNode {
  // Identical nodes
  if (typeNodeKey(a) === typeNodeKey(b)) return a;

  // Both objects: merge properties
  if (a.kind === "object" && b.kind === "object") {
    const aProps = a.properties || {};
    const bProps = b.properties || {};
    const allKeys = new Set([...Object.keys(aProps), ...Object.keys(bProps)]);
    const merged: Record<string, TypeNode> = {};

    for (const key of allKeys) {
      const inA = key in aProps;
      const inB = key in bProps;

      if (inA && inB) {
        // Property exists in both — merge their types
        merged[key] = mergeTypeNodes(aProps[key], bProps[key]);
      } else if (inA) {
        // Only in A — mark as optional (union with undefined)
        merged[key] = makeOptional(aProps[key]);
      } else {
        // Only in B — mark as optional
        merged[key] = makeOptional(bProps[key]);
      }
    }

    return { kind: "object", properties: merged };
  }

  // Both arrays: merge element types
  if (a.kind === "array" && b.kind === "array" && a.element && b.element) {
    return { kind: "array", element: mergeTypeNodes(a.element, b.element) };
  }

  // Both tuples: merge positionally, handle different lengths
  if (a.kind === "tuple" && b.kind === "tuple") {
    const aEls = a.elements || [];
    const bEls = b.elements || [];
    if (aEls.length === bEls.length) {
      return {
        kind: "tuple",
        elements: aEls.map((el, i) => mergeTypeNodes(el, bEls[i])),
      };
    }
    // Different lengths: merge common prefix, make extra elements optional
    const shorter = aEls.length < bEls.length ? aEls : bEls;
    const longer = aEls.length < bEls.length ? bEls : aEls;
    const merged: TypeNode[] = [];
    for (let i = 0; i < longer.length; i++) {
      if (i < shorter.length) {
        merged.push(mergeTypeNodes(shorter[i], longer[i]));
      } else {
        merged.push(makeOptional(longer[i]));
      }
    }
    return { kind: "tuple", elements: merged };
  }

  // Both unions: flatten and deduplicate
  if (a.kind === "union" && b.kind === "union") {
    return deduplicateUnion([...(a.members || []), ...(b.members || [])]);
  }

  // One is a union: add the other as a member
  if (a.kind === "union") {
    return deduplicateUnion([...(a.members || []), b]);
  }
  if (b.kind === "union") {
    return deduplicateUnion([a, ...(b.members || [])]);
  }

  // Different kinds: create union
  return deduplicateUnion([a, b]);
}

/**
 * Make a type optional by adding undefined to it (for properties that
 * don't appear in every observation).
 */
function makeOptional(node: TypeNode): TypeNode {
  // Already has undefined
  if (node.kind === "primitive" && node.name === "undefined") return node;
  if (node.kind === "union") {
    const members = node.members || [];
    if (members.some((m) => m.kind === "primitive" && m.name === "undefined")) {
      return node;
    }
    return {
      kind: "union",
      members: [...members, { kind: "primitive", name: "undefined" }],
    };
  }
  return {
    kind: "union",
    members: [node, { kind: "primitive", name: "undefined" }],
  };
}

/**
 * Create a union type with deduplicated members.
 */
function deduplicateUnion(members: TypeNode[]): TypeNode {
  const seen = new Set<string>();
  const unique: TypeNode[] = [];
  for (const m of members) {
    // Flatten nested unions
    if (m.kind === "union") {
      for (const inner of m.members || []) {
        const key = typeNodeKey(inner);
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(inner);
        }
      }
    } else {
      const key = typeNodeKey(m);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(m);
      }
    }
  }
  if (unique.length === 1) return unique[0];
  return { kind: "union", members: unique };
}

/**
 * Generate a string key for a TypeNode (for deduplication).
 */
function typeNodeKey(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return `p:${node.name}`;
    case "unknown":
      return "unknown";
    case "array":
      return `a:${typeNodeKey(node.element!)}`;
    case "tuple":
      return `t:[${(node.elements || []).map(typeNodeKey).join(",")}]`;
    case "object": {
      const props = node.properties || {};
      const entries = Object.keys(props)
        .sort()
        .map((k) => `${k}:${typeNodeKey(props[k])}`);
      return `o:{${entries.join(",")}}`;
    }
    case "union": {
      const members = (node.members || []).map(typeNodeKey).sort();
      return `u:(${members.join("|")})`;
    }
    default:
      return JSON.stringify(node);
  }
}

// ── Read and merge observations ──

export function readObservations(jsonlPath: string): FunctionTypeData[] {
  if (!fs.existsSync(jsonlPath)) return [];

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  // Collect all observations per function, then merge types
  const byFunction = new Map<string, { payloads: IngestPayload[] }>();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line) as IngestPayload;
      if (payload.functionName && payload.argsType && payload.returnType) {
        if (!byFunction.has(payload.functionName)) {
          byFunction.set(payload.functionName, { payloads: [] });
        }
        byFunction.get(payload.functionName)!.payloads.push(payload);
      }
    } catch {
      // Skip malformed lines
    }
  }

  const results: FunctionTypeData[] = [];
  for (const [name, { payloads }] of byFunction) {
    // Start with the first observation, merge subsequent ones
    let mergedArgs = payloads[0].argsType;
    let mergedReturn = payloads[0].returnType;

    for (let i = 1; i < payloads.length; i++) {
      // Only merge if the type hash differs (different shape)
      if (payloads[i].typeHash !== payloads[0].typeHash) {
        mergedArgs = mergeTypeNodes(mergedArgs, payloads[i].argsType);
        mergedReturn = mergeTypeNodes(mergedReturn, payloads[i].returnType);
      }
    }

    // Use paramNames from the latest payload that has them
    const paramNames = payloads.reduce<string[] | undefined>(
      (acc, p) => p.paramNames && p.paramNames.length > 0 ? p.paramNames : acc,
      undefined,
    );

    // Collect unique type variants (by typeHash) for overload generation
    const seenHashes = new Set<string>();
    const variants: TypeVariant[] = [];
    for (const p of payloads) {
      if (!seenHashes.has(p.typeHash)) {
        seenHashes.add(p.typeHash);
        variants.push({
          argsType: p.argsType,
          returnType: p.returnType,
          paramNames: p.paramNames,
        });
      }
    }

    results.push({
      name,
      argsType: mergedArgs,
      returnType: mergedReturn,
      module: payloads[payloads.length - 1].module, // use latest module
      paramNames,
      variants: variants.length >= 2 && variants.length <= 5 ? variants : undefined,
      isAsync: payloads.some((p: any) => p.isAsync),
    });
  }

  return results;
}

// ── Naming helpers ──

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

// ── TypeScript generation ──

interface ExtractedInterface {
  name: string;
  node: TypeNode;
}

function typeNodeToTS(
  node: TypeNode,
  extracted: ExtractedInterface[],
  parentName: string,
  propName: string | undefined,
  indent: number,
): string {
  if (!node || !node.kind) return "unknown";
  switch (node.kind) {
    case "primitive": {
      const n = node.name || "unknown";
      // Map Python-style type names to TypeScript
      if (n === "integer") return "number";
      if (n === "null") return "null";
      if (n === "undefined") return "undefined";
      return n;
    }
    case "unknown":
      return "unknown";
    case "array": {
      const inner = typeNodeToTS(node.element!, extracted, parentName, propName, indent);
      return node.element!.kind === "union" || node.element!.kind === "function"
        ? `Array<${inner}>`
        : `${inner}[]`;
    }
    case "tuple": {
      const elements = (node.elements || []).map((el, i) =>
        typeNodeToTS(el, extracted, parentName, `${propName || "el"}${i}`, indent),
      );
      return `[${elements.join(", ")}]`;
    }
    case "union": {
      const members = (node.members || []).map((m) =>
        typeNodeToTS(m, extracted, parentName, propName, indent),
      );
      return members.join(" | ");
    }
    case "map": {
      const k = typeNodeToTS(node.key!, extracted, parentName, "key", indent);
      const v = typeNodeToTS(node.value!, extracted, parentName, "value", indent);
      return `Map<${k}, ${v}>`;
    }
    case "set":
      return `Set<${typeNodeToTS(node.element!, extracted, parentName, propName, indent)}>`;
    case "promise":
      return `Promise<${typeNodeToTS(node.resolved!, extracted, parentName, propName, indent)}>`;
    case "iterator": {
      const inner = typeNodeToTS(node.element!, extracted, parentName, propName, indent);
      const iterName = node.name === "AsyncIterator" ? "AsyncIterableIterator" : "IterableIterator";
      return `${iterName}<${inner}>`;
    }
    case "function": {
      const params = (node.params || []).map(
        (p, i) => `arg${i}: ${typeNodeToTS(p, extracted, parentName, `param${i}`, indent)}`,
      );
      const ret = typeNodeToTS(node.returnType!, extracted, parentName, "return", indent);
      return `(${params.join(", ")}) => ${ret}`;
    }
    case "object": {
      // User-defined classes — use class name directly
      if (node.class_name && node.class_name !== "dict") {
        return node.class_name;
      }
      const keys = Object.keys(node.properties || {});
      if (keys.length === 0) return "Record<string, never>";
      if (keys.length > 2 && propName) {
        const ifaceName = toPascalCase(parentName) + toPascalCase(propName);
        if (!extracted.some((e) => e.name === ifaceName)) {
          extracted.push({ name: ifaceName, node });
        }
        return ifaceName;
      }
      const pad = "  ".repeat(indent + 1);
      const closePad = "  ".repeat(indent);
      const entries = keys.map((key) => {
        const val = typeNodeToTS(node.properties![key], extracted, parentName, key, indent + 1);
        return `${pad}${key}: ${val};`;
      });
      return `{\n${entries.join("\n")}\n${closePad}}`;
    }
    default:
      return "unknown";
  }
}

/**
 * Check if a TypeNode is optional (union containing undefined).
 * Returns { isOptional, innerType } where innerType has undefined stripped.
 */
function extractOptional(node: TypeNode): { isOptional: boolean; innerType: TypeNode } {
  if (node.kind !== "union") return { isOptional: false, innerType: node };
  const members = node.members || [];
  const hasUndefined = members.some(
    (m) => m.kind === "primitive" && m.name === "undefined",
  );
  if (!hasUndefined) return { isOptional: false, innerType: node };

  const withoutUndefined = members.filter(
    (m) => !(m.kind === "primitive" && m.name === "undefined"),
  );
  if (withoutUndefined.length === 0) {
    return { isOptional: true, innerType: { kind: "primitive", name: "undefined" } };
  }
  if (withoutUndefined.length === 1) {
    return { isOptional: true, innerType: withoutUndefined[0] };
  }
  return { isOptional: true, innerType: { kind: "union", members: withoutUndefined } };
}

function renderInterface(
  name: string,
  node: TypeNode,
  allExtracted: ExtractedInterface[],
): string {
  const keys = Object.keys(node.properties || {});
  const lines: string[] = [`export interface ${name} {`];
  for (const key of keys) {
    const propType = node.properties![key];
    const { isOptional, innerType } = extractOptional(propType);
    const val = typeNodeToTS(innerType, allExtracted, name, key, 1);
    if (isOptional) {
      lines.push(`  ${key}?: ${val};`);
    } else {
      lines.push(`  ${key}: ${val};`);
    }
  }
  lines.push(`}`);
  return lines.join("\n");
}

function generateTsForFunction(fn: FunctionTypeData): string {
  const baseName = toPascalCase(fn.name);
  const extracted: ExtractedInterface[] = [];
  const lines: string[] = [];

  // Determine args
  let argEntries: Array<{ paramName: string; typeNode: TypeNode }> = [];
  if (fn.argsType.kind === "tuple") {
    const names = fn.paramNames || [];
    argEntries = (fn.argsType.elements || []).map((el, i) => ({
      paramName: names[i] || `arg${i}`,
      typeNode: el,
    }));
  } else if (fn.argsType.kind === "object") {
    for (const key of Object.keys(fn.argsType.properties || {})) {
      argEntries.push({ paramName: key, typeNode: fn.argsType.properties![key] });
    }
  } else {
    argEntries = [{ paramName: "input", typeNode: fn.argsType }];
  }

  const singleObjectArg =
    argEntries.length === 1 && argEntries[0].typeNode.kind === "object";

  // Input type
  if (singleObjectArg) {
    const inputName = `${baseName}Input`;
    lines.push(`/**`);
    lines.push(` * Input type for \`${fn.name}\``);
    lines.push(` */`);
    lines.push(renderInterface(inputName, argEntries[0].typeNode, extracted));
    lines.push("");
  } else if (argEntries.length > 1) {
    for (const entry of argEntries) {
      if (entry.typeNode.kind === "object" && Object.keys(entry.typeNode.properties || {}).length > 0) {
        const typeName = `${baseName}${toPascalCase(entry.paramName)}`;
        lines.push(renderInterface(typeName, entry.typeNode, extracted));
        lines.push("");
      }
    }
  }

  // Output type
  const outputName = `${baseName}Output`;
  if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties || {}).length > 0) {
    lines.push(`/**`);
    lines.push(` * Output type for \`${fn.name}\``);
    lines.push(` */`);
    lines.push(renderInterface(outputName, fn.returnType, extracted));
    lines.push("");
  } else {
    const retStr = typeNodeToTS(fn.returnType, extracted, baseName, undefined, 0);
    lines.push(`export type ${outputName} = ${retStr};`);
    lines.push("");
  }

  // Extracted interfaces
  const emitted = new Set<string>();
  const extractedLines: string[] = [];
  let cursor = 0;
  while (cursor < extracted.length) {
    const iface = extracted[cursor];
    cursor++;
    if (emitted.has(iface.name)) continue;
    emitted.add(iface.name);
    extractedLines.push(renderInterface(iface.name, iface.node, extracted));
    extractedLines.push("");
  }

  // Function declaration
  const funcIdent = baseName.charAt(0).toLowerCase() + baseName.slice(1);
  // Wrap return type in Promise<> for async functions
  const returnTypeStr = fn.isAsync ? `Promise<${outputName}>` : outputName;

  const result: string[] = [];
  if (extractedLines.length > 0) result.push(...extractedLines);
  result.push(...lines);

  // Generate overloads if we have multiple distinct type patterns
  if (fn.variants && fn.variants.length >= 2) {
    for (const variant of fn.variants) {
      const vExt: ExtractedInterface[] = [];
      const vRet = typeNodeToTS(variant.returnType, vExt, baseName, undefined, 0);
      const vRetStr = fn.isAsync ? `Promise<${vRet}>` : vRet;
      const vNames = variant.paramNames || fn.paramNames || [];
      let vArgEntries: Array<{ paramName: string; typeNode: TypeNode }> = [];
      if (variant.argsType.kind === "tuple") {
        vArgEntries = (variant.argsType.elements || []).map((el, i) => ({
          paramName: vNames[i] || `arg${i}`,
          typeNode: el,
        }));
      }
      const vParams = vArgEntries.map(e =>
        `${e.paramName}: ${typeNodeToTS(e.typeNode, vExt, baseName, e.paramName, 0)}`
      );
      result.push(`export declare function ${funcIdent}(${vParams.join(", ")}): ${vRetStr};`);
    }
  } else {
    let funcDecl: string;
    if (singleObjectArg) {
      funcDecl = `export declare function ${funcIdent}(input: ${baseName}Input): ${returnTypeStr};`;
    } else {
      const params = argEntries.map((entry) => {
        if (entry.typeNode.kind === "object" && Object.keys(entry.typeNode.properties || {}).length > 0) {
          return `${entry.paramName}: ${baseName}${toPascalCase(entry.paramName)}`;
        }
        // Check if parameter is optional (union with undefined)
        const { isOptional, innerType } = extractOptional(entry.typeNode);
        if (isOptional) {
          return `${entry.paramName}?: ${typeNodeToTS(innerType, extracted, baseName, entry.paramName, 0)}`;
        }
        return `${entry.paramName}: ${typeNodeToTS(entry.typeNode, extracted, baseName, entry.paramName, 0)}`;
      });
      funcDecl = `export declare function ${funcIdent}(${params.join(", ")}): ${returnTypeStr};`;
    }
    result.push(funcDecl);
  }
  return result.join("\n");
}

// ── Python stub generation ──

function typeNodeToPython(
  node: TypeNode,
  extracted: Array<{ name: string; node: TypeNode }>,
  parentName: string,
  propName: string | undefined,
): string {
  if (!node || !node.kind) return "Any";
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string": return "str";
        case "number": return "float";
        case "integer": return "int";
        case "boolean": return "bool";
        case "null":
        case "undefined": return "None";
        case "bigint": return "int";
        case "bytes": return "bytes";
        case "datetime": return "datetime";
        case "date": return "date";
        case "time": return "time";
        case "Generator": return "Iterator";
        default: return "Any";
      }
    case "unknown": return "Any";
    case "array":
      return `List[${typeNodeToPython(node.element!, extracted, parentName, propName)}]`;
    case "tuple": {
      const els = (node.elements || []).map((el, i) =>
        typeNodeToPython(el, extracted, parentName, `el${i}`),
      );
      if (els.length === 0) return "Tuple[()]";
      return `Tuple[${els.join(", ")}]`;
    }
    case "union": {
      const members = (node.members || []).map((m) =>
        typeNodeToPython(m, extracted, parentName, propName),
      );
      if (members.length === 2 && members.includes("None")) {
        const nonNone = members.find((m) => m !== "None");
        return `Optional[${nonNone}]`;
      }
      return `Union[${members.join(", ")}]`;
    }
    case "map": {
      const k = typeNodeToPython(node.key!, extracted, parentName, "key");
      const v = typeNodeToPython(node.value!, extracted, parentName, "value");
      return `Dict[${k}, ${v}]`;
    }
    case "set":
      return `Set[${typeNodeToPython(node.element!, extracted, parentName, propName)}]`;
    case "promise":
      return `Awaitable[${typeNodeToPython(node.resolved!, extracted, parentName, propName)}]`;
    case "iterator": {
      const inner = typeNodeToPython(node.element!, extracted, parentName, propName);
      const iterName = node.name === "AsyncIterator" ? "AsyncIterator" : "Iterator";
      return `${iterName}[${inner}]`;
    }
    case "function": {
      const params = (node.params || []).map((p) =>
        typeNodeToPython(p, extracted, parentName, undefined),
      );
      const ret = typeNodeToPython(node.returnType!, extracted, parentName, "return");
      return `Callable[[${params.join(", ")}], ${ret}]`;
    }
    case "object": {
      // User-defined classes and known types — use class name directly
      if (node.class_name && node.class_name !== "dict") {
        return node.class_name;
      }
      const keys = Object.keys(node.properties || {});
      if (keys.length === 0) return "Dict[str, Any]";
      // If any key is not a valid Python identifier, fall back to Dict
      if (keys.some((k) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))) {
        const valTypes = [...new Set(keys.slice(0, 4).map((k) =>
          typeNodeToPython(node.properties![k], extracted, parentName, undefined)))];
        const valT = valTypes.length === 1 ? valTypes[0] : "Any";
        return `Dict[str, ${valT}]`;
      }
      if (propName) {
        const className = toPascalCase(parentName) + toPascalCase(propName);
        if (!extracted.some((e) => e.name === className)) {
          extracted.push({ name: className, node });
        }
        return className;
      }
      return "Dict[str, Any]";
    }
    default: return "Any";
  }
}

function renderPythonTypedDict(
  name: string,
  node: TypeNode,
  extracted: Array<{ name: string; node: TypeNode }>,
): string {
  const keys = Object.keys(node.properties || {});
  const lines: string[] = [];

  // Check if we have any optional fields — if so, use total=False pattern
  const hasOptional = keys.some((key) => {
    const { isOptional } = extractOptional(node.properties![key]);
    return isOptional;
  });

  if (hasOptional) {
    // Separate required and optional fields
    const required: string[] = [];
    const optional: string[] = [];

    for (const key of keys) {
      const propType = node.properties![key];
      const { isOptional, innerType } = extractOptional(propType);
      const pyType = isOptional
        ? typeNodeToPython(innerType, extracted, name, key)
        : typeNodeToPython(propType, extracted, name, key);

      if (isOptional) {
        optional.push(`    ${toSnakeCase(key)}: ${pyType}`);
      } else {
        required.push(`    ${toSnakeCase(key)}: ${pyType}`);
      }
    }

    // Use TypedDict with total=False for optional fields
    if (required.length > 0 && optional.length > 0) {
      // Need two TypedDicts: one for required, inherit for optional
      const baseName = `_${name}Required`;
      lines.push(`class ${baseName}(TypedDict):`);
      lines.push(...required);
      lines.push("");
      lines.push("");
      lines.push(`class ${name}(${baseName}, total=False):`);
      lines.push(...optional);
    } else if (optional.length > 0) {
      lines.push(`class ${name}(TypedDict, total=False):`);
      lines.push(...optional);
    } else {
      lines.push(`class ${name}(TypedDict):`);
      lines.push(...required);
    }
  } else {
    const entries = keys.map((key) => {
      const pyType = typeNodeToPython(node.properties![key], extracted, name, key);
      return `    ${toSnakeCase(key)}: ${pyType}`;
    });

    lines.push(`class ${name}(TypedDict):`);
    if (entries.length === 0) {
      lines.push("    pass");
    } else {
      lines.push(...entries);
    }
  }
  return lines.join("\n");
}

function generatePyForFunction(fn: FunctionTypeData): string {
  const baseName = toPascalCase(fn.name);
  const extracted: Array<{ name: string; node: TypeNode }> = [];
  const sections: string[] = [];
  const paramNames = fn.paramNames || [];

  // Build parameter list for def signature
  const params: string[] = [];
  if (fn.argsType.kind === "tuple") {
    for (let i = 0; i < (fn.argsType.elements || []).length; i++) {
      const pname = paramNames[i] || `arg${i}`;
      const el = fn.argsType.elements![i];
      if (pname === "self" || pname === "cls") {
        params.push(pname);
      } else {
        const pyType = typeNodeToPython(el, extracted, baseName, pname);
        params.push(`${toSnakeCase(pname)}: ${pyType}`);
      }
    }
  }

  // Return type
  const retType = typeNodeToPython(fn.returnType, extracted, baseName, undefined);

  // Emit extracted TypedDicts before the function
  const emitted = new Set<string>();
  let cursor = 0;
  while (cursor < extracted.length) {
    const { name, node } = extracted[cursor];
    cursor++;
    if (emitted.has(name)) continue;
    emitted.add(name);
    sections.push(renderPythonTypedDict(name, node, extracted));
    sections.push("");
    sections.push("");
  }

  // Generate def signature
  const asyncPrefix = fn.isAsync ? "async " : "";
  const funcName = toSnakeCase(fn.name);
  sections.push(`${asyncPrefix}def ${funcName}(${params.join(", ")}) -> ${retType}: ...`);

  return sections.join("\n");
}

/**
 * Generate a Python class stub from observed methods.
 */
function generatePyClassStub(clsName: string, methods: FunctionTypeData[]): string {
  const extracted: Array<{ name: string; node: TypeNode }> = [];
  const methodLines: string[] = [];

  for (const fn of methods) {
    const methodName = fn.name.includes(".") ? fn.name.split(".", 2)[1] : fn.name;
    const paramNames = fn.paramNames || [];

    // Detect method kind from first parameter
    let decorator = "";
    let skipFirst = false;
    if (paramNames.length > 0 && paramNames[0] === "cls") {
      decorator = "    @classmethod\n";
      skipFirst = false; // keep cls in signature
    } else if (paramNames.length > 0 && paramNames[0] === "self") {
      skipFirst = false; // keep self in signature
    } else {
      decorator = "    @staticmethod\n";
    }

    // Build parameter list
    const params: string[] = [];
    if (fn.argsType.kind === "tuple") {
      for (let i = 0; i < (fn.argsType.elements || []).length; i++) {
        const pname = paramNames[i] || `arg${i}`;
        const el = fn.argsType.elements![i];
        if (pname === "self" || pname === "cls") {
          params.push(pname);
        } else {
          const pyType = typeNodeToPython(el, extracted, toPascalCase(clsName), pname);
          params.push(`${toSnakeCase(pname)}: ${pyType}`);
        }
      }
    }

    const retType = typeNodeToPython(fn.returnType, extracted, toPascalCase(clsName), undefined);
    const asyncPrefix = fn.isAsync ? "async " : "";
    methodLines.push(`${decorator}    ${asyncPrefix}def ${toSnakeCase(methodName)}(${params.join(", ")}) -> ${retType}: ...`);
  }

  // Emit extracted TypedDicts before the class
  const preSections: string[] = [];
  const emitted = new Set<string>();
  let cursor = 0;
  while (cursor < extracted.length) {
    const { name, node } = extracted[cursor];
    cursor++;
    if (emitted.has(name)) continue;
    emitted.add(name);
    preSections.push(renderPythonTypedDict(name, node, extracted));
    preSections.push("");
    preSections.push("");
  }

  const classBody = methodLines.length > 0 ? methodLines.join("\n") : "    ...";
  const classBlock = `class ${clsName}:\n${classBody}`;

  return [...preSections, classBlock].join("\n");
}

// ── Public API ──

/**
 * Generate type stubs from a .trickle/observations.jsonl file.
 * Returns { ts, python } content strings, grouped by module.
 */
export function generateFromJsonl(jsonlPath: string): Record<string, { ts: string; python: string }> {
  const functions = readObservations(jsonlPath);
  if (functions.length === 0) return {};

  // Group by module
  const byModule = new Map<string, FunctionTypeData[]>();
  for (const fn of functions) {
    const mod = fn.module || "_default";
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(fn);
  }

  const result: Record<string, { ts: string; python: string }> = {};

  for (const [mod, fns] of byModule) {
    // TypeScript
    const tsSections: string[] = [
      "// Auto-generated by trickle from runtime type observations (local mode)",
      `// Generated at ${new Date().toISOString()}`,
      "// Do not edit manually — re-run your code with trickle to update",
      "",
    ];
    for (const fn of fns) {
      tsSections.push(generateTsForFunction(fn));
      tsSections.push("");
    }

    // Python — group class methods together
    const pySections: string[] = [
      "# Auto-generated by trickle from runtime type observations (local mode)",
      `# Generated at ${new Date().toISOString()}`,
      "# Do not edit manually — re-run your code with trickle to update",
      "",
      "from typing import Any, Awaitable, Callable, ContextManager, Dict, List, Optional, Set, Tuple, TypedDict, Union, overload",
      "",
      "",
    ];

    // Separate class methods from standalone functions
    const classMethods = new Map<string, FunctionTypeData[]>();
    const standaloneFns: FunctionTypeData[] = [];
    for (const fn of fns) {
      if (fn.name.includes(".")) {
        const clsName = fn.name.split(".")[0];
        if (!classMethods.has(clsName)) classMethods.set(clsName, []);
        classMethods.get(clsName)!.push(fn);
      } else {
        standaloneFns.push(fn);
      }
    }

    // Generate class stubs
    for (const [clsName, methods] of classMethods) {
      pySections.push(generatePyClassStub(clsName, methods));
      pySections.push("");
      pySections.push("");
    }

    // Generate standalone function stubs
    for (const fn of standaloneFns) {
      pySections.push(generatePyForFunction(fn));
      pySections.push("");
      pySections.push("");
    }

    result[mod] = {
      ts: tsSections.join("\n").trimEnd() + "\n",
      python: pySections.join("\n").trimEnd() + "\n",
    };
  }

  return result;
}

/**
 * Generate sidecar type files from local observations.
 * Writes .d.ts or .pyi files next to the source file.
 */
export function generateLocalStubs(
  sourceFile: string,
  jsonlPath?: string,
): { written: string[]; functionCount: number } {
  const trickleDir = jsonlPath
    ? path.dirname(jsonlPath)
    : path.join(process.cwd(), ".trickle");
  const obsPath = jsonlPath || path.join(trickleDir, "observations.jsonl");

  const stubs = generateFromJsonl(obsPath);
  const written: string[] = [];
  let functionCount = 0;

  const ext = path.extname(sourceFile).toLowerCase();
  const isPython = ext === ".py";
  const dir = path.dirname(sourceFile);
  const baseName = path.basename(sourceFile, ext);
  const normalizedBase = baseName.replace(/[-_]/g, "").toLowerCase();

  const allFunctionsForCount = readObservations(obsPath);
  functionCount = allFunctionsForCount.length;

  for (const [mod, content] of Object.entries(stubs)) {
    const normalizedMod = mod.replace(/[-_]/g, "").toLowerCase();
    const stubExt = isPython ? ".pyi" : ".d.ts";

    // Match module name to source file name — write next to entry file
    if (normalizedMod === normalizedBase || mod === "_default") {
      const stubPath = path.join(dir, `${baseName}${stubExt}`);
      const stubContent = isPython ? content.python : content.ts;
      fs.writeFileSync(stubPath, stubContent, "utf-8");
      written.push(stubPath);
    } else {
      // Write stub next to the imported module's source file (if it exists in the same dir)
      const modFile = path.join(dir, `${mod}${ext}`);
      if (fs.existsSync(modFile)) {
        const modStubPath = path.join(dir, `${mod}${stubExt}`);
        const stubContent = isPython ? content.python : content.ts;
        fs.writeFileSync(modStubPath, stubContent, "utf-8");
        written.push(modStubPath);
      }
    }
  }

  // If no module matched but we have stubs, write them all under the source file name
  if (written.length === 0 && Object.keys(stubs).length > 0) {
    const allFunctions = readObservations(obsPath);
    functionCount = allFunctions.length;

    if (allFunctions.length > 0) {
      const stubExt = isPython ? ".pyi" : ".d.ts";
      const stubPath = path.join(dir, `${baseName}${stubExt}`);

      // Generate combined stubs for all functions (with class grouping)
      if (isPython) {
        const sections = [
          "# Auto-generated by trickle from runtime type observations (local mode)",
          `# Generated at ${new Date().toISOString()}`,
          "# Do not edit manually — re-run your code with trickle to update",
          "",
          "from typing import Any, Awaitable, Callable, ContextManager, Dict, List, Optional, Set, Tuple, TypedDict, Union, overload",
          "",
          "",
        ];
        // Group class methods vs standalone functions
        const classMethods = new Map<string, FunctionTypeData[]>();
        const standaloneFns: FunctionTypeData[] = [];
        for (const fn of allFunctions) {
          if (fn.name.includes(".")) {
            const clsName = fn.name.split(".")[0];
            if (!classMethods.has(clsName)) classMethods.set(clsName, []);
            classMethods.get(clsName)!.push(fn);
          } else {
            standaloneFns.push(fn);
          }
        }
        for (const [clsName, methods] of classMethods) {
          sections.push(generatePyClassStub(clsName, methods));
          sections.push("");
          sections.push("");
        }
        for (const fn of standaloneFns) {
          sections.push(generatePyForFunction(fn));
          sections.push("");
          sections.push("");
        }
        fs.writeFileSync(stubPath, sections.join("\n").trimEnd() + "\n", "utf-8");
      } else {
        const sections = [
          "// Auto-generated by trickle from runtime type observations (local mode)",
          `// Generated at ${new Date().toISOString()}`,
          "// Do not edit manually — re-run your code with trickle to update",
          "",
        ];
        for (const fn of allFunctions) {
          sections.push(generateTsForFunction(fn));
          sections.push("");
        }
        fs.writeFileSync(stubPath, sections.join("\n").trimEnd() + "\n", "utf-8");
      }

      written.push(stubPath);
    }
  }

  return { written, functionCount };
}
