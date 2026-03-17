/**
 * Output source code with inline type hints (like VSCode inlay hints).
 *
 * Reads .trickle/variables.jsonl and renders the source with type
 * annotations inserted inline — suitable for AI agents that need
 * to understand runtime types without running the code.
 *
 * Usage:
 *   trickle hints src/app.py              # all hints for a file
 *   trickle hints src/app.py --values     # include sample values
 *   trickle hints                         # all observed files
 */

import * as fs from "fs";
import * as path from "path";

export interface HintsOptions {
  values?: boolean;
  errors?: boolean;
  show?: string; // "types", "values", "both" (default: "both" in error mode, "types" otherwise)
}

interface TypeNode {
  kind: string;
  name?: string;
  elements?: TypeNode[];
  members?: TypeNode[];
  element?: TypeNode;
  properties?: Record<string, TypeNode>;
  class_name?: string;
}

interface VarObservation {
  kind: string;
  varName: string;
  line: number;
  file: string;
  module?: string;
  cellIndex?: number;
  type: TypeNode;
  sample?: unknown;
  funcName?: string;
  error?: string;
  errorLine?: number;
}

function typeToString(node: TypeNode): string {
  if (!node) return "unknown";
  switch (node.kind) {
    case "primitive": return node.name || "unknown";
    case "object": {
      if (!node.properties) return node.class_name || "object";
      if (node.class_name === "Tensor" || node.class_name === "ndarray") {
        const shape = node.properties["shape"]?.name;
        const dtype = node.properties["dtype"]?.name;
        const parts: string[] = [];
        if (shape) parts.push(`shape=${shape}`);
        if (dtype) parts.push(`dtype=${dtype}`);
        return `${node.class_name}(${parts.join(", ")})`;
      }
      if (node.class_name === "DataFrame") {
        const rows = node.properties["rows"]?.name;
        const cols = node.properties["cols"]?.name;
        const parts: string[] = [];
        if (rows && cols) parts.push(`${rows}x${cols}`);
        return `DataFrame(${parts.join(", ")})`;
      }
      if (node.class_name) {
        const keys = Object.keys(node.properties).slice(0, 4);
        const extra = Object.keys(node.properties).length > 4 ? `, +${Object.keys(node.properties).length - 4}` : "";
        return `${node.class_name}(${keys.join(", ")}${extra})`;
      }
      const props = Object.entries(node.properties).slice(0, 5)
        .map(([k, v]) => `${k}: ${typeToString(v)}`);
      const extra = Object.keys(node.properties).length > 5 ? `, +${Object.keys(node.properties).length - 5}` : "";
      return `{${props.join(", ")}${extra}}`;
    }
    case "array": {
      const elem = node.element;
      if (elem?.kind === "union") {
        const members = elem.elements || elem.members;
        if (members && members.length > 0) {
          const names = new Set(members.map(m => m.class_name).filter(Boolean));
          if (names.size === 1) return `${names.values().next().value}[]`;
        }
      }
      return `${typeToString(elem || { kind: "primitive", name: "unknown" })}[]`;
    }
    case "tuple": return `[${(node.elements || []).map(typeToString).join(", ")}]`;
    case "union": {
      const members = node.elements || node.members;
      if (!members) return "unknown";
      const names = new Set(members.map(m => m.class_name).filter(Boolean));
      if (names.size === 1) return names.values().next().value!;
      return members.map(typeToString).join(" | ");
    }
    case "function": return "Function";
    default: return node.kind;
  }
}

function formatSample(sample: unknown): string {
  if (sample === null || sample === undefined) return "";
  if (typeof sample === "string") {
    if (sample.length > 40) return `"${sample.substring(0, 37)}..."`;
    return `"${sample}"`;
  }
  if (typeof sample === "number") {
    return Number.isInteger(sample) ? String(sample) : sample.toFixed(4);
  }
  if (typeof sample === "boolean") return String(sample);
  if (Array.isArray(sample)) return `[...${sample.length} items]`;
  const s = String(sample);
  return s.length > 40 ? s.substring(0, 37) + "..." : s;
}

export async function hintsCommand(
  targetFile: string | undefined,
  opts: HintsOptions,
): Promise<void> {
  const localDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
  const varsFile = path.join(localDir, "variables.jsonl");

  if (!fs.existsSync(varsFile)) {
    console.error("No trickle data found. Run your app with trickle first:");
    console.error("  trickle run python app.py");
    console.error("  trickle run node app.js");
    process.exit(1);
  }

  // Load observations from variables.jsonl
  const obsMap = new Map<string, VarObservation>();
  const errorSnaps: VarObservation[] = [];
  const targetKinds = opts.errors ? ["error_snapshot"] : ["variable"];

  for (const line of fs.readFileSync(varsFile, "utf-8").split("\n").filter(Boolean)) {
    try {
      const v = JSON.parse(line) as VarObservation;
      if (v.kind === "variable") {
        const key = `${v.file}:${v.line}:${v.varName}`;
        obsMap.set(key, v);
      }
      if (v.kind === "error_snapshot") {
        errorSnaps.push(v);
      }
    } catch {}
  }

  // In error mode, use error snapshots; look up original assignment lines from regular vars
  let vars: VarObservation[];
  if (opts.errors) {
    if (errorSnaps.length === 0) {
      console.error("No error snapshots found. Run code that produces an error first.");
      process.exit(1);
    }
    vars = errorSnaps;
  } else {
    vars = [...obsMap.values()];
  }

  // Filter by target file
  let filtered = vars;
  if (targetFile) {
    const normalized = targetFile.replace(/^\.\//, "");
    filtered = vars.filter(v => {
      const relPath = path.relative(process.cwd(), v.file);
      return relPath.includes(normalized) || v.file.includes(normalized);
    });
  }

  if (filtered.length === 0) {
    console.error(targetFile ? `No observations found for "${targetFile}".` : "No observations found.");
    process.exit(1);
  }

  // In error mode, resolve each snapshot var to its original assignment line
  // by looking up the regular variable observations
  if (opts.errors) {
    for (const snap of filtered) {
      // Find matching regular observation to get original line
      for (const [, obs] of obsMap) {
        if (obs.file === snap.file && obs.varName === snap.varName) {
          snap.line = obs.line; // use original assignment line
          break;
        }
      }
    }
  }

  // Group by file
  const byFile = new Map<string, VarObservation[]>();
  for (const v of filtered) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file)!.push(v);
  }

  for (const [absFile, fileVars] of byFile) {
    let sourceLines: string[] = [];
    let relPath: string = "";

    // Handle notebook cell paths: __notebook__cell_N.py
    const cellMatch = absFile.match(/__notebook__cell_(\d+)\.py$/);
    if (cellMatch) {
      // Try to find the notebook .ipynb in the same directory
      const dir = path.dirname(absFile);
      const cellIdx = parseInt(cellMatch[1]);
      const ipynbFiles = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.endsWith(".ipynb"))
        : [];
      let foundCell = false;
      for (const nbFile of ipynbFiles) {
        const nbPath = path.join(dir, nbFile);
        try {
          const nb = JSON.parse(fs.readFileSync(nbPath, "utf-8"));
          const cells = nb.cells || [];
          // trickle's cellIdx is the Nth code cell execution (1-based).
          // Try direct index first, then count code cells.
          let cellSource: string[] | undefined;
          // Try: cellIdx maps to 0-based index in all cells
          if (cells[cellIdx - 1]?.cell_type === "code") {
            cellSource = cells[cellIdx - 1].source;
          }
          // Fallback: count code cells
          if (!cellSource) {
            let codeCount = 0;
            for (const c of cells) {
              if (c.cell_type === "code") {
                codeCount++;
                if (codeCount === cellIdx) {
                  cellSource = c.source;
                  break;
                }
              }
            }
          }
          if (!cellSource) continue;
          sourceLines = (Array.isArray(cellSource) ? cellSource.join("") : String(cellSource)).split("\n");
          relPath = `${path.relative(process.cwd(), nbPath)} [cell ${cellIdx}]`;
          foundCell = true;
          break;
        } catch {
          continue;
        }
      }
      if (!foundCell) {
        // Can't find source — output just the observations in a summary format
        relPath = absFile.replace(/.*__notebook__/, "notebook ").replace(/\.py$/, "");
        const maxLine = Math.max(...fileVars.map(v => v.line));
        sourceLines = Array.from({ length: maxLine }, (_, i) => `# line ${i + 1}`);
        // Place observations as standalone lines
        const lineObs = new Map<number, Map<string, VarObservation>>();
        for (const v of fileVars) {
          if (!lineObs.has(v.line)) lineObs.set(v.line, new Map());
          lineObs.get(v.line)!.set(v.varName, v);
        }
        // Print header with error info if in error mode
        const errorMsg = fileVars.find(v => v.error)?.error;
        const errorLine = fileVars.find(v => v.errorLine)?.errorLine;
        if (opts.errors && errorMsg) {
          console.log(`# ${relPath} — ERROR`);
          console.log(`# ${errorMsg}${errorLine ? ` (line ${errorLine})` : ""}`);
          console.log(`# Variables at crash time:`);
        } else {
          console.log(`# ${relPath}`);
        }
        console.log("```python");
        for (const [lineNo, obs] of [...lineObs.entries()].sort((a, b) => a[0] - b[0])) {
          for (const v of obs.values()) {
            const typeStr = typeToString(v.type);
            const scope = v.funcName ? ` (in ${v.funcName})` : "";
            const sampleStr = formatSample(v.sample);
            const nbShowMode = opts.show || (opts.errors ? "both" : (opts.values ? "both" : "types"));
            if (nbShowMode === "values" && v.sample !== undefined) {
              console.log(`${v.varName} = ${sampleStr}${scope}`);
            } else if (nbShowMode === "both" && v.sample !== undefined) {
              console.log(`${v.varName}: ${typeStr} = ${sampleStr}${scope}`);
            } else {
              console.log(`${v.varName}: ${typeStr}${scope}`);
            }
          }
        }
        console.log("```");
        console.log("");
        continue;
      }
    } else {
      if (!fs.existsSync(absFile)) continue;
      sourceLines = fs.readFileSync(absFile, "utf-8").split("\n");
      relPath = path.relative(process.cwd(), absFile);
    }

    // Build line → varName → observation map
    const lineObs = new Map<number, Map<string, VarObservation>>();
    for (const v of fileVars) {
      if (!lineObs.has(v.line)) lineObs.set(v.line, new Map());
      lineObs.get(v.line)!.set(v.varName, v);
    }

    // Print header with error info if in error mode
    const errMsg = fileVars.find(v => v.error)?.error;
    const errLine = fileVars.find(v => v.errorLine)?.errorLine;
    if (opts.errors && errMsg) {
      console.log(`# ${relPath} — ERROR`);
      console.log(`# ${errMsg}${errLine ? ` (line ${errLine})` : ""}`);
      console.log(`# Variables at crash time:`);
    } else {
      console.log(`# ${relPath}`);
    }
    console.log("```python");

    for (let i = 0; i < sourceLines.length; i++) {
      const lineNo = i + 1;
      const src = sourceLines[i];
      const obs = lineObs.get(lineNo);

      if (!obs || obs.size === 0) {
        console.log(src);
        // Show error underline on the error line
        if (opts.errors && errLine && lineNo === errLine) {
          const indent = src.match(/^(\s*)/)?.[1] || "";
          const contentLen = src.trimEnd().length - indent.length;
          console.log(indent + "~".repeat(Math.max(contentLen, 1)) + `  ← ${errMsg}`);
        }
        continue;
      }

      // Insert type hints inline after variable names
      let annotated = src;
      // Sort by position in line (rightmost first so indices don't shift)
      const entries = [...obs.values()].sort((a, b) => {
        const aIdx = src.indexOf(a.varName);
        const bIdx = src.indexOf(b.varName);
        return bIdx - aIdx; // rightmost first
      });

      for (const v of entries) {
        const typeStr = typeToString(v.type);
        // Skip if the type is just "unknown" or not useful
        if (typeStr === "unknown") continue;

        // Find variable in the line
        const isAttr = v.varName.includes(".");
        const pattern = isAttr
          ? new RegExp(v.varName.replace(/\./g, "\\."))
          : new RegExp(`\\b${v.varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        const match = pattern.exec(annotated);
        if (!match) continue;

        const varEnd = match.index + v.varName.length;
        const afterVar = annotated.substring(varEnd).trimStart();

        // Check this is an assignment/declaration context
        const beforeVar = annotated.substring(0, match.index);
        const isPython = absFile.endsWith(".py");
        if (isPython) {
          const isAssignment = afterVar.startsWith("=") && !afterVar.startsWith("==");
          const isAnnotated = afterVar.startsWith(":");
          const isForVar = /\bfor\s+$/.test(beforeVar) || /\bfor\s+.*,\s*$/.test(beforeVar);
          const isWithAs = /\bas\s+$/.test(beforeVar);
          const isFuncParam = /\b(?:async\s+)?def\s+\w+\s*\(/.test(beforeVar) &&
            (afterVar.startsWith(",") || afterVar.startsWith(")") || afterVar.startsWith("=") || afterVar.startsWith(":"));
          const isBareAssign = /^\s*$/.test(beforeVar) || /,\s*$/.test(beforeVar);

          if (!isForVar && !isWithAs && !isFuncParam && !((isBareAssign) && (isAssignment || isAnnotated))) continue;
          if (isAnnotated && !isFuncParam) continue;
          if (isFuncParam && afterVar.startsWith(":")) continue;
        }

        // Build the hint string based on --show mode
        const showMode = opts.show || (opts.errors ? "both" : (opts.values ? "both" : "types"));
        const hasSample = v.sample !== undefined && v.sample !== null;
        let hint: string;
        if (showMode === "values" && hasSample) {
          hint = ` = ${formatSample(v.sample)}`;
        } else if (showMode === "both" && hasSample) {
          const sampleStr = formatSample(v.sample);
          hint = sampleStr ? `: ${typeStr} = ${sampleStr}` : `: ${typeStr}`;
        } else {
          hint = `: ${typeStr}`;
        }

        // Insert after variable name
        annotated = annotated.substring(0, varEnd) + hint + annotated.substring(varEnd);
      }

      console.log(annotated);
      // Show error underline on the error line
      if (opts.errors && errLine && lineNo === errLine) {
        const indent = src.match(/^(\s*)/)?.[1] || "";
        const contentLen = src.trimEnd().length - indent.length;
        console.log(indent + "~".repeat(Math.max(contentLen, 1)) + `  ← ${errMsg}`);
      }
    }

    console.log("```");
    console.log("");
  }
}
