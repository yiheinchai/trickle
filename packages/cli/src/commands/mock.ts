import * as http from "http";
import chalk from "chalk";
import { fetchMockConfig, MockRoute } from "../api-client";
import { isLocalMode, getLocalMockRoutes } from "../local-data";

export interface MockOptions {
  port?: string;
  cors?: boolean;
  local?: boolean;
}

/**
 * Convert an Express-style path like `/api/users/:id` to a regex
 * that captures named path params.
 */
function pathToRegex(routePath: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = routePath.replace(/:(\w+)/g, (_match, paramName) => {
    paramNames.push(paramName);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

/**
 * Build a description of the mock server routes for the startup banner.
 */
function formatRouteTable(routes: MockRoute[]): string {
  const lines: string[] = [];
  const methodColors: Record<string, (s: string) => string> = {
    GET: chalk.green,
    POST: chalk.yellow,
    PUT: chalk.blue,
    DELETE: chalk.red,
    PATCH: chalk.magenta,
  };

  for (const route of routes) {
    const color = methodColors[route.method] || chalk.white;
    const method = color(route.method.padEnd(7));
    const path = chalk.white(route.path);
    const age = formatTimeAgo(route.observedAt);
    lines.push(`    ${method} ${path}  ${chalk.gray(`(sample from ${age})`)}`);
  }

  return lines.join("\n");
}

function formatTimeAgo(isoDate: string): string {
  try {
    const date = new Date(isoDate.replace(" ", "T") + (isoDate.includes("Z") ? "" : "Z"));
    const now = Date.now();
    const diffSec = Math.floor((now - date.getTime()) / 1000);
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

/**
 * Substitute path params in sample output to match the requested values.
 * For example, if the sample output has { id: 1 } but the request has :id = "42",
 * replace numeric id fields with the requested value.
 */
function substituteSampleOutput(
  sample: unknown,
  paramValues: Record<string, string>,
): unknown {
  if (sample === null || sample === undefined) return sample;
  if (typeof sample !== "object") return sample;

  if (Array.isArray(sample)) {
    return sample.map((item) => substituteSampleOutput(item, paramValues));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
    // If this key matches a path param name, substitute the value
    if (key in paramValues) {
      const paramVal = paramValues[key];
      // Try to preserve the original type (number vs string)
      if (typeof value === "number") {
        const num = Number(paramVal);
        result[key] = isNaN(num) ? paramVal : num;
      } else {
        result[key] = paramVal;
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = substituteSampleOutput(value, paramValues);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function mockCommand(opts: MockOptions): Promise<void> {
  const port = parseInt(opts.port || "3000", 10);
  const enableCors = opts.cors !== false;

  // Fetch mock configuration from the backend (or local file)
  let routes: MockRoute[];
  try {
    if (isLocalMode(opts)) {
      const config = getLocalMockRoutes();
      routes = config.routes;
    } else {
      const config = await fetchMockConfig();
      routes = config.routes;
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error fetching mock config: ${err.message}\n`));
    }
    process.exit(1);
  }

  if (routes.length === 0) {
    console.log("");
    console.log(chalk.yellow("  No API routes found."));
    console.log(chalk.gray("  Instrument your app and make some requests first."));
    console.log("");
    process.exit(0);
  }

  // Build route matchers
  const matchers = routes.map((route) => {
    const { regex, paramNames } = pathToRegex(route.path);
    return { route, regex, paramNames };
  });

  // Create the mock HTTP server
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
    const reqMethod = (req.method || "GET").toUpperCase();
    const reqPath = reqUrl.pathname;

    // CORS headers
    if (enableCors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    // Handle preflight
    if (reqMethod === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Find matching route
    for (const { route, regex, paramNames } of matchers) {
      if (route.method !== reqMethod) continue;

      const match = reqPath.match(regex);
      if (!match) continue;

      // Extract path params
      const paramValues: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        paramValues[paramNames[i]] = match[i + 1];
      }

      // Get sample output, substituting path param values
      let output = route.sampleOutput;
      if (output && Object.keys(paramValues).length > 0) {
        output = substituteSampleOutput(output, paramValues);
      }

      // Log the request
      const methodColor =
        reqMethod === "GET" ? chalk.green :
        reqMethod === "POST" ? chalk.yellow :
        reqMethod === "PUT" ? chalk.blue :
        reqMethod === "DELETE" ? chalk.red :
        chalk.white;
      console.log(
        `  ${chalk.gray(new Date().toLocaleTimeString())} ${methodColor(reqMethod.padEnd(7))} ${reqPath} ${chalk.gray("→ 200")}`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(output ?? {}));
      return;
    }

    // No route matched
    console.log(
      `  ${chalk.gray(new Date().toLocaleTimeString())} ${chalk.red(reqMethod.padEnd(7))} ${reqPath} ${chalk.red("→ 404")}`,
    );
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: reqPath, method: reqMethod }));
  });

  server.listen(port, () => {
    console.log("");
    console.log(chalk.bold("  Trickle Mock Server"));
    console.log("");
    console.log(chalk.gray("  Routes (from runtime observations):"));
    console.log(formatRouteTable(routes));
    console.log("");
    console.log(`  Listening on ${chalk.cyan(`http://localhost:${port}`)}`);
    if (enableCors) {
      console.log(chalk.gray("  CORS enabled (Access-Control-Allow-Origin: *)"));
    }
    console.log(chalk.gray("  Press Ctrl+C to stop.\n"));
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.gray("\n  Stopping mock server...\n"));
    server.close(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  // Keep process alive
  await new Promise(() => {});
}
