#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { functionsCommand } from "./commands/functions";
import { typesCommand } from "./commands/types";
import { errorsCommand } from "./commands/errors";
import { tailCommand } from "./commands/tail";
import { codegenCommand } from "./commands/codegen";
import { mockCommand } from "./commands/mock";
import { initCommand } from "./commands/init";
import { diffCommand } from "./commands/diff";
import { openapiCommand } from "./commands/openapi";
import { checkCommand } from "./commands/check";
import { devCommand } from "./commands/dev";
import { testGenCommand } from "./commands/test-gen";
import { dashboardCommand } from "./commands/dashboard";
import { proxyCommand } from "./commands/proxy";
import { exportCommand } from "./commands/export";
import { coverageCommand } from "./commands/coverage";
import { replayCommand } from "./commands/replay";
import { docsCommand } from "./commands/docs";
import { sampleCommand } from "./commands/sample";
import { auditCommand } from "./commands/audit";
import { captureCommand } from "./commands/capture";

const program = new Command();

program
  .name("trickle")
  .description("CLI for trickle runtime type observability")
  .version("0.1.0");

// trickle init
program
  .command("init")
  .description("Set up trickle in your project — configures types, tsconfig, and npm scripts")
  .option("--dir <path>", "Project directory (defaults to current directory)")
  .option("--python", "Set up for a Python project")
  .action(async (opts) => {
    await initCommand(opts);
  });

// trickle dev [command]
program
  .command("dev [command]")
  .description("Start your app with auto-instrumentation and live type generation")
  .option("-o, --out <path>", "Types output path (default: .trickle/types.d.ts)")
  .option("--client", "Also generate typed API client (.trickle/api-client.ts)")
  .option("--python", "Generate Python type stubs instead of TypeScript")
  .action(async (command: string | undefined, opts) => {
    await devCommand(command, opts);
  });

// trickle functions
program
  .command("functions")
  .description("List observed functions")
  .option("--env <env>", "Filter by environment")
  .option("--lang <lang>", "Filter by language")
  .option("--search <query>", "Search by function name")
  .action(async (opts) => {
    await functionsCommand(opts);
  });

// trickle types <function-name>
program
  .command("types <function-name>")
  .description("Show type snapshots for a function")
  .option("--env <env>", "Filter by environment")
  .option("--diff", "Show diff between latest two snapshots")
  .option("--env1 <env>", "First environment for cross-env diff")
  .option("--env2 <env>", "Second environment for cross-env diff")
  .action(async (functionName: string, opts) => {
    await typesCommand(functionName, opts);
  });

// trickle errors [id]
program
  .command("errors [id]")
  .description("List errors or show error detail")
  .option("--env <env>", "Filter by environment")
  .option("--since <timeframe>", "Show errors since (e.g., 2d, 5m, 1h)")
  .option("--function <name>", "Filter by function name")
  .option("--limit <n>", "Limit number of results")
  .action(async (id: string | undefined, opts) => {
    await errorsCommand(id, opts);
  });

// trickle tail
program
  .command("tail")
  .description("Stream live events from the backend")
  .option("--filter <pattern>", "Filter by function name pattern")
  .action(async (opts) => {
    await tailCommand(opts);
  });

// trickle codegen [function-name]
program
  .command("codegen [function-name]")
  .description("Generate TypeScript (or Python) type definitions from observed runtime types")
  .option("-o, --out <path>", "Write output to a file instead of stdout")
  .option("--env <env>", "Filter by environment")
  .option("--python", "Generate Python type stubs (.pyi) instead of TypeScript")
  .option("--client", "Generate a typed fetch-based API client from observed routes")
  .option("--handlers", "Generate typed Express handler types for route handlers")
  .option("--zod", "Generate Zod validation schemas with inferred types")
  .option("--react-query", "Generate typed TanStack React Query hooks")
  .option("--guards", "Generate runtime type guard functions")
  .option("--middleware", "Generate Express request validation middleware")
  .option("--msw", "Generate Mock Service Worker (MSW) request handlers")
  .option("--json-schema", "Generate JSON Schema definitions from observed types")
  .option("--swr", "Generate typed SWR data-fetching hooks")
  .option("--pydantic", "Generate Pydantic BaseModel classes (Python)")
  .option("--class-validator", "Generate class-validator DTOs for NestJS")
  .option("--watch", "Watch mode: re-generate when new types are observed")
  .action(async (functionName: string | undefined, opts) => {
    await codegenCommand(functionName, opts);
  });

// trickle diff
program
  .command("diff")
  .description("Show type drift across all functions — what changed and where")
  .option("--since <timeframe>", "Show changes since (e.g., 1h, 2d, 1w)")
  .option("--env <env>", "Filter by environment")
  .option("--env1 <env>", "First environment for cross-env comparison")
  .option("--env2 <env>", "Second environment for cross-env comparison")
  .action(async (opts) => {
    await diffCommand(opts);
  });

// trickle openapi
program
  .command("openapi")
  .description("Generate an OpenAPI 3.0 spec from runtime-observed API routes")
  .option("-o, --out <path>", "Write spec to a file (JSON)")
  .option("--env <env>", "Filter by environment")
  .option("--title <title>", "API title in the spec", "API")
  .option("--api-version <version>", "API version in the spec", "1.0.0")
  .option("--server <url>", "Server URL to include in the spec")
  .action(async (opts) => {
    await openapiCommand(opts);
  });

// trickle check
program
  .command("check")
  .description("Detect breaking API changes by comparing against a saved baseline")
  .option("--save <file>", "Save current types as a baseline snapshot")
  .option("--against <file>", "Check current types against a baseline (exit 1 on breaking changes)")
  .option("--env <env>", "Filter by environment")
  .action(async (opts) => {
    await checkCommand(opts);
  });

// trickle mock
program
  .command("mock")
  .description("Start a mock API server from runtime-observed routes and sample data")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("--no-cors", "Disable CORS headers")
  .action(async (opts) => {
    await mockCommand(opts);
  });

// trickle test --generate
program
  .command("test")
  .description("Generate API test files from runtime-observed routes and sample data")
  .option("--generate", "Generate test file from observed routes")
  .option("-o, --out <path>", "Write tests to a file")
  .option("--framework <name>", "Test framework: vitest or jest (default: vitest)")
  .option("--base-url <url>", "Base URL for API requests (default: http://localhost:3000)")
  .action(async (opts) => {
    if (!opts.generate) {
      console.log(chalk.gray("\n  Usage: trickle test --generate [--out tests.ts] [--framework vitest|jest]\n"));
      return;
    }
    await testGenCommand(opts);
  });

// trickle dashboard
program
  .command("dashboard")
  .description("Open the trickle web dashboard to explore observed types visually")
  .action(async () => {
    await dashboardCommand();
  });

// trickle proxy
program
  .command("proxy")
  .description("Transparent reverse proxy that captures API types without any backend code changes")
  .requiredOption("-t, --target <url>", "Target server URL to proxy to (e.g. http://localhost:3000)")
  .option("-p, --port <port>", "Port for the proxy server", "4000")
  .action(async (opts) => {
    await proxyCommand(opts);
  });

// trickle export
program
  .command("export")
  .description("Generate all output formats into a .trickle/ directory at once")
  .option("-d, --dir <path>", "Output directory (default: .trickle)")
  .option("--env <env>", "Filter by environment")
  .action(async (opts) => {
    await exportCommand(opts);
  });

// trickle coverage
program
  .command("coverage")
  .description("Type observation health report — coverage, staleness, variants, and overall score")
  .option("--env <env>", "Filter by environment")
  .option("--json", "Output raw JSON (for CI integration)")
  .option("--fail-under <score>", "Exit 1 if health score is below this threshold (0-100)")
  .option("--stale-hours <hours>", "Hours before a function is considered stale (default: 24)")
  .action(async (opts) => {
    await coverageCommand(opts);
  });

// trickle replay
program
  .command("replay")
  .description("Replay captured API requests as regression tests — verify response shapes match")
  .option("-t, --target <url>", "Target server URL (default: http://localhost:3000)")
  .option("--strict", "Compare exact values instead of just shapes")
  .option("--json", "Output JSON results (for CI)")
  .option("--fail-fast", "Stop on first failure")
  .action(async (opts) => {
    await replayCommand(opts);
  });

// trickle docs
program
  .command("docs")
  .description("Generate API documentation from observed runtime types and sample data")
  .option("-o, --out <path>", "Write docs to a file instead of stdout")
  .option("--html", "Generate self-contained HTML instead of Markdown")
  .option("--env <env>", "Filter by environment")
  .option("--title <title>", "Documentation title", "API Documentation")
  .action(async (opts) => {
    await docsCommand(opts);
  });

// trickle sample [route]
program
  .command("sample [route]")
  .description("Generate test fixtures and factory functions from observed runtime data")
  .option("-f, --format <format>", "Output format: json, ts, or factory (default: json)")
  .option("-o, --out <path>", "Write fixtures to a file")
  .action(async (route: string | undefined, opts) => {
    await sampleCommand(route, opts);
  });

// trickle audit
program
  .command("audit")
  .description("Analyze observed API types for quality issues — sensitive data, naming, complexity")
  .option("--env <env>", "Filter by environment")
  .option("--json", "Output raw JSON (for CI integration)")
  .option("--fail-on-error", "Exit 1 if any errors are found")
  .option("--fail-on-warning", "Exit 1 if any errors or warnings are found")
  .action(async (opts) => {
    await auditCommand(opts);
  });

// trickle capture <method> <url>
program
  .command("capture <method> <url>")
  .description("Capture types from a live API endpoint — no instrumentation needed")
  .option("-H, --header <header...>", "HTTP headers (e.g. -H 'Authorization: Bearer token')")
  .option("-d, --body <body>", "Request body (JSON string)")
  .option("--env <env>", "Environment label (default: development)")
  .option("--module <module>", "Module label (default: capture)")
  .action(async (method: string, url: string, opts) => {
    await captureCommand(method, url, opts);
  });

// Handle unhandled rejections
process.on("unhandledRejection", (err) => {
  if (err instanceof Error) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
  } else {
    console.error(chalk.red("\n  An unexpected error occurred.\n"));
  }
  process.exit(1);
});

program.parse();
