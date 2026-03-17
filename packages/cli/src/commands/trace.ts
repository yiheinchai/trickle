import * as crypto from "crypto";
import chalk from "chalk";
import { getBackendUrl } from "../config";

export interface TraceOptions {
  header?: string[];
  body?: string;
  save?: boolean;
  env?: string;
  module?: string;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

/**
 * `trickle trace <method> <url>` — Make an HTTP request and show the response
 * with inline type annotations. Like curl but type-aware.
 *
 * Optionally saves the types to the backend with --save.
 */
export async function traceCommand(
  method: string,
  url: string,
  opts: TraceOptions,
): Promise<void> {
  const httpMethod = method.toUpperCase();
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  if (!validMethods.includes(httpMethod)) {
    console.error(chalk.red(`\n  Invalid HTTP method: ${method}\n`));
    process.exit(1);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error(chalk.red(`\n  Invalid URL: ${url}\n`));
    process.exit(1);
  }

  // Build request headers
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.header) {
    for (const h of opts.header) {
      const colonIdx = h.indexOf(":");
      if (colonIdx === -1) {
        console.error(chalk.red(`\n  Invalid header: ${h}\n`));
        process.exit(1);
      }
      headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
    }
  }

  let reqBody: string | undefined;
  let reqJson: unknown = undefined;
  if (opts.body) {
    reqBody = opts.body;
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    try {
      reqJson = JSON.parse(opts.body);
    } catch {}
  }

  console.log("");
  console.log(chalk.bold("  trickle trace"));
  console.log(chalk.gray("  " + "─".repeat(50)));

  // Make the request
  const startTime = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: httpMethod,
      headers,
      body: reqBody,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(chalk.red(`\n  Request failed: ${msg}\n`));
    process.exit(1);
  }
  const elapsed = Date.now() - startTime;

  // Status line
  const status = response.status;
  const statusColor = status < 300 ? chalk.green : status < 400 ? chalk.yellow : chalk.red;
  console.log(
    chalk.gray(`  ${chalk.bold(httpMethod)} ${url}`),
  );
  console.log(
    chalk.gray(`  Status: `) +
    statusColor(`${status} ${response.statusText}`) +
    chalk.gray(` (${elapsed}ms)`),
  );

  // Show response headers summary
  const contentType = response.headers.get("content-type") || "";
  const contentLength = response.headers.get("content-length");
  console.log(
    chalk.gray(`  Type:   ${contentType}`),
  );
  if (contentLength) {
    console.log(chalk.gray(`  Size:   ${formatBytes(parseInt(contentLength, 10))}`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));

  // Read and parse body
  const bodyText = await response.text();
  if (!contentType.includes("json") || bodyText.length === 0) {
    console.log("");
    if (bodyText.length > 0) {
      console.log(chalk.gray("  (non-JSON response)"));
      console.log(chalk.gray("  " + bodyText.slice(0, 500)));
    } else {
      console.log(chalk.gray("  (empty response)"));
    }
    console.log("");
    return;
  }

  let jsonData: unknown;
  try {
    jsonData = JSON.parse(bodyText);
  } catch {
    console.error(chalk.red("\n  Response is not valid JSON.\n"));
    process.exit(1);
  }

  // Render annotated JSON
  console.log("");
  const lines = renderAnnotatedJson(jsonData, 2);
  for (const line of lines) {
    console.log(line);
  }

  // Summary
  const typeNode = jsonToTypeNode(jsonData);
  const stats = countTypeStats(typeNode);
  console.log("");
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(
    chalk.gray(`  ${stats.fields} fields, ${stats.uniqueTypes} unique types, ${stats.depth} depth`),
  );

  // Optionally save to backend
  if (opts.save) {
    await saveTypes(parsedUrl, httpMethod, jsonData, reqJson, opts);
  }

  console.log("");
}

/**
 * Render JSON with inline type annotations.
 */
function renderAnnotatedJson(
  value: unknown,
  baseIndent: number,
): string[] {
  const lines: string[] = [];
  renderValue(value, baseIndent, 0, lines, false, true);
  return lines;
}

function renderValue(
  value: unknown,
  baseIndent: number,
  depth: number,
  lines: string[],
  trailingComma: boolean,
  isLast: boolean,
): void {
  const indent = " ".repeat(baseIndent + depth * 2);
  const comma = trailingComma ? "," : "";
  const annotationGap = 2;

  if (value === null) {
    lines.push(indent + chalk.gray("null") + comma + typeAnnotation("null", indent.length + 4, annotationGap));
    return;
  }

  if (value === undefined) {
    lines.push(indent + chalk.gray("undefined") + comma);
    return;
  }

  switch (typeof value) {
    case "string": {
      const display = value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`;
      lines.push(indent + chalk.green(display) + comma + typeAnnotation("string", indent.length + display.length, annotationGap));
      return;
    }
    case "number":
      lines.push(indent + chalk.yellow(String(value)) + comma + typeAnnotation("number", indent.length + String(value).length, annotationGap));
      return;
    case "boolean":
      lines.push(indent + chalk.blue(String(value)) + comma + typeAnnotation("boolean", indent.length + String(value).length, annotationGap));
      return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(indent + "[]" + comma + typeAnnotation("unknown[]", indent.length + 2, annotationGap));
      return;
    }

    // Show type annotation on the opening bracket
    const elemType = compactType(jsonToTypeNode(value[0]));
    lines.push(indent + "[" + typeAnnotation(`${elemType}[]`, indent.length + 1, annotationGap));

    // Show first few elements, collapse if too many
    const maxShow = Math.min(value.length, 3);
    for (let i = 0; i < maxShow; i++) {
      renderValue(value[i], baseIndent, depth + 1, lines, i < value.length - 1, i === maxShow - 1);
    }
    if (value.length > maxShow) {
      const innerIndent = " ".repeat(baseIndent + (depth + 1) * 2);
      lines.push(innerIndent + chalk.gray(`// ... +${value.length - maxShow} more items`));
    }
    lines.push(indent + "]" + comma);
    return;
  }

  // Object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length === 0) {
    lines.push(indent + "{}" + comma + typeAnnotation("{}", indent.length + 2, annotationGap));
    return;
  }

  lines.push(indent + "{");

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = obj[key];
    const isLastKey = i === keys.length - 1;
    const keyComma = isLastKey ? "" : ",";
    const innerIndent = " ".repeat(baseIndent + (depth + 1) * 2);

    // For simple values, render key: value on one line
    if (val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      const valStr = formatSimpleValue(val);
      const valType = val === null ? "null" : typeof val;
      const lineContent = `${innerIndent}${chalk.white(`"${key}"`)}: ${valStr}${keyComma}`;
      const rawLen = innerIndent.length + `"${key}": `.length + rawValueLen(val) + keyComma.length;
      lines.push(lineContent + typeAnnotation(valType, rawLen, annotationGap));
    } else {
      // Complex value — render key then value
      lines.push(`${innerIndent}${chalk.white(`"${key}"`)}:`);
      renderValue(val, baseIndent, depth + 1, lines, !isLastKey, isLastKey);
    }
  }

  lines.push(indent + "}" + comma);
}

function formatSimpleValue(val: unknown): string {
  if (val === null) return chalk.gray("null");
  if (typeof val === "string") {
    const display = val.length > 50 ? `"${val.slice(0, 47)}..."` : `"${val}"`;
    return chalk.green(display);
  }
  if (typeof val === "number") return chalk.yellow(String(val));
  if (typeof val === "boolean") return chalk.blue(String(val));
  return String(val);
}

function rawValueLen(val: unknown): number {
  if (val === null) return 4;
  if (typeof val === "string") {
    return Math.min(val.length + 2, 53);
  }
  return String(val).length;
}

function typeAnnotation(type: string, currentCol: number, gap: number): string {
  const targetCol = 45;
  const padding = Math.max(gap, targetCol - currentCol);
  return " ".repeat(padding) + chalk.gray(`// ${type}`);
}

function jsonToTypeNode(value: unknown): TypeNode {
  if (value === null) return { kind: "primitive", name: "null" };
  if (value === undefined) return { kind: "primitive", name: "undefined" };
  switch (typeof value) {
    case "string": return { kind: "primitive", name: "string" };
    case "number": return { kind: "primitive", name: "number" };
    case "boolean": return { kind: "primitive", name: "boolean" };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    return { kind: "array", element: jsonToTypeNode(value[0]) };
  }
  const obj = value as Record<string, unknown>;
  const properties: Record<string, TypeNode> = {};
  for (const [key, val] of Object.entries(obj)) {
    properties[key] = jsonToTypeNode(val);
  }
  return { kind: "object", properties };
}

function compactType(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return node.name as string;
    case "object": {
      const props = node.properties as Record<string, TypeNode>;
      const keys = Object.keys(props);
      if (keys.length === 0) return "{}";
      if (keys.length <= 4) {
        return `{${keys.join(", ")}}`;
      }
      return `{${keys.slice(0, 3).join(", ")}, …+${keys.length - 3}}`;
    }
    case "array":
      return `${compactType(node.element as TypeNode)}[]`;
    default:
      return node.kind;
  }
}

function countTypeStats(node: TypeNode): { fields: number; uniqueTypes: number; depth: number } {
  const types = new Set<string>();
  let fields = 0;
  let maxDepth = 0;

  function walk(n: TypeNode, depth: number) {
    maxDepth = Math.max(maxDepth, depth);
    if (n.kind === "primitive") {
      types.add(n.name as string);
    } else if (n.kind === "object") {
      const props = n.properties as Record<string, TypeNode>;
      for (const val of Object.values(props)) {
        fields++;
        walk(val, depth + 1);
      }
    } else if (n.kind === "array") {
      types.add("array");
      walk(n.element as TypeNode, depth + 1);
    }
  }

  walk(node, 0);
  return { fields, uniqueTypes: types.size, depth: maxDepth };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function normalizePath(urlPath: string): string {
  return urlPath.split("/").map((part, i) => {
    if (!part) return part;
    if (/^\d+$/.test(part)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(part) && i > 1) return ":id";
    return part;
  }).join("/");
}

function computeTypeHash(argsType: TypeNode, returnType: TypeNode): string {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

async function saveTypes(
  parsedUrl: URL,
  httpMethod: string,
  resJson: unknown,
  reqJson: unknown,
  opts: TraceOptions,
): Promise<void> {
  const backendUrl = getBackendUrl();

  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.log(chalk.yellow("  Could not save types — backend not reachable."));
    return;
  }

  const routePath = normalizePath(parsedUrl.pathname);
  const functionName = `${httpMethod} ${routePath}`;

  const argsProperties: Record<string, TypeNode> = {};
  if (reqJson !== undefined && reqJson !== null) {
    argsProperties.body = jsonToTypeNode(reqJson);
  }
  if (parsedUrl.search) {
    const queryProps: Record<string, TypeNode> = {};
    for (const [key] of parsedUrl.searchParams) {
      queryProps[key] = { kind: "primitive", name: "string" };
    }
    if (Object.keys(queryProps).length > 0) {
      argsProperties.query = { kind: "object", properties: queryProps };
    }
  }

  const argsType: TypeNode = Object.keys(argsProperties).length > 0
    ? { kind: "object", properties: argsProperties }
    : { kind: "object", properties: {} };

  const returnType = jsonToTypeNode(resJson);
  const typeHash = computeTypeHash(argsType, returnType);

  const payload = {
    functionName,
    module: opts.module || "trace",
    language: "js",
    environment: opts.env || "development",
    typeHash,
    argsType,
    returnType,
    sampleOutput: resJson,
    sampleInput: Object.keys(argsProperties).length > 0 ? argsProperties : undefined,
  };

  try {
    const ingestRes = await fetch(`${backendUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!ingestRes.ok) throw new Error(`HTTP ${ingestRes.status}`);
    console.log(chalk.green(`  Types saved as "${functionName}"`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.log(chalk.yellow(`  Could not save types: ${msg}`));
  }
}
