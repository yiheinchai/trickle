import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import chalk from "chalk";
import { getBackendUrl } from "../config";

export interface ProxyOptions {
  target: string;
  port?: string;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

/**
 * `trickle proxy` — Transparent reverse proxy that captures API types.
 *
 * Sits between the frontend and backend, forwarding all requests while
 * observing request/response shapes and sending type observations to
 * the trickle backend. Works with any backend language or framework —
 * no instrumentation needed.
 */
export async function proxyCommand(opts: ProxyOptions): Promise<void> {
  const targetUrl = opts.target;
  if (!targetUrl) {
    console.error(chalk.red("\n  Missing --target flag."));
    console.error(chalk.gray("  Usage: trickle proxy --target http://localhost:3000\n"));
    process.exit(1);
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    console.error(chalk.red(`\n  Invalid target URL: ${targetUrl}\n`));
    process.exit(1);
  }

  const port = parseInt(opts.port || "4000", 10);
  const backendUrl = getBackendUrl();

  // Check backend connectivity
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`));
    console.error(chalk.gray("  Start the backend first.\n"));
    process.exit(1);
  }

  let requestCount = 0;
  let typesSent = 0;

  const server = http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const urlPath = req.url || "/";

    // Read request body
    const reqBody = await readBody(req);
    let reqJson: unknown = undefined;
    if (reqBody.length > 0) {
      try {
        reqJson = JSON.parse(reqBody.toString("utf-8"));
      } catch {
        // Not JSON — skip type capture for request body
      }
    }

    // Forward to target
    const targetReqUrl = new URL(urlPath, targetUrl);
    const isHttps = parsedTarget.protocol === "https:";
    const mod = isHttps ? https : http;

    const proxyReq = mod.request(
      targetReqUrl.toString(),
      {
        method,
        headers: {
          ...req.headers,
          host: parsedTarget.host,
        },
      },
      (proxyRes) => {
        // Read response body
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const resBody = Buffer.concat(chunks);

          // Forward response to client
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          res.end(resBody);

          requestCount++;

          // Parse response JSON for type capture
          let resJson: unknown = undefined;
          const contentType = proxyRes.headers["content-type"] || "";
          if (contentType.includes("json") && resBody.length > 0) {
            try {
              resJson = JSON.parse(resBody.toString("utf-8"));
            } catch {
              // Not valid JSON
            }
          }

          // Only capture types for JSON API-like routes
          if (resJson !== undefined && isApiRoute(urlPath)) {
            captureTypes(method, urlPath, reqJson, resJson, backendUrl).then((sent) => {
              if (sent) typesSent++;
            }).catch(() => {});

            // Log
            const status = proxyRes.statusCode || 200;
            const statusColor = status < 400 ? chalk.green : chalk.red;
            console.log(
              chalk.gray(`  ${chalk.bold(method)} ${urlPath} → `) +
              statusColor(`${status}`) +
              chalk.gray(` (${typesSent} types captured)`),
            );
          }
        });
      },
    );

    proxyReq.on("error", (err) => {
      console.error(chalk.red(`  Proxy error: ${err.message}`));
      res.writeHead(502);
      res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
    });

    if (reqBody.length > 0) {
      proxyReq.write(reqBody);
    }
    proxyReq.end();
  });

  server.listen(port, () => {
    console.log("");
    console.log(chalk.bold("  trickle proxy"));
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log(chalk.gray(`  Proxy:    http://localhost:${port}`));
    console.log(chalk.gray(`  Target:   ${targetUrl}`));
    console.log(chalk.gray(`  Backend:  ${backendUrl}`));
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log(chalk.gray("  Point your frontend at the proxy URL."));
    console.log(chalk.gray("  Press Ctrl+C to stop.\n"));
  });

  process.on("SIGINT", () => {
    console.log(chalk.gray(`\n  Shutting down... (${requestCount} requests, ${typesSent} types captured)`));
    server.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

function readBody(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/**
 * Heuristic: only capture types for API-like routes (not static assets).
 */
function isApiRoute(urlPath: string): boolean {
  const path = urlPath.split("?")[0];
  // Skip obvious static assets
  if (/\.(js|css|html|png|jpg|gif|svg|ico|woff|woff2|ttf|eot|map)$/i.test(path)) {
    return false;
  }
  // Include /api/ routes always
  if (path.includes("/api/")) return true;
  // Include anything that doesn't look like a file
  if (!path.includes(".")) return true;
  return false;
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
    case "bigint":  return { kind: "primitive", name: "bigint" };
    case "symbol":  return { kind: "primitive", name: "symbol" };
    case "function": return { kind: "function", params: [], returnType: { kind: "unknown" } };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    // Infer element type from first element
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
 * Normalize URL path: replace dynamic segments like /users/123 with :param patterns.
 * Uses heuristics: numeric segments and UUID-like segments become params.
 */
function normalizePath(urlPath: string): string {
  const path = urlPath.split("?")[0];
  const parts = path.split("/");
  return parts
    .map((part, i) => {
      if (!part) return part;
      // Numeric IDs
      if (/^\d+$/.test(part)) return ":id";
      // UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ":id";
      // Short hex hashes
      if (/^[0-9a-f]{16,}$/i.test(part) && i > 1) return ":id";
      return part;
    })
    .join("/");
}

/**
 * Compute a SHA-256 hash (16 hex chars) for type dedup.
 */
function computeTypeHash(argsType: TypeNode, returnType: TypeNode): string {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Send captured types to the trickle backend.
 */
async function captureTypes(
  method: string,
  urlPath: string,
  reqJson: unknown,
  resJson: unknown,
  backendUrl: string,
): Promise<boolean> {
  const normalizedPath = normalizePath(urlPath);
  const functionName = `${method} ${normalizedPath}`;

  // Build argsType: { body, params, query }
  const argsProperties: Record<string, TypeNode> = {};

  if (reqJson !== undefined && reqJson !== null) {
    argsProperties.body = jsonToTypeNode(reqJson);
  }

  // Extract query params
  const queryStart = urlPath.indexOf("?");
  if (queryStart !== -1) {
    const searchParams = new URLSearchParams(urlPath.slice(queryStart + 1));
    const queryProps: Record<string, TypeNode> = {};
    for (const [key] of searchParams) {
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
    module: "proxy",
    language: "js",
    environment: "development",
    typeHash,
    argsType,
    returnType,
    sampleInput: reqJson !== undefined ? (Object.keys(argsProperties).length > 0 ? argsProperties : undefined) : undefined,
    sampleOutput: resJson,
  };

  try {
    const res = await fetch(`${backendUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
