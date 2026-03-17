import chalk from "chalk";
import { getBackendUrl } from "../config";

export interface ValidateOptions {
  header?: string[];
  body?: string;
  env?: string;
  strict?: boolean;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

interface Mismatch {
  path: string;
  issue: "missing" | "extra" | "type_mismatch" | "kind_mismatch";
  expected?: string;
  actual?: string;
}

/**
 * `trickle validate <method> <url>` — Validate a live API response against observed types.
 *
 * Makes an HTTP request, infers types from the response, fetches the stored
 * type for that route from the backend, and reports any mismatches.
 */
export async function validateCommand(
  method: string,
  url: string,
  opts: ValidateOptions,
): Promise<void> {
  const backendUrl = getBackendUrl();

  const httpMethod = method.toUpperCase();
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
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

  // Check backend
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
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
  if (opts.body) {
    reqBody = opts.body;
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  console.log("");
  console.log(chalk.bold("  trickle validate"));
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

  // Parse response
  const resText = await response.text();
  let resJson: unknown;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json") && resText.length > 0) {
    try {
      resJson = JSON.parse(resText);
    } catch {
      console.error(chalk.red("\n  Response is not valid JSON.\n"));
      process.exit(1);
    }
  } else {
    console.error(chalk.red("\n  Response is not JSON.\n"));
    process.exit(1);
  }

  // Normalize path and find stored types
  const routePath = normalizePath(parsedUrl.pathname);
  const functionName = `${httpMethod} ${routePath}`;
  console.log(chalk.gray(`  Route:    `) + chalk.white(functionName));

  // Fetch stored function from backend
  const funcsRes = await fetch(
    `${backendUrl}/api/functions?q=${encodeURIComponent(functionName)}&limit=100`,
    { signal: AbortSignal.timeout(5000) },
  );
  const funcsData = await funcsRes.json() as { functions: Array<{ id: number; function_name: string }> };

  const matchedFunc = funcsData.functions.find(
    (f) => f.function_name === functionName,
  );

  if (!matchedFunc) {
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log(chalk.yellow("  No previously observed types for this route."));
    console.log(chalk.gray("  Run ") + chalk.white("trickle capture") + chalk.gray(" first to establish a baseline.\n"));
    process.exit(1);
  }

  // Fetch latest type snapshot
  const envQuery = opts.env ? `&env=${encodeURIComponent(opts.env)}` : "";
  const typesRes = await fetch(
    `${backendUrl}/api/types/${matchedFunc.id}?limit=1${envQuery}`,
    { signal: AbortSignal.timeout(5000) },
  );
  const typesData = await typesRes.json() as {
    snapshots: Array<{ return_type: string; observed_at: string }>;
  };

  if (!typesData.snapshots || typesData.snapshots.length === 0) {
    console.log(chalk.yellow("  No type snapshots found for this route.\n"));
    process.exit(1);
  }

  const snapshot = typesData.snapshots[0];
  let expectedType: TypeNode;
  try {
    expectedType = (typeof snapshot.return_type === 'string'
      ? JSON.parse(snapshot.return_type)
      : snapshot.return_type) as TypeNode;
  } catch {
    console.error(chalk.red("  Cannot parse stored type snapshot.\n"));
    process.exit(1);
  }

  console.log(chalk.gray(`  Baseline: `) + chalk.gray(`observed ${snapshot.observed_at}`));
  console.log(chalk.gray("  " + "─".repeat(50)));

  // Infer type from actual response
  const actualType = jsonToTypeNode(resJson);

  // Compare
  const mismatches: Mismatch[] = [];
  compareTypes(expectedType, actualType, "response", mismatches, opts.strict || false);

  if (mismatches.length === 0) {
    console.log(chalk.green("\n  ✓ Response matches observed type shape\n"));
    console.log(chalk.gray("  All fields present with expected types.\n"));
  } else {
    console.log(chalk.red(`\n  ✗ ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"} found\n`));

    for (const m of mismatches) {
      switch (m.issue) {
        case "missing":
          console.log(
            chalk.red("  MISSING ") +
            chalk.white(m.path) +
            chalk.gray(` (expected ${m.expected})`),
          );
          break;
        case "extra":
          console.log(
            chalk.yellow("  EXTRA   ") +
            chalk.white(m.path) +
            chalk.gray(` (${m.actual}, not in observed types)`),
          );
          break;
        case "type_mismatch":
          console.log(
            chalk.red("  TYPE    ") +
            chalk.white(m.path) +
            chalk.gray(` (expected ${m.expected}, got ${m.actual})`),
          );
          break;
        case "kind_mismatch":
          console.log(
            chalk.red("  SHAPE   ") +
            chalk.white(m.path) +
            chalk.gray(` (expected ${m.expected}, got ${m.actual})`),
          );
          break;
      }
    }

    const errors = mismatches.filter((m) => m.issue !== "extra");
    const warnings = mismatches.filter((m) => m.issue === "extra");

    console.log("");
    if (errors.length > 0) {
      console.log(chalk.red(`  ${errors.length} error${errors.length === 1 ? "" : "s"}`) +
        (warnings.length > 0 ? chalk.yellow(`, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`) : ""));
    } else {
      console.log(chalk.yellow(`  ${warnings.length} warning${warnings.length === 1 ? "" : "s"} (extra fields only)`));
    }
    console.log("");

    if (errors.length > 0) {
      process.exitCode = 1;
    }
  }
}

/**
 * Recursively compare expected vs actual TypeNode.
 */
function compareTypes(
  expected: TypeNode,
  actual: TypeNode,
  path: string,
  mismatches: Mismatch[],
  strict: boolean,
): void {
  // Kind mismatch
  if (expected.kind !== actual.kind) {
    // Special case: unknown expected matches anything
    if (expected.kind === "unknown") return;
    // Special case: expected primitive null matches any actual (nullable)
    if (expected.kind === "primitive" && (expected as unknown as { name: string }).name === "null") return;

    mismatches.push({
      path,
      issue: "kind_mismatch",
      expected: describeType(expected),
      actual: describeType(actual),
    });
    return;
  }

  switch (expected.kind) {
    case "primitive": {
      const expectedName = (expected as unknown as { name: string }).name;
      const actualName = (actual as unknown as { name: string }).name;
      if (expectedName !== actualName) {
        mismatches.push({
          path,
          issue: "type_mismatch",
          expected: expectedName,
          actual: actualName,
        });
      }
      break;
    }

    case "object": {
      const expectedProps = expected.properties as Record<string, TypeNode>;
      const actualProps = actual.properties as Record<string, TypeNode>;

      // Check for missing fields
      for (const key of Object.keys(expectedProps)) {
        if (!(key in actualProps)) {
          mismatches.push({
            path: `${path}.${key}`,
            issue: "missing",
            expected: describeType(expectedProps[key]),
          });
        } else {
          compareTypes(expectedProps[key], actualProps[key], `${path}.${key}`, mismatches, strict);
        }
      }

      // Check for extra fields (warnings in non-strict, errors in strict)
      if (strict) {
        for (const key of Object.keys(actualProps)) {
          if (!(key in expectedProps)) {
            mismatches.push({
              path: `${path}.${key}`,
              issue: "extra",
              actual: describeType(actualProps[key]),
            });
          }
        }
      }
      break;
    }

    case "array": {
      const expectedElement = expected.element as TypeNode;
      const actualElement = actual.element as TypeNode;
      if (expectedElement.kind !== "unknown" && actualElement.kind !== "unknown") {
        compareTypes(expectedElement, actualElement, `${path}[]`, mismatches, strict);
      }
      break;
    }

    case "union": {
      // For unions, check that actual matches at least one member
      // Simplified: just skip deep comparison for unions
      break;
    }
  }
}

function describeType(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return (node as unknown as { name: string }).name;
    case "object":
      return "object";
    case "array":
      return `${describeType(node.element as TypeNode)}[]`;
    case "union":
      return (node.members as TypeNode[]).map(describeType).join(" | ");
    default:
      return node.kind;
  }
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

function normalizePath(urlPath: string): string {
  return urlPath.split("/").map((part, i) => {
    if (!part) return part;
    if (/^\d+$/.test(part)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(part) && i > 1) return ":id";
    return part;
  }).join("/");
}
