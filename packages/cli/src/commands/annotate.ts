import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchAnnotations, AnnotationEntry } from "../api-client";

export interface AnnotateOptions {
  env?: string;
  dryRun?: boolean;
}

/**
 * Detect language from file extension.
 */
function detectLanguage(filePath: string): "typescript" | "python" | null {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  return null;
}

/**
 * Annotate a TypeScript/JavaScript file with runtime-observed types.
 * Adds parameter types and return types to function declarations.
 */
function annotateTS(source: string, annotations: Record<string, AnnotationEntry>): string {
  const lines = source.split("\n");
  const result: string[] = [];

  // Match: function name(params) { ... }
  // Match: async function name(params) { ... }
  // Match: const name = (params) => { ... }
  // Match: export function name(params) { ... }
  // Match: export async function name(params) { ... }
  const funcDeclRe = /^(\s*(?:export\s+)?(?:async\s+)?function\s+)(\w+)\s*\(([^)]*)\)/;
  const arrowRe = /^(\s*(?:export\s+)?(?:const|let|var)\s+)(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)/;
  // Match method declarations: name(params) { ... }
  const methodRe = /^(\s+)(\w+)\s*\(([^)]*)\)\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = funcDeclRe.exec(line);
    let kind: "function" | "arrow" | "method" = "function";

    if (!match) {
      match = arrowRe.exec(line);
      kind = "arrow";
    }
    if (!match) {
      match = methodRe.exec(line);
      kind = "method";
    }

    if (!match) {
      result.push(line);
      continue;
    }

    const fnName = match[2];
    const annotation = annotations[fnName];
    if (!annotation) {
      result.push(line);
      continue;
    }

    const rawParams = match[3].trim();

    // Skip if already typed (has a colon in param list or return annotation)
    if (rawParams.includes(":") || line.includes("): ")) {
      result.push(line);
      continue;
    }

    // Build typed param list
    const paramNames = rawParams
      ? rawParams.split(",").map((p) => p.trim())
      : [];

    const typedParams = paramNames.map((pName) => {
      // Handle destructured params, rest params, defaults
      if (pName.startsWith("...") || pName.startsWith("{") || pName.includes("=")) {
        return pName;
      }
      const paramType = annotation.params.find(
        (a) => a.name === pName,
      );
      if (paramType) {
        return `${pName}: ${paramType.type}`;
      }
      // Try positional matching (arg0, arg1, etc.)
      const idx = paramNames.indexOf(pName);
      if (idx >= 0 && idx < annotation.params.length) {
        return `${pName}: ${annotation.params[idx].type}`;
      }
      return pName;
    });

    const typedParamStr = typedParams.join(", ");
    const retType = annotation.returnType;

    // Reconstruct the line with types
    if (kind === "function") {
      const prefix = match[1]; // "export async function "
      const rest = line.slice(match[0].length); // everything after params
      // Add return type before the opening brace or rest of line
      const hasReturnType = rest.match(/^\s*:/);
      if (hasReturnType) {
        result.push(`${prefix}${fnName}(${typedParamStr})${rest}`);
      } else {
        result.push(`${prefix}${fnName}(${typedParamStr}): ${retType}${rest}`);
      }
    } else if (kind === "arrow") {
      const prefix = match[1]; // "const "
      const fnNamePart = match[2];
      const afterMatch = line.slice(match[0].length);
      // Reconstruct: const name = (typed_params): ReturnType => ...
      const asyncMatch = line.match(new RegExp(`${fnNamePart}\\s*=\\s*(async\\s+)?\\(`));
      const asyncPrefix = asyncMatch?.[1] || "";
      const arrowStart = `${prefix}${fnNamePart} = ${asyncPrefix}(${typedParamStr}): ${retType}`;
      result.push(`${arrowStart}${afterMatch}`);
    } else {
      // method
      const indent = match[1];
      const rest = line.slice(match[0].length);
      result.push(`${indent}${fnName}(${typedParamStr}): ${retType} {${rest}`);
    }
  }

  return result.join("\n");
}

/**
 * Annotate a Python file with runtime-observed types.
 * Adds parameter types and return types to function definitions.
 */
function annotatePython(source: string, annotations: Record<string, AnnotationEntry>): string {
  const lines = source.split("\n");
  const result: string[] = [];

  // Match: def name(params):
  // Match: async def name(params):
  const defRe = /^(\s*(?:async\s+)?def\s+)(\w+)\s*\(([^)]*)\)\s*(->\s*\S+\s*)?:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = defRe.exec(line);

    if (!match) {
      result.push(line);
      continue;
    }

    const prefix = match[1]; // "def " or "async def "
    const fnName = match[2];
    const rawParams = match[3].trim();
    const existingReturn = match[4]; // existing -> Type if present

    const annotation = annotations[fnName];
    if (!annotation) {
      result.push(line);
      continue;
    }

    // Skip if already typed (has colons in param type annotations)
    const paramsHaveTypes = rawParams.split(",").some((p) => {
      const trimmed = p.trim();
      // "self" and "cls" don't count
      if (trimmed === "self" || trimmed === "cls") return false;
      // Check for "name: type" pattern (but not default values "name=val")
      return trimmed.includes(":") && !trimmed.startsWith("*");
    });

    if (paramsHaveTypes && existingReturn) {
      result.push(line);
      continue;
    }

    // Build typed param list
    const paramNames = rawParams
      ? rawParams.split(",").map((p) => p.trim())
      : [];

    const typedParams = paramNames.map((pName) => {
      // Skip self, cls, *args, **kwargs, defaults with types
      if (
        pName === "self" ||
        pName === "cls" ||
        pName.startsWith("*") ||
        pName.includes(":")
      ) {
        return pName;
      }

      // Handle default values: name=default
      const eqIdx = pName.indexOf("=");
      const baseName = eqIdx >= 0 ? pName.slice(0, eqIdx).trim() : pName;
      const defaultPart = eqIdx >= 0 ? ` = ${pName.slice(eqIdx + 1).trim()}` : "";

      const paramType = annotation.params.find((a) => a.name === baseName);
      if (paramType) {
        return `${baseName}: ${paramType.type}${defaultPart}`;
      }

      // Try positional matching (skip self/cls)
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

export async function annotateCommand(
  file: string,
  opts: AnnotateOptions,
): Promise<void> {
  // Resolve and validate file
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`\n  File not found: ${filePath}\n`));
    process.exit(1);
  }

  const language = detectLanguage(filePath);
  if (!language) {
    console.error(
      chalk.red(`\n  Unsupported file type: ${path.extname(filePath)}\n`),
    );
    console.error(
      chalk.gray("  Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyi\n"),
    );
    process.exit(1);
  }

  // Fetch annotations from backend
  const apiLanguage = language === "python" ? "python" : undefined;
  const { annotations } = await fetchAnnotations({
    env: opts.env,
    language: apiLanguage,
  });

  if (!annotations || Object.keys(annotations).length === 0) {
    console.log(chalk.yellow("\n  No observed types found. Run your code with trickle first.\n"));
    return;
  }

  // Read source
  const source = fs.readFileSync(filePath, "utf-8");

  // Apply annotations
  const annotated =
    language === "python"
      ? annotatePython(source, annotations)
      : annotateTS(source, annotations);

  // Count changes
  const originalLines = source.split("\n");
  const annotatedLines = annotated.split("\n");
  let changeCount = 0;
  for (let i = 0; i < annotatedLines.length; i++) {
    if (originalLines[i] !== annotatedLines[i]) changeCount++;
  }

  if (changeCount === 0) {
    console.log(chalk.gray("\n  No annotations to add — functions already typed or not observed.\n"));
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.cyan("\n  Dry run — annotations that would be added:\n"));
    for (let i = 0; i < annotatedLines.length; i++) {
      if (originalLines[i] !== annotatedLines[i]) {
        console.log(chalk.red(`  - ${originalLines[i].trim()}`));
        console.log(chalk.green(`  + ${annotatedLines[i].trim()}`));
        console.log();
      }
    }
    console.log(chalk.gray(`  ${changeCount} function(s) would be annotated.\n`));
    return;
  }

  // Write annotated file
  fs.writeFileSync(filePath, annotated, "utf-8");
  console.log(chalk.green(`\n  Annotated ${changeCount} function(s) in ${path.relative(process.cwd(), filePath)}\n`));

  // Show what changed
  for (let i = 0; i < annotatedLines.length; i++) {
    if (originalLines[i] !== annotatedLines[i]) {
      const fnMatch = annotatedLines[i].match(/(?:function|def|const|let|var)\s+(\w+)/);
      const fnName = fnMatch?.[1] || "unknown";
      console.log(chalk.gray(`  ${fnName}:`));
      console.log(chalk.gray(`    ${annotatedLines[i].trim()}`));
    }
  }
  console.log();
}
