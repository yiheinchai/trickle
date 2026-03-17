import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { getBackendUrl } from "../config";
import { isLocalMode } from "../local-data";

export interface CaptureOptions {
  header?: string[];
  body?: string;
  env?: string;
  module?: string;
  local?: boolean;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

/**
 * `trickle capture <method> <url>` — Capture types from a live API endpoint.
 *
 * Makes an HTTP request to the given URL, infers TypeNode from the response,
 * and sends the observation to the trickle backend. Zero instrumentation needed —
 * just point at any API and start collecting types.
 */
export async function captureCommand(
  method: string,
  url: string,
  opts: CaptureOptions,
): Promise<void> {
  const backendUrl = getBackendUrl();

  // Validate method
  const httpMethod = method.toUpperCase();
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  if (!validMethods.includes(httpMethod)) {
    console.error(chalk.red(`\n  Invalid HTTP method: ${method}`));
    console.error(chalk.gray(`  Valid methods: ${validMethods.join(", ")}\n`));
    process.exit(1);
  }

  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error(chalk.red(`\n  Invalid URL: ${url}\n`));
    process.exit(1);
  }

  // Build request headers
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  if (opts.header) {
    for (const h of opts.header) {
      const colonIdx = h.indexOf(":");
      if (colonIdx === -1) {
        console.error(chalk.red(`\n  Invalid header format: ${h}`));
        console.error(chalk.gray('  Use "Header-Name: value" format\n'));
        process.exit(1);
      }
      const key = h.slice(0, colonIdx).trim();
      const value = h.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  // Parse request body
  let reqBody: string | undefined;
  let reqJson: unknown = undefined;
  if (opts.body) {
    reqBody = opts.body;
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    try {
      reqJson = JSON.parse(opts.body);
    } catch {
      // Not JSON body — that's fine
    }
  }

  // Check backend connectivity (skip in local mode)
  if (!isLocalMode(opts)) {
    try {
      const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error("not ok");
    } catch {
      console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`));
      console.error(chalk.gray("  Start the backend first: npx trickle-backend\n"));
      process.exit(1);
    }
  }

  console.log("");
  console.log(chalk.bold("  trickle capture"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  ${chalk.bold(httpMethod)} ${url}`));

  // Make the request
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

  const status = response.status;
  const statusColor = status < 400 ? chalk.green : chalk.red;
  console.log(chalk.gray(`  Status:   `) + statusColor(`${status} ${response.statusText}`));

  // Read response body
  const resText = await response.text();
  let resJson: unknown = undefined;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json") && resText.length > 0) {
    try {
      resJson = JSON.parse(resText);
    } catch {
      console.error(chalk.yellow("\n  Response is not valid JSON — cannot capture types.\n"));
      process.exit(1);
    }
  } else {
    console.error(chalk.yellow("\n  Response is not JSON — cannot capture types."));
    console.error(chalk.gray(`  Content-Type: ${contentType}\n`));
    process.exit(1);
  }

  // Build type observations
  const routePath = normalizePath(parsedUrl.pathname);
  const functionName = `${httpMethod} ${routePath}`;

  const argsProperties: Record<string, TypeNode> = {};
  if (reqJson !== undefined && reqJson !== null) {
    argsProperties.body = jsonToTypeNode(reqJson);
  }

  // Extract query params
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
    module: opts.module || "capture",
    language: "js",
    environment: opts.env || "development",
    typeHash,
    argsType,
    returnType,
    sampleInput: Object.keys(argsProperties).length > 0 ? argsProperties : undefined,
    sampleOutput: resJson,
  };

  // Send to backend or write locally
  if (isLocalMode(opts)) {
    const trickleDir = path.join(process.cwd(), ".trickle");
    if (!fs.existsSync(trickleDir)) {
      fs.mkdirSync(trickleDir, { recursive: true });
    }
    const jsonlPath = path.join(trickleDir, "observations.jsonl");
    fs.appendFileSync(jsonlPath, JSON.stringify(payload) + "\n", "utf-8");
  } else {
    try {
      const res = await fetch(`${backendUrl}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(chalk.red(`\n  Failed to send types to backend: ${msg}\n`));
      process.exit(1);
    }
  }

  console.log(chalk.gray(`  Route:    `) + chalk.white(functionName));
  console.log(chalk.gray(`  Backend:  `) + chalk.white(backendUrl));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.green("  Types captured successfully!"));

  // Show a preview of what was captured
  const fieldCount = countFields(returnType);
  console.log(chalk.gray(`  Response shape: ${fieldCount} fields observed`));
  if (reqJson) {
    const reqFieldCount = countFields(argsProperties.body || { kind: "object", properties: {} });
    console.log(chalk.gray(`  Request body:   ${reqFieldCount} fields observed`));
  }
  console.log("");
  console.log(chalk.gray("  Run ") + chalk.white(`trickle codegen`) + chalk.gray(" to generate type definitions."));
  console.log("");
}

/**
 * Infer a TypeNode from a JSON value.
 */
function jsonToTypeNode(value: unknown): TypeNode {
  if (value === null) return { kind: "primitive", name: "null" };
  if (value === undefined) return { kind: "primitive", name: "undefined" };

  switch (typeof value) {
    case "string":  return { kind: "primitive", name: "string" };
    case "number":  return { kind: "primitive", name: "number" };
    case "boolean": return { kind: "primitive", name: "boolean" };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    const elementType = jsonToTypeNode(value[0]);
    return { kind: "array", element: elementType };
  }

  // Object
  const obj = value as Record<string, unknown>;
  const properties: Record<string, TypeNode> = {};
  for (const [key, val] of Object.entries(obj)) {
    properties[key] = jsonToTypeNode(val);
  }
  return { kind: "object", properties };
}

/**
 * Normalize URL path: replace dynamic segments with :param patterns.
 */
function normalizePath(urlPath: string): string {
  const parts = urlPath.split("/");
  return parts
    .map((part, i) => {
      if (!part) return part;
      if (/^\d+$/.test(part)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(part) && i > 1) return ":id";
      return part;
    })
    .join("/");
}

function computeTypeHash(argsType: TypeNode, returnType: TypeNode): string {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function countFields(node: TypeNode): number {
  if (node.kind === "object" && node.properties) {
    return Object.keys(node.properties as Record<string, unknown>).length;
  }
  if (node.kind === "array") return 1;
  return 1;
}
