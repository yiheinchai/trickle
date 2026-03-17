import chalk from "chalk";
import { getBackendUrl } from "../config";
import { isLocalMode, searchLocalObservations } from "../local-data";

export interface SearchOptions {
  env?: string;
  json?: boolean;
  local?: boolean;
}

interface FieldMatch {
  path: string;
  kind: string;
  typeName?: string;
}

interface SearchResult {
  functionName: string;
  module: string;
  environment: string;
  lastSeen: string;
  matches: FieldMatch[];
}

interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
}

export async function searchCommand(
  query: string,
  opts: SearchOptions,
): Promise<void> {
  let data: SearchResponse;

  if (isLocalMode(opts)) {
    data = searchLocalObservations(query, { env: opts.env });
  } else {
    const backendUrl = getBackendUrl();
    const url = new URL("/api/search", backendUrl);
    url.searchParams.set("q", query);
    if (opts.env) {
      url.searchParams.set("env", opts.env);
    }

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      data = await res.json() as SearchResponse;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("HTTP ")) {
        console.error(chalk.red(`\n  Error: ${err.message}\n`));
      } else {
        console.error(chalk.red(`\n  Cannot connect to trickle backend at ${chalk.bold(backendUrl)}.`));
        console.error(chalk.red("  Is the backend running?\n"));
      }
      process.exit(1);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("");
  console.log(chalk.bold(`  Search: "${query}"`));
  console.log(chalk.gray("  " + "─".repeat(50)));

  if (data.total === 0) {
    console.log(chalk.gray("  No matches found.\n"));
    return;
  }

  console.log(chalk.gray(`  ${data.total} function${data.total === 1 ? "" : "s"} matched\n`));

  for (const result of data.results) {
    // Function name with method coloring
    const fnName = result.functionName;
    const methodMatch = fnName.match(/^(GET|POST|PUT|PATCH|DELETE)\s/);
    if (methodMatch) {
      const method = methodMatch[1];
      const rest = fnName.slice(method.length);
      const methodColors: Record<string, (s: string) => string> = {
        GET: chalk.green,
        POST: chalk.yellow,
        PUT: chalk.blue,
        PATCH: chalk.cyan,
        DELETE: chalk.red,
      };
      const colorFn = methodColors[method] || chalk.white;
      console.log(`  ${colorFn(chalk.bold(method))}${chalk.white(rest)}`);
    } else {
      console.log(`  ${chalk.white(chalk.bold(fnName))}`);
    }

    console.log(chalk.gray(`  module: ${result.module}  env: ${result.environment}`));

    // Show matching fields
    for (const match of result.matches) {
      const typeStr = match.typeName ? chalk.cyan(match.typeName) : chalk.gray(match.kind);
      if (match.kind === "name") {
        console.log(chalk.gray("    → ") + chalk.yellow("function name match"));
      } else {
        console.log(chalk.gray("    → ") + chalk.white(match.path) + chalk.gray(": ") + typeStr);
      }
    }
    console.log("");
  }
}
