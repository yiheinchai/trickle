import chalk from "chalk";
import { fetchMockConfig, MockRoute } from "../api-client";
import { isLocalMode, getLocalMockRoutes } from "../local-data";

export interface ReplayOptions {
  target?: string;
  strict?: boolean;
  json?: boolean;
  failFast?: boolean;
  local?: boolean;
}

interface ReplayResult {
  method: string;
  path: string;
  status: "pass" | "fail" | "error";
  httpStatus?: number;
  message?: string;
  expectedKeys?: string[];
  actualKeys?: string[];
  durationMs: number;
}

/**
 * `trickle replay` — Replay captured API requests as regression tests.
 *
 * Uses the sample inputs/outputs already captured by trickle to replay
 * requests against a running server and verify response shapes match.
 * Developers get free regression tests without writing any test code.
 */
export async function replayCommand(opts: ReplayOptions): Promise<void> {
  const target = opts.target || "http://localhost:3000";

  // Fetch observed routes
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

  if (routes.length === 0) {
    console.error(chalk.yellow("\n  No observed routes to replay."));
    console.error(chalk.gray("  Instrument your app and make some requests first.\n"));
    process.exit(0);
  }

  if (!opts.json) {
    console.log("");
    console.log(chalk.bold("  trickle replay"));
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log(chalk.gray(`  Target:  ${target}`));
    console.log(chalk.gray(`  Routes:  ${routes.length}`));
    console.log(chalk.gray(`  Mode:    ${opts.strict ? "strict (exact values)" : "shape (structural match)"}`));
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log("");
  }

  const results: ReplayResult[] = [];

  for (const route of routes) {
    const result = await replayRoute(route, target, opts.strict || false);
    results.push(result);

    if (!opts.json) {
      const icon = result.status === "pass"
        ? chalk.green("✓")
        : result.status === "fail"
          ? chalk.red("✗")
          : chalk.yellow("!");
      const statusStr = result.httpStatus ? chalk.gray(` [${result.httpStatus}]`) : "";
      const timeStr = chalk.gray(` ${result.durationMs}ms`);
      const msg = result.message ? chalk.gray(` — ${result.message}`) : "";
      console.log(`  ${icon} ${chalk.bold(route.method)} ${route.path}${statusStr}${timeStr}${msg}`);
    }

    if (opts.failFast && result.status !== "pass") {
      break;
    }
  }

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;

  if (opts.json) {
    console.log(JSON.stringify({
      target,
      mode: opts.strict ? "strict" : "shape",
      total: results.length,
      passed,
      failed,
      errors,
      results,
    }, null, 2));
  } else {
    console.log("");
    console.log(chalk.gray("  " + "─".repeat(50)));
    if (failed === 0 && errors === 0) {
      console.log(chalk.green(`  ${passed}/${results.length} passed`) + chalk.gray(` — all routes match`));
    } else {
      const parts: string[] = [];
      if (passed > 0) parts.push(chalk.green(`${passed} passed`));
      if (failed > 0) parts.push(chalk.red(`${failed} failed`));
      if (errors > 0) parts.push(chalk.yellow(`${errors} errors`));
      console.log(`  ${parts.join(", ")} out of ${results.length} routes`);
    }
    console.log("");
  }

  if (failed > 0 || errors > 0) {
    process.exit(1);
  }
}

async function replayRoute(
  route: MockRoute,
  target: string,
  strict: boolean,
): Promise<ReplayResult> {
  const { method, path: routePath } = route;

  // Build URL — replace :param patterns with sample values if available
  let url = routePath;
  if (route.sampleInput && typeof route.sampleInput === "object") {
    const input = route.sampleInput as Record<string, unknown>;
    const params = input.params as Record<string, string> | undefined;
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url = url.replace(`:${key}`, String(value));
      }
    }
  }
  // Replace any remaining :params with "1" as fallback
  url = url.replace(/:(\w+)/g, "1");

  const fullUrl = `${target}${url}`;
  const start = Date.now();

  try {
    // Build request
    const fetchOpts: RequestInit = { method };
    const hasBody = ["POST", "PUT", "PATCH"].includes(method);

    if (hasBody && route.sampleInput) {
      const input = route.sampleInput as Record<string, unknown>;
      const body = input.body || input;
      if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
        fetchOpts.headers = { "Content-Type": "application/json" };
        fetchOpts.body = JSON.stringify(body);
      }
    }

    const res = await fetch(fullUrl, {
      ...fetchOpts,
      signal: AbortSignal.timeout(10000),
    });
    const durationMs = Date.now() - start;

    if (!res.ok) {
      return {
        method, path: routePath, status: "fail",
        httpStatus: res.status,
        message: `HTTP ${res.status}`,
        durationMs,
      };
    }

    // Parse response
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      return {
        method, path: routePath, status: "pass",
        httpStatus: res.status,
        message: "non-JSON response",
        durationMs,
      };
    }

    const actual = await res.json();

    if (!route.sampleOutput) {
      return {
        method, path: routePath, status: "pass",
        httpStatus: res.status,
        durationMs,
      };
    }

    // Compare
    if (strict) {
      return compareStrict(method, routePath, route.sampleOutput, actual, res.status, durationMs);
    } else {
      return compareShape(method, routePath, route.sampleOutput, actual, res.status, durationMs);
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      method, path: routePath, status: "error",
      message: message.includes("ECONNREFUSED") ? "connection refused" : message,
      durationMs,
    };
  }
}

/**
 * Shape comparison: verify that the actual response has the same structure
 * (same keys, same types) as the expected sample output.
 */
function compareShape(
  method: string,
  path: string,
  expected: unknown,
  actual: unknown,
  httpStatus: number,
  durationMs: number,
): ReplayResult {
  const mismatches = findShapeMismatches(expected, actual, "");

  if (mismatches.length === 0) {
    return { method, path, status: "pass", httpStatus, durationMs };
  }

  return {
    method, path, status: "fail", httpStatus,
    message: mismatches[0],
    durationMs,
  };
}

function findShapeMismatches(expected: unknown, actual: unknown, prefix: string): string[] {
  const mismatches: string[] = [];

  if (expected === null || expected === undefined) {
    return mismatches;
  }

  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);

  if (expectedType !== actualType) {
    mismatches.push(`${prefix || "root"}: expected ${expectedType}, got ${actualType}`);
    return mismatches;
  }

  if (expectedType === "object") {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedObj).sort();
    const actualKeys = Object.keys(actualObj).sort();

    // Check for missing keys
    for (const key of expectedKeys) {
      if (!(key in actualObj)) {
        mismatches.push(`${prefix ? prefix + "." : ""}${key}: missing`);
      } else {
        // Recurse (limit depth to avoid noise)
        if (prefix.split(".").length < 3) {
          mismatches.push(
            ...findShapeMismatches(expectedObj[key], actualObj[key], `${prefix ? prefix + "." : ""}${key}`),
          );
        }
      }
    }
  }

  if (expectedType === "array") {
    const expectedArr = expected as unknown[];
    const actualArr = actual as unknown[];
    if (expectedArr.length > 0 && actualArr.length > 0) {
      mismatches.push(
        ...findShapeMismatches(expectedArr[0], actualArr[0], `${prefix}[0]`),
      );
    }
  }

  return mismatches;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Strict comparison: verify exact value match.
 */
function compareStrict(
  method: string,
  path: string,
  expected: unknown,
  actual: unknown,
  httpStatus: number,
  durationMs: number,
): ReplayResult {
  // Deep compare, but be lenient with dynamic fields (ids, timestamps)
  const mismatches = findValueMismatches(expected, actual, "");

  if (mismatches.length === 0) {
    return { method, path, status: "pass", httpStatus, durationMs };
  }

  return {
    method, path, status: "fail", httpStatus,
    message: mismatches[0],
    durationMs,
  };
}

function findValueMismatches(expected: unknown, actual: unknown, prefix: string): string[] {
  const mismatches: string[] = [];

  if (expected === null || expected === undefined) return mismatches;

  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);

  if (expectedType !== actualType) {
    mismatches.push(`${prefix || "root"}: expected ${expectedType} got ${actualType}`);
    return mismatches;
  }

  if (expectedType === "object") {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;

    for (const key of Object.keys(expectedObj)) {
      if (!(key in actualObj)) {
        mismatches.push(`${prefix ? prefix + "." : ""}${key}: missing`);
      } else if (prefix.split(".").length < 3) {
        mismatches.push(
          ...findValueMismatches(expectedObj[key], actualObj[key], `${prefix ? prefix + "." : ""}${key}`),
        );
      }
    }
  } else if (expectedType === "array") {
    const expectedArr = expected as unknown[];
    const actualArr = actual as unknown[];
    if (expectedArr.length > 0 && actualArr.length > 0) {
      mismatches.push(
        ...findValueMismatches(expectedArr[0], actualArr[0], `${prefix}[0]`),
      );
    }
  } else {
    // Primitive comparison
    if (expected !== actual) {
      mismatches.push(`${prefix || "root"}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    }
  }

  return mismatches;
}
