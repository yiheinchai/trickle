import chalk from "chalk";
import Table from "cli-table3";
import * as fs from "fs";
import * as path from "path";

interface TypeNode {
  kind: string;
  name?: string;
  class_name?: string;
  element?: TypeNode;
  elements?: TypeNode[];
  properties?: Record<string, TypeNode>;
  members?: TypeNode[];
  params?: TypeNode[];
  returnType?: TypeNode;
  resolved?: TypeNode;
  key?: TypeNode;
  value?: TypeNode;
}

interface VariableObservation {
  kind: "variable";
  varName: string;
  line: number;
  module: string;
  file: string;
  type: TypeNode;
  typeHash: string;
  sample: unknown;
}

export interface VarsOptions {
  file?: string;
  module?: string;
  json?: boolean;
  tensors?: boolean;
}

function renderType(node: TypeNode, depth: number = 0): string {
  if (depth > 3) return "...";
  switch (node.kind) {
    case "primitive":
      return node.name || "unknown";
    case "array":
      return `${renderType(node.element!, depth + 1)}[]`;
    case "object": {
      const props = node.properties || {};
      const keys = Object.keys(props);
      if (keys.length === 0) return node.class_name || "{}";

      // Special types
      if (keys.length === 1 && keys[0].startsWith("__")) {
        if (keys[0] === "__date") return "Date";
        if (keys[0] === "__regexp") return "RegExp";
        if (keys[0] === "__error") return "Error";
        if (keys[0] === "__buffer") return "Buffer";
      }

      // Tensor / ndarray — show as "Tensor[1, 16, 32] float32"
      if (node.class_name === "Tensor" || node.class_name === "ndarray") {
        return renderTensorType(node.class_name, props);
      }

      // Named class — show as "ClassName(field=type, ...)"
      if (node.class_name) {
        if (keys.length > 4) {
          const shown = keys.slice(0, 3).map((k) => `${k}=${renderType(props[k], depth + 1)}`);
          return `${node.class_name}(${shown.join(", ")}, ...)`;
        }
        const entries = keys.map((k) => `${k}=${renderType(props[k], depth + 1)}`);
        return `${node.class_name}(${entries.join(", ")})`;
      }

      if (keys.length > 4) {
        const shown = keys.slice(0, 3).map((k) => `${k}: ${renderType(props[k], depth + 1)}`);
        return `{ ${shown.join(", ")}, ... }`;
      }
      const entries = keys.map((k) => `${k}: ${renderType(props[k], depth + 1)}`);
      return `{ ${entries.join(", ")} }`;
    }
    case "union":
      return (node.members || []).map((m) => renderType(m, depth + 1)).join(" | ");
    case "tuple":
      return `[${(node.elements || []).map((e) => renderType(e, depth + 1)).join(", ")}]`;
    case "promise":
      return `Promise<${renderType(node.resolved!, depth + 1)}>`;
    case "function":
      if (node.name && node.name !== "anonymous") return `${node.name}(...)`;
      return "Function";
    case "map":
      return `Map<${renderType(node.key!, depth + 1)}, ${renderType(node.value!, depth + 1)}>`;
    case "set":
      return `Set<${renderType(node.element!, depth + 1)}>`;
    default:
      return "unknown";
  }
}

/** Format a tensor type as "Tensor[1, 16, 32] float32 @cuda:0" */
function renderTensorType(className: string, properties: Record<string, TypeNode>): string {
  const parts: string[] = [className];

  const shapeProp = properties["shape"];
  if (shapeProp?.kind === "primitive" && shapeProp.name) {
    parts[0] = `${className}${shapeProp.name}`;
  }

  const dtypeProp = properties["dtype"];
  if (dtypeProp?.kind === "primitive" && dtypeProp.name) {
    let dtype = dtypeProp.name;
    dtype = dtype.replace("torch.", "").replace("numpy.", "");
    parts.push(dtype);
  }

  const deviceProp = properties["device"];
  if (deviceProp?.kind === "primitive" && deviceProp.name && deviceProp.name !== "cpu") {
    parts.push(`@${deviceProp.name}`);
  }

  return parts.join(" ");
}

/** Check if a TypeNode represents a tensor type */
function isTensorType(node: TypeNode): boolean {
  return node.kind === "object" && (node.class_name === "Tensor" || node.class_name === "ndarray");
}

function renderSample(sample: unknown): string {
  if (sample === null) return "null";
  if (sample === undefined) return "undefined";
  const str = JSON.stringify(sample);
  if (str.length > 60) return str.substring(0, 57) + "...";
  return str;
}

export async function varsCommand(opts: VarsOptions): Promise<void> {
  const trickleDir = path.join(process.cwd(), ".trickle");
  const varsFile = path.join(trickleDir, "variables.jsonl");

  if (!fs.existsSync(varsFile)) {
    console.log(chalk.yellow("\n  No variable observations found."));
    console.log(chalk.gray("  Run your code with: trickle run <command>\n"));
    return;
  }

  const content = fs.readFileSync(varsFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const observations: VariableObservation[] = [];

  for (const line of lines) {
    try {
      const obs = JSON.parse(line);
      if (obs.kind === "variable") observations.push(obs);
    } catch {
      // skip malformed lines
    }
  }

  if (observations.length === 0) {
    console.log(chalk.yellow("\n  No variable observations found.\n"));
    return;
  }

  // Filter
  let filtered = observations;
  if (opts.file) {
    const fileFilter = opts.file;
    filtered = filtered.filter(
      (o) => o.file.includes(fileFilter) || o.module.includes(fileFilter)
    );
  }
  if (opts.module) {
    filtered = filtered.filter((o) => o.module === opts.module);
  }
  if (opts.tensors) {
    filtered = filtered.filter((o) => isTensorType(o.type));
  }

  if (filtered.length === 0) {
    console.log(chalk.yellow("\n  No matching variables found.\n"));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // Group by file
  const byFile = new Map<string, VariableObservation[]>();
  for (const obs of filtered) {
    const key = obs.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(obs);
  }

  // Sort each file's vars by line number
  for (const [, vars] of byFile) {
    vars.sort((a, b) => a.line - b.line);
  }

  console.log("");

  for (const [file, vars] of byFile) {
    // Show relative path
    const relPath = path.relative(process.cwd(), file);
    console.log(chalk.cyan.bold(`  ${relPath}`));
    console.log("");

    const table = new Table({
      head: [
        chalk.gray("Line"),
        chalk.gray("Variable"),
        chalk.gray("Type"),
        chalk.gray("Sample Value"),
      ],
      style: { head: [], border: ["gray"] },
      colWidths: [8, 20, 35, 40],
      wordWrap: true,
      chars: {
        top: "─",
        "top-mid": "┬",
        "top-left": "┌",
        "top-right": "┐",
        bottom: "─",
        "bottom-mid": "┴",
        "bottom-left": "└",
        "bottom-right": "┘",
        left: "│",
        "left-mid": "├",
        mid: "─",
        "mid-mid": "┼",
        right: "│",
        "right-mid": "┤",
        middle: "│",
      },
    });

    for (const v of vars) {
      table.push([
        chalk.gray(String(v.line)),
        chalk.white.bold(v.varName),
        chalk.green(renderType(v.type)),
        chalk.gray(renderSample(v.sample)),
      ]);
    }

    console.log(table.toString());
    console.log("");
  }

  // Summary
  const totalVars = filtered.length;
  const totalFiles = byFile.size;
  const tensorCount = filtered.filter((o) => isTensorType(o.type)).length;
  const summaryParts = [`${totalVars} variable(s) across ${totalFiles} file(s)`];
  if (tensorCount > 0) {
    summaryParts.push(`${tensorCount} tensor(s)`);
  }
  console.log(chalk.gray(`  ${summaryParts.join(", ")}\n`));
}

/**
 * Show a brief post-run summary of traced variables (especially tensors).
 * Called by `trickle run` after the user's command finishes.
 */
export function showVarsSummary(varsFile: string): void {
  if (!fs.existsSync(varsFile)) return;

  const content = fs.readFileSync(varsFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const observations: VariableObservation[] = [];

  for (const line of lines) {
    try {
      const obs = JSON.parse(line);
      if (obs.kind === "variable") observations.push(obs);
    } catch {
      // skip
    }
  }

  if (observations.length === 0) return;

  const tensorObs = observations.filter((o) => isTensorType(o.type));
  const byFile = new Map<string, VariableObservation[]>();
  for (const obs of tensorObs) {
    if (!byFile.has(obs.file)) byFile.set(obs.file, []);
    byFile.get(obs.file)!.push(obs);
  }

  // Sort by line within each file
  for (const [, vars] of byFile) {
    vars.sort((a, b) => a.line - b.line);
  }

  console.log(`  Variables traced: ${chalk.bold(String(observations.length))}`);
  if (tensorObs.length > 0) {
    console.log(`  Tensor variables: ${chalk.bold(String(tensorObs.length))}`);
    console.log("");

    // Show up to 15 most interesting tensor variables
    const shown: VariableObservation[] = [];
    for (const [, vars] of byFile) {
      shown.push(...vars);
    }
    const toShow = shown.slice(0, 15);

    for (const obs of toShow) {
      const relPath = path.relative(process.cwd(), obs.file);
      const typeStr = renderType(obs.type);
      console.log(
        `    ${chalk.gray(`${relPath}:${obs.line}`)} ${chalk.white.bold(obs.varName)} ${chalk.green(typeStr)}`
      );
    }
    if (shown.length > 15) {
      console.log(chalk.gray(`    ... and ${shown.length - 15} more`));
    }
  }
  console.log(chalk.gray(`  Run ${chalk.white("trickle vars")} for full details`));
}
