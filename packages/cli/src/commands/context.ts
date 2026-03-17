/**
 * Generate runtime context for AI coding agents.
 *
 * Reads .trickle/variables.jsonl and observations.jsonl to produce
 * a concise, structured summary of runtime state that AI agents
 * can use to understand and debug applications without running them.
 *
 * Usage:
 *   trickle context                          # full context
 *   trickle context src/api.ts               # context for specific file
 *   trickle context src/api.ts:25            # context around line 25
 *   trickle context --function createUser    # context for a function
 *   trickle context --errors                 # only error-related context
 *   trickle context --compact                # minimal output for small context windows
 *   trickle context src/api.ts --annotated   # source code with inline runtime values
 */

import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

export interface ContextOptions {
  function?: string;
  errors?: boolean;
  compact?: boolean;
  json?: boolean;
  annotated?: boolean;
}

interface VarObservation {
  kind: string;
  varName: string;
  line: number;
  module: string;
  file: string;
  type: TypeNode;
  typeHash: string;
  sample: unknown;
  funcName?: string;
  previousSamples?: unknown[];
}

interface FuncObservation {
  functionName: string;
  module: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

interface ErrorRecord {
  kind?: string;
  error?: string;
  message?: string;
  stack?: string;
  file?: string;
  line?: number;
  varName?: string;
  context?: Record<string, unknown>;
}

interface TypeNode {
  kind: string;
  name?: string;
  elements?: TypeNode[];
  element?: TypeNode;
  properties?: Record<string, TypeNode>;
  class_name?: string;
}

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
    case "function": return "Function";
    default: return node.kind;
  }
}

function formatSampleCompact(sample: unknown): string {
  if (sample === null || sample === undefined) return "null";
  if (typeof sample === "string") return sample.length > 50 ? `"${sample.substring(0, 50)}..."` : `"${sample}"`;
  if (typeof sample === "number" || typeof sample === "boolean") return String(sample);
  return JSON.stringify(sample)?.substring(0, 80) || "?";
}

export async function contextCommand(
  fileOrLine: string | undefined,
  opts: ContextOptions,
): Promise<void> {
  const localDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
  const varsFile = path.join(localDir, "variables.jsonl");
  const obsFile = path.join(localDir, "observations.jsonl");
  const errFile = path.join(localDir, "errors.jsonl");

  if (!fs.existsSync(varsFile) && !fs.existsSync(obsFile)) {
    console.error("No trickle data found. Run your app with trickle first:");
    console.error("  trickle run node app.js");
    console.error("  trickle run python app.py");
    process.exit(1);
  }

  // Parse file:line target
  let targetFile: string | undefined;
  let targetLine: number | undefined;
  if (fileOrLine) {
    const parts = fileOrLine.split(":");
    targetFile = parts[0];
    if (parts[1]) targetLine = parseInt(parts[1]);
  }

  // Load variables
  const vars: VarObservation[] = [];
  if (fs.existsSync(varsFile)) {
    for (const line of fs.readFileSync(varsFile, "utf-8").split("\n").filter(Boolean)) {
      try {
        const v = JSON.parse(line) as VarObservation;
        if (v.kind === "variable") vars.push(v);
      } catch {}
    }
  }

  // Load function observations
  const funcs: FuncObservation[] = [];
  const funcMap = new Map<string, FuncObservation>();
  if (fs.existsSync(obsFile)) {
    for (const line of fs.readFileSync(obsFile, "utf-8").split("\n").filter(Boolean)) {
      try {
        const f = JSON.parse(line) as FuncObservation;
        if (f.functionName) {
          const key = `${f.module}.${f.functionName}`;
          funcMap.set(key, f);
        }
      } catch {}
    }
    funcs.push(...funcMap.values());
  }

  // Load errors
  const errors: ErrorRecord[] = [];
  if (fs.existsSync(errFile)) {
    for (const line of fs.readFileSync(errFile, "utf-8").split("\n").filter(Boolean)) {
      try { errors.push(JSON.parse(line)); } catch {}
    }
  }

  // Filter by target
  let filteredVars = vars;
  let filteredFuncs = funcs;

  if (targetFile) {
    const normalizedTarget = targetFile.replace(/^\.\//, "");
    filteredVars = vars.filter(v => {
      const relPath = path.relative(process.cwd(), v.file);
      return relPath.includes(normalizedTarget) || v.file.includes(normalizedTarget);
    });
    filteredFuncs = funcs.filter(f => f.module === path.basename(normalizedTarget).replace(/\.[jt]sx?$|\.py$/, ""));
  }

  if (targetLine) {
    const radius = 10;
    filteredVars = filteredVars.filter(v => Math.abs(v.line - targetLine!) <= radius);
  }

  if (opts.function) {
    filteredVars = vars.filter(v => v.funcName === opts.function);
    filteredFuncs = funcs.filter(f => f.functionName === opts.function);
  }

  if (opts.errors) {
    // Only show context related to error locations
    if (errors.length === 0) {
      console.log("No errors recorded.");
      return;
    }
  }

  // Annotated output: show source code with inline runtime values
  if (opts.annotated && targetFile) {
    const output: string[] = [];
    // Find the actual source file
    const candidates = filteredVars.map(v => v.file);
    const uniqueFiles = [...new Set(candidates)];

    for (const absFile of uniqueFiles) {
      if (!fs.existsSync(absFile)) continue;
      const relPath = path.relative(process.cwd(), absFile);
      const sourceLines = fs.readFileSync(absFile, "utf-8").split("\n");

      // Build line → observations map (deduped, last wins per varName)
      const lineObs = new Map<number, Map<string, VarObservation>>();
      for (const v of filteredVars) {
        if (v.file !== absFile) continue;
        if (!lineObs.has(v.line)) lineObs.set(v.line, new Map());
        lineObs.get(v.line)!.set(v.varName, v);
      }

      // Determine line range to show
      let startLine = 1;
      let endLine = sourceLines.length;
      if (targetLine) {
        const radius = 15;
        startLine = Math.max(1, targetLine - radius);
        endLine = Math.min(sourceLines.length, targetLine + radius);
      }

      output.push(`## ${relPath}`);
      output.push("```");
      for (let i = startLine; i <= endLine; i++) {
        const src = sourceLines[i - 1] || "";
        const obs = lineObs.get(i);
        if (obs && obs.size > 0) {
          const annotations = Array.from(obs.values())
            .map(v => `${v.varName} = ${formatSampleCompact(v.sample)}`)
            .join(", ");
          // Pad source line and add annotation as comment
          const padded = src.padEnd(60);
          output.push(`${String(i).padStart(4)} | ${padded} // ${annotations}`);
        } else {
          output.push(`${String(i).padStart(4)} | ${src}`);
        }
      }
      output.push("```");
      output.push("");
    }

    if (output.length === 0) {
      console.log("No source files found for the specified target.");
    } else {
      console.log(output.join("\n"));
    }
    return;
  }

  // Output
  if (opts.json) {
    // Load console output for JSON mode
    const consoleFile = path.join(localDir, "console.jsonl");
    let consoleOutput: unknown[] | undefined;
    if (fs.existsSync(consoleFile)) {
      const lines: unknown[] = [];
      for (const line of fs.readFileSync(consoleFile, "utf-8").split("\n").filter(Boolean)) {
        try { lines.push(JSON.parse(line)); } catch {}
      }
      if (lines.length > 0) consoleOutput = lines;
    }

    const context = {
      variables: filteredVars.map(v => ({
        file: path.relative(process.cwd(), v.file),
        line: v.line,
        name: v.varName,
        type: typeNodeToCompact(v.type),
        value: v.sample,
      })),
      functions: filteredFuncs.map(f => ({
        name: f.functionName,
        module: f.module,
        params: (f.argsType?.elements || []).map((e, i) => ({
          name: f.paramNames?.[i] || `arg${i}`,
          type: typeNodeToCompact(e),
        })),
        returns: typeNodeToCompact(f.returnType),
        durationMs: (f as any).durationMs,
      })),
      errors: errors.length > 0 ? errors : undefined,
      console: consoleOutput,
    };
    console.log(JSON.stringify(context, null, 2));
    return;
  }

  // Human-readable but agent-friendly output
  const output: string[] = [];
  output.push("# Trickle Runtime Context");
  output.push("");

  if (filteredFuncs.length > 0) {
    output.push("## Functions");
    output.push("");
    for (const f of filteredFuncs) {
      const params = (f.argsType?.elements || [])
        .map((e, i) => `${f.paramNames?.[i] || `arg${i}`}: ${typeNodeToCompact(e)}`)
        .join(", ");
      const ret = typeNodeToCompact(f.returnType);
      const timing = (f as any).durationMs !== undefined ? ` (${(f as any).durationMs}ms)` : "";
      output.push(`- \`${f.module}.${f.functionName}(${params}) -> ${ret}\`${timing}`);
      if (!opts.compact && f.sampleInput !== undefined) {
        output.push(`  Sample call: ${formatSampleCompact(f.sampleInput)} -> ${formatSampleCompact(f.sampleOutput)}`);
      }
    }
    output.push("");
  }

  // Group variables by file
  const byFile = new Map<string, VarObservation[]>();
  for (const v of filteredVars) {
    const relPath = path.relative(process.cwd(), v.file);
    if (!byFile.has(relPath)) byFile.set(relPath, []);
    byFile.get(relPath)!.push(v);
  }

  if (byFile.size > 0) {
    output.push("## Variables (runtime values)");
    output.push("");
    for (const [file, fileVars] of byFile) {
      output.push(`### ${file}`);
      // Deduplicate: last value per (line, varName)
      const deduped = new Map<string, VarObservation>();
      for (const v of fileVars) {
        deduped.set(`${v.line}:${v.varName}`, v);
      }
      const sorted = Array.from(deduped.values()).sort((a, b) => a.line - b.line);
      for (const v of sorted) {
        const typeStr = typeNodeToCompact(v.type);
        const sampleStr = formatSampleCompact(v.sample);
        if (opts.compact) {
          output.push(`  L${v.line} ${v.varName}: ${typeStr} = ${sampleStr}`);
        } else {
          output.push(`- **L${v.line}** \`${v.varName}\`: \`${typeStr}\` = \`${sampleStr}\``);
        }
      }
      output.push("");
    }
  }

  if (errors.length > 0) {
    output.push("## Errors");
    output.push("");
    for (const e of errors) {
      const msg = e.error || e.message || "Unknown error";
      output.push(`- ${msg}`);
      if (e.file) output.push(`  at ${e.file}:${e.line || "?"}`);
      if (e.stack && !opts.compact) {
        output.push(`  \`\`\`\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}\n  \`\`\``);
      }
    }
    output.push("");
  }

  // Show console output if available
  const consoleFile = path.join(localDir, "console.jsonl");
  if (fs.existsSync(consoleFile) && !opts.compact) {
    const consoleLines: Array<{ level: string; message: string }> = [];
    for (const line of fs.readFileSync(consoleFile, "utf-8").split("\n").filter(Boolean)) {
      try { consoleLines.push(JSON.parse(line)); } catch {}
    }
    if (consoleLines.length > 0) {
      output.push("## Console Output");
      output.push("");
      const shown = consoleLines.slice(-10); // Show last 10 lines
      for (const c of shown) {
        const prefix = c.level === "error" ? "stderr" : c.level === "warn" ? "warn" : "log";
        output.push(`- \`[${prefix}]\` ${c.message.substring(0, 80)}`);
      }
      if (consoleLines.length > 10) {
        output.push(`- *(${consoleLines.length - 10} more lines)*`);
      }
      output.push("");
    }
  }

  if (filteredVars.length === 0 && filteredFuncs.length === 0 && errors.length === 0) {
    output.push("No runtime data available for the specified target.");
    output.push("Run your app with trickle to capture runtime information.");
  }

  console.log(output.join("\n"));
}
