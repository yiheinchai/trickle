/**
 * MCP (Model Context Protocol) server for trickle.
 *
 * Exposes trickle's runtime observability data as MCP tools that AI agents
 * can call directly. Supports stdio transport.
 *
 * Usage:
 *   trickle mcp-server                    # start MCP server on stdio
 *
 * Configure in Claude Code's MCP settings:
 *   {
 *     "mcpServers": {
 *       "trickle": {
 *         "command": "npx",
 *         "args": ["trickle-cli", "mcp-server"]
 *       }
 *     }
 *   }
 *
 * Tools exposed:
 *   - get_runtime_context: Get variable values and function types for a file
 *   - get_annotated_source: Source code with inline runtime values
 *   - get_function_signatures: List all observed function signatures
 *   - get_errors: Get error context from crashes
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";

// ── Types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface TypeNode {
  kind: string;
  name?: string;
  elements?: TypeNode[];
  element?: TypeNode;
  properties?: Record<string, TypeNode>;
  class_name?: string;
}

interface VarObservation {
  kind: string;
  varName: string;
  line: number;
  module: string;
  file: string;
  type: TypeNode;
  sample: unknown;
}

interface FuncObservation {
  functionName: string;
  module: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
  durationMs?: number;
}

// ── Helpers ──

function typeNodeToCompact(node: TypeNode): string {
  if (!node) return "unknown";
  switch (node.kind) {
    case "primitive": return node.name || "unknown";
    case "object": {
      if (node.class_name) return node.class_name;
      if (!node.properties) return "{}";
      const props = Object.entries(node.properties).slice(0, 5)
        .map(([k, v]) => `${k}: ${typeNodeToCompact(v)}`);
      const extra = Object.keys(node.properties).length > 5 ? `, +${Object.keys(node.properties).length - 5}` : "";
      return `{ ${props.join(", ")}${extra} }`;
    }
    case "array": return `${typeNodeToCompact(node.element || { kind: "primitive", name: "unknown" })}[]`;
    case "tuple": return `[${(node.elements || []).map(typeNodeToCompact).join(", ")}]`;
    case "union": return (node.elements || []).map(typeNodeToCompact).join(" | ");
    default: return node.kind;
  }
}

function formatSample(sample: unknown): string {
  if (sample === null || sample === undefined) return "null";
  if (typeof sample === "string") return sample.length > 60 ? `"${sample.substring(0, 60)}..."` : `"${sample}"`;
  if (typeof sample === "number" || typeof sample === "boolean") return String(sample);
  return JSON.stringify(sample)?.substring(0, 80) || "?";
}

function findTrickleDir(): string {
  return process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
}

function loadVars(): VarObservation[] {
  const file = path.join(findTrickleDir(), "variables.jsonl");
  if (!fs.existsSync(file)) return [];
  const vars: VarObservation[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try {
      const v = JSON.parse(line);
      if (v.kind === "variable") vars.push(v);
    } catch {}
  }
  return vars;
}

function loadFuncs(): FuncObservation[] {
  const file = path.join(findTrickleDir(), "observations.jsonl");
  if (!fs.existsSync(file)) return [];
  const map = new Map<string, FuncObservation>();
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try {
      const f = JSON.parse(line);
      if (f.functionName) map.set(`${f.module}.${f.functionName}`, f);
    } catch {}
  }
  return Array.from(map.values());
}

function loadErrors(): unknown[] {
  const file = path.join(findTrickleDir(), "errors.jsonl");
  if (!fs.existsSync(file)) return [];
  const errors: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { errors.push(JSON.parse(line)); } catch {}
  }
  return errors;
}

// ── Tool implementations ──

function getRuntimeContext(params: Record<string, unknown>): unknown {
  const targetFile = params.file as string | undefined;
  const targetLine = params.line as number | undefined;

  let vars = loadVars();
  const funcs = loadFuncs();

  if (targetFile) {
    const norm = targetFile.replace(/^\.\//, "");
    vars = vars.filter(v => {
      const rel = path.relative(process.cwd(), v.file);
      return rel.includes(norm) || v.file.includes(norm);
    });
  }
  if (targetLine) {
    vars = vars.filter(v => Math.abs(v.line - targetLine) <= 15);
  }

  // Deduplicate
  const deduped = new Map<string, VarObservation>();
  for (const v of vars) {
    deduped.set(`${v.file}:${v.line}:${v.varName}`, v);
  }

  const variables = Array.from(deduped.values()).map(v => ({
    file: path.relative(process.cwd(), v.file),
    line: v.line,
    name: v.varName,
    type: typeNodeToCompact(v.type),
    value: v.sample,
  }));

  const functions = (targetFile
    ? funcs.filter(f => f.module === path.basename(targetFile).replace(/\.[jt]sx?$|\.py$/, ""))
    : funcs
  ).map(f => ({
    name: `${f.module}.${f.functionName}`,
    params: (f.argsType?.elements || []).map((e, i) => ({
      name: f.paramNames?.[i] || `arg${i}`,
      type: typeNodeToCompact(e),
    })),
    returns: typeNodeToCompact(f.returnType),
    durationMs: f.durationMs,
    sampleInput: f.sampleInput,
    sampleOutput: f.sampleOutput,
  }));

  return { variables, functions };
}

function getAnnotatedSource(params: Record<string, unknown>): unknown {
  const targetFile = params.file as string;
  const targetLine = params.line as number | undefined;
  if (!targetFile) return { error: "file parameter required" };

  const vars = loadVars();
  const norm = targetFile.replace(/^\.\//, "");
  const fileVars = vars.filter(v => {
    const rel = path.relative(process.cwd(), v.file);
    return rel.includes(norm) || v.file.includes(norm);
  });

  // Find actual source file
  const absFiles = [...new Set(fileVars.map(v => v.file))];
  const results: string[] = [];

  for (const absFile of absFiles) {
    if (!fs.existsSync(absFile)) continue;
    const sourceLines = fs.readFileSync(absFile, "utf-8").split("\n");

    const lineObs = new Map<number, Map<string, VarObservation>>();
    for (const v of fileVars) {
      if (v.file !== absFile) continue;
      if (!lineObs.has(v.line)) lineObs.set(v.line, new Map());
      lineObs.get(v.line)!.set(v.varName, v);
    }

    let startLine = 1, endLine = sourceLines.length;
    if (targetLine) {
      startLine = Math.max(1, targetLine - 15);
      endLine = Math.min(sourceLines.length, targetLine + 15);
    }

    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const src = sourceLines[i - 1] || "";
      const obs = lineObs.get(i);
      if (obs && obs.size > 0) {
        const annotations = Array.from(obs.values())
          .map(v => `${v.varName} = ${formatSample(v.sample)}`)
          .join(", ");
        lines.push(`${String(i).padStart(4)} | ${src.padEnd(55)} // ${annotations}`);
      } else {
        lines.push(`${String(i).padStart(4)} | ${src}`);
      }
    }
    results.push(`## ${path.relative(process.cwd(), absFile)}\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  }

  return { annotatedSource: results.join("\n\n") || "No source files found for the specified target." };
}

function getFunctionSignatures(): unknown {
  const funcs = loadFuncs();
  return {
    functions: funcs.map(f => {
      const params = (f.argsType?.elements || [])
        .map((e, i) => `${f.paramNames?.[i] || `arg${i}`}: ${typeNodeToCompact(e)}`)
        .join(", ");
      return {
        name: `${f.module}.${f.functionName}`,
        signature: `${f.functionName}(${params}) -> ${typeNodeToCompact(f.returnType)}`,
        module: f.module,
        durationMs: f.durationMs,
      };
    }),
  };
}

function getErrors(): unknown {
  const errors = loadErrors();
  if (errors.length === 0) return { errors: "No errors recorded." };

  // Enrich errors with nearby variable values for debugging context
  const vars = loadVars();

  // Group variables by module for function-based matching
  const varsByModule = new Map<string, typeof vars>();
  for (const v of vars) {
    const mod = v.module || '';
    if (!varsByModule.has(mod)) varsByModule.set(mod, []);
    varsByModule.get(mod)!.push(v);
  }

  const enriched = (errors as any[]).map(err => {
    const errFunc = err.function || '';
    const errModule = err.module || '';

    // Strategy 1: Match variables from same module (try multiple module name formats)
    const moduleNames = [errModule];
    if (errModule === '__main__') {
      // Entry file may use the filename as module name in variable tracing
      for (const [mod] of varsByModule) {
        if (mod && mod !== '__main__' && !mod.includes('.')) moduleNames.push(mod);
      }
    }

    let matchedVars: typeof vars = [];
    for (const mod of moduleNames) {
      matchedVars = varsByModule.get(mod) || [];
      if (matchedVars.length > 0) break;
    }

    let context = matchedVars
      .slice(0, 10)
      .map(v => ({
        name: v.varName,
        line: v.line,
        type: typeNodeToCompact(v.type),
        value: v.sample,
      }));

    // Strategy 2: If no module match, use all vars (for small programs)
    if (context.length === 0 && vars.length > 0) {
      context = vars.slice(0, 10).map(v => ({
        name: v.varName,
        line: v.line,
        type: typeNodeToCompact(v.type),
        value: v.sample,
      }));
    }

    return {
      ...err,
      variableContext: context.length > 0 ? context : undefined,
    };
  });

  return { errors: enriched };
}

function getDatabaseQueries(): unknown {
  const file = path.join(findTrickleDir(), "queries.jsonl");
  if (!fs.existsSync(file)) return { queries: "No database queries captured. The app may not use pg (node-postgres)." };
  const lines: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch {}
  }
  if (lines.length === 0) return { queries: "No database queries recorded." };
  return { queries: lines };
}

function getCallTrace(): unknown {
  const file = path.join(findTrickleDir(), "calltrace.jsonl");
  if (!fs.existsSync(file)) return { trace: "No call trace captured. Run the app with trickle first." };
  const events: any[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  if (events.length === 0) return { trace: "No call trace events recorded." };

  // Build a tree structure from flat events
  interface TreeNode {
    function: string;
    module: string;
    callId: number;
    durationMs?: number;
    error?: string;
    children: TreeNode[];
  }

  const byCallId = new Map<number, TreeNode>();
  const roots: TreeNode[] = [];

  // First pass: create all nodes
  for (const ev of events) {
    if (ev.kind !== 'call') continue;
    const node: TreeNode = {
      function: ev.function,
      module: ev.module,
      callId: ev.callId,
      durationMs: ev.durationMs,
      error: ev.error,
      children: [],
    };
    byCallId.set(ev.callId, node);
  }

  // Second pass: build tree
  for (const ev of events) {
    if (ev.kind !== 'call') continue;
    const node = byCallId.get(ev.callId);
    if (!node) continue;
    const parent = byCallId.get(ev.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Generate a readable text representation
  function renderTree(nodes: TreeNode[], indent: string = ''): string {
    return nodes.map(n => {
      const timing = n.durationMs ? ` (${n.durationMs}ms)` : '';
      const err = n.error ? ` ✗ ${n.error}` : '';
      const line = `${indent}${n.module}.${n.function}${timing}${err}`;
      const childLines = n.children.length > 0 ? '\n' + renderTree(n.children, indent + '  ') : '';
      return line + childLines;
    }).join('\n');
  }

  return {
    tree: roots,
    readable: renderTree(roots),
    totalCalls: events.filter((e: any) => e.kind === 'call').length,
  };
}

function getWebSocketEvents(): unknown {
  const file = path.join(findTrickleDir(), "websocket.jsonl");
  if (!fs.existsSync(file)) return { events: "No WebSocket events captured. The app may not use ws or socket.io." };
  const events: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  if (events.length === 0) return { events: "No WebSocket events recorded." };
  return { events };
}

function getAlerts(): unknown {
  // Run monitor analysis to generate fresh alerts
  try {
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: findTrickleDir() });
  } catch {}

  const file = path.join(findTrickleDir(), "alerts.jsonl");
  if (!fs.existsSync(file)) return { alerts: "No alerts. Run `trickle monitor` or the app with trickle first." };
  const alerts: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { alerts.push(JSON.parse(line)); } catch {}
  }
  if (alerts.length === 0) return { alerts: "No issues detected — all clear." };
  return { alerts };
}

function getDistributedTraces(): unknown {
  const file = path.join(findTrickleDir(), "traces.jsonl");
  if (!fs.existsSync(file)) return { traces: "No distributed traces captured. The app may not make cross-service HTTP calls." };
  const spans: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { spans.push(JSON.parse(line)); } catch {}
  }
  if (spans.length === 0) return { traces: "No trace spans recorded." };
  // Group by traceId
  const byTrace = new Map<string, unknown[]>();
  for (const span of spans as any[]) {
    const tid = span.traceId || 'unknown';
    if (!byTrace.has(tid)) byTrace.set(tid, []);
    byTrace.get(tid)!.push(span);
  }
  return { traces: Object.fromEntries(byTrace), spanCount: spans.length, traceCount: byTrace.size };
}

function getPerformanceProfile(): unknown {
  const file = path.join(findTrickleDir(), "profile.jsonl");
  if (!fs.existsSync(file)) return { profile: "No performance profile captured. Run the app with trickle first." };
  const events: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  if (events.length === 0) return { profile: "No profile events recorded." };
  return { profile: events };
}

function getConsoleOutput(): unknown {
  const file = path.join(findTrickleDir(), "console.jsonl");
  if (!fs.existsSync(file)) return { output: "No console output captured. Run the app with trickle first." };
  const lines: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch {}
  }
  if (lines.length === 0) return { output: "No console output recorded." };
  return { output: lines };
}

function getHttpRequests(): unknown {
  const funcs = loadFuncs();
  const httpObs = funcs.filter(f =>
    f.functionName.startsWith("GET ") || f.functionName.startsWith("POST ") ||
    f.functionName.startsWith("PUT ") || f.functionName.startsWith("DELETE ") ||
    f.functionName.startsWith("PATCH ")
  );
  if (httpObs.length === 0) return { requests: "No HTTP requests captured. Run the app with trickle to observe fetch() calls." };
  return {
    requests: httpObs.map(f => ({
      endpoint: f.functionName,
      host: f.module,
      durationMs: f.durationMs,
      responseType: typeNodeToCompact(f.returnType),
      sampleResponse: f.sampleOutput,
    })),
  };
}

function checkDataFreshness(): unknown {
  const dir = findTrickleDir();
  const varsFile = path.join(dir, "variables.jsonl");
  const obsFile = path.join(dir, "observations.jsonl");

  const result: Record<string, unknown> = { hasData: false };

  if (fs.existsSync(varsFile)) {
    const stat = fs.statSync(varsFile);
    const ageMs = Date.now() - stat.mtimeMs;
    const lines = fs.readFileSync(varsFile, "utf-8").split("\n").filter(Boolean).length;
    result.variables = { count: lines, lastModified: stat.mtime.toISOString(), ageMinutes: Math.round(ageMs / 60000) };
    result.hasData = lines > 0;
  }
  if (fs.existsSync(obsFile)) {
    const stat = fs.statSync(obsFile);
    const lines = fs.readFileSync(obsFile, "utf-8").split("\n").filter(Boolean).length;
    result.functions = { count: lines, lastModified: stat.mtime.toISOString() };
  }

  // Detect project type and suggest run command
  const pkgPath = path.join(process.cwd(), "package.json");
  const pyprojectPath = path.join(process.cwd(), "pyproject.toml");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const main = pkg.main || "index.js";
      result.suggestedCommand = `trickle run node ${main}`;
    } catch {}
  } else if (fs.existsSync(pyprojectPath) || fs.existsSync(path.join(process.cwd(), "app.py"))) {
    const entry = fs.existsSync(path.join(process.cwd(), "app.py")) ? "app.py" : "main.py";
    result.suggestedCommand = `trickle run python ${entry}`;
  }

  return result;
}

function refreshData(params: Record<string, unknown>): unknown {
  const command = params.command as string | undefined;
  if (!command) {
    // Try to auto-detect
    const freshness = checkDataFreshness() as Record<string, unknown>;
    if (freshness.suggestedCommand) {
      return { error: `No command provided. Suggested: ${freshness.suggestedCommand}` };
    }
    return { error: "No command provided. Pass the command to run, e.g., 'node app.js' or 'python app.py'" };
  }

  try {
    const output = execSync(`npx trickle-cli run ${command}`, {
      cwd: process.cwd(),
      timeout: 60000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Return comprehensive summary after run
    try {
      const { generateRunSummary } = require('./summary');
      const summary = generateRunSummary({ command });
      return { success: true, summary };
    } catch {
      return { success: true, output: output.substring(0, 500) };
    }
  } catch (e: any) {
    // Command may fail (e.g., crash) but still capture data
    const hasData = fs.existsSync(path.join(findTrickleDir(), "variables.jsonl"));
    // Still try to return summary even on failure — errors are valuable data
    let summary;
    try {
      const { generateRunSummary } = require('./summary');
      summary = generateRunSummary({ command, exitCode: e.status || 1 });
    } catch {}
    return {
      success: false,
      dataCaptured: hasData,
      error: (e.stderr || e.message || "").substring(0, 300),
      summary,
    };
  }
}

// ── MCP Protocol ──

const TOOLS = [
  {
    name: "get_runtime_context",
    description: "Get runtime variable values and function types. Use this to understand what values variables had at runtime without adding console.log or re-running the code.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Source file path (e.g., src/api.ts). Omit for all files." },
        line: { type: "number", description: "Line number to focus on (shows ±15 lines of context)." },
      },
    },
  },
  {
    name: "get_annotated_source",
    description: "Get source code with runtime values shown as inline comments. Shows exactly what each variable contained at runtime.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Source file path (required)." },
        line: { type: "number", description: "Line number to focus on (shows ±15 lines)." },
      },
      required: ["file"],
    },
  },
  {
    name: "get_function_signatures",
    description: "List all observed function signatures with parameter types and return types.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_errors",
    description: "Get error context from application crashes, including nearby variable values at the crash site.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_database_queries",
    description: "Get captured database queries (SQL, Redis, MongoDB) with execution time, row counts, and column names. Supports pg, mysql2, better-sqlite3, ioredis, mongoose (JS) and sqlite3, psycopg2, pymysql, redis, pymongo (Python).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_call_trace",
    description: "Get the function call trace showing execution order, parent-child relationships, and timing. Use this to understand which functions called which and in what order — essential for debugging execution flow.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_websocket_events",
    description: "Get WebSocket message events — connections, sent/received messages, close events. Supports ws and socket.io.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_doctor",
    description: "Comprehensive health check — returns status (healthy/warning/critical), data counts, performance summary, top issues, runtime info, and memory usage. Use this FIRST to get a complete overview before diving into specific tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_alerts",
    description: "Get actionable alerts — slow queries, N+1 patterns, errors, memory issues, slow functions. Each alert includes a severity level and a fix suggestion. Use this as the FIRST tool when debugging.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_heal_plans",
    description: "Get auto-remediation plans — each plan has a detected issue, relevant context (variables, queries, call trace), a fix recommendation, and a confidence level. Use this to automatically fix issues.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_environment",
    description: "Get the application's environment snapshot — Python version, env vars (secrets redacted), detected frameworks, working directory. Use to debug configuration issues.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_distributed_traces",
    description: "Get distributed traces showing request flow across microservices. Each trace has spans with service name, operation, timing, and parent-child relationships via trace IDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_performance_profile",
    description: "Get memory usage profile — RSS and heap snapshots at start/end of execution. Use to identify memory leaks or high memory usage.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_logs",
    description: "Get structured log entries from Python's logging module — level, logger name, message, file, line, extra fields, and exceptions. Like Datadog log aggregation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_console_output",
    description: "Get console.log/error/warn output from the last application run. Shows what the app printed to stdout/stderr.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_http_requests",
    description: "Get all HTTP requests (fetch calls) made by the application, with URL, status, response time, and response type.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_data_freshness",
    description: "Check if trickle runtime data exists and how fresh it is. Use this before querying to know if data needs refreshing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "refresh_runtime_data",
    description: "Run the application with trickle to capture fresh runtime data. Use when data is stale or missing. Returns a comprehensive summary of everything captured.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run (e.g., 'node app.js' or 'python app.py'). If omitted, suggests a command." },
      },
    },
  },
  {
    name: "get_last_run_summary",
    description: "Get a comprehensive summary of the last trickle run — status, errors, queries (with N+1 detection), function signatures, logs, HTTP requests, memory profile, alerts, and fix recommendations. This is the RECOMMENDED first tool to call — it replaces 5-10 separate tool calls with a single comprehensive result. Use this instead of calling get_errors, get_database_queries, get_alerts, etc. individually.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explain_file",
    description: "Understand a file via runtime data. Returns: functions with signatures and sample I/O, call graph (who calls these functions, what they call), database queries triggered, variables with values, errors, and relevant alerts. Use this when you need to understand how a file works at runtime before modifying it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Source file path to explain (e.g., 'src/api.ts', 'app.py')" },
      },
      required: ["file"],
    },
  },
  {
    name: "check_slos",
    description: "Check Service Level Objective compliance — latency, error rate, query latency SLOs with error budget tracking. Returns which SLOs are passing/breaching and remaining budget percentage. Initialize SLOs with trickle slo init first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "detect_anomalies",
    description: "Detect performance anomalies by comparing current function/query latencies against a learned baseline. Call with learn: true first to establish normal behavior, then call without to detect deviations (>2σ from mean). Returns anomalies sorted by severity.",
    inputSchema: {
      type: "object",
      properties: {
        learn: { type: "boolean", description: "If true, learns the current data as the normal baseline" },
      },
    },
  },
  {
    name: "get_request_trace",
    description: "Show everything that happened during a single HTTP request — functions called, database queries, timing. Pass a requestId to filter, or omit to list all requests. Requires trickle-observe >= 0.2.115 with per-request correlation enabled.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Request ID to trace (e.g., 'req-3-m4x7k2'). Omit to list all request IDs." },
      },
    },
  },
  {
    name: "diff_runs",
    description: "Compare current runtime data against a saved snapshot. Shows new/removed functions, query changes, performance regressions, new/resolved errors. Call save_snapshot first, then make changes, re-run, and call diff_runs. Returns a verdict: improved/regressed/mixed/unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        save_snapshot: { type: "boolean", description: "If true, saves the current data as a snapshot instead of comparing" },
      },
    },
  },
  {
    name: "get_fix_suggestions",
    description: "Generate actual code fix suggestions for detected issues. Returns suggested SQL rewrites for N+1 queries, null check code for null reference errors, and optimization hints for slow functions. More actionable than get_heal_plans — gives you the actual code to write.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_recommended_actions",
    description: "Analyzes the current state of trickle data and recommends the next actions to take. Returns a prioritized list of what to do — which tools to call, what to investigate, and what to fix. Call this FIRST when you're unsure what to do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_flamegraph",
    description: "Generate a performance flamegraph from call traces. Returns hotspots (functions sorted by time), a call tree, and folded stacks format. Use this to understand WHERE time is being spent in the application — essential for performance debugging.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_new_alerts",
    description: "Get only NEW alerts since the last check. Designed for polling-based production monitoring — call this periodically to detect new issues without seeing duplicates. On first call, returns all current alerts. Subsequent calls return only alerts that appeared after the previous check.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_baseline",
    description: "Save current runtime metrics as a baseline for before/after comparison. Call this BEFORE making changes. Then after fixing the code and re-running, call compare_with_baseline to see what improved or regressed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "compare_with_baseline",
    description: "Compare current runtime metrics against a saved baseline. Shows what improved, regressed, or stayed the same — alerts, errors, N+1 queries, slow queries, function latency, memory. Returns a structured verdict: 'Fix verified', 'Regression detected', or 'No change'. Use after save_baseline + fix + re-run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_tests",
    description: "Run tests with trickle observability and get structured results. Returns pass/fail for each test, and for failures: the error message, runtime variable values near the failure, database queries that ran, and the call trace. Auto-detects the test framework (jest, vitest, pytest, mocha). Much more useful than raw test output — gives agents actionable context for fixing failures.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Test command to run (e.g., 'npm test', 'python -m pytest tests/', 'npx jest'). If omitted, auto-detects." },
      },
    },
  },
  {
    name: "get_llm_calls",
    description: "Get all captured LLM/AI API calls — OpenAI, Anthropic, Google Gemini. Shows model, token counts (input/output/total), estimated cost (USD), latency, temperature, system prompt, input/output previews, streaming status, tool use, and errors. Essential for understanding AI cost, performance, and behavior in any app that calls LLM APIs.",
    inputSchema: { type: "object", properties: {
      provider: { type: "string", description: "Filter by provider: openai, anthropic, gemini" },
    }},
  },
  {
    name: "get_mcp_tool_calls",
    description: "Get all captured MCP tool call invocations. Shows tool name, arguments, response preview, latency, errors, and direction (outgoing = client calling tool, incoming = server handling tool call). Use this to debug MCP server/client interactions and understand which tools are called, how often, and how fast.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_agent_trace",
    description: "Get the agent execution trace — a timeline of all agent workflow events with parent-child relationships. Shows chain starts/ends, tool invocations, agent actions (with reasoning/thoughts), LLM calls, and errors. Each event has a runId and parentRunId for building the execution tree. Essential for debugging LangChain, CrewAI, or any agent framework.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "why",
    description: "Causal debugging — given an error message, function name, or behavior query, traces back through the execution to show WHY it happened. Returns the error, call chain, variable values at crash point, LLM reasoning, agent decisions, and MCP tool calls that are relevant. Essential for understanding root causes — don't just see what failed, understand the chain of events that led to it.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Error message, function name, or search term. If omitted, shows the most recent error." },
    }},
  },
  {
    name: "get_cost_report",
    description: "Get LLM cost attribution — breakdown by provider and model with token counts, estimated costs, error rates, and monthly projection. Use this to understand WHERE money is being spent on LLM APIs and identify cost optimization opportunities. Shows the most expensive individual calls.",
    inputSchema: { type: "object", properties: {
      budget: { type: "number", description: "Optional budget in USD to check against" },
    }},
  },
  {
    name: "get_memory_operations",
    description: "Get captured agent memory operations (Mem0 add/get/search/update/delete). Shows what was stored, what was retrieved, retrieval counts, and latency. Essential for debugging agent memory — understanding why an agent remembered or forgot something.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "trickle", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      return { jsonrpc: "2.0", id: req.id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (req.params as any)?.name as string;
      const args = ((req.params as any)?.arguments || {}) as Record<string, unknown>;

      let result: unknown;
      try {
        switch (toolName) {
          case "get_runtime_context": result = getRuntimeContext(args); break;
          case "get_annotated_source": result = getAnnotatedSource(args); break;
          case "get_function_signatures": result = getFunctionSignatures(); break;
          case "get_errors": result = getErrors(); break;
          case "get_database_queries": result = getDatabaseQueries(); break;
          case "get_call_trace": result = getCallTrace(); break;
          case "get_doctor": {
            try {
              // Capture doctor output as JSON
              const origLog = console.log;
              let doctorOutput = '';
              console.log = (s: string) => { doctorOutput += s; };
              const { runDoctor } = require('./doctor');
              runDoctor({ json: true });
              console.log = origLog;
              try { result = JSON.parse(doctorOutput); } catch { result = { doctor: doctorOutput }; }
            } catch (e: any) {
              result = { error: e.message };
            }
            break;
          }
          case "get_alerts": result = getAlerts(); break;
          case "get_heal_plans": {
            try {
              const { runHeal } = require('./heal');
              const plans = runHeal({ json: true, dir: findTrickleDir() });
              result = { plans: plans.length > 0 ? plans : "No issues detected — all clear." };
            } catch (e: any) {
              result = { plans: `Error generating heal plans: ${e.message}` };
            }
            break;
          }
          case "get_websocket_events": result = getWebSocketEvents(); break;
          case "get_distributed_traces": result = getDistributedTraces(); break;
          case "get_environment": {
            const envFile = path.join(findTrickleDir(), "environment.json");
            if (!fs.existsSync(envFile)) {
              result = { environment: "No environment snapshot. Run the app with trickle first." };
            } else {
              try { result = JSON.parse(fs.readFileSync(envFile, "utf-8")); } catch { result = { environment: "Failed to read environment snapshot." }; }
            }
            break;
          }
          case "get_performance_profile": result = getPerformanceProfile(); break;
          case "get_logs": {
            const logsFile = path.join(findTrickleDir(), "logs.jsonl");
            if (!fs.existsSync(logsFile)) {
              result = { logs: "No structured logs captured. The app may not use Python's logging module." };
            } else {
              const logs: unknown[] = [];
              for (const line of fs.readFileSync(logsFile, "utf-8").split("\n").filter(Boolean)) {
                try { logs.push(JSON.parse(line)); } catch {}
              }
              result = logs.length > 0 ? { logs } : { logs: "No log entries recorded." };
            }
            break;
          }
          case "get_console_output": result = getConsoleOutput(); break;
          case "get_http_requests": result = getHttpRequests(); break;
          case "check_data_freshness": result = checkDataFreshness(); break;
          case "refresh_runtime_data": result = refreshData(args); break;
          case "get_last_run_summary": {
            const summaryFile = path.join(findTrickleDir(), "summary.json");
            if (fs.existsSync(summaryFile)) {
              try {
                result = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
              } catch {
                // Regenerate if file is corrupt
                const { generateRunSummary } = require('./summary');
                result = generateRunSummary({ dir: findTrickleDir() });
              }
            } else {
              // Generate on-the-fly from existing data
              try {
                const { generateRunSummary } = require('./summary');
                result = generateRunSummary({ dir: findTrickleDir() });
              } catch (e: any) {
                result = { error: "No runtime data found. Run the app with trickle first." };
              }
            }
            break;
          }
          case "check_slos": {
            try {
              const { checkSloCommand } = require('./slo');
              const origLog = console.log;
              console.log = () => {};
              checkSloCommand({ dir: findTrickleDir(), json: true });
              console.log = origLog;
              // Read from file since checkSloCommand writes JSON to stdout
              const sloFile = path.join(findTrickleDir(), 'slo-results.json');
              if (fs.existsSync(sloFile)) {
                result = JSON.parse(fs.readFileSync(sloFile, 'utf-8'));
              } else {
                result = { error: 'No SLO results. Run trickle slo init first.' };
              }
            } catch (e: any) {
              result = { error: `SLO check failed: ${e.message}` };
            }
            break;
          }
          case "detect_anomalies": {
            try {
              if (args.learn) {
                const { learnBaseline } = require('./anomaly');
                const origLog = console.log;
                console.log = () => {};
                learnBaseline(findTrickleDir());
                console.log = origLog;
                result = { learned: true, message: 'Baseline learned. Run the app again and call detect_anomalies to find deviations.' };
              } else {
                const { detectAnomalies } = require('./anomaly');
                const origLog = console.log;
                console.log = () => {};
                result = detectAnomalies({ dir: findTrickleDir() });
                console.log = origLog;
              }
            } catch (e: any) {
              result = { error: `Anomaly detection failed: ${e.message}` };
            }
            break;
          }
          case "get_request_trace": {
            const reqId = args.requestId as string | undefined;
            const dir = findTrickleDir();

            const calltrace = fs.existsSync(path.join(dir, 'calltrace.jsonl'))
              ? fs.readFileSync(path.join(dir, 'calltrace.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
              : [];
            const queries = fs.existsSync(path.join(dir, 'queries.jsonl'))
              ? fs.readFileSync(path.join(dir, 'queries.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
              : [];

            if (!reqId) {
              // List all unique request IDs
              const ids = new Set<string>();
              for (const e of calltrace) if (e.requestId) ids.add(e.requestId);
              for (const q of queries) if (q.requestId) ids.add(q.requestId);
              result = {
                requestIds: [...ids],
                count: ids.size,
                hint: ids.size === 0 ? 'No request IDs found. Make sure you are using trickle-observe >= 0.2.115 and the Express middleware is active.' : 'Pass a requestId to see the full trace.',
              };
            } else {
              // Filter by request ID
              const reqCalls = calltrace.filter((e: any) => e.requestId === reqId);
              const reqQueries = queries.filter((q: any) => q.requestId === reqId);
              const totalMs = reqCalls.reduce((sum: number, c: any) => Math.max(sum, c.durationMs || 0), 0);

              result = {
                requestId: reqId,
                functions: reqCalls.map((c: any) => ({
                  name: `${c.module}.${c.function}`,
                  durationMs: c.durationMs,
                  depth: c.depth,
                  error: c.error,
                })),
                queries: reqQueries.map((q: any) => ({
                  query: (q.query || '').substring(0, 200),
                  durationMs: q.durationMs,
                  rowCount: q.rowCount,
                })),
                totalFunctions: reqCalls.length,
                totalQueries: reqQueries.length,
                totalMs,
              };
            }
            break;
          }
          case "diff_runs": {
            try {
              const { runDiffCommand, diffRuns } = require('./run-diff');
              const dir = findTrickleDir();
              const snapshotDir = path.join(dir, 'snapshot');

              if (args.save_snapshot) {
                const origLog = console.log;
                console.log = () => {};
                runDiffCommand({ snapshot: true });
                console.log = origLog;
                result = { saved: true, message: 'Snapshot saved. Make changes, re-run, then call diff_runs again.' };
              } else if (fs.existsSync(snapshotDir)) {
                result = diffRuns(snapshotDir, dir);
              } else {
                result = { error: 'No snapshot found. Call with save_snapshot: true first.' };
              }
            } catch (e: any) {
              result = { error: `Failed to diff runs: ${e.message}` };
            }
            break;
          }
          case "get_fix_suggestions": {
            try {
              const { runFix } = require('./fix');
              const origLog = console.log;
              console.log = () => {};
              const fixes = runFix({ json: false, dir: findTrickleDir() });
              console.log = origLog;
              result = { fixes, count: fixes.length };
            } catch (e: any) {
              result = { error: `Failed to generate fixes: ${e.message}` };
            }
            break;
          }
          case "get_recommended_actions": {
            try {
              const dir = findTrickleDir();
              const actions: Array<{ priority: number; action: string; tool: string; reason: string }> = [];

              // Check if data exists
              const hasObs = fs.existsSync(path.join(dir, 'observations.jsonl'));
              const hasVars = fs.existsSync(path.join(dir, 'variables.jsonl'));
              const hasQueries = fs.existsSync(path.join(dir, 'queries.jsonl'));
              const hasErrors = fs.existsSync(path.join(dir, 'errors.jsonl'));
              const hasSummary = fs.existsSync(path.join(dir, 'summary.json'));
              const hasBaseline = fs.existsSync(path.join(dir, 'baseline.json'));

              if (!hasObs && !hasVars) {
                actions.push({
                  priority: 1,
                  action: 'Run the application with trickle to capture runtime data',
                  tool: 'refresh_runtime_data',
                  reason: 'No runtime data found. You need to run the app first.',
                });
                result = { actions, status: 'no_data' };
                break;
              }

              // Check freshness
              let dataAgeMs = Infinity;
              try {
                const stat = fs.statSync(path.join(dir, hasObs ? 'observations.jsonl' : 'variables.jsonl'));
                dataAgeMs = Date.now() - stat.mtimeMs;
              } catch {}

              if (dataAgeMs > 3600000) {
                actions.push({
                  priority: 1,
                  action: 'Re-run the app — data is stale (over 1 hour old)',
                  tool: 'refresh_runtime_data',
                  reason: `Data is ${Math.round(dataAgeMs / 60000)} minutes old.`,
                });
              }

              // Always recommend summary first
              actions.push({
                priority: 2,
                action: 'Get a comprehensive overview of the last run',
                tool: 'get_last_run_summary',
                reason: 'One call gives you status, errors, queries, functions, alerts, and fix recommendations.',
              });

              // Check for alerts
              let alertCount = 0;
              let criticalCount = 0;
              const alertsFile = path.join(dir, 'alerts.jsonl');
              if (fs.existsSync(alertsFile)) {
                const lines = fs.readFileSync(alertsFile, 'utf-8').split('\n').filter(Boolean);
                alertCount = lines.length;
                criticalCount = lines.filter(l => { try { return JSON.parse(l).severity === 'critical'; } catch { return false; } }).length;
              }

              if (criticalCount > 0) {
                actions.push({
                  priority: 1,
                  action: `Investigate ${criticalCount} critical alert(s)`,
                  tool: 'get_alerts',
                  reason: 'Critical issues detected that need immediate attention.',
                });
              } else if (alertCount > 0) {
                actions.push({
                  priority: 3,
                  action: `Review ${alertCount} alert(s) (N+1 queries, slow functions, etc.)`,
                  tool: 'get_alerts',
                  reason: 'Warnings detected — review for optimization opportunities.',
                });
              }

              // Check for errors
              if (hasErrors) {
                const errorLines = fs.readFileSync(path.join(dir, 'errors.jsonl'), 'utf-8').split('\n').filter(Boolean);
                if (errorLines.length > 0) {
                  actions.push({
                    priority: 1,
                    action: `Debug ${errorLines.length} error(s)`,
                    tool: 'get_errors',
                    reason: 'Runtime errors detected. Use explain_file on the relevant source file for context.',
                  });
                }
              }

              // Suggest flamegraph if we have call traces
              if (fs.existsSync(path.join(dir, 'calltrace.jsonl'))) {
                const traceLines = fs.readFileSync(path.join(dir, 'calltrace.jsonl'), 'utf-8').split('\n').filter(Boolean).length;
                if (traceLines > 5) {
                  actions.push({
                    priority: 4,
                    action: 'Generate a performance flamegraph to find bottlenecks',
                    tool: 'get_flamegraph',
                    reason: `${traceLines} call trace events available for analysis.`,
                  });
                }
              }

              // Suggest baseline if not saved
              if (!hasBaseline && alertCount > 0) {
                actions.push({
                  priority: 3,
                  action: 'Save a baseline before making fixes',
                  tool: 'save_baseline',
                  reason: 'Save current metrics so you can verify improvements after fixing issues.',
                });
              }

              // Suggest comparison if baseline exists
              if (hasBaseline) {
                actions.push({
                  priority: 2,
                  action: 'Compare current state against saved baseline',
                  tool: 'compare_with_baseline',
                  reason: 'A baseline exists — check if recent changes improved or regressed metrics.',
                });
              }

              // Sort by priority
              actions.sort((a, b) => a.priority - b.priority);

              result = {
                actions,
                status: criticalCount > 0 ? 'critical' : alertCount > 0 ? 'needs_attention' : 'healthy',
                dataAge: dataAgeMs < Infinity ? `${Math.round(dataAgeMs / 1000)}s ago` : 'unknown',
              };
            } catch (e: any) {
              result = { error: `Failed to analyze state: ${e.message}` };
            }
            break;
          }
          case "get_flamegraph": {
            try {
              const { generateFlamegraph } = require('./flamegraph');
              const data = generateFlamegraph({ dir: findTrickleDir() });
              if (!data) {
                result = { error: "No call trace data found. Run the app with trickle first." };
              } else {
                result = {
                  totalMs: data.totalMs,
                  hotspots: data.hotspots,
                  tree: data.tree,
                };
              }
            } catch (e: any) {
              result = { error: `Failed to generate flamegraph: ${e.message}` };
            }
            break;
          }
          case "get_new_alerts": {
            try {
              // Run monitor silently for fresh alerts
              const origLog3 = console.log;
              const origErr3 = console.error;
              try {
                console.log = () => {};
                console.error = () => {};
                const { runMonitor } = require('./monitor');
                runMonitor({ dir: findTrickleDir() });
              } catch {} finally {
                console.log = origLog3;
                console.error = origErr3;
              }

              const dir = findTrickleDir();
              const alertsFile = path.join(dir, 'alerts.jsonl');
              const checkFile = path.join(dir, 'last-alert-check.json');

              // Load all current alerts
              const allAlerts: any[] = [];
              if (fs.existsSync(alertsFile)) {
                for (const line of fs.readFileSync(alertsFile, 'utf-8').split('\n').filter(Boolean)) {
                  try { allAlerts.push(JSON.parse(line)); } catch {}
                }
              }

              // Load last check state
              let lastSeenHashes: string[] = [];
              if (fs.existsSync(checkFile)) {
                try {
                  const state = JSON.parse(fs.readFileSync(checkFile, 'utf-8'));
                  lastSeenHashes = state.hashes || [];
                } catch {}
              }

              // Hash each alert for dedup
              const hashAlert = (a: any) => `${a.severity}:${a.category}:${a.message}`;
              const currentHashes = allAlerts.map(hashAlert);

              // Find new alerts (not seen before)
              const newAlerts = allAlerts.filter((a, i) => !lastSeenHashes.includes(currentHashes[i]));

              // Save current state
              fs.writeFileSync(checkFile, JSON.stringify({
                hashes: currentHashes,
                lastCheck: new Date().toISOString(),
                totalAlerts: allAlerts.length,
              }), 'utf-8');

              result = {
                newAlerts: newAlerts.map(a => ({
                  severity: a.severity,
                  category: a.category,
                  message: a.message,
                  suggestion: a.suggestion,
                })),
                totalAlerts: allAlerts.length,
                newCount: newAlerts.length,
                isFirstCheck: lastSeenHashes.length === 0,
              };
            } catch (e: any) {
              result = { error: `Failed to check alerts: ${e.message}` };
            }
            break;
          }
          case "save_baseline": {
            try {
              const { saveBaselineJson } = require('./verify');
              result = saveBaselineJson({ dir: findTrickleDir() });
            } catch (e: any) {
              result = { error: `Failed to save baseline: ${e.message}` };
            }
            break;
          }
          case "compare_with_baseline": {
            try {
              const { compareWithBaselineJson } = require('./verify');
              result = compareWithBaselineJson({ dir: findTrickleDir() });
            } catch (e: any) {
              result = { error: `Failed to compare: ${e.message}` };
            }
            break;
          }
          case "explain_file": {
            const file = args.file as string;
            if (!file) {
              result = { error: "file parameter required" };
            } else {
              try {
                const { explain } = require('./explain');
                result = explain(file);
              } catch (e: any) {
                result = { error: `Failed to explain file: ${e.message}` };
              }
            }
            break;
          }
          case "run_tests": {
            const testCommand = args.command as string | undefined;
            try {
              const { runTestCommand } = require('./test-runner');
              // Suppress console output — we only want the structured result
              const origLog = console.log;
              const origErr = console.error;
              console.log = () => {};
              console.error = () => {};
              try {
                const report = await runTestCommand({ json: false, command: testCommand });
                result = report;
              } finally {
                console.log = origLog;
                console.error = origErr;
              }
            } catch (e: any) {
              result = { error: `Failed to run tests: ${e.message}` };
            }
            break;
          }
          case "get_llm_calls": {
            try {
              const llmFile = require('path').join(findTrickleDir(), 'llm.jsonl');
              const fs = require('fs');
              if (!fs.existsSync(llmFile)) {
                result = { calls: [], total: 0, message: "No LLM call data. Run your app with trickle to capture OpenAI/Anthropic/Gemini calls." };
              } else {
                let calls = fs.readFileSync(llmFile, 'utf-8').split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                if (args.provider) calls = calls.filter((c: any) => c.provider === args.provider);
                const totalCost = calls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
                const totalTokens = calls.reduce((s: number, c: any) => s + (c.totalTokens || 0), 0);
                result = { calls, total: calls.length, totalCost: Math.round(totalCost * 10000) / 10000, totalTokens };
              }
            } catch (e: any) {
              result = { error: `Failed to read LLM calls: ${e.message}` };
            }
            break;
          }
          case "get_mcp_tool_calls": {
            try {
              const mcpFile = require('path').join(findTrickleDir(), 'mcp.jsonl');
              const fs = require('fs');
              if (!fs.existsSync(mcpFile)) {
                result = { calls: [], total: 0, message: "No MCP tool call data. Run an app that uses MCP with trickle." };
              } else {
                const calls = fs.readFileSync(mcpFile, 'utf-8').split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter((c: any) => c && c.kind === 'mcp_tool_call');
                result = { calls, total: calls.length, outgoing: calls.filter((c: any) => c.direction === 'outgoing').length, incoming: calls.filter((c: any) => c.direction === 'incoming').length };
              }
            } catch (e: any) {
              result = { error: `Failed to read MCP calls: ${e.message}` };
            }
            break;
          }
          case "why": {
            try {
              const { whyCommand } = require('./why');
              // Capture JSON output
              const origLog = console.log;
              let output = '';
              console.log = (msg: string) => { output += msg + '\n'; };
              try {
                whyCommand(args.query as string || undefined, { json: true });
              } finally {
                console.log = origLog;
              }
              try { result = JSON.parse(output.trim()); } catch { result = { raw: output.trim() }; }
            } catch (e: any) {
              result = { error: `Failed: ${e.message}` };
            }
            break;
          }
          case "get_cost_report": {
            try {
              const llmFile = require('path').join(findTrickleDir(), 'llm.jsonl');
              const fs = require('fs');
              if (!fs.existsSync(llmFile)) {
                result = { error: "No LLM call data. Run your app with trickle to capture costs." };
              } else {
                const calls = fs.readFileSync(llmFile, 'utf-8').split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                const totalCost = calls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
                const totalTokens = calls.reduce((s: number, c: any) => s + (c.totalTokens || 0), 0);
                const byModel: Record<string, any> = {};
                for (const c of calls) {
                  const key = `${c.provider}/${c.model}`;
                  if (!byModel[key]) byModel[key] = { calls: 0, tokens: 0, cost: 0, errors: 0 };
                  byModel[key].calls++;
                  byModel[key].tokens += c.totalTokens || 0;
                  byModel[key].cost += c.estimatedCostUsd || 0;
                  if (c.error) byModel[key].errors++;
                }
                const costlyCalls = calls.filter((c: any) => c.estimatedCostUsd > 0).sort((a: any, b: any) => b.estimatedCostUsd - a.estimatedCostUsd).slice(0, 5).map((c: any) => ({
                  model: c.model, cost: c.estimatedCostUsd, tokens: c.totalTokens, input: (c.inputPreview || '').substring(0, 80),
                }));
                const budget = args.budget ? parseFloat(args.budget as string) : undefined;
                result = {
                  totalCost: Math.round(totalCost * 10000) / 10000, totalTokens, totalCalls: calls.length,
                  byModel, costlyCalls,
                  ...(budget ? { budget, budgetUsed: Math.round((totalCost / budget) * 1000) / 10 + '%', overBudget: totalCost > budget } : {}),
                };
              }
            } catch (e: any) {
              result = { error: `Failed to generate cost report: ${e.message}` };
            }
            break;
          }
          case "get_memory_operations": {
            try {
              const memFile = require('path').join(findTrickleDir(), 'memory.jsonl');
              const fs = require('fs');
              if (!fs.existsSync(memFile)) {
                result = { operations: [], total: 0, message: "No memory data. Run an app that uses Mem0 with trickle." };
              } else {
                const ops = fs.readFileSync(memFile, 'utf-8').split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter((o: any) => o && o.kind === 'memory_op');
                result = { operations: ops, total: ops.length };
              }
            } catch (e: any) {
              result = { error: `Failed to read memory operations: ${e.message}` };
            }
            break;
          }
          case "get_agent_trace": {
            try {
              const agentsFile = require('path').join(findTrickleDir(), 'agents.jsonl');
              const fs = require('fs');
              if (!fs.existsSync(agentsFile)) {
                result = { events: [], total: 0, message: "No agent trace data. Run a LangChain/CrewAI agent with trickle." };
              } else {
                const events = fs.readFileSync(agentsFile, 'utf-8').split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                result = { events, total: events.length };
              }
            } catch (e: any) {
              result = { error: `Failed to read agent trace: ${e.message}` };
            }
            break;
          }
          default:
            return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
        }
      } catch (e: any) {
        return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Error: ${e.message}` }] } };
      }

      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    }

    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

// ── Main ──

export async function mcpServerCommand(): Promise<void> {
  // Stdio JSON-RPC transport
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const resp = await handleRequest(req);
      if (resp.id !== null) {
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    } catch {
      // Ignore malformed input
    }
  });

  // Keep the process alive
  await new Promise(() => {});
}
