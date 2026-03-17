import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchMockConfig, fetchFunctionSamples, listFunctions, listTypes, MockRoute, FunctionRow, TypeSnapshot } from "../api-client";

export interface TestGenOptions {
  out?: string;
  framework?: string;
  baseUrl?: string;
  unit?: boolean;
  function?: string;
  module?: string;
}

/**
 * `trickle test --generate` — Generate test files from runtime observations.
 *
 * Two modes:
 *   Default: API route tests (HTTP endpoint integration tests)
 *   --unit:  Function-level unit tests from observed inputs/outputs
 *
 * Frameworks: vitest, jest, pytest
 */
export async function testGenCommand(opts: TestGenOptions): Promise<void> {
  const framework = opts.framework || (opts.unit ? "vitest" : "vitest");
  const baseUrl = opts.baseUrl || "http://localhost:3000";

  const supportedFrameworks = ["vitest", "jest", "pytest"];
  if (!supportedFrameworks.includes(framework)) {
    console.error(chalk.red(`\n  Unsupported framework: ${framework}`));
    console.error(chalk.gray(`  Supported: ${supportedFrameworks.join(", ")}\n`));
    process.exit(1);
  }

  try {
    if (opts.unit) {
      await generateUnitTests(opts, framework);
    } else {
      await generateRouteTests(opts, framework, baseUrl);
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
    process.exit(1);
  }
}

// ── Route tests (existing behavior) ──

async function generateRouteTests(opts: TestGenOptions, framework: string, baseUrl: string): Promise<void> {
  if (framework === "pytest") {
    console.error(chalk.red("\n  pytest is only supported with --unit mode"));
    console.error(chalk.gray("  For API route tests, use vitest or jest\n"));
    process.exit(1);
  }

  const { routes } = await fetchMockConfig();

  if (routes.length === 0) {
    console.error(chalk.yellow("\n  No API routes observed yet."));
    console.error(chalk.gray("  Instrument your app and make some requests first.\n"));
    process.exit(1);
  }

  const testCode = generateRouteTestFile(routes, framework, baseUrl);
  outputTestCode(testCode, opts, routes.length, "route", framework);
}

// ── Unit tests (new) ──

interface FunctionSampleData {
  functionName: string;
  module: string;
  language: string;
  samples: Array<{ input: unknown; output: unknown }>;
}

async function generateUnitTests(opts: TestGenOptions, framework: string): Promise<void> {
  // Fetch all functions with their sample data
  const { functions } = await listFunctions({ limit: 500 });

  if (functions.length === 0) {
    console.error(chalk.yellow("\n  No functions observed yet."));
    console.error(chalk.gray("  Run your app with trickle first: trickle run <command>\n"));
    process.exit(1);
  }

  // Filter by function name or module if specified
  let filtered = functions;
  if (opts.function) {
    const searchTerm = opts.function.toLowerCase();
    filtered = functions.filter(f => f.function_name.toLowerCase().includes(searchTerm));
  }
  if (opts.module) {
    const searchTerm = opts.module.toLowerCase();
    filtered = filtered.filter(f => f.module.toLowerCase().includes(searchTerm));
  }

  // Skip route handlers (GET /api/..., POST /api/...) — those are covered by route tests
  filtered = filtered.filter(f => !isRouteHandler(f.function_name));

  if (filtered.length === 0) {
    console.error(chalk.yellow("\n  No matching functions found."));
    if (opts.function || opts.module) {
      console.error(chalk.gray(`  Try without --function or --module filters\n`));
    } else {
      console.error(chalk.gray("  Only route handlers were found. Try without --unit for API route tests.\n"));
    }
    process.exit(1);
  }

  // Collect sample data for each function
  const functionSamples: FunctionSampleData[] = [];

  for (const fn of filtered) {
    try {
      const { snapshots } = await listTypes(fn.id, { limit: 10 });
      const samples: Array<{ input: unknown; output: unknown }> = [];

      for (const snap of snapshots) {
        if (snap.sample_input !== undefined || snap.sample_output !== undefined) {
          samples.push({
            input: snap.sample_input,
            output: snap.sample_output,
          });
        }
      }

      if (samples.length > 0) {
        functionSamples.push({
          functionName: fn.function_name,
          module: fn.module,
          language: fn.language,
          samples,
        });
      }
    } catch {
      // Skip functions with no snapshot data
    }
  }

  if (functionSamples.length === 0) {
    console.error(chalk.yellow("\n  No functions with sample data found."));
    console.error(chalk.gray("  Run your app with trickle to capture function inputs/outputs first.\n"));
    process.exit(1);
  }

  // Auto-detect language if framework doesn't specify
  const isPython = framework === "pytest";
  const isJS = framework === "vitest" || framework === "jest";

  // Filter samples by language
  const languageFiltered = functionSamples.filter(f =>
    isPython ? f.language === "python" : f.language !== "python"
  );

  if (languageFiltered.length === 0) {
    const lang = isPython ? "Python" : "JavaScript/TypeScript";
    console.error(chalk.yellow(`\n  No ${lang} functions with sample data found.`));
    console.error(chalk.gray(`  Try --framework ${isPython ? "vitest" : "pytest"} for the other language\n`));
    process.exit(1);
  }

  const testCode = isPython
    ? generatePytestFile(languageFiltered)
    : generateUnitTestFile(languageFiltered, framework);

  outputTestCode(testCode, opts, languageFiltered.length, "function", framework);
}

function outputTestCode(
  testCode: string,
  opts: TestGenOptions,
  count: number,
  kind: string,
  framework: string,
): void {
  if (opts.out) {
    const resolvedPath = path.resolve(opts.out);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, testCode, "utf-8");
    console.log("");
    console.log(chalk.green(`  Tests written to ${chalk.bold(opts.out)}`));
    console.log(chalk.gray(`  ${count} ${kind} tests generated (${framework})`));

    const runCmd = framework === "pytest"
      ? `pytest ${opts.out} -v`
      : `npx ${framework === "vitest" ? "vitest run" : "jest"} ${opts.out}`;
    console.log(chalk.gray(`  Run with: ${runCmd}`));
    console.log("");
  } else {
    console.log("");
    console.log(testCode);
  }
}

// ── JS/TS unit test generation ──

function generateUnitTestFile(functions: FunctionSampleData[], framework: string): string {
  const lines: string[] = [];

  lines.push("// Auto-generated unit tests by trickle");
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push("// Based on observed runtime behavior — re-run `trickle test --generate --unit` to update");
  lines.push("");

  if (framework === "vitest") {
    lines.push('import { describe, it, expect } from "vitest";');
    lines.push("");
  }

  // Group functions by module for import organization
  const byModule = groupByModule(functions);

  // Generate import statements
  for (const [mod, fns] of Object.entries(byModule)) {
    const importPath = normalizeImportPath(mod);
    const fnNames = fns.map(f => sanitizeFnName(f.functionName));
    lines.push(`import { ${fnNames.join(", ")} } from "${importPath}";`);
  }
  lines.push("");

  // Generate test blocks
  for (const [mod, fns] of Object.entries(byModule)) {
    for (const fn of fns) {
      const safeName = sanitizeFnName(fn.functionName);
      lines.push(`describe("${safeName}", () => {`);

      for (let i = 0; i < fn.samples.length; i++) {
        const sample = fn.samples[i];
        const testName = describeTestCase(sample.input, sample.output, i);
        const isAsync = isPromiseOutput(sample.output);

        lines.push(`  it("${testName}", ${isAsync ? "async " : ""}() => {`);

        // Build function call
        const argsStr = formatArgs(sample.input);
        const resultVar = isAsync ? `await ${safeName}(${argsStr})` : `${safeName}(${argsStr})`;

        lines.push(`    const result = ${resultVar};`);

        // Generate assertions based on output
        if (sample.output !== undefined && sample.output !== null) {
          const assertions = generateOutputAssertions(sample.output, "result");
          for (const assertion of assertions) {
            lines.push(`    ${assertion}`);
          }
        } else if (sample.output === null) {
          lines.push("    expect(result).toBeNull();");
        } else {
          lines.push("    expect(result).toBeDefined();");
        }

        lines.push("  });");
        lines.push("");
      }

      lines.push("});");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Python pytest generation ──

function generatePytestFile(functions: FunctionSampleData[]): string {
  const lines: string[] = [];

  lines.push("# Auto-generated unit tests by trickle");
  lines.push(`# Generated at ${new Date().toISOString()}`);
  lines.push("# Based on observed runtime behavior — re-run `trickle test --generate --unit --framework pytest` to update");
  lines.push("");

  // Group by module for imports
  const byModule = groupByModule(functions);

  // Generate import statements
  for (const [mod, fns] of Object.entries(byModule)) {
    const importModule = normalizePythonImport(mod);
    const fnNames = fns.map(f => sanitizePythonName(f.functionName));
    lines.push(`from ${importModule} import ${fnNames.join(", ")}`);
  }
  lines.push("");
  lines.push("");

  // Generate test functions
  for (const fn of functions) {
    const safeName = sanitizePythonName(fn.functionName);

    for (let i = 0; i < fn.samples.length; i++) {
      const sample = fn.samples[i];
      const testSuffix = fn.samples.length > 1 ? `_case_${i + 1}` : "";
      const testFnName = `test_${safeName}${testSuffix}`;

      lines.push(`def ${testFnName}():`);
      lines.push(`    """Test ${safeName} with observed runtime data."""`);

      // Format input args
      const argsStr = formatPythonArgs(sample.input);
      lines.push(`    result = ${safeName}(${argsStr})`);

      // Generate assertions
      if (sample.output !== undefined && sample.output !== null) {
        const assertions = generatePythonAssertions(sample.output, "result");
        for (const assertion of assertions) {
          lines.push(`    ${assertion}`);
        }
      } else if (sample.output === null) {
        lines.push("    assert result is None");
      } else {
        lines.push("    assert result is not None");
      }

      lines.push("");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Route test generation (existing logic, preserved) ──

function generateRouteTestFile(routes: MockRoute[], framework: string, baseUrl: string): string {
  const lines: string[] = [];

  lines.push("// Auto-generated API tests by trickle");
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push("// Do not edit manually — re-run `trickle test --generate` to update");
  lines.push("");

  if (framework === "vitest") {
    lines.push('import { describe, it, expect } from "vitest";');
  }
  lines.push("");

  lines.push(`const BASE_URL = process.env.TEST_API_URL || "${baseUrl}";`);
  lines.push("");

  const groups = groupByResource(routes);

  for (const [resource, resourceRoutes] of Object.entries(groups)) {
    lines.push(`describe("${resource}", () => {`);

    for (const route of resourceRoutes) {
      const testName = `${route.method} ${route.path}`;
      const hasBody = ["POST", "PUT", "PATCH"].includes(route.method);

      lines.push(`  it("${testName} — returns expected shape", async () => {`);

      const fetchPath = route.path.replace(/:(\w+)/g, (_, param) => {
        const sampleValue = extractParamFromSample(route.sampleInput, param);
        return sampleValue || `test-${param}`;
      });

      lines.push(`    const res = await fetch(\`\${BASE_URL}${fetchPath}\`, {`);
      lines.push(`      method: "${route.method}",`);
      if (hasBody && route.sampleInput) {
        const bodyData = extractBodyFromSample(route.sampleInput);
        if (bodyData && Object.keys(bodyData).length > 0) {
          lines.push(`      headers: { "Content-Type": "application/json" },`);
          lines.push(`      body: JSON.stringify(${JSON.stringify(bodyData, null, 6).replace(/\n/g, "\n      ")}),`);
        }
      }
      lines.push("    });");
      lines.push("");

      // POST typically returns 201, others return 200
      // Use expect(res.ok) which covers 200-299 range
      lines.push("    expect(res.ok).toBe(true);");
      if (hasBody) {
        lines.push("    expect(res.status === 200 || res.status === 201).toBe(true);");
      } else {
        lines.push(`    expect(res.status).toBe(200);`);
      }
      lines.push("");

      lines.push("    const body = await res.json();");

      if (route.sampleOutput && typeof route.sampleOutput === "object") {
        const assertions = generateAssertions(route.sampleOutput as Record<string, unknown>, "body");
        for (const assertion of assertions) {
          lines.push(`    ${assertion}`);
        }
      }

      lines.push("  });");
      lines.push("");
    }

    lines.push("});");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Helpers: grouping & naming ──

function isRouteHandler(name: string): boolean {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(name);
}

function groupByModule(functions: FunctionSampleData[]): Record<string, FunctionSampleData[]> {
  const groups: Record<string, FunctionSampleData[]> = {};
  for (const fn of functions) {
    const mod = fn.module || "unknown";
    if (!groups[mod]) groups[mod] = [];
    groups[mod].push(fn);
  }
  return groups;
}

function sanitizeFnName(name: string): string {
  // Handle names like "MyClass.method" → "method" (keep class context in describe)
  // Handle names with special chars
  return name
    .replace(/[^a-zA-Z0-9_$]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function sanitizePythonName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeImportPath(mod: string): string {
  // Convert file paths to relative import paths
  // e.g., "/Users/.../src/utils.ts" → "./src/utils"
  // e.g., "src/helpers/math.js" → "./src/helpers/math"
  let p = mod;

  // Strip file extension
  p = p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

  // If absolute path, try to make it relative to CWD
  if (path.isAbsolute(p)) {
    const cwd = process.cwd();
    p = path.relative(cwd, p);
  }

  // Ensure starts with ./ or ../
  if (!p.startsWith(".") && !p.startsWith("/")) {
    p = "./" + p;
  }

  return p;
}

function normalizePythonImport(mod: string): string {
  // Convert file paths to Python module paths
  // e.g., "app/utils.py" → "app.utils"
  // e.g., "/abs/path/app/models.py" → "app.models"
  let p = mod;

  // Strip .py extension
  p = p.replace(/\.py$/, "");

  // If absolute path, try to make relative
  if (path.isAbsolute(p)) {
    const cwd = process.cwd();
    p = path.relative(cwd, p);
  }

  // Convert path separators to dots
  p = p.replace(/[/\\]/g, ".");

  // Remove leading dots
  p = p.replace(/^\.+/, "");

  // Handle __init__ modules
  p = p.replace(/\.__init__$/, "");

  return p || "app";
}

function describeTestCase(input: unknown, output: unknown, index: number): string {
  // Generate a human-readable test name from the input/output
  if (input === undefined && output === undefined) {
    return `case ${index + 1}`;
  }

  const parts: string[] = [];

  // Describe input
  if (input !== undefined) {
    if (input === null) {
      parts.push("given null input");
    } else if (Array.isArray(input)) {
      if (input.length === 0) {
        parts.push("given empty args");
      } else {
        const argSummaries = input.slice(0, 3).map(summarizeValue);
        parts.push(`given ${argSummaries.join(", ")}`);
      }
    } else if (typeof input === "object") {
      // Named args or single object arg
      const keys = Object.keys(input as Record<string, unknown>);
      if (keys.length <= 3) {
        parts.push(`given ${keys.join(", ")}`);
      } else {
        parts.push(`given ${keys.length} params`);
      }
    } else {
      parts.push(`given ${summarizeValue(input)}`);
    }
  }

  // Describe expected output briefly
  if (output !== undefined) {
    if (output === null) {
      parts.push("returns null");
    } else if (Array.isArray(output)) {
      parts.push(`returns array(${output.length})`);
    } else if (typeof output === "object") {
      const keys = Object.keys(output as Record<string, unknown>);
      parts.push(`returns {${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`);
    } else {
      parts.push(`returns ${summarizeValue(output)}`);
    }
  }

  const name = parts.join(", ") || `case ${index + 1}`;
  // Escape double quotes for use inside it("...") strings
  return name.replace(/"/g, '\\"');
}

function summarizeValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") {
    const escaped = val.replace(/"/g, '\\"');
    return escaped.length > 20 ? `"${escaped.slice(0, 17)}..."` : `"${escaped}"`;
  }
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return `[${val.length} items]`;
  if (typeof val === "object") {
    const keys = Object.keys(val as Record<string, unknown>);
    return `{${keys.length} keys}`;
  }
  return String(val);
}

function isPromiseOutput(output: unknown): boolean {
  // Heuristic: if the type node says "Promise" it's async
  if (output && typeof output === "object" && "type" in (output as any)) {
    const t = (output as any).type;
    if (typeof t === "string" && t.includes("Promise")) return true;
  }
  return false;
}

// ── Helpers: argument formatting ──

function formatArgs(input: unknown): string {
  if (input === undefined || input === null) return "";

  // If input is an array, it's positional args
  if (Array.isArray(input)) {
    return input.map(v => formatValue(v)).join(", ");
  }

  // If input is an object, check if it looks like named args or a single object arg
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);

    // If it has typical Express-like keys (params, body, query), it's a route handler — skip
    if (keys.some(k => ["params", "body", "query", "headers"].includes(k))) {
      return formatValue(input);
    }

    // Treat as a single object argument
    return formatValue(input);
  }

  return formatValue(input);
}

function formatValue(val: unknown): string {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") return JSON.stringify(val);
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    if (val.length <= 5) {
      return `[${val.map(v => formatValue(v)).join(", ")}]`;
    }
    // For large arrays, use JSON.stringify with formatting
    return JSON.stringify(val);
  }
  if (typeof val === "object") {
    return JSON.stringify(val);
  }
  return String(val);
}

function formatPythonArgs(input: unknown): string {
  if (input === undefined || input === null) return "";

  if (Array.isArray(input)) {
    return input.map(v => formatPythonValue(v)).join(", ");
  }

  if (typeof input === "object") {
    return formatPythonValue(input);
  }

  return formatPythonValue(input);
}

function formatPythonValue(val: unknown): string {
  if (val === undefined) return "None";
  if (val === null) return "None";
  if (typeof val === "boolean") return val ? "True" : "False";
  if (typeof val === "string") return JSON.stringify(val); // JSON string syntax works in Python
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    if (val.length <= 5) {
      return `[${val.map(v => formatPythonValue(v)).join(", ")}]`;
    }
    return toPythonLiteral(val);
  }
  if (typeof val === "object") {
    return toPythonLiteral(val);
  }
  return String(val);
}

function toPythonLiteral(val: unknown): string {
  // Convert JS objects/arrays to Python dict/list syntax
  const json = JSON.stringify(val);
  return json
    .replace(/\bnull\b/g, "None")
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False");
}

// ── Helpers: assertion generation ──

function generateOutputAssertions(output: unknown, varName: string): string[] {
  if (output === null) return [`expect(${varName}).toBeNull();`];
  if (output === undefined) return [`expect(${varName}).toBeDefined();`];

  if (typeof output === "string") {
    return [`expect(typeof ${varName}).toBe("string");`];
  }
  if (typeof output === "number") {
    return [`expect(typeof ${varName}).toBe("number");`];
  }
  if (typeof output === "boolean") {
    return [`expect(typeof ${varName}).toBe("boolean");`];
  }

  if (Array.isArray(output)) {
    const assertions = [`expect(Array.isArray(${varName})).toBe(true);`];
    if (output.length > 0 && typeof output[0] === "object" && output[0] !== null) {
      assertions.push(`expect(${varName}.length).toBeGreaterThan(0);`);
      const itemAssertions = generateOutputAssertions(output[0], `${varName}[0]`);
      assertions.push(...itemAssertions);
    }
    return assertions;
  }

  if (typeof output === "object") {
    return generateAssertions(output as Record<string, unknown>, varName);
  }

  return [`expect(${varName}).toBeDefined();`];
}

function generatePythonAssertions(output: unknown, varName: string, depth = 0): string[] {
  if (depth > 3) return [];
  if (output === null) return [`assert ${varName} is None`];
  if (output === undefined) return [`assert ${varName} is not None`];

  if (typeof output === "string") {
    return [`assert isinstance(${varName}, str)`];
  }
  if (typeof output === "number") {
    return [`assert isinstance(${varName}, (int, float))`];
  }
  if (typeof output === "boolean") {
    return [`assert isinstance(${varName}, bool)`];
  }

  if (Array.isArray(output)) {
    const assertions = [`assert isinstance(${varName}, list)`];
    if (output.length > 0 && typeof output[0] === "object" && output[0] !== null) {
      assertions.push(`assert len(${varName}) > 0`);
      const itemAssertions = generatePythonAssertions(output[0], `${varName}[0]`, depth + 1);
      assertions.push(...itemAssertions);
    }
    return assertions;
  }

  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const assertions = [`assert isinstance(${varName}, dict)`];
    for (const [key, value] of Object.entries(obj)) {
      if (depth < 2) {
        assertions.push(`assert "${key}" in ${varName}`);
        if (value !== null && value !== undefined && typeof value !== "object") {
          const typeAssertions = generatePythonAssertions(value, `${varName}["${key}"]`, depth + 1);
          assertions.push(...typeAssertions);
        }
      }
    }
    return assertions;
  }

  return [`assert ${varName} is not None`];
}

// ── Route test helpers (preserved from original) ──

function groupByResource(routes: MockRoute[]): Record<string, MockRoute[]> {
  const groups: Record<string, MockRoute[]> = {};

  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    let resource: string;
    if (parts[0] === "api" && parts.length >= 2) {
      resource = `/api/${parts[1]}`;
    } else {
      resource = `/${parts[0] || "root"}`;
    }

    if (!groups[resource]) groups[resource] = [];
    groups[resource].push(route);
  }

  return groups;
}

function extractParamFromSample(sampleInput: unknown, param: string): string | null {
  if (!sampleInput || typeof sampleInput !== "object") return null;
  const input = sampleInput as Record<string, unknown>;

  if (input.params && typeof input.params === "object") {
    const params = input.params as Record<string, unknown>;
    if (params[param] !== undefined) return String(params[param]);
  }

  return null;
}

function extractBodyFromSample(sampleInput: unknown): Record<string, unknown> | null {
  if (!sampleInput || typeof sampleInput !== "object") return null;
  const input = sampleInput as Record<string, unknown>;

  if (input.body && typeof input.body === "object") {
    return input.body as Record<string, unknown>;
  }

  return null;
}

function generateAssertions(obj: Record<string, unknown>, path: string, depth = 0): string[] {
  if (depth > 3) return [];

  const assertions: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const propPath = `${path}.${key}`;

    // Skip truncated values from sanitizeSample — they have wrong types
    if (value === "[truncated]") {
      assertions.push(`expect(${propPath}).toBeDefined();`);
      continue;
    }

    if (value === null) {
      assertions.push(`expect(${propPath}).toBeNull();`);
    } else if (Array.isArray(value)) {
      assertions.push(`expect(Array.isArray(${propPath})).toBe(true);`);
      if (value.length > 0) {
        // Skip if first item is truncated
        if (value[0] === "[truncated]") {
          assertions.push(`expect(${propPath}.length).toBeGreaterThan(0);`);
        } else if (typeof value[0] === "object" && value[0] !== null) {
          assertions.push(`expect(${propPath}.length).toBeGreaterThan(0);`);
          const itemAssertions = generateAssertions(
            value[0] as Record<string, unknown>,
            `${propPath}[0]`,
            depth + 1,
          );
          assertions.push(...itemAssertions);
        }
      }
    } else if (typeof value === "object") {
      assertions.push(`expect(typeof ${propPath}).toBe("object");`);
      const nestedAssertions = generateAssertions(
        value as Record<string, unknown>,
        propPath,
        depth + 1,
      );
      assertions.push(...nestedAssertions);
    } else if (typeof value === "string") {
      // Check if this looks like a truncated string from sanitizeSample
      if (typeof value === "string" && (value as string).endsWith("...")) {
        assertions.push(`expect(typeof ${propPath}).toBe("string");`);
      } else {
        assertions.push(`expect(typeof ${propPath}).toBe("string");`);
      }
    } else if (typeof value === "number") {
      assertions.push(`expect(typeof ${propPath}).toBe("number");`);
    } else if (typeof value === "boolean") {
      assertions.push(`expect(typeof ${propPath}).toBe("boolean");`);
    }
  }

  return assertions;
}
