import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchMockConfig, MockRoute } from "../api-client";
import { isLocalMode, getLocalMockRoutes } from "../local-data";

export interface SampleOptions {
  format?: string;
  out?: string;
  route?: string;
  local?: boolean;
}

/**
 * `trickle sample` — Generate test fixtures from observed runtime data.
 *
 * Produces JSON, TypeScript constants, or factory functions from the
 * actual sample inputs and outputs captured by trickle. Great for tests,
 * seed scripts, and Storybook data.
 */
export async function sampleCommand(routeFilter: string | undefined, opts: SampleOptions): Promise<void> {
  let routes: MockRoute[];
  if (isLocalMode(opts)) {
    routes = getLocalMockRoutes().routes;
  } else {
    try {
      const config = await fetchMockConfig();
      routes = config.routes;
    } catch {
      console.error(chalk.red("\n  Cannot connect to trickle backend."));
      console.error(chalk.gray("  Is the backend running?\n"));
      process.exit(1);
    }
  }

  // Filter routes
  if (routeFilter) {
    const filter = routeFilter.toLowerCase();
    routes = routes.filter((r) =>
      r.functionName.toLowerCase().includes(filter) ||
      r.path.toLowerCase().includes(filter),
    );
  }

  // Only include routes with sample data
  routes = routes.filter((r) => r.sampleOutput !== null && r.sampleOutput !== undefined);

  if (routes.length === 0) {
    console.error(chalk.yellow("\n  No sample data found."));
    if (routeFilter) {
      console.error(chalk.gray(`  No routes matching "${routeFilter}" with sample data.\n`));
    } else {
      console.error(chalk.gray("  Instrument your app and make some requests first.\n"));
    }
    process.exit(0);
  }

  const format = (opts.format || "json").toLowerCase();
  let output: string;

  switch (format) {
    case "json":
      output = generateJson(routes);
      break;
    case "ts":
    case "typescript":
      output = generateTypeScript(routes);
      break;
    case "factory":
      output = generateFactories(routes);
      break;
    default:
      console.error(chalk.red(`\n  Unknown format: ${format}`));
      console.error(chalk.gray("  Supported: json, ts, factory\n"));
      process.exit(1);
  }

  if (opts.out) {
    const resolvedPath = path.resolve(opts.out);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, output, "utf-8");
    console.log(chalk.green(`\n  Fixtures written to ${chalk.bold(opts.out)}`));
    console.log(chalk.gray(`  ${routes.length} routes, format: ${format}\n`));
  } else {
    console.log(output);
  }
}

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ── JSON format ──

function generateJson(routes: MockRoute[]): string {
  const samples: Record<string, { request?: unknown; response: unknown }> = {};

  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const entry: { request?: unknown; response: unknown } = {
      response: route.sampleOutput,
    };

    if (route.sampleInput) {
      const input = route.sampleInput as Record<string, unknown>;
      const body = input.body || input;
      if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
        entry.request = body;
      }
    }

    samples[key] = entry;
  }

  return JSON.stringify(samples, null, 2) + "\n";
}

// ── TypeScript constants ──

function generateTypeScript(routes: MockRoute[]): string {
  const lines: string[] = [];
  lines.push("// Auto-generated test fixtures by trickle");
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push("// Do not edit manually — re-run `trickle sample --format ts` to update");
  lines.push("");

  for (const route of routes) {
    const varName = toCamelCase(route.functionName);

    // Response sample
    lines.push(`/** Sample response for ${route.method} ${route.path} */`);
    lines.push(`export const ${varName}Response = ${formatValue(route.sampleOutput, 0)} as const;`);
    lines.push("");

    // Request body sample (for POST/PUT/PATCH)
    if (["POST", "PUT", "PATCH"].includes(route.method) && route.sampleInput) {
      const input = route.sampleInput as Record<string, unknown>;
      const body = input.body || input;
      if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
        lines.push(`/** Sample request body for ${route.method} ${route.path} */`);
        lines.push(`export const ${varName}Request = ${formatValue(body, 0)} as const;`);
        lines.push("");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Factory functions ──

function generateFactories(routes: MockRoute[]): string {
  const lines: string[] = [];
  lines.push("// Auto-generated test fixture factories by trickle");
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push("// Do not edit manually — re-run `trickle sample --format factory` to update");
  lines.push("");

  // First emit the base samples as constants
  for (const route of routes) {
    const varName = toCamelCase(route.functionName);

    lines.push(`const _${varName}Response = ${formatValue(route.sampleOutput, 0)};`);
    lines.push("");

    if (["POST", "PUT", "PATCH"].includes(route.method) && route.sampleInput) {
      const input = route.sampleInput as Record<string, unknown>;
      const body = input.body || input;
      if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
        lines.push(`const _${varName}Request = ${formatValue(body, 0)};`);
        lines.push("");
      }
    }
  }

  // Then emit factory functions
  for (const route of routes) {
    const varName = toCamelCase(route.functionName);
    const typeName = toPascalCase(route.functionName);

    // Response factory
    if (route.sampleOutput && typeof route.sampleOutput === "object" && !Array.isArray(route.sampleOutput)) {
      lines.push(`/** Create a test fixture for ${route.method} ${route.path} response */`);
      lines.push(`export function create${typeName}Response(overrides?: Partial<typeof _${varName}Response>): typeof _${varName}Response {`);
      lines.push(`  return { ..._${varName}Response, ...overrides };`);
      lines.push(`}`);
      lines.push("");
    } else {
      // For non-object responses (arrays, primitives), just export the constant
      lines.push(`/** Sample response for ${route.method} ${route.path} */`);
      lines.push(`export const ${varName}Response = _${varName}Response;`);
      lines.push("");
    }

    // Request body factory
    if (["POST", "PUT", "PATCH"].includes(route.method) && route.sampleInput) {
      const input = route.sampleInput as Record<string, unknown>;
      const body = input.body || input;
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).length > 0) {
        lines.push(`/** Create a test fixture for ${route.method} ${route.path} request body */`);
        lines.push(`export function create${typeName}Request(overrides?: Partial<typeof _${varName}Request>): typeof _${varName}Request {`);
        lines.push(`  return { ..._${varName}Request, ...overrides };`);
        lines.push(`}`);
        lines.push("");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Value formatting ──

function formatValue(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length === 1 && typeof value[0] !== "object") {
      return `[${formatValue(value[0], 0)}]`;
    }
    const items = value.map((v) => `${innerPad}${formatValue(v, indent + 1)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";

    const entries = keys.map((key) => {
      const formattedVal = formatValue(obj[key], indent + 1);
      // Use identifier-safe keys without quotes, quoted otherwise
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `${innerPad}${safeKey}: ${formattedVal}`;
    });
    return `{\n${entries.join(",\n")}\n${pad}}`;
  }

  return JSON.stringify(value);
}
