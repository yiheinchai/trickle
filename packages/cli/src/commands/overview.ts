import chalk from "chalk";
import { listFunctions, listTypes, FunctionRow, TypeSnapshot } from "../api-client";
import { getBackendUrl } from "../config";
import { relativeTime } from "../ui/helpers";
import { isLocalMode, getLocalFunctions, getLocalTypes } from "../local-data";

export interface OverviewOptions {
  env?: string;
  json?: boolean;
  local?: boolean;
}

interface TypeNode {
  kind: string;
  [key: string]: unknown;
}

interface RouteInfo {
  name: string;
  method: string;
  path: string;
  module: string;
  environment: string;
  lastSeen: string;
  argsSignature: string;
  returnSignature: string;
  fieldCount: number;
}

/**
 * `trickle overview` — Compact API overview with inline type signatures.
 *
 * Shows all observed routes with their return type shapes, making it easy to
 * understand your entire API surface at a glance. Like `git log --oneline` for APIs.
 */
export async function overviewCommand(opts: OverviewOptions): Promise<void> {
  const local = isLocalMode(opts);
  const backendUrl = local ? "(local)" : getBackendUrl();

  if (!local) {
    // Check backend
    try {
      const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error("not ok");
    } catch {
      console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
      process.exit(1);
    }
  }

  // Fetch all functions
  const result = local
    ? getLocalFunctions({ env: opts.env, limit: 500 })
    : await listFunctions({ env: opts.env, limit: 500 });
  const { functions } = result;

  if (functions.length === 0) {
    console.log(chalk.yellow("\n  No observed routes yet."));
    console.log(chalk.gray("  Run ") + chalk.white("trickle capture") + chalk.gray(" or ") + chalk.white("trickle dev") + chalk.gray(" to start observing.\n"));
    return;
  }

  // Fetch latest type snapshot for each function
  const routes: RouteInfo[] = [];
  for (const fn of functions) {
    try {
      const typesResult = local
        ? getLocalTypes(fn.function_name, { env: opts.env, limit: 1 })
        : await listTypes(fn.id, { env: opts.env, limit: 1 });
      const snapshot = typesResult.snapshots[0];

      const returnType = snapshot
        ? (typeof snapshot.return_type === "string"
          ? JSON.parse(snapshot.return_type)
          : snapshot.return_type) as TypeNode
        : null;

      const argsType = snapshot
        ? (typeof snapshot.args_type === "string"
          ? JSON.parse(snapshot.args_type)
          : snapshot.args_type) as TypeNode
        : null;

      const { method, path: routePath } = parseRoute(fn.function_name);

      routes.push({
        name: fn.function_name,
        method,
        path: routePath,
        module: fn.module,
        environment: fn.environment,
        lastSeen: fn.last_seen_at,
        argsSignature: argsType ? compactSignature(argsType, 60) : "",
        returnSignature: returnType ? compactSignature(returnType, 60) : "unknown",
        fieldCount: returnType ? countFields(returnType) : 0,
      });
    } catch {
      // Skip functions with errors
      const { method, path: routePath } = parseRoute(fn.function_name);
      routes.push({
        name: fn.function_name,
        method,
        path: routePath,
        module: fn.module,
        environment: fn.environment,
        lastSeen: fn.last_seen_at,
        argsSignature: "",
        returnSignature: "?",
        fieldCount: 0,
      });
    }
  }

  // JSON output
  if (opts.json) {
    console.log(JSON.stringify({ routes, total: routes.length }, null, 2));
    return;
  }

  // Group by module
  const byModule = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    const mod = r.module || "default";
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(r);
  }

  console.log("");
  console.log(chalk.bold("  trickle overview"));
  console.log(chalk.gray("  " + "─".repeat(60)));
  console.log(chalk.gray(`  ${routes.length} route${routes.length === 1 ? "" : "s"} observed`));
  if (opts.env) {
    console.log(chalk.gray(`  Environment: ${opts.env}`));
  }
  console.log(chalk.gray("  " + "─".repeat(60)));

  // Find the longest method for alignment
  const maxMethodLen = Math.max(...routes.map((r) => r.method.length));
  const maxPathLen = Math.min(30, Math.max(...routes.map((r) => r.path.length)));

  for (const [mod, modRoutes] of byModule) {
    console.log("");
    if (byModule.size > 1) {
      console.log(chalk.gray(`  ┌─ ${mod}`));
    }

    // Sort routes: GET before POST before PUT before DELETE, then by path
    const methodOrder: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
    modRoutes.sort((a, b) => {
      const orderA = methodOrder[a.method] ?? 5;
      const orderB = methodOrder[b.method] ?? 5;
      if (orderA !== orderB) return orderA - orderB;
      return a.path.localeCompare(b.path);
    });

    for (const route of modRoutes) {
      const methodColor = getMethodColor(route.method);
      const methodStr = route.method.padEnd(maxMethodLen);
      const pathStr = route.path.padEnd(maxPathLen);
      const age = relativeTime(route.lastSeen);

      // Build the line
      const prefix = byModule.size > 1 ? "  │ " : "  ";
      const line =
        prefix +
        methodColor(methodStr) +
        " " +
        chalk.white(pathStr) +
        chalk.gray(" → ") +
        chalk.cyan(route.returnSignature) +
        chalk.gray(`  ${age}`);

      console.log(line);

      // Show request body if present and non-empty
      if (route.argsSignature && route.argsSignature !== "{ }") {
        const argsLine =
          prefix +
          " ".repeat(maxMethodLen) +
          " " +
          " ".repeat(maxPathLen) +
          chalk.gray(" ← ") +
          chalk.yellow(route.argsSignature);
        console.log(argsLine);
      }
    }

    if (byModule.size > 1) {
      console.log(chalk.gray("  └─"));
    }
  }

  console.log("");
  const totalFields = routes.reduce((sum, r) => sum + r.fieldCount, 0);
  console.log(
    chalk.gray(`  ${routes.length} routes, ${totalFields} fields observed`) +
    chalk.gray(` · ${backendUrl}`),
  );
  console.log("");
}

function parseRoute(functionName: string): { method: string; path: string } {
  const spaceIdx = functionName.indexOf(" ");
  if (spaceIdx > 0) {
    return {
      method: functionName.slice(0, spaceIdx),
      path: functionName.slice(spaceIdx + 1),
    };
  }
  return { method: "", path: functionName };
}

function getMethodColor(method: string): (s: string) => string {
  switch (method) {
    case "GET": return chalk.green;
    case "POST": return chalk.yellow;
    case "PUT": return chalk.blue;
    case "PATCH": return chalk.magenta;
    case "DELETE": return chalk.red;
    default: return chalk.white;
  }
}

/**
 * Render a compact type signature from a TypeNode.
 * Truncates to maxLen characters.
 */
function compactSignature(node: TypeNode, maxLen: number): string {
  const sig = renderCompact(node);
  if (sig.length <= maxLen) return sig;
  return sig.slice(0, maxLen - 1) + "…";
}

function renderCompact(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return node.name as string;

    case "object": {
      const props = node.properties as Record<string, TypeNode>;
      const keys = Object.keys(props);
      if (keys.length === 0) return "{ }";

      const parts: string[] = [];
      for (const key of keys) {
        const val = props[key];
        const valStr = renderCompactShort(val);
        parts.push(`${key}: ${valStr}`);
      }

      const full = `{ ${parts.join(", ")} }`;
      if (full.length <= 60) return full;

      // Truncate: show first few fields
      let result = "{ ";
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) result += ", ";
        if (result.length + parts[i].length > 55 && i > 0) {
          result += `…+${parts.length - i}`;
          break;
        }
        result += parts[i];
      }
      return result + " }";
    }

    case "array": {
      const element = node.element as TypeNode;
      return `${renderCompact(element)}[]`;
    }

    case "union": {
      const members = node.members as TypeNode[];
      return members.map(renderCompactShort).join(" | ");
    }

    default:
      return node.kind;
  }
}

function renderCompactShort(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return node.name as string;
    case "object": {
      const props = node.properties as Record<string, TypeNode>;
      const keys = Object.keys(props);
      if (keys.length === 0) return "{}";
      if (keys.length <= 3) {
        return `{${keys.join(", ")}}`;
      }
      return `{${keys.slice(0, 2).join(", ")}, …+${keys.length - 2}}`;
    }
    case "array":
      return `${renderCompactShort(node.element as TypeNode)}[]`;
    case "union": {
      const members = node.members as TypeNode[];
      return members.map(renderCompactShort).join(" | ");
    }
    default:
      return node.kind;
  }
}

function countFields(node: TypeNode): number {
  if (node.kind === "object") {
    const props = node.properties as Record<string, TypeNode>;
    let count = Object.keys(props).length;
    for (const val of Object.values(props)) {
      count += countFields(val);
    }
    return count;
  }
  if (node.kind === "array") {
    return countFields(node.element as TypeNode);
  }
  return 0;
}
