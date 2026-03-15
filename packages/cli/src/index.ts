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
import { searchCommand } from "./commands/search";
import { autoCommand } from "./commands/auto";
import { validateCommand } from "./commands/validate";
import { watchCommand } from "./commands/watch";
import { inferCommand } from "./commands/infer";
import { overviewCommand } from "./commands/overview";
import { traceCommand } from "./commands/trace";
import { packCommand } from "./commands/pack";
import { unpackCommand } from "./commands/unpack";
import { runCommand } from "./commands/run";
import { annotateCommand } from "./commands/annotate";
import { stubsCommand } from "./commands/stubs";
import { varsCommand } from "./commands/vars";
import { layersCommand } from "./commands/layers";
import { lambdaCommand } from "./commands/lambda";
import { toolSchemaCommand } from "./commands/tool-schema";
import { contextCommand } from "./commands/context";
import { mcpServerCommand } from "./commands/mcp-server";
import { rnCommand } from "./commands/rn";
import { nextCommand } from "./commands/next";
import { pythonCommand } from "./commands/python";

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

// trickle run <command>
program
  .command("run [command...]")
  .description("Run any command or file with universal type observation — zero code changes needed")
  .option("--module <name>", "Module name for captured functions")
  .option("--include <patterns>", "Comma-separated substrings — only observe matching modules")
  .option("--exclude <patterns>", "Comma-separated substrings — skip matching modules")
  .option("--stubs <dir>", "Auto-generate .d.ts/.pyi type stubs in this directory after the run")
  .option("--annotate <path>", "Auto-annotate this file or directory with types after the run")
  .option("-w, --watch", "Watch source files and re-run on changes")
  .allowUnknownOption()
  .action(async (commandParts: string[], opts) => {
    const command = commandParts.length > 0 ? commandParts.join(" ") : undefined;
    await runCommand(command, opts);
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
  .option("--graphql", "Generate GraphQL SDL schema from observed routes")
  .option("--trpc", "Generate typed tRPC router from observed routes")
  .option("--axios", "Generate typed Axios client from observed routes")
  .option("--watch", "Watch mode: re-generate when new types are observed")
  .action(async (functionName: string | undefined, opts) => {
    await codegenCommand(functionName, opts);
  });

// trickle mcp-server
program
  .command("mcp-server")
  .description("Start MCP server for AI agent integration (stdio transport)")
  .action(async () => {
    await mcpServerCommand();
  });

// trickle context
program
  .command("context [file:line]")
  .description("Show runtime context for AI agents — variable values, function types, errors")
  .option("--function <name>", "Filter by function name")
  .option("--errors", "Only show error-related context")
  .option("--compact", "Minimal output for small context windows")
  .option("--annotated", "Show source code with inline runtime values")
  .option("--json", "Output as structured JSON")
  .action(async (fileOrLine: string | undefined, opts) => {
    await contextCommand(fileOrLine, opts);
  });

// trickle tool-schema
program
  .command("tool-schema [function-name]")
  .description("Generate LLM tool calling schemas from observed function types")
  .option("--format <format>", "Output format: openai, anthropic, mcp", "openai")
  .option("-o, --out <path>", "Write schemas to a JSON file")
  .option("--module <name>", "Filter by module name")
  .action(async (functionName: string | undefined, opts) => {
    await toolSchemaCommand(functionName, opts);
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

// trickle test [command] — smart test runner or test file generation
program
  .command("test [command...]")
  .description("Run tests with observability (default) or generate test files (--generate)")
  .option("--generate", "Generate test file from observed routes instead of running tests")
  .option("--json", "Structured JSON output for agent consumption")
  .option("-o, --out <path>", "Write tests to a file (with --generate)")
  .option("--framework <name>", "Test framework: vitest or jest (with --generate)")
  .option("--base-url <url>", "Base URL for API requests (with --generate)")
  .action(async (commandParts: string[], opts) => {
    if (opts.generate) {
      await testGenCommand(opts);
      return;
    }
    const { runTestCommand } = await import("./commands/test-runner");
    const command = commandParts.length > 0 ? commandParts.join(' ') : undefined;
    await runTestCommand({ json: opts.json, command });
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
  .option("--otlp [endpoint]", "Export to OpenTelemetry (OTLP) format — send to Grafana/SigNoz/Jaeger")
  .option("--service-name <name>", "Service name for OTLP export")
  .action(async (opts) => {
    if (opts.otlp !== undefined) {
      const { exportOtlp } = await import("./commands/otlp-export");
      await exportOtlp({
        endpoint: typeof opts.otlp === 'string' ? opts.otlp : undefined,
        json: opts.otlp === true,
        serviceName: opts.serviceName,
      });
      return;
    }
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

// trickle search <query>
program
  .command("search <query>")
  .description("Search across all observed types — find functions by field names, types, or patterns")
  .option("--env <env>", "Filter by environment")
  .option("--json", "Output raw JSON")
  .action(async (query: string, opts) => {
    await searchCommand(query, opts);
  });

// trickle auto
program
  .command("auto")
  .description("Auto-detect project dependencies and generate only the relevant type files")
  .option("-d, --dir <path>", "Output directory (default: .trickle)")
  .option("--env <env>", "Filter by environment")
  .action(async (opts) => {
    await autoCommand(opts);
  });

// trickle validate <method> <url>
program
  .command("validate <method> <url>")
  .description("Validate a live API response against previously observed types")
  .option("-H, --header <header...>", "HTTP headers")
  .option("-d, --body <body>", "Request body (JSON string)")
  .option("--env <env>", "Filter by environment")
  .option("--strict", "Treat extra fields as errors (not just warnings)")
  .action(async (method: string, url: string, opts) => {
    await validateCommand(method, url, opts);
  });

// trickle watch
program
  .command("watch")
  .description("Watch for new type observations and auto-regenerate type files")
  .option("-d, --dir <path>", "Output directory (default: .trickle)")
  .option("--env <env>", "Filter by environment")
  .option("--interval <interval>", "Poll interval (e.g., 3s, 500ms, 1m)", "3s")
  .action(async (opts) => {
    await watchCommand(opts);
  });

// trickle infer [file]
program
  .command("infer [file]")
  .description("Infer types from a JSON file or stdin — no live API needed")
  .requiredOption("-n, --name <name>", "Function/route name (e.g., 'GET /api/users')")
  .option("--env <env>", "Environment label (default: development)")
  .option("--module <module>", "Module label (default: infer)")
  .option("--request-body <json>", "Example request body JSON (for documenting input types)")
  .action(async (file: string | undefined, opts) => {
    await inferCommand(file, opts);
  });

// trickle overview
program
  .command("overview")
  .description("Compact API overview — all routes with inline type signatures")
  .option("--env <env>", "Filter by environment")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    await overviewCommand(opts);
  });

// trickle trace <method> <url>
program
  .command("trace <method> <url>")
  .description("Make an HTTP request and show the response with inline type annotations")
  .option("-H, --header <header...>", "HTTP headers")
  .option("-d, --body <body>", "Request body (JSON string)")
  .option("--save", "Save inferred types to the backend")
  .option("--env <env>", "Environment label (default: development)")
  .option("--module <module>", "Module label (default: trace)")
  .action(async (method: string, url: string, opts) => {
    await traceCommand(method, url, opts);
  });

// trickle pack
program
  .command("pack")
  .description("Export all observed types as a portable bundle")
  .option("-o, --out <file>", "Write bundle to a file (otherwise stdout)")
  .option("--env <env>", "Filter by environment")
  .action(async (opts) => {
    await packCommand(opts);
  });

// trickle unpack <file>
program
  .command("unpack <file>")
  .description("Import types from a packed bundle into the backend")
  .option("--env <env>", "Override environment for all imported types")
  .option("--dry-run", "List contents without importing")
  .action(async (file: string, opts) => {
    await unpackCommand(file, opts);
  });

// trickle stubs <dir>
program
  .command("stubs <dir>")
  .description("Generate .d.ts and .pyi sidecar type stubs next to source files — IDEs pick them up automatically")
  .option("--env <env>", "Filter by environment")
  .option("--dry-run", "Preview which files would be created without writing them")
  .action(async (dir: string, opts) => {
    await stubsCommand(dir, opts);
  });

// trickle vars
program
  .command("vars")
  .description("Show captured variable types and sample values from runtime observations")
  .option("-f, --file <file>", "Filter by file path or module name")
  .option("-m, --module <module>", "Filter by module name")
  .option("--json", "Output raw JSON")
  .option("--tensors", "Show only tensor/ndarray variables")
  .action(async (opts) => {
    await varsCommand(opts);
  });

// trickle layers
program
  .command("layers")
  .description("Per-layer activation and gradient breakdown for nn.Sequential models — see what each layer does")
  .option("-f, --file <file>", "Filter by source file path")
  .option("-w, --watch", "Watch mode: refresh on file changes")
  .option("--json", "Output structured JSON for agent consumption")
  .action(async (opts) => {
    await layersCommand(opts);
  });

// trickle lambda [setup|layer|pull]
lambdaCommand(program);

// trickle rn [setup|ip]
rnCommand(program);

// trickle next [setup]
nextCommand(program);

// trickle python [setup]
pythonCommand(program);

// trickle monitor
program
  .command("monitor")
  .description("Analyze runtime data for performance issues, errors, and anomalies — generates actionable alerts for agents")
  .option("--slow-query <ms>", "Slow query threshold in ms", "100")
  .option("--slow-function <ms>", "Slow function threshold in ms", "1000")
  .option("--memory <mb>", "Memory threshold in MB", "512")
  .option("--webhook <url>", "Send alerts to a webhook URL (Slack-compatible)")
  .option("--watch", "Continuously watch for data changes and re-analyze")
  .option("--rules <file>", "Path to custom rules file (default: .trickle/rules.json)")
  .action(async (opts) => {
    const { runMonitor } = await import("./commands/monitor");
    runMonitor({
      slowQueryMs: parseInt(opts.slowQuery),
      slowFunctionMs: parseInt(opts.slowFunction),
      memoryThresholdMb: parseInt(opts.memory),
      webhook: opts.webhook,
      watch: opts.watch,
      rulesFile: opts.rules,
    });
  });

// trickle rules
const rulesCmd = program.command("rules").description("Manage alerting rules — custom thresholds for monitoring");
rulesCmd.command("init").description("Create a .trickle/rules.json with default rules").action(async () => {
  const { initRules } = await import("./commands/monitor");
  initRules();
});
rulesCmd.command("list").description("Show active alerting rules and thresholds").action(async () => {
  const { listRules } = await import("./commands/monitor");
  listRules();
});

// trickle status
program
  .command("status")
  .description("Quick overview of available observability data — file counts, freshness, size")
  .action(async () => {
    const { runStatus } = await import("./commands/status");
    runStatus();
  });

// trickle agent
program
  .command("agent [command...]")
  .description("Autonomous debugging agent — runs app, detects issues, generates analysis report with fix recommendations")
  .option("--fix", "Include fix recommendations in the report")
  .action(async (command: string[], opts) => {
    const { runAgent } = await import("./commands/agent");
    await runAgent({ command: command.length > 0 ? command.join(' ') : undefined, fix: opts.fix });
  });

// trickle ci
program
  .command("ci [command...]")
  .description("CI/CD integration — run app, detect issues, output GitHub/GitLab annotations, exit non-zero on critical")
  .option("--fail-on-warning", "Also fail on warnings (default: only critical)")
  .option("--format <format>", "Output format: github, gitlab, json, text (auto-detected)")
  .action(async (command: string[], opts) => {
    const { runCi } = await import("./commands/ci");
    await runCi({
      command: command.length > 0 ? command.join(' ') : undefined,
      failOnWarning: opts.failOnWarning,
      format: opts.format,
    });
  });

// trickle doctor
program
  .command("doctor")
  .description("Comprehensive health check — one command to understand your app's state (for agents and humans)")
  .option("--json", "Structured JSON output for agent consumption")
  .action(async (opts) => {
    const { runDoctor } = await import("./commands/doctor");
    runDoctor({ json: opts.json });
  });

// trickle summary
program
  .command("summary")
  .description("Comprehensive post-run summary — everything captured in one JSON (agent-optimized)")
  .option("--json", "Output as JSON (default)")
  .action(async () => {
    const { generateRunSummary } = await import("./commands/summary");
    const summary = generateRunSummary({});
    console.log(JSON.stringify(summary, null, 2));
  });

// trickle explain <file>
program
  .command("explain <file>")
  .description("Understand a file via runtime data — functions, call graph, queries, errors (agent-optimized)")
  .option("--json", "Structured JSON output for agent consumption")
  .action(async (file: string, opts) => {
    const { runExplain } = await import("./commands/explain");
    runExplain({ file, json: opts.json });
  });

// trickle flamegraph
program
  .command("flamegraph")
  .description("Generate an interactive flamegraph from call traces — shows where time is spent")
  .option("--json", "Output structured JSON (hotspots, tree, folded stacks)")
  .option("-o, --out <path>", "Output HTML file path")
  .action(async (opts) => {
    const { runFlamegraph } = await import("./commands/flamegraph");
    runFlamegraph({ json: opts.json, out: opts.out });
  });

// trickle watch-alerts — continuous monitoring
program
  .command("watch-alerts")
  .description("Continuous monitoring — outputs structured JSON events for new alerts (agent-optimized)")
  .option("--interval <seconds>", "Check interval in seconds (default: 3)")
  .option("--webhook <url>", "Send new alerts to a webhook URL")
  .option("--json", "Minimal output (only JSON events to stdout)")
  .action(async (opts) => {
    const { runWatch } = await import("./commands/watch-monitor");
    await runWatch({ interval: opts.interval ? parseInt(opts.interval) : undefined, webhook: opts.webhook, json: opts.json });
  });

// trickle cloud
const cloudCmd = program.command("cloud").description("Cloud sync — share observability data with your team");
cloudCmd.command("login").description("Authenticate with a trickle cloud server")
  .option("--url <url>", "Cloud server URL")
  .action(async (opts) => {
    const { cloudLogin } = await import("./commands/cloud");
    await cloudLogin(opts);
  });
cloudCmd.command("push").description("Upload .trickle/ data to the cloud").action(async () => {
  const { cloudPush } = await import("./commands/cloud");
  await cloudPush();
});
cloudCmd.command("pull").description("Download latest data from the cloud").action(async () => {
  const { cloudPull } = await import("./commands/cloud");
  await cloudPull();
});
cloudCmd.command("share").description("Create a shareable dashboard link").action(async () => {
  const { cloudShare } = await import("./commands/cloud");
  await cloudShare();
});
cloudCmd.command("projects").description("List all cloud projects").action(async () => {
  const { cloudProjects } = await import("./commands/cloud");
  await cloudProjects();
});
cloudCmd.command("status").description("Check cloud sync status").action(async () => {
  const { cloudStatus } = await import("./commands/cloud");
  await cloudStatus();
});

// trickle cloud team
const teamCmd = cloudCmd.command("team").description("Team management — invite members, manage roles (RBAC)");
teamCmd.command("create <name>").description("Create a new team").action(async (name: string) => {
  const { teamCreate } = await import("./commands/cloud");
  await teamCreate({ name });
});
teamCmd.command("list").description("List your teams").action(async () => {
  const { teamList } = await import("./commands/cloud");
  await teamList();
});
teamCmd.command("info").description("Show team details, members, and projects")
  .requiredOption("--team <id>", "Team ID")
  .action(async (opts: any) => {
    const { teamInfo } = await import("./commands/cloud");
    await teamInfo(opts);
  });
teamCmd.command("invite").description("Add a member to a team")
  .requiredOption("--team <id>", "Team ID")
  .requiredOption("--key-id <id>", "API key ID of the member to invite")
  .option("--role <role>", "Role: owner, admin, member, viewer", "member")
  .action(async (opts: any) => {
    const { teamInvite } = await import("./commands/cloud");
    await teamInvite({ team: opts.team, keyId: opts.keyId, role: opts.role });
  });
teamCmd.command("remove").description("Remove a member from a team")
  .requiredOption("--team <id>", "Team ID")
  .requiredOption("--key-id <id>", "API key ID of the member to remove")
  .action(async (opts: any) => {
    const { teamRemove } = await import("./commands/cloud");
    await teamRemove({ team: opts.team, keyId: opts.keyId });
  });
teamCmd.command("add-project").description("Share a project with your team")
  .requiredOption("--team <id>", "Team ID")
  .option("--project <name>", "Project name (defaults to current directory)")
  .action(async (opts: any) => {
    const { teamAddProject } = await import("./commands/cloud");
    await teamAddProject({ team: opts.team, project: opts.project });
  });

// trickle metrics
program
  .command("metrics")
  .description("APM-style metrics — latency percentiles (p50/p95/p99), throughput, error rates, query performance")
  .option("--json", "Output structured JSON for agent consumption")
  .option("--html", "Serve interactive APM dashboard in the browser")
  .option("-p, --port <port>", "Port for HTML dashboard", "4322")
  .action(async (opts) => {
    const { runMetrics } = await import("./commands/metrics");
    runMetrics({ json: opts.json, html: opts.html, port: parseInt(opts.port) });
  });

// trickle slo
const sloCmd = program.command("slo").description("SLO monitoring — define and track Service Level Objectives");
sloCmd.command("init").description("Create .trickle/slos.json with default SLO definitions").action(async () => {
  const { initSlos } = await import("./commands/slo");
  initSlos();
});
sloCmd.command("check").description("Check SLO compliance against current data (exit 1 if breached)")
  .option("--json", "Output structured JSON")
  .action(async (opts: any) => {
    const { checkSloCommand } = await import("./commands/slo");
    checkSloCommand({ json: opts.json });
  });

// trickle heal
program
  .command("heal")
  .description("Agent auto-remediation — detects issues, gathers context, generates fix plans with recommendations")
  .option("--json", "Output structured JSON for agent consumption")
  .action(async (opts) => {
    const { runHeal } = await import("./commands/heal");
    runHeal({ json: opts.json });
  });

// trickle verify
program
  .command("verify")
  .description("Verify a fix by comparing current metrics with a saved baseline — closes the detect→heal→verify loop")
  .option("--baseline", "Save current metrics as baseline (run before fixing)")
  .option("--compare", "Compare current metrics with saved baseline (run after fixing)")
  .action(async (opts) => {
    const { saveBaseline, compareWithBaseline } = await import("./commands/verify");
    if (opts.baseline) {
      saveBaseline({});
    } else {
      compareWithBaseline({});
    }
  });

// trickle dashboard --local
program
  .command("dashboard-local")
  .description("Open a self-contained observability dashboard — no backend needed. Shows alerts, functions, queries, errors, memory.")
  .option("-p, --port <port>", "Port to serve on", "4321")
  .action(async (opts) => {
    const { serveDashboard } = await import("./commands/dashboard-local");
    serveDashboard({ port: parseInt(opts.port) });
  });

// trickle annotate <file>
program
  .command("annotate <file>")
  .description("Add runtime-observed type annotations directly into source files")
  .option("--env <env>", "Filter by environment")
  .option("--dry-run", "Preview changes without modifying the file")
  .option("--jsdoc", "Force JSDoc comments (default for .js files)")
  .action(async (file: string, opts) => {
    await annotateCommand(file, opts);
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

// ── Direct file execution shorthand ──
// `trickle app.js` → `trickle run app.js`
// `trickle script.py --watch` → `trickle run script.py --watch`
const CODE_EXTENSIONS = /\.(js|ts|tsx|jsx|mjs|cjs|mts|py)$/i;
const firstArg = process.argv[2];
if (
  firstArg &&
  !firstArg.startsWith("-") &&
  CODE_EXTENSIONS.test(firstArg)
) {
  // Inject "run" before the file argument
  process.argv.splice(2, 0, "run");
}

// Custom help: show curated commands first, then full list
program.addHelpText('before', `
  ${chalk.bold('Quick Start')}
    trickle init                Set up trickle in your project
    trickle run <command>       Run with observability (zero code changes)
    trickle test [command]      Run tests with structured results

  ${chalk.bold('Analyze')}
    trickle summary             Full overview: errors, queries, root causes
    trickle explain <file>      Understand a file: functions, call graph, data flow
    trickle flamegraph          Performance hotspots visualization
    trickle doctor              Health check with recommended actions

  ${chalk.bold('Fix & Verify')}
    trickle verify --baseline   Save metrics before fixing
    trickle verify              Compare after fixing

  ${chalk.bold('All Commands')}
`);

program.parse();
