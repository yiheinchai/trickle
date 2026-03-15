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
  return { errors: errors.length > 0 ? errors : "No errors recorded." };
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
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, output: output.substring(0, 500) };
  } catch (e: any) {
    // Command may fail (e.g., crash) but still capture data
    const hasData = fs.existsSync(path.join(findTrickleDir(), "variables.jsonl"));
    return {
      success: false,
      dataCaptured: hasData,
      error: (e.stderr || e.message || "").substring(0, 300),
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
    description: "Run the application with trickle to capture fresh runtime data. Use when data is stale or missing.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run (e.g., 'node app.js' or 'python app.py'). If omitted, suggests a command." },
      },
    },
  },
];

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
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
          case "get_http_requests": result = getHttpRequests(); break;
          case "check_data_freshness": result = checkDataFreshness(); break;
          case "refresh_runtime_data": result = refreshData(args); break;
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

  rl.on("line", (line) => {
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const resp = handleRequest(req);
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
