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
  watch?: boolean;
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

// ── Detect if command is a single source file ──

function detectSingleFile(command: string): string | null {
  const trimmed = command.trim();
  // Must be a single token (no spaces unless quoted)
  if (/\s/.test(trimmed)) return null;

  const ext = path.extname(trimmed).toLowerCase();
  if (![".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".py"].includes(ext)) {
    return null;
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) return null;

  return resolved;
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
  const { execSync } = require("child_process");

  // Add node_modules/.bin to PATH so local binaries are found
  const binPath = path.join(process.cwd(), "node_modules", ".bin");
  const currentPath = process.env.PATH || "";
  const augmentedPath = currentPath.includes(binPath) ? currentPath : `${binPath}${path.delimiter}${currentPath}`;
  const execOpts = { stdio: "ignore" as const, env: { ...process.env, PATH: augmentedPath } };

  // Check for tsx (fastest, most compatible)
  try {
    execSync("tsx --version", execOpts);
    return "tsx";
  } catch {
    // not available
  }

  // Check for ts-node
  try {
    execSync("ts-node --version", execOpts);
    return "ts-node";
  } catch {
    // not available
  }

  // Check for bun (supports TS natively)
  try {
    execSync("bun --version", execOpts);
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
    console.error(chalk.gray("    trickle run app.js --watch       # watch for changes and re-run"));
    console.error("");
    process.exit(1);
  }

  // Load project config
  const config = loadProjectConfig();
  opts = mergeConfigWithOpts(opts, config);

  // Detect if command is a single file — if so, auto-generate sidecar types
  const singleFile = detectSingleFile(command);

  // Auto-detect runtime from file extension
  const resolvedCommand = autoDetectCommand(command);

  const backendUrl = getBackendUrl();

  // Auto-start backend if not running — fall back to local mode
  let backendProc: ChildProcess | null = null;
  let localMode = false;
  const backendRunning = await checkBackend(backendUrl);
  if (!backendRunning) {
    // Only try auto-start if using default URL (custom URL means user manages their own backend)
    const isCustomUrl = !!process.env.TRICKLE_BACKEND_URL &&
      process.env.TRICKLE_BACKEND_URL !== "http://localhost:4888";
    if (!isCustomUrl) {
      backendProc = await autoStartBackend();
    }
    if (!backendProc) {
      // Fall back to local/offline mode instead of exiting
      localMode = true;
      console.log(
        chalk.yellow(
          `\n  Backend not available — using local mode (offline)`,
        ),
      );
      console.log(
        chalk.gray(
          "  Observations will be saved to .trickle/observations.jsonl",
        ),
      );
    }
  }

  // Detect language and inject instrumentation
  const { instrumentedCommand, env: extraEnv } = injectObservation(
    resolvedCommand,
    backendUrl,
    opts,
  );

  // Print header
  console.log("");
  console.log(chalk.bold(opts.watch ? "  trickle run --watch" : "  trickle run"));
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
  if (localMode) {
    console.log(chalk.gray(`  Mode:      local (offline)`));
  } else {
    console.log(chalk.gray(`  Backend:   ${backendUrl}`));
  }
  if (config) {
    console.log(chalk.gray(`  Config:    .tricklerc.json`));
  }
  if (opts.stubs) {
    console.log(chalk.gray(`  Stubs:     ${opts.stubs}`));
  }
  if (opts.annotate) {
    console.log(chalk.gray(`  Annotate:  ${opts.annotate}`));
  }
  if (opts.watch) {
    console.log(chalk.gray(`  Watch:     enabled`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Shared env for all runs
  const runEnv: Record<string, string> = {
    ...extraEnv,
    TRICKLE_BACKEND_URL: backendUrl,
    TRICKLE_DEBUG: process.env.TRICKLE_DEBUG || "",
  };

  // In local mode, set TRICKLE_LOCAL=1 so the client writes to JSONL
  if (localMode) {
    runEnv.TRICKLE_LOCAL = "1";
    // Forward TRICKLE_LOCAL_DIR if set
    if (process.env.TRICKLE_LOCAL_DIR) {
      runEnv.TRICKLE_LOCAL_DIR = process.env.TRICKLE_LOCAL_DIR;
    }
  }

  // Execute the single-run flow
  const exitCode = await executeSingleRun(
    instrumentedCommand,
    runEnv,
    opts,
    singleFile,
    localMode,
  );

  // If --watch, enter watch loop instead of exiting
  if (opts.watch) {
    await enterWatchLoop(command, instrumentedCommand, runEnv, opts, singleFile, backendProc, localMode);
    // enterWatchLoop never returns (handles its own exit)
  }

  // Clean up
  if (backendProc) {
    backendProc.kill("SIGTERM");
    await sleep(500);
  }

  process.exit(exitCode);
}

/**
 * Execute a single observation run: run the command, wait for flush, show summary.
 */
async function executeSingleRun(
  instrumentedCommand: string,
  env: Record<string, string>,
  opts: RunOptions,
  singleFile?: string | null,
  localMode?: boolean,
): Promise<number> {
  if (!localMode) {
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

    // Start live type generation for backend mode
    let liveStop: (() => void) | null = null;
    if (opts.stubs) {
      liveStop = startLiveStubsGeneration(opts.stubs);
    } else if (singleFile) {
      liveStop = startLiveBackendTypes(singleFile);
    }

    // Run the instrumented command
    const exitCode = await runProcess(instrumentedCommand, env);

    // Stop live watcher
    if (liveStop) liveStop();

    // Wait for transport to flush
    console.log(chalk.gray("\n  Waiting for type data to flush..."));
    await sleep(3000);

    // Show summary with inline type signatures
    const varsPath = path.join(
      process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle"),
      "variables.jsonl",
    );
    await showSummary(functionsBefore, errorsBefore, varsPath);

    // Auto-generate stubs if --stubs was specified
    if (opts.stubs) {
      await autoGenerateStubs(opts.stubs);
    }

    // Auto-annotate if --annotate was specified
    if (opts.annotate) {
      await autoAnnotateFiles(opts.annotate);
    }

    // Auto-generate sidecar type file when invoked with a single file
    // (unless --stubs was explicitly specified, which overrides this)
    if (singleFile && !opts.stubs) {
      await autoGenerateSidecar(singleFile);
    }

    return exitCode;
  }

  // ── Local/offline mode ──

  const localDir = env.TRICKLE_LOCAL_DIR || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
  const jsonlPath = path.join(localDir, "observations.jsonl");

  const { generateLocalStubs, generateFromJsonl, readObservations } = await import("../local-codegen");

  // Check if stub generation is enabled (TRICKLE_STUBS=0 disables .pyi/.d.ts files)
  const stubsEnabled = (env.TRICKLE_STUBS || process.env.TRICKLE_STUBS || "1").toLowerCase() !== "0";

  // Start live type generation — types update while the process runs
  let liveTypesStop: (() => void) | null = null;
  if (singleFile && stubsEnabled) {
    liveTypesStop = startLiveLocalTypes(singleFile, jsonlPath, generateLocalStubs);
  }

  // Run the instrumented command
  const exitCode = await runProcess(instrumentedCommand, env);

  // Stop live watcher
  if (liveTypesStop) liveTypesStop();

  // Brief pause for any async file writes to complete
  await sleep(500);

  if (!fs.existsSync(jsonlPath)) {
    console.log(chalk.gray("\n  No observations captured."));
    return exitCode;
  }

  // Final type generation (catches any remaining observations)
  if (singleFile && stubsEnabled) {
    generateLocalStubs(singleFile, jsonlPath);
  }

  // Show local summary with function signatures
  const observations = readObservations(jsonlPath);
  const totalFunctions = observations.length;

  console.log("");
  console.log(chalk.bold("  trickle summary"));
  console.log(chalk.gray("  " + "─".repeat(50)));

  // ── Function signatures ──
  if (totalFunctions > 0) {
    console.log(`  ${chalk.bold("Function types")} — ${totalFunctions} observed`);
    // Group by module
    const byModule = new Map<string, typeof observations>();
    for (const fn of observations) {
      const mod = fn.module || "_default";
      if (!byModule.has(mod)) byModule.set(mod, []);
      byModule.get(mod)!.push(fn);
    }

    for (const [mod, fns] of byModule) {
      if (byModule.size > 1) {
        console.log(`  ${chalk.bold(mod)}`);
      }
      const shown = fns.slice(0, 15);
      for (const fn of shown) {
        const sig = _formatLocalSignature(fn);
        console.log(`    ${chalk.green("→")} ${sig}`);
      }
      if (fns.length > 15) {
        console.log(chalk.gray(`    ... and ${fns.length - 15} more`));
      }
    }

    // Stub file status
    if (singleFile && stubsEnabled) {
      const ext = path.extname(singleFile).toLowerCase();
      const isPython = ext === ".py";
      const baseName = path.basename(singleFile, ext);
      const stubExt = isPython ? ".pyi" : ".d.ts";
      const stubFile = path.join(path.dirname(singleFile), `${baseName}${stubExt}`);
      if (fs.existsSync(stubFile)) {
        const relPath = path.relative(process.cwd(), stubFile);
        console.log(`  ${chalk.green("✓")} Stub file: ${chalk.bold(relPath)} ${chalk.gray("(for type checkers)")}`);
      }
    } else if (singleFile && !stubsEnabled) {
      console.log(chalk.gray(`  ⊘ Stub generation disabled (TRICKLE_STUBS=0)`));
    }
  } else {
    console.log(chalk.gray(`  No functions observed.`));
  }

  // ── Variable/tensor summary ──
  const varsJsonlPath = path.join(localDir, "variables.jsonl");
  if (fs.existsSync(varsJsonlPath)) {
    try {
      const { showVarsSummary } = await import("./vars");
      showVarsSummary(varsJsonlPath);
    } catch {
      // vars module not available, skip
    }
    console.log(chalk.gray(`  ↳ Variable data feeds VSCode inline hints`));
  }

  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  return exitCode;
}

// ── Live type generation ──

/**
 * Start a background watcher that regenerates type stubs whenever the
 * JSONL file changes. Returns a stop function.
 *
 * Uses polling (fs.watchFile) because the file is being appended to by
 * the child process and fs.watch can be unreliable with rapid appends.
 */
function startLiveLocalTypes(
  sourceFile: string,
  jsonlPath: string,
  generateLocalStubs: (sourceFile: string, jsonlPath: string) => { written: string[]; functionCount: number },
): () => void {
  let lastSize = 0;
  let lastFunctionCount = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const regenerate = () => {
    if (stopped) return;
    try {
      if (!fs.existsSync(jsonlPath)) return;

      const stat = fs.statSync(jsonlPath);
      if (stat.size === lastSize) return; // no new data
      lastSize = stat.size;

      const { written, functionCount } = generateLocalStubs(sourceFile, jsonlPath);
      if (written.length > 0 && functionCount > lastFunctionCount) {
        const newCount = functionCount - lastFunctionCount;
        const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
        const relPath = path.relative(process.cwd(), written[0]);
        console.log(
          chalk.gray(`  [${ts}]`) +
          chalk.green(` +${newCount} type(s)`) +
          chalk.gray(` → ${relPath}`) +
          chalk.gray(` (${functionCount} total)`),
        );
        lastFunctionCount = functionCount;
      }
    } catch {
      // Never crash — this is a background helper
    }
  };

  // Do an initial check after a short delay (catch fast-running scripts)
  const initialTimer = setTimeout(regenerate, 800);

  // Poll every 2 seconds
  const interval = setInterval(regenerate, 2000);

  // Also try fs.watchFile for faster response on changes
  try {
    fs.watchFile(jsonlPath, { interval: 1000 }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(regenerate, 200);
    });
  } catch {
    // watchFile may fail if file doesn't exist yet — polling handles it
  }

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
    try { fs.unwatchFile(jsonlPath); } catch {}
  };
}

/**
 * Start a background poller that fetches stubs from the backend and
 * writes sidecar type files while the process runs. Returns a stop function.
 */
function startLiveBackendTypes(sourceFile: string): () => void {
  let lastFunctionCount = 0;
  let stopped = false;

  const ext = path.extname(sourceFile).toLowerCase();
  const isPython = ext === ".py";
  const dir = path.dirname(sourceFile);
  const baseName = path.basename(sourceFile, ext);
  const sidecarName = isPython ? `${baseName}.pyi` : `${baseName}.d.ts`;
  const sidecarPath = path.join(dir, sidecarName);
  // Also check .trickle/types/ where auto-codegen now writes
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const trickleTypesPath = path.join(trickleDir, 'types', `${baseName}.d.ts`);

  const poll = async () => {
    if (stopped) return;
    try {
      const { stubsCommand } = await import("./stubs");
      await stubsCommand(dir, { silent: true });

      // Check both old sidecar path and new .trickle/types/ path
      const effectivePath = fs.existsSync(trickleTypesPath) ? trickleTypesPath : sidecarPath;
      if (fs.existsSync(effectivePath)) {
        const content = fs.readFileSync(effectivePath, "utf-8");
        const funcCount = (content.match(/export declare function/g) || []).length;

        if (funcCount > lastFunctionCount) {
          const newCount = funcCount - lastFunctionCount;
          const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
          console.log(
            chalk.gray(`  [${ts}]`) +
            chalk.green(` +${newCount} type(s)`) +
            chalk.gray(` → ${sidecarName}`) +
            chalk.gray(` (${funcCount} total)`),
          );
          lastFunctionCount = funcCount;
        }
      }
    } catch {
      // Never crash — background helper
    }
  };

  // Poll every 3 seconds (backend mode has higher overhead)
  const interval = setInterval(poll, 3000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

// ── Live stubs generation during run ──

function startLiveStubsGeneration(stubsDir: string): () => void {
  let lastTotal = 0;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const { stubsCommand } = await import("./stubs");
      const result = await stubsCommand(stubsDir, { silent: true });

      // Count .d.ts files in the stubs dir to track progress
      const files = fs.readdirSync(stubsDir).filter(f => f.endsWith('.d.ts'));
      let funcCount = 0;
      for (const f of files) {
        const content = fs.readFileSync(path.join(stubsDir, f), 'utf-8');
        funcCount += (content.match(/export declare function/g) || []).length;
      }

      if (funcCount > lastTotal) {
        const newCount = funcCount - lastTotal;
        const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
        console.log(
          chalk.gray(`  [${ts}]`) +
          chalk.green(` +${newCount} type(s)`) +
          chalk.gray(` → ${stubsDir}`) +
          chalk.gray(` (${funcCount} total)`),
        );
        lastTotal = funcCount;
      }
    } catch {
      // Never crash — background helper
    }
  };

  const interval = setInterval(poll, 3000);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

// ── Auto-generate sidecar type file ──

async function autoGenerateSidecar(filePath: string): Promise<void> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isPython = ext === ".py";
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ext);

    // Determine sidecar filename
    const sidecarName = isPython ? `${baseName}.pyi` : `${baseName}.d.ts`;
    const sidecarPath = path.join(dir, sidecarName);

    // Use the stubs command to generate stubs for the file's directory
    const { stubsCommand } = await import("./stubs");
    await stubsCommand(dir, { silent: true });

    // Check if types were generated (either sidecar or .trickle/types/)
    const tDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
    const tTypesPath = path.join(tDir, 'types', `${baseName}.d.ts`);
    const effectiveSidecar = fs.existsSync(tTypesPath) ? tTypesPath : sidecarPath;
    const displayName = fs.existsSync(tTypesPath) ? `${baseName}.d.ts` : sidecarName;
    if (fs.existsSync(effectiveSidecar)) {
      const stats = fs.statSync(effectiveSidecar);
      if (stats.size > 0) {
        console.log(
          chalk.green(`\n  Types written to ${chalk.bold(displayName)}`),
        );
      }
    }
  } catch {
    // Don't fail the run if sidecar generation fails
  }
}

// ── Watch mode ──

/**
 * Find source files to watch based on the command.
 * Returns the directory to watch and specific file paths.
 */
function findWatchTargets(command: string): { dir: string; file: string | null } {
  const parts = command.split(/\s+/);

  // Find the first token that looks like a file path
  for (const part of parts) {
    const ext = path.extname(part).toLowerCase();
    if ([".js", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".py", ".jsx"].includes(ext)) {
      const resolved = path.resolve(part);
      if (fs.existsSync(resolved)) {
        return {
          dir: path.dirname(resolved),
          file: resolved,
        };
      }
    }
  }

  return { dir: process.cwd(), file: null };
}

/**
 * Enter watch mode — watch source files and re-run on changes.
 */
async function enterWatchLoop(
  originalCommand: string,
  instrumentedCommand: string,
  env: Record<string, string>,
  opts: RunOptions,
  singleFile: string | null,
  backendProc: ChildProcess | null,
  localMode?: boolean,
): Promise<void> {
  const { dir: watchDir, file: watchFile } = findWatchTargets(originalCommand);

  const watchExts = new Set([".js", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".py", ".jsx"]);
  const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".trickle"]);

  console.log("");
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.cyan("  Watching for changes...") + chalk.gray(` (${watchDir})`));
  console.log(chalk.gray("  Press Ctrl+C to stop."));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let runCount = 1;

  const triggerRerun = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      runCount++;
      const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log("");
      console.log(chalk.cyan(`  [${ts}]`) + chalk.bold(` Re-running (#${runCount})...`));
      console.log(chalk.gray("  " + "─".repeat(50)));

      try {
        await executeSingleRun(instrumentedCommand, env, opts, singleFile, localMode);
      } catch {
        console.log(chalk.red("  Run failed. Waiting for next change..."));
      }

      console.log("");
      console.log(chalk.gray("  Watching for changes..."));
    }, 300); // 300ms debounce
  };

  // Use fs.watch with recursive option (supported on macOS and Windows)
  try {
    const watcher = fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // Check file extension
      const ext = path.extname(filename).toLowerCase();
      if (!watchExts.has(ext)) return;

      // Skip ignored directories
      const parts = filename.split(path.sep);
      if (parts.some(p => ignoreDirs.has(p))) return;

      const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log(chalk.gray(`  [${ts}] Changed: ${filename}`));
      triggerRerun();
    });

    // Handle graceful shutdown
    const cleanup = () => {
      watcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (backendProc) {
        backendProc.kill("SIGTERM");
      }
      console.log(chalk.gray("\n  Watch stopped.\n"));
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Keep the process alive
    await new Promise<never>(() => {});
  } catch (err: unknown) {
    // Fallback: if recursive watch isn't supported, watch just the target file
    if (watchFile) {
      console.log(chalk.gray("  (Watching single file: " + path.basename(watchFile) + ")"));

      const watcher = fs.watch(watchFile, () => {
        const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
        console.log(chalk.gray(`  [${ts}] Changed: ${path.basename(watchFile)}`));
        triggerRerun();
      });

      const cleanup = () => {
        watcher.close();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (backendProc) {
          backendProc.kill("SIGTERM");
        }
        console.log(chalk.gray("\n  Watch stopped.\n"));
        process.exit(0);
      };

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      await new Promise<never>(() => {});
    }

    // Can't watch anything
    console.error(chalk.red("  Could not set up file watcher."));
    if (backendProc) backendProc.kill("SIGTERM");
    process.exit(1);
  }
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

/**
 * Format a compact type string from a TypeNode for terminal display.
 */
function _compactType(node: import("../local-codegen").TypeNode, depth: number = 0): string {
  if (!node) return "any";
  const kind = node.kind;
  if (kind === "primitive") return node.name || "any";
  if (kind === "unknown") return "any";
  if (depth >= 3) return "...";
  if (kind === "array") return `${_compactType(node.element!, depth + 1)}[]`;
  if (kind === "tuple") {
    const els = (node.elements || []).map((e) => _compactType(e, depth + 1));
    return `[${els.join(", ")}]`;
  }
  if (kind === "union") {
    const members = (node.members || []).map((m) => _compactType(m, depth + 1));
    return members.join(" | ");
  }
  if (kind === "object") {
    if ((node as any).class_name && (node as any).class_name !== "dict") {
      return (node as any).class_name;
    }
    const props = node.properties || {};
    const keys = Object.keys(props);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) {
      const entries = keys.map((k) => `${k}: ${_compactType(props[k], depth + 1)}`);
      return `{ ${entries.join(", ")} }`;
    }
    const first = keys.slice(0, 2).map((k) => `${k}: ${_compactType(props[k], depth + 1)}`);
    return `{ ${first.join(", ")}, ... }`;
  }
  if (kind === "map") return `Map<${_compactType(node.key!, depth + 1)}, ${_compactType(node.value!, depth + 1)}>`;
  if (kind === "set") return `Set<${_compactType(node.element!, depth + 1)}>`;
  if (kind === "promise") return `Promise<${_compactType(node.resolved!, depth + 1)}>`;
  if (kind === "iterator") {
    const inner = _compactType(node.element!, depth + 1);
    return `${node.name || "Iterator"}<${inner}>`;
  }
  if (kind === "function") return "Function";
  return "any";
}

/**
 * Format a function signature from local observations for terminal display.
 */
function _formatLocalSignature(fn: import("../local-codegen").FunctionTypeData, maxLen: number = 90): string {
  const paramNames = fn.paramNames || [];
  const params: string[] = [];

  if (fn.argsType.kind === "tuple") {
    for (let i = 0; i < (fn.argsType.elements || []).length; i++) {
      const pname = paramNames[i] || `arg${i}`;
      const ptype = _compactType(fn.argsType.elements![i]);
      params.push(`${pname}: ${ptype}`);
    }
  }

  const ret = _compactType(fn.returnType);
  const sig = `${fn.name}(${params.join(", ")}) → ${ret}`;
  if (sig.length > maxLen) {
    return sig.substring(0, maxLen - 1) + "…";
  }
  return sig;
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
    command.includes("trickle-observe/observe") ||
    command.includes("trickle-observe/register") ||
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
      // Use both ESM hooks (for exported functions) and CJS hook (for Express auto-detection)
      const modified = command.replace(
        new RegExp(`^${runner}\\s`),
        `${runner} -r ${observePath} --import ${observeEsmPath} `,
      );
      return { instrumentedCommand: modified, env };
    } else if (runner === "tsx") {
      // tsx always uses ESM internally — inject both CJS and ESM hooks
      const modified = command.replace(
        new RegExp(`^${runner}\\s`),
        `${runner} -r ${observePath} --import ${observeEsmPath} `,
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
    // Auto-enable terminal type summary when running via trickle run
    if (!process.env.TRICKLE_SUMMARY) env.TRICKLE_SUMMARY = "1";
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
    return require.resolve("trickle-observe/observe");
  } catch {
    // Not in node_modules
  }

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

  return "trickle-observe/observe";
}

function resolveObserveEsmPath(): string | null {
  try {
    return require.resolve("trickle-observe/observe-esm");
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
    // Add node_modules/.bin to PATH so local binaries (tsx, ts-node, etc.) are found
    const binPath = path.join(process.cwd(), "node_modules", ".bin");
    const currentPath = process.env.PATH || "";
    const augmentedPath = currentPath.includes(binPath) ? currentPath : `${binPath}${path.delimiter}${currentPath}`;

    const proc = spawn(command, [], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env, PATH: augmentedPath },
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
  varsJsonlPath?: string,
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

    // Count variable observations from variables.jsonl
    let varCount = 0;
    if (varsJsonlPath && fs.existsSync(varsJsonlPath)) {
      try {
        const content = fs.readFileSync(varsJsonlPath, "utf-8");
        varCount = content.trim().split("\n").filter(l => {
          try { return JSON.parse(l).kind === "variable"; } catch { return false; }
        }).length;
      } catch { /* ignore */ }
    }

    if (functions.length === 0) {
      if (varCount > 0) {
        console.log(
          `  Variables traced: ${chalk.bold(String(varCount))} inline hints ready`,
        );
        console.log(chalk.gray("  Open the file in VSCode to see type hints inline."));
      } else {
        console.log(
          chalk.yellow("  No functions captured. The command may not have"),
        );
        console.log(
          chalk.yellow("  loaded any modules that could be instrumented."),
        );
      }
    } else {
      console.log(
        `  Functions observed: ${chalk.bold(String(functions.length))} total, ${chalk.green(String(newFunctions.length) + " new")}`,
      );
      if (varCount > 0) {
        console.log(`  Variables traced:   ${chalk.bold(String(varCount))} inline hints ready`);
      }

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
