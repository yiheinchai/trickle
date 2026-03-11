import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import chalk from "chalk";
import { getBackendUrl } from "../config";
import {
  listFunctions,
  listErrors,
  fetchAnnotations,
  fetchStubs,
  FunctionRow,
  ErrorRow,
  AnnotationEntry,
} from "../api-client";

export interface RunOptions {
  module?: string;
  include?: string;
  exclude?: string;
  stubs?: string;
  annotate?: string;
}

// ── .tricklerc.json config ──

interface TrickleConfig {
  stubs?: string;
  annotate?: string | string[];
  include?: string | string[];
  exclude?: string | string[];
}

function loadProjectConfig(): TrickleConfig | null {
  const configNames = [".tricklerc.json", ".tricklerc", "trickle.config.json"];
  for (const name of configNames) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        return null;
      }
    }
  }
  // Also check package.json "trickle" field
  const pkgPath = path.resolve("package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.trickle && typeof pkg.trickle === "object") {
        return pkg.trickle as TrickleConfig;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function mergeConfigWithOpts(opts: RunOptions, config: TrickleConfig | null): RunOptions {
  if (!config) return opts;
  const merged = { ...opts };

  // CLI flags override config
  if (!merged.stubs && config.stubs) {
    merged.stubs = config.stubs;
  }
  if (!merged.annotate && config.annotate) {
    // If array, join first item (run --annotate takes a single path)
    merged.annotate = Array.isArray(config.annotate)
      ? config.annotate[0]
      : config.annotate;
  }
  if (!merged.include && config.include) {
    merged.include = Array.isArray(config.include)
      ? config.include.join(",")
      : config.include;
  }
  if (!merged.exclude && config.exclude) {
    merged.exclude = Array.isArray(config.exclude)
      ? config.exclude.join(",")
      : config.exclude;
  }
  return merged;
}

// ── Auto-detect runtime from file extension ──

function autoDetectCommand(input: string): string {
  // If it already starts with a known runtime, return as-is
  if (/^(node|ts-node|tsx|nodemon|bun|deno|python3?|python3?\.\d+|vitest|jest|mocha|npx|bunx|pytest|uvicorn|gunicorn|flask|django-admin)\b/.test(input)) {
    return input;
  }

  // Check if the first token is a file path
  const parts = input.split(/\s+/);
  const file = parts[0];
  const rest = parts.slice(1).join(" ");
  const ext = path.extname(file).toLowerCase();

  // Resolve relative to cwd
  const resolved = path.resolve(file);
  const fileExists = fs.existsSync(resolved);

  if (!fileExists) {
    // Not a file — might be a custom command, return as-is
    return input;
  }

  switch (ext) {
    case ".js":
    case ".cjs":
      return rest ? `node ${file} ${rest}` : `node ${file}`;

    case ".mjs":
      return rest ? `node ${file} ${rest}` : `node ${file}`;

    case ".ts":
    case ".tsx":
    case ".mts": {
      // Find best available TS runtime
      const tsRunner = findTsRunner();
      return rest ? `${tsRunner} ${file} ${rest}` : `${tsRunner} ${file}`;
    }

    case ".py":
      return rest ? `python ${file} ${rest}` : `python ${file}`;

    default:
      return input;
  }
}

function findTsRunner(): string {
  // Check for tsx (fastest, most compatible)
  try {
    const { execSync } = require("child_process");
    execSync("tsx --version", { stdio: "ignore" });
    return "tsx";
  } catch {
    // not available
  }

  // Check for ts-node
  try {
    const { execSync } = require("child_process");
    execSync("ts-node --version", { stdio: "ignore" });
    return "ts-node";
  } catch {
    // not available
  }

  // Check for bun (supports TS natively)
  try {
    const { execSync } = require("child_process");
    execSync("bun --version", { stdio: "ignore" });
    return "bun";
  } catch {
    // not available
  }

  // Fallback to npx tsx
  return "npx tsx";
}

/**
 * `trickle run <command>` — Run any command with universal type observation.
 *
 * Auto-detects JS or Python, injects the right instrumentation, starts the
 * backend if needed, and shows a summary of captured types after exit.
 * With --stubs or --annotate, also generates type files automatically.
 * Reads .tricklerc.json for project defaults.
 */
export async function runCommand(
  command: string | undefined,
  opts: RunOptions,
): Promise<void> {
  if (!command) {
    console.error(chalk.red("\n  Usage: trickle run <command>\n"));
    console.error(chalk.gray("  Examples:"));
    console.error(chalk.gray('    trickle run "node app.js"'));
    console.error(chalk.gray("    trickle run app.ts              # auto-detects TypeScript runtime"));
    console.error(chalk.gray("    trickle run script.py            # auto-detects Python"));
    console.error(chalk.gray('    trickle run "node app.js" --stubs src/'));
    console.error("");
    process.exit(1);
  }

  // Load project config
  const config = loadProjectConfig();
  opts = mergeConfigWithOpts(opts, config);

  // Auto-detect runtime from file extension
  const resolvedCommand = autoDetectCommand(command);

  const backendUrl = getBackendUrl();

  // Auto-start backend if not running
  let backendProc: ChildProcess | null = null;
  const backendRunning = await checkBackend(backendUrl);
  if (!backendRunning) {
    backendProc = await autoStartBackend();
    if (!backendProc) {
      console.error(
        chalk.red(
          `\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`,
        ),
      );
      console.error(
        chalk.gray(
          "  Start the backend: cd packages/backend && npm start\n",
        ),
      );
      process.exit(1);
    }
  }

  // Snapshot functions before run (to compute delta)
  let functionsBefore: FunctionRow[] = [];
  let errorsBefore: ErrorRow[] = [];
  try {
    const fb = await listFunctions();
    functionsBefore = fb.functions;
    const eb = await listErrors();
    errorsBefore = eb.errors;
  } catch {
    // Backend might not have data yet
  }

  // Detect language and inject instrumentation
  const { instrumentedCommand, env: extraEnv } = injectObservation(
    resolvedCommand,
    backendUrl,
    opts,
  );

  // Print header
  console.log("");
  console.log(chalk.bold("  trickle run"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  if (resolvedCommand !== command) {
    console.log(chalk.gray(`  File:      ${command}`));
    console.log(chalk.gray(`  Resolved:  ${resolvedCommand}`));
  } else {
    console.log(chalk.gray(`  Command:   ${command}`));
  }
  if (instrumentedCommand !== resolvedCommand) {
    console.log(chalk.gray(`  Injected:  ${instrumentedCommand}`));
  }
  console.log(chalk.gray(`  Backend:   ${backendUrl}`));
  if (config) {
    console.log(chalk.gray(`  Config:    .tricklerc.json`));
  }
  if (opts.stubs) {
    console.log(chalk.gray(`  Stubs:     ${opts.stubs}`));
  }
  if (opts.annotate) {
    console.log(chalk.gray(`  Annotate:  ${opts.annotate}`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Run the instrumented command
  const exitCode = await runProcess(instrumentedCommand, {
    ...extraEnv,
    TRICKLE_BACKEND_URL: backendUrl,
    TRICKLE_DEBUG: process.env.TRICKLE_DEBUG || "",
  });

  // Wait for transport to flush
  console.log(chalk.gray("\n  Waiting for type data to flush..."));
  await sleep(3000);

  // Show summary with inline type signatures
  await showSummary(functionsBefore, errorsBefore);

  // Auto-generate stubs if --stubs was specified
  if (opts.stubs) {
    await autoGenerateStubs(opts.stubs);
  }

  // Auto-annotate if --annotate was specified
  if (opts.annotate) {
    await autoAnnotateFiles(opts.annotate);
  }

  // Clean up
  if (backendProc) {
    backendProc.kill("SIGTERM");
    await sleep(500);
  }

  process.exit(exitCode);
}

// ── Auto-generate stubs ──

async function autoGenerateStubs(dir: string): Promise<void> {
  try {
    const { stubsCommand } = await import("./stubs");
    await stubsCommand(dir, {});
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.yellow(`\n  Stubs generation warning: ${err.message}`));
    }
  }
}

// ── Auto-annotate files ──

async function autoAnnotateFiles(fileOrDir: string): Promise<void> {
  try {
    const { annotateCommand } = await import("./annotate");
    const resolved = path.resolve(fileOrDir);

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      // Annotate all JS/TS/Python files in the directory
      const files = findAnnotatableFiles(resolved);
      if (files.length === 0) {
        console.log(chalk.gray(`\n  No annotatable files found in ${fileOrDir}`));
        return;
      }
      for (const file of files) {
        await annotateCommand(file, {});
      }
    } else {
      // Annotate a single file
      await annotateCommand(fileOrDir, {});
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.yellow(`\n  Annotation warning: ${err.message}`));
    }
  }
}

function findAnnotatableFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__pycache__", ".git", "dist", "build", ".trickle"].includes(entry.name)) continue;
      results.push(...findAnnotatableFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"].includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ── Inline type signatures in summary ──

async function fetchTypeSignatures(
  newFunctions: FunctionRow[],
): Promise<Record<string, AnnotationEntry>> {
  try {
    const { annotations } = await fetchAnnotations({});
    return annotations || {};
  } catch {
    return {};
  }
}

function formatSignature(
  fnName: string,
  annotation: AnnotationEntry,
  maxLen: number = 90,
): string {
  const params = annotation.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const sig = `${fnName}(${params}) → ${annotation.returnType}`;
  if (sig.length > maxLen) {
    return sig.substring(0, maxLen - 1) + "…";
  }
  return sig;
}

/**
 * Detect if a script file uses ES modules.
 */
function isEsmFile(command: string): boolean {
  const parts = command.split(/\s+/);
  for (const part of parts) {
    if (part.endsWith(".mjs") || part.endsWith(".mts")) return true;

    if (
      part.endsWith(".js") ||
      part.endsWith(".ts") ||
      part.endsWith(".tsx") ||
      part.endsWith(".jsx")
    ) {
      const filePath = path.resolve(part);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (/^\s*(import|export)\s/m.test(content)) return true;
      } catch {
        // File might not exist at this path
      }

      try {
        let dir = path.dirname(filePath);
        for (let i = 0; i < 10; i++) {
          const pkgPath = path.join(dir, "package.json");
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            if (pkg.type === "module") return true;
            break;
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch {
        // Ignore
      }
    }
  }
  return false;
}

/**
 * Detect the language and inject the appropriate auto-observation mechanism.
 */
function injectObservation(
  command: string,
  backendUrl: string,
  opts: RunOptions,
): { instrumentedCommand: string; env: Record<string, string> } {
  const env: Record<string, string> = {};

  if (
    command.includes("trickle/observe") ||
    command.includes("trickle/register") ||
    command.includes("-m trickle")
  ) {
    return { instrumentedCommand: command, env };
  }

  const observePath = resolveObservePath();
  const observeEsmPath = resolveObserveEsmPath();

  if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
  if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;

  const nodeMatch = command.match(/^(node|ts-node|tsx|nodemon)\s/);
  if (nodeMatch) {
    const runner = nodeMatch[1];
    const useEsm = isEsmFile(command) && observeEsmPath;

    if (useEsm) {
      const modified = command.replace(
        new RegExp(`^${runner}\\s`),
        `${runner} --import ${observeEsmPath} `,
      );
      return { instrumentedCommand: modified, env };
    } else {
      const modified = command.replace(
        new RegExp(`^${runner}\\s`),
        `${runner} -r ${observePath} `,
      );
      return { instrumentedCommand: modified, env };
    }
  }

  if (/^(vitest|jest|mocha|npx|bunx|bun)\b/.test(command)) {
    const existing = process.env.NODE_OPTIONS || "";
    if (observeEsmPath) {
      env.NODE_OPTIONS =
        `${existing} -r ${observePath} --import ${observeEsmPath}`.trim();
    } else {
      env.NODE_OPTIONS = `${existing} -r ${observePath}`.trim();
    }
    return { instrumentedCommand: command, env };
  }

  const pyMatch = command.match(/^(python3?|python3?\.\d+)\s/);
  if (pyMatch) {
    const python = pyMatch[1];
    const rest = command.slice(pyMatch[0].length);
    if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
    if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;
    return {
      instrumentedCommand: `${python} -c "from trickle.observe_runner import main; main()" ${rest}`,
      env,
    };
  }

  if (/^(pytest|uvicorn|gunicorn|flask|django-admin)\b/.test(command)) {
    if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
    if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;
    return {
      instrumentedCommand: `python -c "from trickle.observe_runner import main; main()" -m ${command}`,
      env,
    };
  }

  console.log(
    chalk.yellow(
      "  Could not detect language. Trying Node.js instrumentation...",
    ),
  );
  const existing = process.env.NODE_OPTIONS || "";
  env.NODE_OPTIONS = `${existing} -r ${observePath}`.trim();
  return { instrumentedCommand: command, env };
}

function resolveObservePath(): string {
  try {
    return require.resolve("trickle/observe");
  } catch {
    // Not in node_modules
  }

  const monorepoPath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "client-js",
    "observe.js",
  );
  if (fs.existsSync(monorepoPath)) return monorepoPath;

  return "trickle/observe";
}

function resolveObserveEsmPath(): string | null {
  try {
    return require.resolve("trickle/observe-esm");
  } catch {
    // Not in node_modules
  }

  const monorepoPath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "client-js",
    "observe-esm.mjs",
  );
  if (fs.existsSync(monorepoPath)) return monorepoPath;

  return null;
}

function runProcess(
  command: string,
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });

    proc.on("error", (err) => {
      console.error(chalk.red(`\n  Failed to start: ${err.message}\n`));
      resolve(1);
    });

    proc.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * Show a summary of what was captured during the run, with inline type signatures.
 */
async function showSummary(
  functionsBefore: FunctionRow[],
  errorsBefore: ErrorRow[],
): Promise<void> {
  try {
    const { functions } = await listFunctions();
    const { errors } = await listErrors();

    const beforeIds = new Set(functionsBefore.map((f) => f.id));
    const newFunctions = functions.filter((f) => !beforeIds.has(f.id));

    const beforeErrorIds = new Set(errorsBefore.map((e) => e.id));
    const newErrors = errors.filter((e) => !beforeErrorIds.has(e.id));

    // Fetch inline type signatures for the new functions
    const annotations = await fetchTypeSignatures(newFunctions);

    console.log("");
    console.log(chalk.bold("  Summary"));
    console.log(chalk.gray("  " + "─".repeat(50)));

    if (functions.length === 0) {
      console.log(
        chalk.yellow("  No functions captured. The command may not have"),
      );
      console.log(
        chalk.yellow("  loaded any modules that could be instrumented."),
      );
    } else {
      console.log(
        `  Functions observed: ${chalk.bold(String(functions.length))} total, ${chalk.green(String(newFunctions.length) + " new")}`,
      );

      if (newFunctions.length > 0) {
        console.log("");
        const shown = newFunctions.slice(0, 15);
        for (const fn of shown) {
          const annotation = annotations[fn.function_name];
          if (annotation) {
            // Show full type signature
            const sig = formatSignature(fn.function_name, annotation);
            console.log(`    ${chalk.green("+")} ${sig}`);
            console.log(chalk.gray(`      ${fn.module} module`));
          } else {
            const moduleBadge = chalk.gray(`[${fn.module}]`);
            console.log(
              `    ${chalk.green("+")} ${fn.function_name} ${moduleBadge}`,
            );
          }
        }
        if (newFunctions.length > 15) {
          console.log(
            chalk.gray(`    ... and ${newFunctions.length - 15} more`),
          );
        }
      }

      if (newErrors.length > 0) {
        console.log("");
        console.log(
          `  Errors captured: ${chalk.red(String(newErrors.length))}`,
        );
        const shownErrors = newErrors.slice(0, 5);
        for (const err of shownErrors) {
          const fn = functions.find((f) => f.id === err.function_id);
          const fnName = fn ? fn.function_name : "unknown";
          console.log(
            `    ${chalk.red("!")} ${fnName}: ${chalk.gray(err.error_message.substring(0, 80))}`,
          );
        }
      }

      console.log("");
      console.log(chalk.gray("  Explore results:"));
      console.log(
        chalk.gray(
          "    trickle functions          # list all captured functions",
        ),
      );
      if (newFunctions.length > 0) {
        const example = newFunctions[0].function_name;
        console.log(
          chalk.gray(
            `    trickle types ${example}  # see types + sample data`,
          ),
        );
      }
      if (newErrors.length > 0) {
        console.log(
          chalk.gray(
            "    trickle errors             # see captured errors",
          ),
        );
      }
    }

    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log("");
  } catch {
    console.log(chalk.gray("\n  Could not fetch summary from backend.\n"));
  }
}

async function checkBackend(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function autoStartBackend(): Promise<ChildProcess | null> {
  const backendPaths = [
    path.resolve("packages/backend/dist/index.js"),
    path.resolve("node_modules/trickle-backend/dist/index.js"),
  ];

  for (const p of backendPaths) {
    if (fs.existsSync(p)) {
      console.log(chalk.gray("  Auto-starting trickle backend..."));
      const proc = spawn("node", [p], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: false,
      });

      proc.stdout?.on("data", () => {});
      proc.stderr?.on("data", () => {});
      proc.unref();

      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const ready = await checkBackend(getBackendUrl());
        if (ready) {
          console.log(chalk.gray("  Backend started ✓\n"));
          return proc;
        }
      }

      proc.kill("SIGTERM");
      return null;
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
