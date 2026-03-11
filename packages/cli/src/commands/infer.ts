import * as fs from "fs";
import * as crypto from "crypto";
import chalk from "chalk";
import { getBackendUrl } from "../config";

export interface InferOptions {
  name: string;
  env?: string;
  module?: string;
  requestBody?: string;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

/**
 * `trickle infer <file>` — Infer types from a JSON file or stdin and store them.
 *
 * Reads JSON from a file (or stdin if file is "-" or omitted with piped input),
 * infers TypeNode from the data, and sends the observation to the trickle backend.
 * Works offline with saved API responses, test fixtures, or piped command output.
 */
export async function inferCommand(
  file: string | undefined,
  opts: InferOptions,
): Promise<void> {
  const backendUrl = getBackendUrl();

  // Check backend connectivity
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
    process.exit(1);
  }

  // Read JSON input
  let jsonText: string;
  let sourceName: string;

  if (!file || file === "-") {
    // Read from stdin
    if (process.stdin.isTTY) {
      console.error(chalk.red("\n  No input provided."));
      console.error(chalk.gray("  Pipe JSON via stdin or provide a file path:\n"));
      console.error(chalk.gray('  echo \'{"key":"value"}\' | trickle infer --name "GET /api/data"'));
      console.error(chalk.gray('  trickle infer response.json --name "GET /api/data"\n'));
      process.exit(1);
    }
    jsonText = await readStdin();
    sourceName = "stdin";
  } else {
    // Read from file
    if (!fs.existsSync(file)) {
      console.error(chalk.red(`\n  File not found: ${file}\n`));
      process.exit(1);
    }
    jsonText = fs.readFileSync(file, "utf-8");
    sourceName = file;
  }

  // Parse JSON
  let jsonData: unknown;
  try {
    jsonData = JSON.parse(jsonText.trim());
  } catch {
    console.error(chalk.red("\n  Input is not valid JSON.\n"));
    process.exit(1);
  }

  // Build type observations
  const functionName = opts.name;
  const returnType = jsonToTypeNode(jsonData);

  const argsProperties: Record<string, TypeNode> = {};

  // Parse request body example if provided
  if (opts.requestBody) {
    try {
      const reqJson = JSON.parse(opts.requestBody);
      argsProperties.body = jsonToTypeNode(reqJson);
    } catch {
      console.error(chalk.red("\n  --request-body is not valid JSON.\n"));
      process.exit(1);
    }
  }

  const argsType: TypeNode = Object.keys(argsProperties).length > 0
    ? { kind: "object", properties: argsProperties }
    : { kind: "object", properties: {} };

  const typeHash = computeTypeHash(argsType, returnType);

  const payload = {
    functionName,
    module: opts.module || "infer",
    language: "js",
    environment: opts.env || "development",
    typeHash,
    argsType,
    returnType,
    sampleInput: Object.keys(argsProperties).length > 0 ? argsProperties : undefined,
    sampleOutput: jsonData,
  };

  // Send to backend
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

  console.log("");
  console.log(chalk.bold("  trickle infer"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Source:   `) + chalk.white(sourceName));
  console.log(chalk.gray(`  Name:     `) + chalk.white(functionName));
  console.log(chalk.gray(`  Backend:  `) + chalk.white(backendUrl));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.green("  Types inferred and stored successfully!"));

  // Show a preview of the inferred shape
  const shape = describeShape(returnType, 1);
  console.log("");
  console.log(chalk.gray("  Inferred shape:"));
  for (const line of shape) {
    console.log(chalk.gray("    ") + line);
  }

  if (opts.requestBody) {
    const reqShape = describeShape(argsProperties.body, 1);
    console.log("");
    console.log(chalk.gray("  Request body shape:"));
    for (const line of reqShape) {
      console.log(chalk.gray("    ") + line);
    }
  }

  console.log("");
  console.log(chalk.gray("  Run ") + chalk.white("trickle codegen") + chalk.gray(" to generate type definitions."));
  console.log("");
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    // Timeout after 10 seconds
    setTimeout(() => {
      if (data.length === 0) {
        reject(new Error("No input received from stdin"));
      } else {
        resolve(data);
      }
    }, 10000);
  });
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

function computeTypeHash(argsType: TypeNode, returnType: TypeNode): string {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Describe a TypeNode shape as human-readable lines.
 */
function describeShape(node: TypeNode, maxDepth: number, depth: number = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  if (node.kind === "primitive") {
    lines.push(indent + chalk.cyan(node.name as string));
  } else if (node.kind === "array") {
    const element = node.element as TypeNode;
    if (element.kind === "object" && depth < maxDepth) {
      lines.push(indent + chalk.yellow("Array<{"));
      const subLines = describeShape(element, maxDepth, depth + 1);
      lines.push(...subLines);
      lines.push(indent + chalk.yellow("}>"));
    } else {
      lines.push(indent + chalk.yellow(`${describeTypeCompact(element)}[]`));
    }
  } else if (node.kind === "object") {
    const props = node.properties as Record<string, TypeNode>;
    const keys = Object.keys(props);
    if (keys.length === 0) {
      lines.push(indent + chalk.gray("{}"));
    } else {
      for (const key of keys) {
        const propType = props[key];
        const typeStr = describeTypeCompact(propType);
        lines.push(indent + chalk.white(key) + chalk.gray(": ") + chalk.cyan(typeStr));
      }
    }
  } else {
    lines.push(indent + chalk.gray(node.kind));
  }

  return lines;
}

function describeTypeCompact(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return node.name as string;
    case "array": {
      const element = node.element as TypeNode;
      return `${describeTypeCompact(element)}[]`;
    }
    case "object": {
      const props = node.properties as Record<string, TypeNode>;
      const keys = Object.keys(props);
      if (keys.length === 0) return "{}";
      if (keys.length <= 3) {
        const inner = keys.map((k) => `${k}: ${describeTypeCompact(props[k])}`).join(", ");
        return `{ ${inner} }`;
      }
      return `{ ${keys.slice(0, 2).map((k) => `${k}: ${describeTypeCompact(props[k])}`).join(", ")}, ... }`;
    }
    default:
      return node.kind;
  }
}
