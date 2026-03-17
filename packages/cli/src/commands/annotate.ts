import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchAnnotations, fetchFunctionSamples, AnnotationEntry, FunctionSample } from "../api-client";

export interface AnnotateOptions {
  env?: string;
  dryRun?: boolean;
  jsdoc?: boolean;
}

type FileKind = "typescript" | "javascript" | "python" | null;

/**
 * Detect file kind from extension.
 * JavaScript files get JSDoc comments; TypeScript files get inline type annotations.
 */
function detectFileKind(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  return null;
}

// ── Shared regex for JS/TS function detection ──

const funcDeclRe = /^(\s*(?:export\s+)?(?:async\s+)?function\s+)(\w+)\s*\(([^)]*)\)/;
const arrowRe = /^(\s*(?:export\s+)?(?:const|let|var)\s+)(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)/;
const methodRe = /^(\s+)(\w+)\s*\(([^)]*)\)\s*\{/;

/**
 * Extract function name and raw params from a line, if it matches a function pattern.
 */
function matchFunction(line: string): { fnName: string; rawParams: string; kind: "function" | "arrow" | "method"; match: RegExpExecArray } | null {
  let match = funcDeclRe.exec(line);
  if (match) return { fnName: match[2], rawParams: match[3].trim(), kind: "function", match };
  match = arrowRe.exec(line);
  if (match) return { fnName: match[2], rawParams: match[3].trim(), kind: "arrow", match };
  match = methodRe.exec(line);
  if (match) return { fnName: match[2], rawParams: match[3].trim(), kind: "method", match };
  return null;
}

/**
 * Get param names from raw param string, filtering out complex patterns.
 */
function getParamNames(rawParams: string): string[] {
  if (!rawParams) return [];
  return rawParams.split(",").map((p) => p.trim());
}

// ── JSDoc annotation for JavaScript files ──

/**
 * Annotate a JavaScript file with JSDoc comments above functions.
 * Produces valid JavaScript that IDEs understand for type hints.
 */
function annotateJSDoc(source: string, annotations: Record<string, AnnotationEntry>): string {
  const lines = source.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const info = matchFunction(line);

    if (!info) {
      result.push(line);
      continue;
    }

    const annotation = annotations[info.fnName];
    if (!annotation) {
      result.push(line);
      continue;
    }

    // Skip if there's already a JSDoc comment right above
    const prevLineIdx = result.length - 1;
    if (prevLineIdx >= 0) {
      const prevLine = result[prevLineIdx].trim();
      if (prevLine === "*/" || prevLine.endsWith("*/")) {
        // Check if this is a JSDoc block that already has @param or @returns
        let j = prevLineIdx;
        while (j >= 0 && !result[j].trim().startsWith("/**")) j--;
        if (j >= 0) {
          const block = result.slice(j, prevLineIdx + 1).join("\n");
          if (block.includes("@param") || block.includes("@returns")) {
            result.push(line);
            continue;
          }
        }
      }
    }

    // Build JSDoc comment
    const paramNames = getParamNames(info.rawParams);
    const indent = line.match(/^(\s*)/)?.[1] || "";
    const jsdocLines: string[] = [];
    jsdocLines.push(`${indent}/**`);

    // Add @param tags
    for (const pName of paramNames) {
      if (pName.startsWith("...") || pName.startsWith("{") || pName.includes("=")) {
        // Handle rest, destructured, default params
        const baseName = pName.startsWith("...")
          ? pName.slice(3)
          : pName.includes("=")
            ? pName.slice(0, pName.indexOf("=")).trim()
            : pName;
        const paramType = annotation.params.find((a) => a.name === baseName);
        if (paramType) {
          jsdocLines.push(`${indent} * @param {${paramType.type}} ${baseName}`);
        }
        continue;
      }

      // Try name match first, then positional
      let paramType = annotation.params.find((a) => a.name === pName);
      if (!paramType) {
        const idx = paramNames.indexOf(pName);
        if (idx >= 0 && idx < annotation.params.length) {
          paramType = annotation.params[idx];
        }
      }
      if (paramType) {
        jsdocLines.push(`${indent} * @param {${paramType.type}} ${pName}`);
      }
    }

    // Add @returns tag
    if (annotation.returnType && annotation.returnType !== "void" && annotation.returnType !== "undefined") {
      jsdocLines.push(`${indent} * @returns {${annotation.returnType}}`);
    }

    jsdocLines.push(`${indent} */`);

    // Only add JSDoc if we have useful content
    if (jsdocLines.length > 2) {
      // Insert JSDoc before the function line
      result.push(...jsdocLines);
    }

    result.push(line);
  }

  return result.join("\n");
}

// ── TypeScript annotation (inline types) ──

/**
 * Annotate a TypeScript file with inline type annotations on function signatures.
 * When samples are provided, adds JSDoc @example comments even for already-typed functions.
 */
function annotateTS(source: string, annotations: Record<string, AnnotationEntry>, samples?: Record<string, FunctionSample>): string {
  const lines = source.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const info = matchFunction(line);

    if (!info) {
      result.push(line);
      continue;
    }

    const annotation = annotations[info.fnName];
    const sample = samples?.[info.fnName];

    if (!annotation && !sample) {
      result.push(line);
      continue;
    }

    // Add JSDoc with @example from sample data (even for already-typed functions)
    if (sample) {
      // Check if there's already a trickle JSDoc comment above
      const prevIdx = result.length - 1;
      let alreadyHasTrickleDoc = false;
      if (prevIdx >= 0) {
        // Look back for a JSDoc block containing @example and "trickle"
        let j = prevIdx;
        while (j >= 0 && !result[j].trim().startsWith("/**")) j--;
        if (j >= 0 && result[prevIdx].trim().endsWith("*/")) {
          const block = result.slice(j, prevIdx + 1).join("\n");
          if (block.includes("@example") && block.includes("trickle")) {
            alreadyHasTrickleDoc = true;
          }
        }
      }

      if (!alreadyHasTrickleDoc) {
        const indent = line.match(/^(\s*)/)?.[1] || "";
        const jsdocLines: string[] = [];
        jsdocLines.push(`${indent}/** @trickle`);

        if (sample.sampleInput !== undefined && sample.sampleInput !== null) {
          jsdocLines.push(`${indent} * @example`);
          jsdocLines.push(`${indent} * // Sample input:`);
          const inputStr = JSON.stringify(sample.sampleInput, null, 2);
          for (const l of inputStr.split('\n')) {
            jsdocLines.push(`${indent} * ${l}`);
          }
        }

        if (sample.sampleOutput !== undefined && sample.sampleOutput !== null) {
          if (sample.sampleInput === undefined || sample.sampleInput === null) {
            jsdocLines.push(`${indent} * @example`);
          }
          jsdocLines.push(`${indent} * // Sample output:`);
          const outputStr = JSON.stringify(sample.sampleOutput, null, 2);
          for (const l of outputStr.split('\n')) {
            jsdocLines.push(`${indent} * ${l}`);
          }
        }

        jsdocLines.push(`${indent} */`);
        result.push(...jsdocLines);
      }
    }

    // Skip inline type modification if already typed
    if (info.rawParams.includes(":") || line.includes("): ")) {
      result.push(line);
      continue;
    }

    if (!annotation) {
      result.push(line);
      continue;
    }

    // Build typed param list
    const paramNames = getParamNames(info.rawParams);

    const typedParams = paramNames.map((pName) => {
      if (pName.startsWith("...") || pName.startsWith("{") || pName.includes("=")) {
        return pName;
      }
      const paramType = annotation.params.find((a) => a.name === pName);
      if (paramType) {
        return `${pName}: ${paramType.type}`;
      }
      const idx = paramNames.indexOf(pName);
      if (idx >= 0 && idx < annotation.params.length) {
        return `${pName}: ${annotation.params[idx].type}`;
      }
      return pName;
    });

    const typedParamStr = typedParams.join(", ");
    const retType = annotation.returnType;

    if (info.kind === "function") {
      const prefix = info.match[1];
      const rest = line.slice(info.match[0].length);
      const hasReturnType = rest.match(/^\s*:/);
      if (hasReturnType) {
        result.push(`${prefix}${info.fnName}(${typedParamStr})${rest}`);
      } else {
        result.push(`${prefix}${info.fnName}(${typedParamStr}): ${retType}${rest}`);
      }
    } else if (info.kind === "arrow") {
      const prefix = info.match[1];
      const afterMatch = line.slice(info.match[0].length);
      const asyncMatch = line.match(new RegExp(`${info.fnName}\\s*=\\s*(async\\s+)?\\(`));
      const asyncPrefix = asyncMatch?.[1] || "";
      result.push(`${prefix}${info.fnName} = ${asyncPrefix}(${typedParamStr}): ${retType}${afterMatch}`);
    } else {
      const indent = info.match[1];
      const rest = line.slice(info.match[0].length);
      result.push(`${indent}${info.fnName}(${typedParamStr}): ${retType} {${rest}`);
    }
  }

  return result.join("\n");
}

// ── Python annotation ──

/**
 * Annotate a Python file with inline type annotations.
 */
function annotatePython(source: string, annotations: Record<string, AnnotationEntry>): string {
  const lines = source.split("\n");
  const result: string[] = [];
  const defRe = /^(\s*(?:async\s+)?def\s+)(\w+)\s*\(([^)]*)\)\s*(->\s*\S+\s*)?:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = defRe.exec(line);

    if (!match) {
      result.push(line);
      continue;
    }

    const prefix = match[1];
    const fnName = match[2];
    const rawParams = match[3].trim();
    const existingReturn = match[4];

    const annotation = annotations[fnName];
    if (!annotation) {
      result.push(line);
      continue;
    }

    const paramsHaveTypes = rawParams.split(",").some((p) => {
      const trimmed = p.trim();
      if (trimmed === "self" || trimmed === "cls") return false;
      return trimmed.includes(":") && !trimmed.startsWith("*");
    });

    if (paramsHaveTypes && existingReturn) {
      result.push(line);
      continue;
    }

    const paramNames = rawParams ? rawParams.split(",").map((p) => p.trim()) : [];

    const typedParams = paramNames.map((pName) => {
      if (pName === "self" || pName === "cls" || pName.startsWith("*") || pName.includes(":")) {
        return pName;
      }

      const eqIdx = pName.indexOf("=");
      const baseName = eqIdx >= 0 ? pName.slice(0, eqIdx).trim() : pName;
      const defaultPart = eqIdx >= 0 ? ` = ${pName.slice(eqIdx + 1).trim()}` : "";

      const paramType = annotation.params.find((a) => a.name === baseName);
      if (paramType) {
        return `${baseName}: ${paramType.type}${defaultPart}`;
      }

      const nonSelfParams = paramNames.filter(
        (p) => p !== "self" && p !== "cls" && !p.startsWith("*"),
      );
      const idx = nonSelfParams.indexOf(pName);
      if (idx >= 0 && idx < annotation.params.length) {
        return `${baseName}: ${annotation.params[idx].type}${defaultPart}`;
      }

      return pName;
    });

    const typedParamStr = typedParams.join(", ");
    const retAnnotation = existingReturn || ` -> ${annotation.returnType}`;

    result.push(`${prefix}${fnName}(${typedParamStr})${retAnnotation}:`);
  }

  return result.join("\n");
}

// ── Main command ──

export async function annotateCommand(
  file: string,
  opts: AnnotateOptions,
): Promise<void> {
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`\n  File not found: ${filePath}\n`));
    process.exit(1);
  }

  const fileKind = detectFileKind(filePath);
  if (!fileKind) {
    console.error(chalk.red(`\n  Unsupported file type: ${path.extname(filePath)}\n`));
    console.error(chalk.gray("  Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyi\n"));
    process.exit(1);
  }

  // Determine annotation language for the API
  const apiLanguage = fileKind === "python" ? "python" : undefined;

  // Determine annotation mode
  // --jsdoc flag forces JSDoc mode; otherwise JS files get JSDoc automatically
  const useJSDoc = opts.jsdoc || fileKind === "javascript";

  const { annotations } = await fetchAnnotations({
    env: opts.env,
    language: apiLanguage,
  });

  // Fetch sample data for @example JSDoc
  let samplesMap: Record<string, FunctionSample> = {};
  try {
    const samples = await fetchFunctionSamples();
    for (const s of samples) {
      samplesMap[s.functionName] = s;
    }
  } catch {
    // Sample data is optional
  }

  if ((!annotations || Object.keys(annotations).length === 0) && Object.keys(samplesMap).length === 0) {
    console.log(chalk.yellow("\n  No observed types found. Run your code with trickle first.\n"));
    return;
  }

  const source = fs.readFileSync(filePath, "utf-8");

  // Apply annotations based on file type
  let annotated: string;
  let mode: string;
  if (fileKind === "python") {
    annotated = annotatePython(source, annotations);
    mode = "Python type annotations";
  } else if (useJSDoc) {
    annotated = annotateJSDoc(source, annotations);
    mode = "JSDoc comments";
  } else {
    annotated = annotateTS(source, annotations, samplesMap);
    mode = "TypeScript annotations + sample data";
  }

  // Count changes
  const originalLines = source.split("\n");
  const annotatedLines = annotated.split("\n");

  // For JSDoc, count functions annotated (not lines changed, since JSDoc adds lines)
  let changeCount = 0;
  if (useJSDoc && fileKind !== "python") {
    // Count new JSDoc blocks added
    for (let i = 0; i < annotatedLines.length; i++) {
      if (annotatedLines[i].trimEnd().endsWith("/**") && (i >= originalLines.length || originalLines[i] !== annotatedLines[i])) {
        changeCount++;
      }
    }
  } else {
    for (let i = 0; i < Math.max(originalLines.length, annotatedLines.length); i++) {
      if ((originalLines[i] || "") !== (annotatedLines[i] || "")) changeCount++;
    }
  }

  if (changeCount === 0) {
    console.log(chalk.gray("\n  No annotations to add — functions already typed or not observed.\n"));
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.cyan(`\n  Dry run — ${mode} that would be added:\n`));
    if (useJSDoc && fileKind !== "python") {
      // Show JSDoc blocks that would be inserted
      let inNew = false;
      for (let i = 0; i < annotatedLines.length; i++) {
        const isNewLine = i >= originalLines.length || originalLines[i] !== annotatedLines[i];
        if (isNewLine && !inNew) {
          // Find the function line that follows this JSDoc
          inNew = true;
        }
        if (isNewLine) {
          console.log(chalk.green(`  + ${annotatedLines[i]}`));
          if (annotatedLines[i].trimEnd().endsWith("*/")) {
            inNew = false;
          }
        }
      }
    } else {
      for (let i = 0; i < Math.max(originalLines.length, annotatedLines.length); i++) {
        if ((originalLines[i] || "") !== (annotatedLines[i] || "")) {
          console.log(chalk.red(`  - ${(originalLines[i] || "").trim()}`));
          console.log(chalk.green(`  + ${(annotatedLines[i] || "").trim()}`));
          console.log();
        }
      }
    }
    console.log(chalk.gray(`\n  ${changeCount} function(s) would be annotated with ${mode}.\n`));
    return;
  }

  // Write annotated file
  fs.writeFileSync(filePath, annotated, "utf-8");
  console.log(chalk.green(`\n  Annotated ${changeCount} function(s) in ${path.relative(process.cwd(), filePath)} (${mode})\n`));

  // Show what changed
  if (useJSDoc && fileKind !== "python") {
    // Show JSDoc blocks that were added
    let inBlock = false;
    let blockLines: string[] = [];
    for (let i = 0; i < annotatedLines.length; i++) {
      const isNew = i >= originalLines.length || originalLines[i] !== annotatedLines[i];
      if (isNew && annotatedLines[i].trimEnd().endsWith("/**")) {
        inBlock = true;
        blockLines = [annotatedLines[i]];
      } else if (inBlock) {
        blockLines.push(annotatedLines[i]);
        if (annotatedLines[i].trimEnd().endsWith("*/")) {
          inBlock = false;
          // Next line should be the function
          const fnLine = annotatedLines[i + 1] || "";
          const fnMatch = fnLine.match(/(?:function|const|let|var)\s+(\w+)/);
          const fnName = fnMatch?.[1] || "function";
          console.log(chalk.gray(`  ${fnName}:`));
          for (const bl of blockLines) {
            console.log(chalk.gray(`    ${bl.trim()}`));
          }
        }
      }
    }
  } else {
    for (let i = 0; i < annotatedLines.length; i++) {
      if (i < originalLines.length && originalLines[i] !== annotatedLines[i]) {
        const fnMatch = annotatedLines[i].match(/(?:function|def|const|let|var)\s+(\w+)/);
        const fnName = fnMatch?.[1] || "unknown";
        console.log(chalk.gray(`  ${fnName}:`));
        console.log(chalk.gray(`    ${annotatedLines[i].trim()}`));
      }
    }
  }
  console.log();
}
