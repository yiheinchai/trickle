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

// Public re-export for single-node conversion (used in tests)
export { typeNodeToTS as typeNodeToTSPublic };
