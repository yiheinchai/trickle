import { TypeNode } from "../types";

// ── Naming helpers ──

function toPascalCase(name: string): string {
  // Sanitize route-style names like "GET /api/users/:id" → "GetApiUsersId"
  // Also handles camelCase/PascalCase input by splitting on boundaries
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")  // replace non-alphanumeric with spaces
    .replace(/([a-z])([A-Z])/g, "$1 $2")  // split camelCase: "userId" → "user Id"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")  // split acronyms: "XMLParser" → "XML Parser"
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function formatTimeAgo(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return isoDate;
  }
}

// ── TypeScript generation ──

/**
 * Accumulates extracted named interfaces so complex nested objects
 * get their own `export interface Foo { ... }` block.
 */
interface ExtractedInterface {
  name: string;
  node: Extract<TypeNode, { kind: "object" }>;
}

/**
 * Convert a TypeNode to a TypeScript type string.
 *
 * Large nested objects (>2 properties) are extracted into named interfaces
 * so the output stays readable.
 */
function typeNodeToTS(
  node: TypeNode,
  extracted: ExtractedInterface[],
  parentName: string,
  propName: string | undefined,
  indent: number,
): string {
  switch (node.kind) {
    case "primitive":
      return node.name;

    case "unknown":
      return "unknown";

    case "array": {
      const inner = typeNodeToTS(node.element, extracted, parentName, propName, indent);
      if (node.element.kind === "union" || node.element.kind === "function") {
        return `Array<${inner}>`;
      }
      return `${inner}[]`;
    }

    case "tuple": {
      const elements = node.elements.map((el, i) =>
        typeNodeToTS(el, extracted, parentName, `${propName || "el"}${i}`, indent)
      );
      return `[${elements.join(", ")}]`;
    }

    case "union": {
      const members = node.members.map((m) =>
        typeNodeToTS(m, extracted, parentName, propName, indent)
      );
      return members.join(" | ");
    }

    case "map": {
      const k = typeNodeToTS(node.key, extracted, parentName, "key", indent);
      const v = typeNodeToTS(node.value, extracted, parentName, "value", indent);
      return `Map<${k}, ${v}>`;
    }

    case "set": {
      const inner = typeNodeToTS(node.element, extracted, parentName, propName, indent);
      return `Set<${inner}>`;
    }

    case "promise": {
      const inner = typeNodeToTS(node.resolved, extracted, parentName, propName, indent);
      return `Promise<${inner}>`;
    }

    case "function": {
      const params = node.params.map((p, i) =>
        `arg${i}: ${typeNodeToTS(p, extracted, parentName, `param${i}`, indent)}`
      );
      const ret = typeNodeToTS(node.returnType, extracted, parentName, "return", indent);
      return `(${params.join(", ")}) => ${ret}`;
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return "Record<string, never>";

      // Extract large nested objects into named interfaces for readability
      if (keys.length > 2 && propName) {
        const ifaceName = toPascalCase(parentName) + toPascalCase(propName);
        // Avoid duplicate extractions
        if (!extracted.some((e) => e.name === ifaceName)) {
          extracted.push({ name: ifaceName, node });
        }
        return ifaceName;
      }

      // Inline small objects
      const pad = "  ".repeat(indent + 1);
      const closePad = "  ".repeat(indent);
      const entries = keys.map((key) => {
        const val = typeNodeToTS(node.properties[key], extracted, parentName, key, indent + 1);
        return `${pad}${key}: ${val};`;
      });
      return `{\n${entries.join("\n")}\n${closePad}}`;
    }
  }
}

/**
 * Render a named interface from an extracted object TypeNode.
 * Recursively extracts any further nested objects.
 */
function renderInterface(
  name: string,
  node: Extract<TypeNode, { kind: "object" }>,
  allExtracted: ExtractedInterface[],
): string {
  const keys = Object.keys(node.properties);
  const lines: string[] = [];

  lines.push(`export interface ${name} {`);
  for (const key of keys) {
    const val = typeNodeToTS(node.properties[key], allExtracted, name, key, 1);
    lines.push(`  ${key}: ${val};`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * Generate TypeScript definitions for a single function.
 *
 * For a function `processOrder(order)` that takes an object and returns an object:
 * ```ts
 * export interface ProcessOrderInput { id: string; customer: Customer; ... }
 * export interface ProcessOrderOutput { orderId: string; total: number; ... }
 * export declare function processOrder(order: ProcessOrderInput): ProcessOrderOutput;
 * ```
 */
export function generateFunctionTypes(
  functionName: string,
  argsType: TypeNode,
  returnType: TypeNode,
  meta?: { module?: string; env?: string; observedAt?: string },
): string {
  const baseName = toPascalCase(functionName);
  const extracted: ExtractedInterface[] = [];
  const lines: string[] = [];

  // Metadata comment
  const metaParts: string[] = [];
  if (meta?.module) metaParts.push(`${meta.module} module`);
  if (meta?.env) metaParts.push(`observed in ${meta.env}`);
  if (meta?.observedAt) metaParts.push(formatTimeAgo(meta.observedAt));
  const metaStr = metaParts.length > 0 ? ` — ${metaParts.join(", ")}` : "";

  // ── Determine argument structure ──
  // argsType is typically a tuple of the function's positional args.
  // For a single-object arg, we use that object directly as the "Input" interface.
  // For multiple args, we generate separate types and a function declaration with individual params.

  let argEntries: Array<{ paramName: string; typeNode: TypeNode }> = [];

  if (argsType.kind === "tuple") {
    argEntries = argsType.elements.map((el, i) => ({
      paramName: `arg${i}`,
      typeNode: el,
    }));
  } else if (argsType.kind === "object") {
    // Named params from Python kwargs
    for (const key of Object.keys(argsType.properties)) {
      argEntries.push({ paramName: key, typeNode: argsType.properties[key] });
    }
  } else {
    argEntries = [{ paramName: "input", typeNode: argsType }];
  }

  // ── Single-object shortcut ──
  // If there's exactly one arg and it's an object, promote it to a named interface.
  const singleObjectArg =
    argEntries.length === 1 && argEntries[0].typeNode.kind === "object";

  // ── Generate input type(s) ──

  if (singleObjectArg) {
    const inputName = `${baseName}Input`;
    const objNode = argEntries[0].typeNode as Extract<TypeNode, { kind: "object" }>;

    // Extract nested objects from within the input
    const inputBody = renderInterface(inputName, objNode, extracted);

    lines.push(`/**`);
    lines.push(` * Input type for \`${functionName}\`${metaStr}`);
    lines.push(` */`);
    lines.push(inputBody);
    lines.push("");
  } else if (argEntries.length > 1) {
    // Multiple args — generate a type for each non-primitive arg
    for (let i = 0; i < argEntries.length; i++) {
      const entry = argEntries[i];
      if (entry.typeNode.kind === "object" && Object.keys(entry.typeNode.properties).length > 0) {
        const typeName = `${baseName}${toPascalCase(entry.paramName)}`;
        const body = renderInterface(typeName, entry.typeNode as Extract<TypeNode, { kind: "object" }>, extracted);
        lines.push(body);
        lines.push("");
      }
    }
  }

  // ── Generate output type ──

  const outputName = `${baseName}Output`;

  if (returnType.kind === "object" && Object.keys(returnType.properties).length > 0) {
    const outputBody = renderInterface(outputName, returnType as Extract<TypeNode, { kind: "object" }>, extracted);
    lines.push(`/**`);
    lines.push(` * Output type for \`${functionName}\`${metaStr}`);
    lines.push(` */`);
    lines.push(outputBody);
    lines.push("");
  } else {
    const retStr = typeNodeToTS(returnType, extracted, baseName, undefined, 0);
    lines.push(`/**`);
    lines.push(` * Output type for \`${functionName}\`${metaStr}`);
    lines.push(` */`);
    lines.push(`export type ${outputName} = ${retStr};`);
    lines.push("");
  }

  // ── Emit extracted interfaces (dependencies) ──
  // Process in order: render each, which may add more extractions.
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

  // ── Build function declaration ──

  // Use camelCase version of baseName for function declaration identifier
  const funcIdent = baseName.charAt(0).toLowerCase() + baseName.slice(1);

  let funcDecl: string;
  if (singleObjectArg) {
    const inputName = `${baseName}Input`;
    funcDecl = `export declare function ${funcIdent}(input: ${inputName}): ${outputName};`;
  } else {
    // Build param list with proper types
    const params = argEntries.map((entry) => {
      if (entry.typeNode.kind === "object" && Object.keys(entry.typeNode.properties).length > 0) {
        return `${entry.paramName}: ${baseName}${toPascalCase(entry.paramName)}`;
      }
      return `${entry.paramName}: ${typeNodeToTS(entry.typeNode, extracted, baseName, entry.paramName, 0)}`;
    });
    funcDecl = `export declare function ${funcIdent}(${params.join(", ")}): ${outputName};`;
  }

  // ── Assemble output ──
  // Order: extracted interfaces → input → output → function declaration

  const result: string[] = [];
  if (extractedLines.length > 0) {
    result.push(...extractedLines);
  }
  result.push(...lines);
  result.push(funcDecl);

  return result.join("\n");
}

/**
 * Generate a complete TypeScript declarations file for all functions.
 */
export function generateAllTypes(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const sections: string[] = [];

  sections.push("// Auto-generated by trickle from runtime type observations");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen` to update");
  sections.push("");

  for (const fn of functions) {
    sections.push(
      generateFunctionTypes(fn.name, fn.argsType, fn.returnType, {
        module: fn.module,
        env: fn.env,
        observedAt: fn.observedAt,
      }),
    );
    sections.push("");
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── Python stub generation ──

function typeNodeToPython(
  node: TypeNode,
  extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
  parentName: string,
  propName: string | undefined,
  depth: number,
): string {
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string":    return "str";
        case "number":    return "float";
        case "boolean":   return "bool";
        case "null":      return "None";
        case "undefined": return "None";
        case "bigint":    return "int";
        case "symbol":    return "str";
        default:          return "Any";
      }

    case "unknown":
      return "Any";

    case "array": {
      const inner = typeNodeToPython(node.element, extracted, parentName, propName, depth + 1);
      return `List[${inner}]`;
    }

    case "tuple": {
      const elements = node.elements.map((el, i) =>
        typeNodeToPython(el, extracted, parentName, `el${i}`, depth + 1)
      );
      return `Tuple[${elements.join(", ")}]`;
    }

    case "union": {
      const members = node.members.map((m) =>
        typeNodeToPython(m, extracted, parentName, propName, depth + 1)
      );
      if (members.length === 2 && members.includes("None")) {
        const nonNone = members.find((m) => m !== "None");
        return `Optional[${nonNone}]`;
      }
      return `Union[${members.join(", ")}]`;
    }

    case "map": {
      const k = typeNodeToPython(node.key, extracted, parentName, "key", depth + 1);
      const v = typeNodeToPython(node.value, extracted, parentName, "value", depth + 1);
      return `Dict[${k}, ${v}]`;
    }

    case "set": {
      const inner = typeNodeToPython(node.element, extracted, parentName, propName, depth + 1);
      return `Set[${inner}]`;
    }

    case "promise": {
      const inner = typeNodeToPython(node.resolved, extracted, parentName, propName, depth + 1);
      return `Awaitable[${inner}]`;
    }

    case "function": {
      const params = node.params.map((p) =>
        typeNodeToPython(p, extracted, parentName, undefined, depth + 1)
      );
      const ret = typeNodeToPython(node.returnType, extracted, parentName, "return", depth + 1);
      return `Callable[[${params.join(", ")}], ${ret}]`;
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return "Dict[str, Any]";

      // Always extract objects as named TypedDicts
      if (propName) {
        const className = toPascalCase(parentName) + toPascalCase(propName);
        if (!extracted.some((e) => e.name === className)) {
          extracted.push({ name: className, node });
        }
        return className;
      }
      return "Dict[str, Any]";
    }
  }
}

function renderPythonTypedDict(
  name: string,
  node: Extract<TypeNode, { kind: "object" }>,
  extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
): string {
  const keys = Object.keys(node.properties);
  const innerExtracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
  const lines: string[] = [];

  const entries = keys.map((key) => {
    const pyType = typeNodeToPython(node.properties[key], innerExtracted, name, key, 1);
    return `    ${toSnakeCase(key)}: ${pyType}`;
  });

  // Emit nested TypedDicts first
  for (const iface of innerExtracted) {
    lines.push(renderPythonTypedDict(iface.name, iface.node, innerExtracted));
    lines.push("");
    lines.push("");
  }

  lines.push(`class ${name}(TypedDict):`);
  if (entries.length === 0) {
    lines.push("    pass");
  } else {
    lines.push(...entries);
  }
  return lines.join("\n");
}

export function generatePythonTypes(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const sections: string[] = [];

  sections.push("# Auto-generated by trickle from runtime type observations");
  sections.push(`# Generated at ${new Date().toISOString()}`);
  sections.push("# Do not edit manually — re-run `trickle codegen --python` to update");
  sections.push("");
  sections.push("from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple, TypedDict, Union");
  sections.push("");
  sections.push("");

  for (const fn of functions) {
    const baseName = toPascalCase(fn.name);
    const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];

    // Meta comment
    const metaParts: string[] = [];
    if (fn.module) metaParts.push(`${fn.module} module`);
    if (fn.env) metaParts.push(`observed in ${fn.env}`);
    if (fn.observedAt) metaParts.push(formatTimeAgo(fn.observedAt));
    if (metaParts.length > 0) {
      sections.push(`# ${baseName} — ${metaParts.join(", ")}`);
    }

    // Input type
    if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1 && fn.argsType.elements[0].kind === "object") {
      // Single-object arg: use it directly
      sections.push(renderPythonTypedDict(`${baseName}Input`, fn.argsType.elements[0] as Extract<TypeNode, { kind: "object" }>, extracted));
    } else if (fn.argsType.kind === "object") {
      sections.push(renderPythonTypedDict(`${baseName}Input`, fn.argsType as Extract<TypeNode, { kind: "object" }>, extracted));
    } else if (fn.argsType.kind === "tuple") {
      // Multiple args — create a TypedDict with param names
      const fakeObj: Extract<TypeNode, { kind: "object" }> = { kind: "object", properties: {} };
      fn.argsType.elements.forEach((el, i) => {
        fakeObj.properties[`arg${i}`] = el;
      });
      sections.push(renderPythonTypedDict(`${baseName}Args`, fakeObj, extracted));
    } else {
      const pyType = typeNodeToPython(fn.argsType, extracted, baseName, undefined, 0);
      sections.push(`${baseName}Input = ${pyType}`);
    }
    sections.push("");
    sections.push("");

    // Output type
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      sections.push(renderPythonTypedDict(`${baseName}Output`, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
    } else {
      const pyType = typeNodeToPython(fn.returnType, extracted, baseName, undefined, 0);
      sections.push(`${baseName}Output = ${pyType}`);
    }

    // Emit extracted TypedDicts that were accumulated
    const emitted = new Set<string>();
    const pendingExtracted: string[] = [];
    for (const iface of extracted) {
      if (emitted.has(iface.name)) continue;
      emitted.add(iface.name);
      pendingExtracted.push("");
      pendingExtracted.push("");
      pendingExtracted.push(renderPythonTypedDict(iface.name, iface.node, extracted));
    }
    // Insert extracted defs before the last output (they need to be defined first)
    // Actually, since Python TypedDicts reference forward, just append
    if (pendingExtracted.length > 0) {
      // Re-order: put extracted before the Input/Output that reference them
      // For simplicity, just include them — Python TypedDict forward refs work with __future__.annotations
    }

    sections.push("");
    sections.push("");
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── Typed API client generation ──

interface ParsedRoute {
  method: string;       // GET, POST, PUT, DELETE, PATCH
  path: string;         // /api/users/:id
  pathParams: string[]; // ["id"]
  funcName: string;     // camelCase: getApiUsersById
  typeName: string;     // PascalCase: GetApiUsersById
}

function parseRouteName(name: string): ParsedRoute | null {
  const match = name.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
  if (!match) return null;

  const method = match[1].toUpperCase();
  const path = match[2];

  // Extract path params like :id, :userId
  const pathParams: string[] = [];
  path.replace(/:(\w+)/g, (_, param) => {
    pathParams.push(param);
    return _;
  });

  const typeName = toPascalCase(name);
  // For camelCase: lowercase the HTTP method prefix (e.g., GETApiUsers → getApiUsers)
  const methodLower = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const pathPart = toPascalCase(path);
  const funcName = method.toLowerCase() + pathPart;

  return { method, path, pathParams, funcName, typeName };
}

function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Generate a fully-typed fetch-based API client from runtime-observed routes.
 *
 * Output is a single TypeScript file with:
 * - All request/response interfaces
 * - A `createTrickleClient(baseUrl)` factory that returns typed fetch wrappers
 * - Proper path parameter substitution
 * - Request body typing for POST/PUT/PATCH
 */
export function generateApiClient(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  // Filter to route-style functions only
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express/FastAPI app to generate a typed client.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated typed API client by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --client` to update");
  sections.push("");

  // Generate interfaces for each route
  const extracted: ExtractedInterface[] = [];

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;

    // --- Input types (only for methods with body) ---
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      // argsType is typically an object with { body, params, query } from Express instrumentation
      if (fn.argsType.kind === "object") {
        const bodyNode = fn.argsType.properties["body"];
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          const inputName = `${baseName}Input`;
          sections.push(renderInterface(inputName, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
          sections.push("");
        }
      } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
        const el = fn.argsType.elements[0];
        if (el.kind === "object") {
          const bodyNode = el.properties["body"];
          if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
            const inputName = `${baseName}Input`;
            sections.push(renderInterface(inputName, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
            sections.push("");
          }
        }
      }
    }

    // --- Path params type (if route has :params) ---
    if (parsed.pathParams.length > 0) {
      // Try to extract from argsType.properties.params
      let paramsNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["params"]) {
        paramsNode = fn.argsType.properties["params"];
      }
      // Only generate if we have object-typed params
      if (paramsNode && paramsNode.kind === "object" && Object.keys(paramsNode.properties).length > 0) {
        const paramsName = `${baseName}Params`;
        sections.push(renderInterface(paramsName, paramsNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
      }
    }

    // --- Query params type ---
    if (fn.argsType.kind === "object" && fn.argsType.properties["query"]) {
      const queryNode = fn.argsType.properties["query"];
      if (queryNode.kind === "object" && Object.keys(queryNode.properties).length > 0) {
        const queryName = `${baseName}Query`;
        sections.push(renderInterface(queryName, queryNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
      }
    }

    // --- Output type ---
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      const outputName = `${baseName}Output`;
      sections.push(renderInterface(outputName, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
      sections.push("");
    } else {
      const outputName = `${baseName}Output`;
      const retStr = typeNodeToTS(fn.returnType, extracted, baseName, undefined, 0);
      sections.push(`export type ${outputName} = ${retStr};`);
      sections.push("");
    }
  }

  // Emit extracted sub-interfaces
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

  if (extractedLines.length > 0) {
    // Insert extracted interfaces before the main interfaces
    sections.splice(4, 0, ...extractedLines);
  }

  // --- Generate the client factory ---
  sections.push("// ── API Client ──");
  sections.push("");
  sections.push("export function createTrickleClient(baseUrl: string) {");
  sections.push("  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {");
  sections.push("    const url = new URL(path, baseUrl);");
  sections.push("    if (query) { for (const [k, v] of Object.entries(query)) { if (v !== undefined) url.searchParams.set(k, v); } }");
  sections.push("    const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };");
  sections.push("    if (body !== undefined) opts.body = JSON.stringify(body);");
  sections.push("    const res = await fetch(url.toString(), opts);");
  sections.push("    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);");
  sections.push("    return res.json() as Promise<T>;");
  sections.push("  }");
  sections.push("");
  sections.push("  return {");

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;
    const outputType = `${baseName}Output`;
    const hasBody = ["POST", "PUT", "PATCH"].includes(parsed.method);

    // Determine if we have a typed input
    let hasInputType = false;
    if (hasBody && fn.argsType.kind === "object") {
      const bodyNode = fn.argsType.properties["body"];
      hasInputType = !!(bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0);
    }

    // Build path expression with template literals for path params
    let pathExpr: string;
    if (parsed.pathParams.length > 0) {
      pathExpr = "`" + parsed.path.replace(/:(\w+)/g, (_, param) => `\${${toCamelCase(param)}}`) + "`";
    } else {
      pathExpr = `"${parsed.path}"`;
    }

    // Build method signature
    const params: string[] = [];
    if (parsed.pathParams.length > 0) {
      for (const p of parsed.pathParams) {
        params.push(`${toCamelCase(p)}: string`);
      }
    }
    if (hasInputType) {
      params.push(`input: ${baseName}Input`);
    }

    const bodyArg = hasInputType ? "input" : "undefined";
    const paramStr = params.length > 0 ? params.join(", ") : "";

    // Generate JSDoc comment
    sections.push(`    /** ${parsed.method} ${parsed.path} */`);
    sections.push(`    ${parsed.funcName}: (${paramStr}): Promise<${outputType}> =>`);
    sections.push(`      request<${outputType}>("${parsed.method}", ${pathExpr}, ${bodyArg}),`);
    sections.push("");
  }

  sections.push("  };");
  sections.push("}");
  sections.push("");
  sections.push("export type TrickleClient = ReturnType<typeof createTrickleClient>;");

  return sections.join("\n").trimEnd() + "\n";
}

// ── OpenAPI spec generation ──

/**
 * Convert a TypeNode to a JSON Schema object.
 */
function typeNodeToJsonSchema(
  node: TypeNode,
  defs: Record<string, object>,
  parentName: string,
  propName: string | undefined,
): object {
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string":    return { type: "string" };
        case "number":    return { type: "number" };
        case "boolean":   return { type: "boolean" };
        case "null":      return { type: "string", nullable: true };
        case "undefined": return { type: "string", nullable: true };
        case "bigint":    return { type: "integer", format: "int64" };
        case "symbol":    return { type: "string" };
        default:          return {};
      }

    case "unknown":
      return {};

    case "array":
      return {
        type: "array",
        items: typeNodeToJsonSchema(node.element, defs, parentName, propName),
      };

    case "tuple":
      return {
        type: "array",
        items: node.elements.length > 0
          ? typeNodeToJsonSchema(node.elements[0], defs, parentName, propName)
          : {},
        minItems: node.elements.length,
        maxItems: node.elements.length,
      };

    case "union": {
      const schemas = node.members.map((m) =>
        typeNodeToJsonSchema(m, defs, parentName, propName)
      );
      // Simplify nullable unions: { type: "string" } | null → nullable string
      const nonNull = schemas.filter(
        (s) => !("nullable" in s && (s as Record<string, unknown>).nullable === true),
      );
      if (nonNull.length === 1 && nonNull.length < schemas.length) {
        return { ...nonNull[0], nullable: true };
      }
      return { oneOf: schemas };
    }

    case "map":
      return {
        type: "object",
        additionalProperties: typeNodeToJsonSchema(node.value, defs, parentName, propName),
      };

    case "set":
      return {
        type: "array",
        items: typeNodeToJsonSchema(node.element, defs, parentName, propName),
        uniqueItems: true,
      };

    case "promise":
      return typeNodeToJsonSchema(node.resolved, defs, parentName, propName);

    case "function":
      return { type: "object", description: "function" };

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return { type: "object" };

      // Extract complex objects as $ref to keep schemas readable
      if (keys.length > 2 && propName) {
        const schemaName = toPascalCase(parentName) + toPascalCase(propName);
        if (!defs[schemaName]) {
          // Placeholder to prevent infinite recursion
          defs[schemaName] = {};
          const properties: Record<string, object> = {};
          const required: string[] = [];
          for (const key of keys) {
            properties[key] = typeNodeToJsonSchema(node.properties[key], defs, schemaName, key);
            required.push(key);
          }
          defs[schemaName] = { type: "object", properties, required };
        }
        return { $ref: `#/components/schemas/${schemaName}` };
      }

      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const key of keys) {
        properties[key] = typeNodeToJsonSchema(node.properties[key], defs, parentName, key);
        required.push(key);
      }
      return { type: "object", properties, required };
    }
  }
}

/**
 * Generate an OpenAPI 3.0 specification from runtime-observed route types.
 */
export function generateOpenApiSpec(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
  options?: { title?: string; version?: string; serverUrl?: string },
): object {
  const title = options?.title || "API";
  const version = options?.version || "1.0.0";
  const paths: Record<string, Record<string, object>> = {};
  const schemas: Record<string, object> = {};

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (!parsed) continue;

    const method = parsed.method.toLowerCase();
    const baseName = parsed.typeName;

    // Convert Express :param to OpenAPI {param}
    const openApiPath = parsed.path.replace(/:(\w+)/g, "{$1}");

    // Build response schema
    const responseDefs: Record<string, object> = {};
    const responseSchema = typeNodeToJsonSchema(fn.returnType, responseDefs, baseName + "Output", undefined);
    Object.assign(schemas, responseDefs);

    // If response is a complex object, extract to a named schema
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      const responseSchemaName = `${baseName}Response`;
      schemas[responseSchemaName] = responseSchema;
    }

    const responseRef = fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0
      ? { $ref: `#/components/schemas/${baseName}Response` }
      : responseSchema;

    // Build operation object
    const operation: Record<string, unknown> = {
      operationId: parsed.funcName,
      summary: `${parsed.method} ${parsed.path}`,
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: responseRef,
            },
          },
        },
      },
    };

    // Add path parameters
    if (parsed.pathParams.length > 0) {
      operation.parameters = parsed.pathParams.map((param) => ({
        name: param,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }

    // Add query parameters from argsType
    if (fn.argsType.kind === "object" && fn.argsType.properties["query"]) {
      const queryNode = fn.argsType.properties["query"];
      if (queryNode.kind === "object") {
        const queryParams = Object.keys(queryNode.properties).map((param) => {
          const paramSchema = typeNodeToJsonSchema(queryNode.properties[param], schemas, baseName, param);
          return {
            name: param,
            in: "query" as const,
            required: false,
            schema: paramSchema,
          };
        });
        const existing = (operation.parameters as Array<object>) || [];
        operation.parameters = [...existing, ...queryParams];
      }
    }

    // Add request body for POST/PUT/PATCH
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      let bodyNode: TypeNode | undefined;

      if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
        bodyNode = fn.argsType.properties["body"];
      } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
        const el = fn.argsType.elements[0];
        if (el.kind === "object" && el.properties["body"]) {
          bodyNode = el.properties["body"];
        }
      }

      if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
        const bodyDefs: Record<string, object> = {};
        const bodySchema = typeNodeToJsonSchema(bodyNode, bodyDefs, baseName + "Request", undefined);
        Object.assign(schemas, bodyDefs);

        const requestSchemaName = `${baseName}Request`;
        schemas[requestSchemaName] = bodySchema;

        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${requestSchemaName}` },
            },
          },
        };
      }
    }

    // Add tags based on path prefix
    const pathParts = parsed.path.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      operation.tags = [pathParts[1]]; // e.g., /api/users → "users" tag would be pathParts[1]
      // But /api is the first meaningful segment, so use the one after /api
      if (pathParts[0] === "api" && pathParts.length >= 2) {
        operation.tags = [pathParts[1]];
      }
    }

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }
    paths[openApiPath][method] = operation;
  }

  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title, version },
    paths,
  };

  if (Object.keys(schemas).length > 0) {
    spec.components = { schemas };
  }

  if (options?.serverUrl) {
    spec.servers = [{ url: options.serverUrl }];
  }

  return spec;
}

// ── Express handler type generation ──

/**
 * Generate typed Express handler type aliases from runtime-observed routes.
 *
 * For each route like `GET /api/users/:id`, produces:
 * - `GetApiUsersIdHandler` — a fully typed `RequestHandler` with
 *   `Request<Params, ResBody, ReqBody, Query>` and `Response<ResBody>`
 *
 * Developers can use these to type their route handlers:
 *   app.get('/api/users/:id', ((req, res) => { ... }) as GetApiUsersIdHandler);
 */
export function generateHandlerTypes(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  // Filter to route-style functions only
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express app to generate handler types.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated Express handler types by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --handlers` to update");
  sections.push("");
  sections.push('import { Request, Response, NextFunction } from "express";');
  sections.push("");

  const extracted: ExtractedInterface[] = [];

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;

    // --- Params type ---
    let paramsType = "Record<string, string>";
    if (parsed.pathParams.length > 0) {
      const paramsName = `${baseName}Params`;
      // Check if we have observed param types
      let paramsNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["params"]) {
        paramsNode = fn.argsType.properties["params"];
      }
      if (paramsNode && paramsNode.kind === "object" && Object.keys(paramsNode.properties).length > 0) {
        sections.push(renderInterface(paramsName, paramsNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
      } else {
        // Generate from path params — all strings
        const props: string[] = parsed.pathParams.map(p => `  ${p}: string;`);
        sections.push(`export interface ${paramsName} {`);
        sections.push(...props);
        sections.push("}");
        sections.push("");
      }
      paramsType = paramsName;
    }

    // --- Response body type ---
    let resBodyType = "unknown";
    const resBodyName = `${baseName}ResBody`;
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      sections.push(renderInterface(resBodyName, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
      sections.push("");
      resBodyType = resBodyName;
    } else {
      const retStr = typeNodeToTS(fn.returnType, extracted, baseName, undefined, 0);
      sections.push(`export type ${resBodyName} = ${retStr};`);
      sections.push("");
      resBodyType = resBodyName;
    }

    // --- Request body type ---
    let reqBodyType = "unknown";
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      let bodyNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
        bodyNode = fn.argsType.properties["body"];
      } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
        const el = fn.argsType.elements[0];
        if (el.kind === "object" && el.properties["body"]) {
          bodyNode = el.properties["body"];
        }
      }
      if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
        const reqBodyName = `${baseName}ReqBody`;
        sections.push(renderInterface(reqBodyName, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
        reqBodyType = reqBodyName;
      }
    }

    // --- Query type ---
    let queryType = "qs.ParsedQs";
    if (fn.argsType.kind === "object" && fn.argsType.properties["query"]) {
      const queryNode = fn.argsType.properties["query"];
      if (queryNode.kind === "object" && Object.keys(queryNode.properties).length > 0) {
        const queryName = `${baseName}Query`;
        sections.push(renderInterface(queryName, queryNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
        queryType = queryName;
      }
    }

    // --- Handler type alias ---
    sections.push(`/** ${parsed.method} ${parsed.path} */`);
    sections.push(
      `export type ${baseName}Handler = (` +
      `req: Request<${paramsType}, ${resBodyType}, ${reqBodyType}, ${queryType}>, ` +
      `res: Response<${resBodyType}>, ` +
      `next: NextFunction` +
      `) => void;`,
    );
    sections.push("");
  }

  // Emit extracted sub-interfaces
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

  if (extractedLines.length > 0) {
    // Insert after the import line (index 4 = after the blank line after import)
    sections.splice(5, 0, ...extractedLines);
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── Zod schema generation ──

/**
 * Convert a TypeNode to a Zod schema expression string.
 */
function typeNodeToZod(node: TypeNode, indent: number): string {
  const pad = "  ".repeat(indent);
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string":    return "z.string()";
        case "number":    return "z.number()";
        case "boolean":   return "z.boolean()";
        case "null":      return "z.null()";
        case "undefined": return "z.undefined()";
        case "bigint":    return "z.bigint()";
        case "symbol":    return "z.symbol()";
        default:          return "z.unknown()";
      }

    case "unknown":
      return "z.unknown()";

    case "array":
      return `z.array(${typeNodeToZod(node.element, indent)})`;

    case "tuple": {
      if (node.elements.length === 0) return "z.tuple([])";
      const els = node.elements.map((el) => typeNodeToZod(el, indent));
      return `z.tuple([${els.join(", ")}])`;
    }

    case "union": {
      const members = node.members.map((m) => typeNodeToZod(m, indent));
      if (members.length === 1) return members[0];
      return `z.union([${members.join(", ")}])`;
    }

    case "map": {
      return `z.map(${typeNodeToZod(node.key, indent)}, ${typeNodeToZod(node.value, indent)})`;
    }

    case "set": {
      return `z.set(${typeNodeToZod(node.element, indent)})`;
    }

    case "promise": {
      return `z.promise(${typeNodeToZod(node.resolved, indent)})`;
    }

    case "function": {
      return "z.function()";
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return "z.object({})";

      const innerPad = "  ".repeat(indent + 1);
      const entries = keys.map((key) => {
        const val = typeNodeToZod(node.properties[key], indent + 1);
        return `${innerPad}${key}: ${val},`;
      });
      return `z.object({\n${entries.join("\n")}\n${pad}})`;
    }
  }
}

/**
 * Generate Zod validation schemas from runtime-observed types.
 *
 * For each function/route, generates a named Zod schema that can be used for:
 * - Runtime validation of API inputs/outputs
 * - TypeScript type inference via `z.infer<typeof schema>`
 * - Form validation, config parsing, etc.
 */
export function generateZodSchemas(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  if (functions.length === 0) {
    return "// No functions found. Instrument your app to generate Zod schemas.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated Zod schemas by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --zod` to update");
  sections.push("");
  sections.push('import { z } from "zod";');
  sections.push("");

  // Check if any are route-style functions
  const hasRoutes = functions.some((fn) => parseRouteName(fn.name) !== null);

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);

    if (parsed) {
      // Route-style: generate Input/Output schemas
      const baseName = toCamelCase(parsed.typeName);
      const BaseNamePascal = parsed.typeName;

      // --- Response schema ---
      sections.push(`/** ${parsed.method} ${parsed.path} — response */`);
      sections.push(`export const ${baseName}ResponseSchema = ${typeNodeToZod(fn.returnType, 0)};`);
      sections.push(`export type ${BaseNamePascal}Response = z.infer<typeof ${baseName}ResponseSchema>;`);
      sections.push("");

      // --- Request body schema (for POST/PUT/PATCH) ---
      if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
          bodyNode = fn.argsType.properties["body"];
        } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
          const el = fn.argsType.elements[0];
          if (el.kind === "object" && el.properties["body"]) {
            bodyNode = el.properties["body"];
          }
        }
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          sections.push(`/** ${parsed.method} ${parsed.path} — request body */`);
          sections.push(`export const ${baseName}RequestSchema = ${typeNodeToZod(bodyNode, 0)};`);
          sections.push(`export type ${BaseNamePascal}Request = z.infer<typeof ${baseName}RequestSchema>;`);
          sections.push("");
        }
      }

      // --- Path params schema (if route has :params) ---
      if (parsed.pathParams.length > 0) {
        let paramsNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["params"]) {
          paramsNode = fn.argsType.properties["params"];
        }
        if (paramsNode && paramsNode.kind === "object" && Object.keys(paramsNode.properties).length > 0) {
          sections.push(`/** ${parsed.method} ${parsed.path} — path params */`);
          sections.push(`export const ${baseName}ParamsSchema = ${typeNodeToZod(paramsNode, 0)};`);
          sections.push(`export type ${BaseNamePascal}Params = z.infer<typeof ${baseName}ParamsSchema>;`);
          sections.push("");
        }
      }

      // --- Query params schema ---
      if (fn.argsType.kind === "object" && fn.argsType.properties["query"]) {
        const queryNode = fn.argsType.properties["query"];
        if (queryNode.kind === "object" && Object.keys(queryNode.properties).length > 0) {
          sections.push(`/** ${parsed.method} ${parsed.path} — query params */`);
          sections.push(`export const ${baseName}QuerySchema = ${typeNodeToZod(queryNode, 0)};`);
          sections.push(`export type ${BaseNamePascal}Query = z.infer<typeof ${baseName}QuerySchema>;`);
          sections.push("");
        }
      }
    } else {
      // Non-route function: generate Input/Output schemas
      const baseName = toCamelCase(toPascalCase(fn.name));
      const BaseNamePascal = toPascalCase(fn.name);

      // Input schema
      if (fn.argsType.kind !== "unknown") {
        sections.push(`/** ${fn.name} — input */`);
        if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
          sections.push(`export const ${baseName}InputSchema = ${typeNodeToZod(fn.argsType.elements[0], 0)};`);
        } else {
          sections.push(`export const ${baseName}InputSchema = ${typeNodeToZod(fn.argsType, 0)};`);
        }
        sections.push(`export type ${BaseNamePascal}Input = z.infer<typeof ${baseName}InputSchema>;`);
        sections.push("");
      }

      // Output schema
      sections.push(`/** ${fn.name} — output */`);
      sections.push(`export const ${baseName}OutputSchema = ${typeNodeToZod(fn.returnType, 0)};`);
      sections.push(`export type ${BaseNamePascal}Output = z.infer<typeof ${baseName}OutputSchema>;`);
      sections.push("");
    }
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── React Query hooks generation ──

/**
 * Generate fully-typed TanStack Query (React Query) hooks from runtime-observed routes.
 *
 * For each route:
 * - GET → useQuery hook with typed response and query keys
 * - POST/PUT/PATCH/DELETE → useMutation hook with typed input/output
 * - Query key factory for cache invalidation
 * - All request/response interfaces included
 */
export function generateReactQueryHooks(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  // Filter to route-style functions only
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express/FastAPI app to generate React Query hooks.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated React Query hooks by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --react-query` to update");
  sections.push("");
  sections.push('import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";');
  sections.push('import type { UseQueryOptions, UseMutationOptions } from "@tanstack/react-query";');
  sections.push("");

  // --- Generate interfaces ---
  const extracted: ExtractedInterface[] = [];

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;

    // Response type
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      sections.push(renderInterface(`${baseName}Response`, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
      sections.push("");
    } else {
      const retStr = typeNodeToTS(fn.returnType, extracted, baseName, undefined, 0);
      sections.push(`export type ${baseName}Response = ${retStr};`);
      sections.push("");
    }

    // Request body type (POST/PUT/PATCH)
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      let bodyNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
        bodyNode = fn.argsType.properties["body"];
      } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
        const el = fn.argsType.elements[0];
        if (el.kind === "object" && el.properties["body"]) {
          bodyNode = el.properties["body"];
        }
      }
      if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
        sections.push(renderInterface(`${baseName}Input`, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
      }
    }
  }

  // Emit extracted sub-interfaces
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
  if (extractedLines.length > 0) {
    sections.push(...extractedLines);
  }

  // --- Internal fetch helper ---
  sections.push("// ── Internal fetch helper ──");
  sections.push("");
  sections.push("let _baseUrl = \"\";");
  sections.push("");
  sections.push("/** Set the base URL for all API requests. Call once at app startup. */");
  sections.push("export function configureTrickleHooks(baseUrl: string) {");
  sections.push("  _baseUrl = baseUrl;");
  sections.push("}");
  sections.push("");
  sections.push("async function _fetch<T>(method: string, path: string, body?: unknown): Promise<T> {");
  sections.push("  const opts: RequestInit = { method, headers: { \"Content-Type\": \"application/json\" } };");
  sections.push("  if (body !== undefined) opts.body = JSON.stringify(body);");
  sections.push("  const res = await fetch(`${_baseUrl}${path}`, opts);");
  sections.push("  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);");
  sections.push("  return res.json() as Promise<T>;");
  sections.push("}");
  sections.push("");

  // --- Query key factory ---
  sections.push("// ── Query Keys ──");
  sections.push("");
  sections.push("export const queryKeys = {");

  // Group routes by resource (first path segment after /api/)
  const resources = new Set<string>();
  for (const { parsed } of routes) {
    const parts = parsed.path.split("/").filter(Boolean);
    // /api/users → "users", /products → "products"
    const resource = parts[0] === "api" && parts.length >= 2 ? parts[1] : parts[0];
    resources.add(resource);
  }

  for (const resource of resources) {
    sections.push(`  ${resource}: {`);
    sections.push(`    all: ["${resource}"] as const,`);

    // Add specific keys for routes in this resource
    const resourceRoutes = routes.filter(({ parsed }) => {
      const parts = parsed.path.split("/").filter(Boolean);
      const r = parts[0] === "api" && parts.length >= 2 ? parts[1] : parts[0];
      return r === resource;
    });

    for (const { parsed } of resourceRoutes) {
      if (parsed.method === "GET") {
        if (parsed.pathParams.length > 0) {
          const paramArgs = parsed.pathParams.map((p) => `${p}: string`).join(", ");
          const paramKeys = parsed.pathParams.map((p) => p).join(", ");
          sections.push(`    detail: (${paramArgs}) => ["${resource}", ${paramKeys}] as const,`);
        } else {
          sections.push(`    list: () => ["${resource}", "list"] as const,`);
        }
      }
    }
    sections.push("  },");
  }
  sections.push("} as const;");
  sections.push("");

  // --- Generate hooks ---
  sections.push("// ── Hooks ──");
  sections.push("");

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;
    const hookName = `use${baseName}`;
    const responseType = `${baseName}Response`;

    // Determine resource for query keys
    const parts = parsed.path.split("/").filter(Boolean);
    const resource = parts[0] === "api" && parts.length >= 2 ? parts[1] : parts[0];

    if (parsed.method === "GET") {
      // --- useQuery hook ---
      const hasPathParams = parsed.pathParams.length > 0;

      // Build params
      const fnParams: string[] = [];
      if (hasPathParams) {
        for (const p of parsed.pathParams) {
          fnParams.push(`${p}: string`);
        }
      }
      fnParams.push(`options?: Omit<UseQueryOptions<${responseType}, Error>, "queryKey" | "queryFn">`);

      // Build path expression
      let pathExpr: string;
      if (hasPathParams) {
        pathExpr = "`" + parsed.path.replace(/:(\w+)/g, (_, param) => `\${${param}}`) + "`";
      } else {
        pathExpr = `"${parsed.path}"`;
      }

      // Build query key
      let queryKeyExpr: string;
      if (hasPathParams) {
        queryKeyExpr = `queryKeys.${resource}.detail(${parsed.pathParams.join(", ")})`;
      } else {
        queryKeyExpr = `queryKeys.${resource}.list()`;
      }

      sections.push(`/** ${parsed.method} ${parsed.path} */`);
      sections.push(`export function ${hookName}(${fnParams.join(", ")}) {`);
      sections.push(`  return useQuery({`);
      sections.push(`    queryKey: ${queryKeyExpr},`);
      sections.push(`    queryFn: () => _fetch<${responseType}>("GET", ${pathExpr}),`);
      sections.push(`    ...options,`);
      sections.push(`  });`);
      sections.push(`}`);
      sections.push("");
    } else {
      // --- useMutation hook ---
      const hasBody = ["POST", "PUT", "PATCH"].includes(parsed.method);
      let inputType = "void";

      // Check if we have a typed input
      if (hasBody) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object") {
          bodyNode = fn.argsType.properties["body"];
        } else if (fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1) {
          const el = fn.argsType.elements[0];
          if (el.kind === "object") bodyNode = el.properties["body"];
        }
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          inputType = `${baseName}Input`;
        }
      }

      // For mutations with path params, create a combined variables type
      const hasPathParams = parsed.pathParams.length > 0;
      let variablesType: string;
      if (hasPathParams && inputType !== "void") {
        variablesType = `{ ${parsed.pathParams.map((p) => `${p}: string`).join("; ")}; input: ${inputType} }`;
      } else if (hasPathParams) {
        variablesType = `{ ${parsed.pathParams.map((p) => `${p}: string`).join("; ")} }`;
      } else {
        variablesType = inputType;
      }

      // Build path expression
      let pathExpr: string;
      if (hasPathParams) {
        pathExpr = "`" + parsed.path.replace(/:(\w+)/g, (_, param) => `\${vars.${param}}`) + "`";
      } else {
        pathExpr = `"${parsed.path}"`;
      }

      // Build body expression
      let bodyExpr: string;
      if (hasPathParams && inputType !== "void") {
        bodyExpr = "vars.input";
      } else if (inputType !== "void") {
        bodyExpr = "vars";
      } else {
        bodyExpr = "undefined";
      }

      const optionsType = `UseMutationOptions<${responseType}, Error, ${variablesType}>`;

      sections.push(`/** ${parsed.method} ${parsed.path} */`);
      sections.push(`export function ${hookName}(options?: Omit<${optionsType}, "mutationFn">) {`);
      sections.push(`  const queryClient = useQueryClient();`);
      sections.push(`  return useMutation({`);
      if (variablesType === "void") {
        sections.push(`    mutationFn: () => _fetch<${responseType}>("${parsed.method}", ${pathExpr}, ${bodyExpr}),`);
      } else {
        sections.push(`    mutationFn: (vars: ${variablesType}) => _fetch<${responseType}>("${parsed.method}", ${pathExpr}, ${bodyExpr}),`);
      }
      sections.push(`    onSuccess: (...args) => {`);
      sections.push(`      queryClient.invalidateQueries({ queryKey: queryKeys.${resource}.all });`);
      sections.push(`      options?.onSuccess?.(...args);`);
      sections.push(`    },`);
      sections.push(`    ...options,`);
      sections.push(`  });`);
      sections.push(`}`);
      sections.push("");
    }
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── Type guard generation ──

/**
 * Generate a runtime type guard check expression for a TypeNode.
 * Returns a string that evaluates to boolean when `varName` is the variable.
 */
function typeNodeToGuardCheck(node: TypeNode, varName: string, depth: number = 0): string {
  if (depth > 4) return "true"; // Limit recursion depth

  switch (node.kind) {
    case "primitive": {
      if (node.name === "null") return `${varName} === null`;
      if (node.name === "undefined") return `${varName} === undefined`;
      return `typeof ${varName} === "${node.name}"`;
    }

    case "unknown":
      return "true";

    case "array": {
      const elemCheck = typeNodeToGuardCheck(node.element, `${varName}[0]`, depth + 1);
      if (elemCheck === "true") {
        return `Array.isArray(${varName})`;
      }
      return `(Array.isArray(${varName}) && (${varName}.length === 0 || ${elemCheck}))`;
    }

    case "tuple": {
      const checks = [`Array.isArray(${varName})`];
      checks.push(`${varName}.length === ${node.elements.length}`);
      node.elements.forEach((el, i) => {
        const c = typeNodeToGuardCheck(el, `${varName}[${i}]`, depth + 1);
        if (c !== "true") checks.push(c);
      });
      return checks.join(" && ");
    }

    case "union": {
      const memberChecks = node.members.map(
        (m) => typeNodeToGuardCheck(m, varName, depth + 1),
      );
      return `(${memberChecks.join(" || ")})`;
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) {
        return `(typeof ${varName} === "object" && ${varName} !== null)`;
      }

      const checks: string[] = [
        `typeof ${varName} === "object"`,
        `${varName} !== null`,
      ];

      for (const key of keys) {
        checks.push(`"${key}" in ${varName}`);
        if (depth < 3) {
          const propCheck = typeNodeToGuardCheck(
            node.properties[key],
            `(${varName} as any).${key}`,
            depth + 1,
          );
          if (propCheck !== "true") {
            checks.push(propCheck);
          }
        }
      }

      return checks.join(" && ");
    }

    case "map":
      return `${varName} instanceof Map`;

    case "set":
      return `${varName} instanceof Set`;

    case "promise":
      return `${varName} instanceof Promise`;

    case "function":
      return `typeof ${varName} === "function"`;
  }
}

/**
 * Generate TypeScript type guard functions from runtime-observed types.
 *
 * For each route:
 * - `isGetApiUsersResponse(value): value is GetApiUsersResponse`
 * - `isPostApiUsersRequest(value): value is PostApiUsersRequest`
 *
 * Type guards perform structural checks: verify typeof, key existence,
 * array shapes, and nested object structure.
 */
export function generateTypeGuards(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  if (functions.length === 0) {
    return "// No functions found. Instrument your app to generate type guards.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated type guards by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --guards` to update");
  sections.push("");

  // First, collect all interfaces we'll need to reference
  const interfaces: string[] = [];
  const guards: string[] = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);

    if (parsed) {
      const basePascal = parsed.typeName;
      const baseCamel = toCamelCase(basePascal);

      // Response type + guard
      const responseTypeName = `${basePascal}Response`;
      const responseInterface = generateGuardInterface(responseTypeName, fn.returnType);
      if (responseInterface) interfaces.push(responseInterface);

      const responseCheck = typeNodeToGuardCheck(fn.returnType, "value");
      guards.push(`/** Type guard for ${parsed.method} ${parsed.path} response */`);
      guards.push(`export function is${responseTypeName}(value: unknown): value is ${responseTypeName} {`);
      guards.push(`  return ${responseCheck};`);
      guards.push(`}`);
      guards.push("");

      // Request body type + guard (for POST/PUT/PATCH)
      if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
          bodyNode = fn.argsType.properties["body"];
        }
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          const requestTypeName = `${basePascal}Request`;
          const requestInterface = generateGuardInterface(requestTypeName, bodyNode);
          if (requestInterface) interfaces.push(requestInterface);

          const requestCheck = typeNodeToGuardCheck(bodyNode, "value");
          guards.push(`/** Type guard for ${parsed.method} ${parsed.path} request body */`);
          guards.push(`export function is${requestTypeName}(value: unknown): value is ${requestTypeName} {`);
          guards.push(`  return ${requestCheck};`);
          guards.push(`}`);
          guards.push("");
        }
      }
    } else {
      // Non-route function
      const basePascal = toPascalCase(fn.name);

      // Output guard
      const outputTypeName = `${basePascal}Output`;
      const outputInterface = generateGuardInterface(outputTypeName, fn.returnType);
      if (outputInterface) interfaces.push(outputInterface);

      const outputCheck = typeNodeToGuardCheck(fn.returnType, "value");
      guards.push(`/** Type guard for ${fn.name} output */`);
      guards.push(`export function is${outputTypeName}(value: unknown): value is ${outputTypeName} {`);
      guards.push(`  return ${outputCheck};`);
      guards.push(`}`);
      guards.push("");

      // Input guard (if non-trivial)
      if (fn.argsType.kind !== "unknown" && fn.argsType.kind !== "object" || (fn.argsType.kind === "object" && Object.keys(fn.argsType.properties).length > 0)) {
        const inputTypeName = `${basePascal}Input`;
        const inputNode = fn.argsType.kind === "tuple" && fn.argsType.elements.length === 1
          ? fn.argsType.elements[0]
          : fn.argsType;
        const inputInterface = generateGuardInterface(inputTypeName, inputNode);
        if (inputInterface) interfaces.push(inputInterface);

        const inputCheck = typeNodeToGuardCheck(inputNode, "value");
        guards.push(`/** Type guard for ${fn.name} input */`);
        guards.push(`export function is${inputTypeName}(value: unknown): value is ${inputTypeName} {`);
        guards.push(`  return ${inputCheck};`);
        guards.push(`}`);
        guards.push("");
      }
    }
  }

  // Output: interfaces first, then guards
  sections.push("// ── Type Interfaces ──");
  sections.push("");
  sections.push(...interfaces);
  sections.push("// ── Type Guards ──");
  sections.push("");
  sections.push(...guards);

  return sections.join("\n").trimEnd() + "\n";
}

/**
 * Generate a simple interface declaration for use with type guards.
 */
function generateGuardInterface(name: string, node: TypeNode): string | null {
  if (node.kind !== "object") {
    // For non-object types, generate a type alias
    const extracted: ExtractedInterface[] = [];
    const tsType = typeNodeToTS(node, extracted, name, undefined, 0);
    return `export type ${name} = ${tsType};\n`;
  }

  const keys = Object.keys(node.properties);
  if (keys.length === 0) return `export type ${name} = Record<string, unknown>;\n`;

  const extracted: ExtractedInterface[] = [];
  const lines: string[] = [];
  lines.push(`export interface ${name} {`);
  for (const key of keys) {
    const val = typeNodeToTS(node.properties[key], extracted, name, key, 1);
    lines.push(`  ${key}: ${val};`);
  }
  lines.push(`}`);

  // Include any extracted sub-interfaces
  const subInterfaces: string[] = [];
  for (const ext of extracted) {
    if (ext.node.kind === "object") {
      subInterfaces.push(renderInterface(ext.name, ext.node, extracted));
    }
  }

  return [...subInterfaces, lines.join("\n")].join("\n\n") + "\n";
}

// ── Express validation middleware generation ──

/**
 * Generate a validation expression that returns an array of error strings.
 * `varName` is the variable being checked.
 */
function typeNodeToValidation(node: TypeNode, varName: string, path: string, depth: number = 0): string[] {
  if (depth > 3) return [];
  const checks: string[] = [];

  switch (node.kind) {
    case "primitive": {
      if (node.name === "null") {
        checks.push(`if (${varName} !== null) errors.push(\`${path} must be null\`);`);
      } else if (node.name === "undefined") {
        // Don't validate undefined — field just shouldn't be required
      } else {
        checks.push(`if (typeof ${varName} !== "${node.name}") errors.push(\`${path} must be a ${node.name}\`);`);
      }
      break;
    }

    case "array": {
      checks.push(`if (!Array.isArray(${varName})) errors.push(\`${path} must be an array\`);`);
      if (node.element.kind !== "unknown" && depth < 3) {
        checks.push(`else if (${varName}.length > 0) {`);
        checks.push(...typeNodeToValidation(node.element, `${varName}[0]`, `${path}[0]`, depth + 1).map(l => "  " + l));
        checks.push(`}`);
      }
      break;
    }

    case "object": {
      const keys = Object.keys(node.properties);
      checks.push(`if (typeof ${varName} !== "object" || ${varName} === null) errors.push(\`${path} must be an object\`);`);
      if (keys.length > 0 && depth < 3) {
        checks.push(`else {`);
        for (const key of keys) {
          const propPath = path ? `${path}.${key}` : key;
          const propAccess = `${varName}["${key}"]`;
          // Check key existence
          checks.push(`  if (!("${key}" in ${varName})) errors.push(\`${propPath} is required\`);`);
          // Type check if present
          const innerChecks = typeNodeToValidation(node.properties[key], propAccess, propPath, depth + 1);
          if (innerChecks.length > 0) {
            checks.push(`  else {`);
            checks.push(...innerChecks.map(l => "    " + l));
            checks.push(`  }`);
          }
        }
        checks.push(`}`);
      }
      break;
    }

    case "union": {
      // For unions, value must match at least one member — skip detailed validation
      break;
    }

    default:
      break;
  }

  return checks;
}

/**
 * Generate Express validation middleware from runtime-observed types.
 *
 * For each POST/PUT/PATCH route, generates middleware that:
 * - Validates request body structure and types
 * - Returns 400 with structured errors on failure
 * - Passes through to next() on success
 *
 * Self-contained — no external validation library required.
 */
export function generateMiddleware(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  // Filter to routes with request bodies
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
    bodyNode: TypeNode;
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (!parsed) continue;
    if (!["POST", "PUT", "PATCH"].includes(parsed.method)) continue;

    let bodyNode: TypeNode | undefined;
    if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
      bodyNode = fn.argsType.properties["body"];
    }
    if (!bodyNode || bodyNode.kind === "unknown") continue;
    if (bodyNode.kind === "object" && Object.keys(bodyNode.properties).length === 0) continue;

    routes.push({ parsed, fn, bodyNode });
  }

  if (routes.length === 0) {
    return "// No POST/PUT/PATCH routes with request bodies found.\n// Instrument your app and make some requests first.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated Express validation middleware by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --middleware` to update");
  sections.push("");
  sections.push('import { Request, Response, NextFunction } from "express";');
  sections.push("");

  // Generate interfaces for request body types
  const extracted: ExtractedInterface[] = [];

  for (const { parsed, bodyNode } of routes) {
    const typeName = `${parsed.typeName}Body`;

    if (bodyNode.kind === "object") {
      sections.push(renderInterface(typeName, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
    } else {
      const tsType = typeNodeToTS(bodyNode, extracted, typeName, undefined, 0);
      sections.push(`export type ${typeName} = ${tsType};`);
    }
    sections.push("");
  }

  // Render any extracted sub-interfaces
  for (const ext of extracted) {
    if (ext.node.kind === "object") {
      sections.push(renderInterface(ext.name, ext.node, extracted));
      sections.push("");
    }
  }

  // Generate validation middleware for each route
  for (const { parsed, bodyNode } of routes) {
    const middlewareName = `validate${parsed.typeName}`;
    const typeName = `${parsed.typeName}Body`;

    sections.push(`/**`);
    sections.push(` * Validates request body for ${parsed.method} ${parsed.path}`);
    sections.push(` * Returns 400 with structured errors if validation fails.`);
    sections.push(` */`);
    sections.push(`export function ${middlewareName}(req: Request, res: Response, next: NextFunction): void {`);
    sections.push(`  const errors: string[] = [];`);
    sections.push(`  const body = req.body;`);
    sections.push("");

    // Null/undefined check
    sections.push(`  if (body === null || body === undefined || typeof body !== "object") {`);
    sections.push(`    res.status(400).json({ error: "Request body is required", errors: ["body must be an object"] });`);
    sections.push(`    return;`);
    sections.push(`  }`);
    sections.push("");

    // Generate field validations
    if (bodyNode.kind === "object") {
      const keys = Object.keys(bodyNode.properties);
      for (const key of keys) {
        const propNode = bodyNode.properties[key];
        sections.push(`  // Validate ${key}`);
        sections.push(`  if (!("${key}" in body)) {`);
        sections.push(`    errors.push("${key} is required");`);
        sections.push(`  }`);

        const innerChecks = typeNodeToValidation(propNode, `body["${key}"]`, key, 1);
        if (innerChecks.length > 0) {
          sections.push(`  else {`);
          for (const check of innerChecks) {
            sections.push(`    ${check}`);
          }
          sections.push(`  }`);
        }
        sections.push("");
      }
    }

    sections.push(`  if (errors.length > 0) {`);
    sections.push(`    res.status(400).json({ error: "Validation failed", errors });`);
    sections.push(`    return;`);
    sections.push(`  }`);
    sections.push("");
    sections.push(`  next();`);
    sections.push(`}`);
    sections.push("");
  }

  // Export a combined middleware map for convenience
  sections.push("/** Map of route patterns to their validation middleware */");
  sections.push("export const validators = {");
  for (const { parsed } of routes) {
    const middlewareName = `validate${parsed.typeName}`;
    sections.push(`  "${parsed.method} ${parsed.path}": ${middlewareName},`);
  }
  sections.push("} as const;");
  sections.push("");

  return sections.join("\n").trimEnd() + "\n";
}

// ── MSW Handler Generation ──

/**
 * Generate a sample value literal string from a TypeNode.
 * Used to create realistic mock responses in MSW handlers.
 */
function typeNodeToSampleLiteral(node: TypeNode, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);

  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string": return '""';
        case "number": return "0";
        case "boolean": return "true";
        case "null": return "null";
        case "undefined": return "undefined";
        case "bigint": return "0";
        case "symbol": return '"symbol"';
        default: return "null";
      }

    case "array":
      return `[${typeNodeToSampleLiteral(node.element, indent)}]`;

    case "tuple": {
      const elements = node.elements.map((el) => typeNodeToSampleLiteral(el, indent));
      return `[${elements.join(", ")}]`;
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return "{}";
      const entries = keys.map(
        (key) => `${innerPad}${key}: ${typeNodeToSampleLiteral(node.properties[key], indent + 1)}`
      );
      return `{\n${entries.join(",\n")}\n${pad}}`;
    }

    case "union":
      // Use the first non-null/undefined member
      for (const m of node.members) {
        if (m.kind === "primitive" && (m.name === "null" || m.name === "undefined")) continue;
        return typeNodeToSampleLiteral(m, indent);
      }
      return "null";

    case "map":
      return "new Map()";

    case "set":
      return "new Set()";

    case "promise":
      return typeNodeToSampleLiteral(node.resolved, indent);

    case "function":
      return "() => {}";

    case "unknown":
      return "null";

    default:
      return "null";
  }
}

/**
 * Generate Mock Service Worker (MSW) request handlers from observed API routes.
 *
 * Output:
 * - Import from 'msw'
 * - Response type interfaces for each route
 * - Individual handler exports (e.g. getApiUsersHandler)
 * - A combined `handlers` array for setupServer/setupWorker
 */
export function generateMswHandlers(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express app to generate MSW handlers.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated MSW request handlers by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --msw` to update");
  sections.push("");
  sections.push('import { http, HttpResponse } from "msw";');
  sections.push("");

  // Generate response type interfaces
  const extracted: ExtractedInterface[] = [];

  for (const { parsed, fn } of routes) {
    const responseName = `${parsed.typeName}Response`;
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      sections.push(renderInterface(responseName, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
    } else {
      const tsType = typeNodeToTS(fn.returnType, extracted, responseName, undefined, 0);
      sections.push(`export type ${responseName} = ${tsType};`);
    }
    sections.push("");
  }

  // Render extracted sub-interfaces
  for (const ext of extracted) {
    if (ext.node.kind === "object") {
      sections.push(renderInterface(ext.name, ext.node, extracted));
      sections.push("");
    }
  }

  // Generate individual handler exports
  const handlerNames: string[] = [];

  for (const { parsed, fn } of routes) {
    const handlerName = `${parsed.funcName}Handler`;
    handlerNames.push(handlerName);
    const method = parsed.method.toLowerCase();

    // Convert Express-style :param to MSW-style :param (same format, already compatible)
    const mswPath = parsed.path;

    // Generate sample response from returnType
    const sampleResponse = typeNodeToSampleLiteral(fn.returnType, 1);

    sections.push(`/**`);
    sections.push(` * Mock handler for ${parsed.method} ${parsed.path}`);
    sections.push(` */`);
    sections.push(`export const ${handlerName} = http.${method}("${mswPath}", () => {`);
    sections.push(`  return HttpResponse.json(${sampleResponse} satisfies ${parsed.typeName}Response);`);
    sections.push(`});`);
    sections.push("");
  }

  // Export combined handlers array
  sections.push("/** All mock handlers — use with setupServer(...handlers) or setupWorker(...handlers) */");
  sections.push("export const handlers = [");
  for (const name of handlerNames) {
    sections.push(`  ${name},`);
  }
  sections.push("];");
  sections.push("");

  return sections.join("\n").trimEnd() + "\n";
}

// ── JSON Schema Generation ──

/**
 * Convert a TypeNode to a standalone JSON Schema (Draft 2020-12).
 * Unlike the OpenAPI variant, this produces proper JSON Schema with
 * $defs, oneOf, prefixItems, and nullable via type arrays.
 */
function typeNodeToStandaloneSchema(node: TypeNode): Record<string, unknown> {
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string": return { type: "string" };
        case "number": return { type: "number" };
        case "boolean": return { type: "boolean" };
        case "null": return { type: "null" };
        case "undefined": return { type: "null" };
        case "bigint": return { type: "integer" };
        case "symbol": return { type: "string" };
        default: return {};
      }

    case "array":
      return { type: "array", items: typeNodeToStandaloneSchema(node.element) };

    case "tuple":
      return {
        type: "array",
        prefixItems: node.elements.map(typeNodeToStandaloneSchema),
        minItems: node.elements.length,
        maxItems: node.elements.length,
      };

    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(node.properties)) {
        properties[key] = typeNodeToStandaloneSchema(val);
        required.push(key);
      }
      const schema: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) schema.required = required;
      return schema;
    }

    case "union": {
      const nonNull = node.members.filter(
        (m) => !(m.kind === "primitive" && (m.name === "null" || m.name === "undefined"))
      );
      const hasNull = nonNull.length < node.members.length;

      if (nonNull.length === 1) {
        const inner = typeNodeToStandaloneSchema(nonNull[0]);
        if (hasNull) {
          if (typeof inner.type === "string") {
            return { ...inner, type: [inner.type, "null"] };
          }
          return { oneOf: [inner, { type: "null" }] };
        }
        return inner;
      }

      const schemas = nonNull.map(typeNodeToStandaloneSchema);
      if (hasNull) schemas.push({ type: "null" });
      return { oneOf: schemas };
    }

    case "map":
      return {
        type: "object",
        additionalProperties: typeNodeToStandaloneSchema(node.value),
      };

    case "set":
      return {
        type: "array",
        uniqueItems: true,
        items: typeNodeToStandaloneSchema(node.element),
      };

    case "promise":
      return typeNodeToStandaloneSchema(node.resolved);

    case "function":
      return {};

    case "unknown":
      return {};

    default:
      return {};
  }
}

/**
 * Generate JSON Schema definitions from observed runtime types.
 *
 * Output is a single JSON object with $defs for each route/function's
 * request and response types, suitable for use with ajv, joi, or any
 * JSON Schema-compatible validator.
 */
export function generateJsonSchemas(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const defs: Record<string, unknown> = {};

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    const baseName = parsed ? parsed.typeName : toPascalCase(fn.name);

    // For routes, generate request body + response schemas
    if (parsed) {
      // Request body (only for methods with body)
      if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
          bodyNode = fn.argsType.properties["body"];
        }
        if (bodyNode && bodyNode.kind !== "unknown") {
          const bodySchema = typeNodeToStandaloneSchema(bodyNode);
          defs[`${baseName}Request`] = {
            description: `Request body for ${parsed.method} ${parsed.path}`,
            ...bodySchema,
          };
        }
      }

      // Response
      if (fn.returnType.kind !== "unknown") {
        const responseSchema = typeNodeToStandaloneSchema(fn.returnType);
        defs[`${baseName}Response`] = {
          description: `Response for ${parsed.method} ${parsed.path}`,
          ...responseSchema,
        };
      }
    } else {
      // Non-route function: generate input/output schemas
      if (fn.argsType.kind !== "unknown") {
        defs[`${baseName}Input`] = typeNodeToStandaloneSchema(fn.argsType);
      }
      if (fn.returnType.kind !== "unknown") {
        defs[`${baseName}Output`] = typeNodeToStandaloneSchema(fn.returnType);
      }
    }
  }

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "API Schemas",
    description: "Auto-generated JSON Schema definitions by trickle",
    $defs: defs,
  };

  return JSON.stringify(schema, null, 2) + "\n";
}

// ── SWR Hook Generation ──

/**
 * Generate typed SWR hooks from observed API routes.
 *
 * Output:
 * - Import from 'swr' and 'swr/mutation'
 * - Response/input type interfaces
 * - A configurable fetcher
 * - useSWR hooks for GET routes
 * - useSWRMutation hooks for POST/PUT/PATCH/DELETE routes
 */
export function generateSwrHooks(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express/FastAPI app to generate SWR hooks.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated SWR hooks by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --swr` to update");
  sections.push("");
  sections.push('import useSWR from "swr";');
  sections.push('import useSWRMutation from "swr/mutation";');
  sections.push('import type { SWRConfiguration, SWRResponse } from "swr";');
  sections.push('import type { SWRMutationConfiguration, SWRMutationResponse } from "swr/mutation";');
  sections.push("");

  // Generate interfaces
  const extracted: ExtractedInterface[] = [];

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;

    // Response type
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      sections.push(renderInterface(`${baseName}Response`, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
    } else {
      const retStr = typeNodeToTS(fn.returnType, extracted, baseName, undefined, 0);
      sections.push(`export type ${baseName}Response = ${retStr};`);
    }
    sections.push("");

    // Request body type (POST/PUT/PATCH)
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      let bodyNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
        bodyNode = fn.argsType.properties["body"];
      }
      if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
        sections.push(renderInterface(`${baseName}Input`, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
      }
    }
  }

  // Emit extracted sub-interfaces
  const emitted = new Set<string>();
  let cursor = 0;
  while (cursor < extracted.length) {
    const iface = extracted[cursor];
    cursor++;
    if (emitted.has(iface.name)) continue;
    emitted.add(iface.name);
    sections.push(renderInterface(iface.name, iface.node, extracted));
    sections.push("");
  }

  // Fetcher setup
  sections.push("// ── Fetcher ──");
  sections.push("");
  sections.push("let _baseUrl = \"\";");
  sections.push("");
  sections.push("/** Set the base URL for all API requests. Call once at app startup. */");
  sections.push("export function configureSwrHooks(baseUrl: string) {");
  sections.push("  _baseUrl = baseUrl;");
  sections.push("}");
  sections.push("");
  sections.push("const fetcher = <T>(path: string): Promise<T> =>");
  sections.push("  fetch(`${_baseUrl}${path}`).then((res) => {");
  sections.push("    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);");
  sections.push("    return res.json() as Promise<T>;");
  sections.push("  });");
  sections.push("");
  sections.push("async function mutationFetcher<T>(");
  sections.push("  url: string,");
  sections.push("  { arg }: { arg: { method: string; body?: unknown } },");
  sections.push("): Promise<T> {");
  sections.push("  const opts: RequestInit = {");
  sections.push("    method: arg.method,");
  sections.push('    headers: { "Content-Type": "application/json" },');
  sections.push("  };");
  sections.push("  if (arg.body !== undefined) opts.body = JSON.stringify(arg.body);");
  sections.push("  const res = await fetch(`${_baseUrl}${url}`, opts);");
  sections.push("  if (!res.ok) throw new Error(`${arg.method} ${url}: HTTP ${res.status}`);");
  sections.push("  return res.json() as Promise<T>;");
  sections.push("}");
  sections.push("");

  // Generate hooks
  sections.push("// ── Hooks ──");
  sections.push("");

  for (const { parsed, fn } of routes) {
    const baseName = parsed.typeName;
    const hookName = `use${baseName}`;
    const responseType = `${baseName}Response`;

    if (parsed.method === "GET") {
      // useSWR hook
      const hasPathParams = parsed.pathParams.length > 0;
      const fnParams: string[] = [];

      if (hasPathParams) {
        for (const p of parsed.pathParams) {
          fnParams.push(`${p}: string`);
        }
      }
      fnParams.push(`config?: SWRConfiguration<${responseType}, Error>`);

      let pathExpr: string;
      if (hasPathParams) {
        pathExpr = "`" + parsed.path.replace(/:(\w+)/g, (_, param: string) => `\${${param}}`) + "`";
      } else {
        pathExpr = `"${parsed.path}"`;
      }

      sections.push(`/** ${parsed.method} ${parsed.path} */`);
      sections.push(`export function ${hookName}(${fnParams.join(", ")}): SWRResponse<${responseType}, Error> {`);
      sections.push(`  return useSWR<${responseType}, Error>(${pathExpr}, fetcher<${responseType}>, config);`);
      sections.push("}");
      sections.push("");
    } else {
      // useSWRMutation hook for POST/PUT/PATCH/DELETE
      const method = parsed.method;
      const hasPathParams = parsed.pathParams.length > 0;
      const fnParams: string[] = [];

      if (hasPathParams) {
        for (const p of parsed.pathParams) {
          fnParams.push(`${p}: string`);
        }
      }

      // Check if route has input body
      let inputType: string | undefined;
      if (["POST", "PUT", "PATCH"].includes(method)) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
          bodyNode = fn.argsType.properties["body"];
        }
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          inputType = `${baseName}Input`;
        }
      }

      const triggerArgType = inputType || "void";
      fnParams.push(`config?: SWRMutationConfiguration<${responseType}, Error, string, ${triggerArgType}>`);

      let pathExpr: string;
      if (hasPathParams) {
        pathExpr = "`" + parsed.path.replace(/:(\w+)/g, (_, param: string) => `\${${param}}`) + "`";
      } else {
        pathExpr = `"${parsed.path}"`;
      }

      sections.push(`/** ${method} ${parsed.path} */`);
      sections.push(`export function ${hookName}(${fnParams.join(", ")}): SWRMutationResponse<${responseType}, Error, string, ${triggerArgType}> {`);
      sections.push(`  return useSWRMutation<${responseType}, Error, string, ${triggerArgType}>(`);
      sections.push(`    ${pathExpr},`);

      if (inputType) {
        sections.push(`    (url, { arg }) => mutationFetcher<${responseType}>(url, { arg: { method: "${method}", body: arg } }),`);
      } else {
        sections.push(`    (url) => mutationFetcher<${responseType}>(url, { arg: { method: "${method}" } }),`);
      }

      sections.push("    config,");
      sections.push("  );");
      sections.push("}");
      sections.push("");
    }
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── Pydantic Model Generation ──

/**
 * Convert a TypeNode to a Pydantic-compatible Python type string.
 */
function typeNodeToPydantic(
  node: TypeNode,
  extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
  parentName: string,
  propName: string | undefined,
): string {
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string":    return "str";
        case "number":    return "float";
        case "boolean":   return "bool";
        case "null":      return "None";
        case "undefined": return "None";
        case "bigint":    return "int";
        case "symbol":    return "str";
        default:          return "Any";
      }

    case "unknown":
      return "Any";

    case "array": {
      const inner = typeNodeToPydantic(node.element, extracted, parentName, propName);
      return `List[${inner}]`;
    }

    case "tuple": {
      const elements = node.elements.map((el, i) =>
        typeNodeToPydantic(el, extracted, parentName, `el${i}`)
      );
      return `Tuple[${elements.join(", ")}]`;
    }

    case "union": {
      const members = node.members.map((m) =>
        typeNodeToPydantic(m, extracted, parentName, propName)
      );
      if (members.length === 2 && members.includes("None")) {
        const nonNone = members.find((m) => m !== "None");
        return `Optional[${nonNone}]`;
      }
      return `Union[${members.join(", ")}]`;
    }

    case "map": {
      const v = typeNodeToPydantic(node.value, extracted, parentName, "value");
      return `Dict[str, ${v}]`;
    }

    case "set": {
      const inner = typeNodeToPydantic(node.element, extracted, parentName, propName);
      return `Set[${inner}]`;
    }

    case "promise":
      return typeNodeToPydantic(node.resolved, extracted, parentName, propName);

    case "function":
      return "Any";

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) return "Dict[str, Any]";

      if (propName) {
        const className = toPascalCase(parentName) + toPascalCase(propName);
        if (!extracted.some((e) => e.name === className)) {
          extracted.push({ name: className, node });
        }
        return className;
      }
      return "Dict[str, Any]";
    }
  }
}

/**
 * Render a Pydantic BaseModel class from an object TypeNode.
 */
function renderPydanticModel(
  name: string,
  node: Extract<TypeNode, { kind: "object" }>,
  extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
): string {
  const keys = Object.keys(node.properties);
  const innerExtracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
  const lines: string[] = [];

  const entries = keys.map((key) => {
    const pyType = typeNodeToPydantic(node.properties[key], innerExtracted, name, key);
    return `    ${toSnakeCase(key)}: ${pyType}`;
  });

  // Emit nested models first (they must be defined before use)
  for (const iface of innerExtracted) {
    lines.push(renderPydanticModel(iface.name, iface.node, innerExtracted));
    lines.push("");
    lines.push("");
  }

  lines.push(`class ${name}(BaseModel):`);
  if (entries.length === 0) {
    lines.push("    pass");
  } else {
    lines.push(...entries);
  }
  return lines.join("\n");
}

/**
 * Generate Pydantic BaseModel classes from observed runtime types.
 *
 * Unlike --python (TypedDict), Pydantic models provide:
 * - Runtime validation (model_validate)
 * - JSON serialization (model_dump_json)
 * - JSON Schema generation (model_json_schema)
 * - Direct use as FastAPI request/response models
 */
export function generatePydanticModels(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const sections: string[] = [];

  sections.push("# Auto-generated Pydantic models by trickle");
  sections.push(`# Generated at ${new Date().toISOString()}`);
  sections.push("# Do not edit manually — re-run `trickle codegen --pydantic` to update");
  sections.push("");
  sections.push("from __future__ import annotations");
  sections.push("");
  sections.push("from typing import Any, Dict, List, Optional, Set, Tuple, Union");
  sections.push("");
  sections.push("from pydantic import BaseModel");
  sections.push("");
  sections.push("");

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    const baseName = parsed ? parsed.typeName : toPascalCase(fn.name);

    const metaParts: string[] = [];
    if (fn.module) metaParts.push(`${fn.module} module`);
    if (fn.env) metaParts.push(`observed in ${fn.env}`);
    if (fn.observedAt) metaParts.push(formatTimeAgo(fn.observedAt));
    if (metaParts.length > 0) {
      sections.push(`# ${baseName} — ${metaParts.join(", ")}`);
    }

    if (parsed) {
      // Route-style: generate Request (body) and Response models

      // Request body (only for methods with body)
      if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
        let bodyNode: TypeNode | undefined;
        if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
          bodyNode = fn.argsType.properties["body"];
        }
        if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
          const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
          sections.push(renderPydanticModel(`${baseName}Request`, bodyNode as Extract<TypeNode, { kind: "object" }>, extracted));
          sections.push("");
          sections.push("");
        }
      }

      // Response model
      if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
        const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
        sections.push(renderPydanticModel(`${baseName}Response`, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
      } else if (fn.returnType.kind !== "unknown") {
        const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
        const pyType = typeNodeToPydantic(fn.returnType, extracted, baseName, undefined);
        sections.push(`${baseName}Response = ${pyType}`);
      }
    } else {
      // Non-route: generate Input/Output models
      if (fn.argsType.kind === "object" && Object.keys(fn.argsType.properties).length > 0) {
        const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
        sections.push(renderPydanticModel(`${baseName}Input`, fn.argsType as Extract<TypeNode, { kind: "object" }>, extracted));
        sections.push("");
        sections.push("");
      }

      if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
        const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
        sections.push(renderPydanticModel(`${baseName}Output`, fn.returnType as Extract<TypeNode, { kind: "object" }>, extracted));
      } else if (fn.returnType.kind !== "unknown") {
        const extracted: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];
        const pyType = typeNodeToPydantic(fn.returnType, extracted, baseName, undefined);
        sections.push(`${baseName}Output = ${pyType}`);
      }
    }

    sections.push("");
    sections.push("");
  }

  return sections.join("\n").trimEnd() + "\n";
}

// ── class-validator DTO Generation (NestJS) ──

/**
 * Get the class-validator decorator for a TypeNode.
 * Returns the decorator string(s) and the TypeScript type.
 */
function classValidatorField(
  node: TypeNode,
  propName: string,
  parentName: string,
  nestedClasses: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
): { decorators: string[]; tsType: string } {
  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string":
          return { decorators: ["@IsString()"], tsType: "string" };
        case "number":
          return { decorators: ["@IsNumber()"], tsType: "number" };
        case "boolean":
          return { decorators: ["@IsBoolean()"], tsType: "boolean" };
        default:
          return { decorators: [], tsType: "any" };
      }

    case "array": {
      const innerDecorators: string[] = ["@IsArray()"];
      if (node.element.kind === "object" && Object.keys(node.element.properties).length > 0) {
        const nestedName = parentName + toPascalCase(propName) + "Item";
        if (!nestedClasses.some((c) => c.name === nestedName)) {
          nestedClasses.push({ name: nestedName, node: node.element as Extract<TypeNode, { kind: "object" }> });
        }
        innerDecorators.push("@ValidateNested({ each: true })");
        innerDecorators.push(`@Type(() => ${nestedName})`);
        return { decorators: innerDecorators, tsType: `${nestedName}[]` };
      }
      const inner = classValidatorField(node.element, propName, parentName, nestedClasses);
      return { decorators: innerDecorators, tsType: `${inner.tsType}[]` };
    }

    case "object": {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) {
        return { decorators: ["@IsObject()"], tsType: "Record<string, any>" };
      }
      const nestedName = parentName + toPascalCase(propName);
      if (!nestedClasses.some((c) => c.name === nestedName)) {
        nestedClasses.push({ name: nestedName, node });
      }
      return {
        decorators: ["@ValidateNested()", `@Type(() => ${nestedName})`],
        tsType: nestedName,
      };
    }

    case "union": {
      // Check for nullable (T | null)
      const nonNull = node.members.filter(
        (m) => !(m.kind === "primitive" && (m.name === "null" || m.name === "undefined")),
      );
      const isNullable = nonNull.length < node.members.length;

      if (nonNull.length === 1) {
        const inner = classValidatorField(nonNull[0], propName, parentName, nestedClasses);
        if (isNullable) {
          return {
            decorators: ["@IsOptional()", ...inner.decorators],
            tsType: `${inner.tsType} | null`,
          };
        }
        return inner;
      }
      // Complex union — use basic validation
      return { decorators: [], tsType: "any" };
    }

    case "unknown":
      return { decorators: [], tsType: "any" };

    default:
      return { decorators: [], tsType: "any" };
  }
}

/**
 * Render a class-validator DTO class.
 */
function renderValidatorClass(
  name: string,
  node: Extract<TypeNode, { kind: "object" }>,
  nestedClasses: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }>,
): string {
  const lines: string[] = [];
  const keys = Object.keys(node.properties);

  lines.push(`export class ${name} {`);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const propNode = node.properties[key];
    const { decorators, tsType } = classValidatorField(propNode, key, name, nestedClasses);

    for (const dec of decorators) {
      lines.push(`  ${dec}`);
    }
    lines.push(`  ${key}: ${tsType};`);
    if (i < keys.length - 1) lines.push("");
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate class-validator DTO classes from observed runtime types.
 *
 * Output: NestJS-ready DTOs with class-validator decorators for
 * request validation and class-transformer for nested object support.
 */
export function generateClassValidatorDtos(
  functions: Array<{
    name: string;
    argsType: TypeNode;
    returnType: TypeNode;
    module?: string;
    env?: string;
    observedAt?: string;
  }>,
): string {
  const routes: Array<{
    parsed: ParsedRoute;
    fn: (typeof functions)[number];
  }> = [];

  for (const fn of functions) {
    const parsed = parseRouteName(fn.name);
    if (parsed) {
      routes.push({ parsed, fn });
    }
  }

  if (routes.length === 0) {
    return "// No API routes found. Instrument your Express/NestJS app to generate DTOs.\n";
  }

  const sections: string[] = [];
  sections.push("// Auto-generated class-validator DTOs by trickle");
  sections.push(`// Generated at ${new Date().toISOString()}`);
  sections.push("// Do not edit manually — re-run `trickle codegen --class-validator` to update");
  sections.push("");

  // Collect which decorators are needed
  const usedDecorators = new Set<string>();
  const needsType = { value: false };

  // Pre-scan to collect all classes and nested classes
  const allClasses: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }>; comment: string }> = [];
  const nestedClasses: Array<{ name: string; node: Extract<TypeNode, { kind: "object" }> }> = [];

  for (const { parsed, fn } of routes) {
    // Request body DTO (POST/PUT/PATCH only)
    if (["POST", "PUT", "PATCH"].includes(parsed.method)) {
      let bodyNode: TypeNode | undefined;
      if (fn.argsType.kind === "object" && fn.argsType.properties["body"]) {
        bodyNode = fn.argsType.properties["body"];
      }
      if (bodyNode && bodyNode.kind === "object" && Object.keys(bodyNode.properties).length > 0) {
        allClasses.push({
          name: `${parsed.typeName}Body`,
          node: bodyNode as Extract<TypeNode, { kind: "object" }>,
          comment: `/** Request body for ${parsed.method} ${parsed.path} */`,
        });
      }
    }

    // Response DTO
    if (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length > 0) {
      allClasses.push({
        name: `${parsed.typeName}Response`,
        node: fn.returnType as Extract<TypeNode, { kind: "object" }>,
        comment: `/** Response for ${parsed.method} ${parsed.path} */`,
      });
    }
  }

  // Render all classes, collecting nested ones as we go
  const renderedClasses: Array<{ name: string; code: string; comment: string }> = [];
  const rendered = new Set<string>();

  for (const cls of allClasses) {
    if (rendered.has(cls.name)) continue;
    rendered.add(cls.name);
    const code = renderValidatorClass(cls.name, cls.node, nestedClasses);
    renderedClasses.push({ name: cls.name, code, comment: cls.comment });
  }

  // Render nested classes (may add more to nestedClasses as we process)
  let cursor = 0;
  while (cursor < nestedClasses.length) {
    const nested = nestedClasses[cursor];
    cursor++;
    if (rendered.has(nested.name)) continue;
    rendered.add(nested.name);
    const code = renderValidatorClass(nested.name, nested.node, nestedClasses);
    renderedClasses.unshift({ name: nested.name, code, comment: "" });
  }

  // Scan for used decorators
  const allCode = renderedClasses.map((c) => c.code).join("\n");
  const decoratorNames = ["IsString", "IsNumber", "IsBoolean", "IsArray", "IsObject", "IsOptional", "ValidateNested", "IsNotEmpty"];
  for (const name of decoratorNames) {
    if (allCode.includes(`@${name}`)) usedDecorators.add(name);
  }
  if (allCode.includes("@Type(")) needsType.value = true;

  // Emit imports
  if (usedDecorators.size > 0) {
    const sorted = Array.from(usedDecorators).sort();
    sections.push(`import { ${sorted.join(", ")} } from "class-validator";`);
  }
  if (needsType.value) {
    sections.push('import { Type } from "class-transformer";');
  }
  sections.push("");

  // Emit classes
  for (const cls of renderedClasses) {
    if (cls.comment) {
      sections.push(cls.comment);
    }
    sections.push(cls.code);
    sections.push("");
  }

  return sections.join("\n").trimEnd() + "\n";
}

// Public re-export for single-node conversion (used in tests)
export { typeNodeToTS as typeNodeToTSPublic };
