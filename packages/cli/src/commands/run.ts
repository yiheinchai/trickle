import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, execSync } from "child_process";
import chalk from "chalk";

export interface RunOptions {
  module?: string;
  include?: string;
  exclude?: string;
  watch?: boolean;
}

// ── Auto-detect entry point ──

function autoDetectEntryPoint(): string | null {
  const pkgPath = path.resolve("package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.start && !pkg.scripts.start.includes("trickle")) {
        const startCmd = pkg.scripts.start;
        if (startCmd.includes("node ") || startCmd.includes("ts-node ") || startCmd.includes("tsx ") || startCmd.includes("python ")) {
          return startCmd;
        }
      }
      if (pkg.main && fs.existsSync(path.resolve(pkg.main))) {
        return `node ${pkg.main}`;
      }
    } catch {}
  }

  const candidates = [
    "app.js", "app.ts", "index.js", "index.ts", "server.js", "server.ts",
    "src/index.js", "src/index.ts", "src/app.js", "src/app.ts", "src/server.js", "src/server.ts",
    "app.py", "main.py", "server.py", "manage.py",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.resolve(candidate))) {
      return candidate;
    }
  }

  if (fs.existsSync(path.resolve("pyproject.toml"))) {
    if (fs.existsSync(path.resolve("app.py"))) return "python app.py";
    if (fs.existsSync(path.resolve("main.py"))) return "python main.py";
  }

  return null;
}

// ── .tricklerc.json config ──

interface TrickleConfig {
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
  if (/^((?:[\w./~-]+\/)?(node|ts-node|tsx|nodemon|bun|deno|python3?(?:\.\d+)?|vitest|jest|mocha|npx|bunx|pytest|uvicorn|gunicorn|flask|django-admin))\b/.test(input)) {
    return input;
  }

  const parts = input.split(/\s+/);
  const file = parts[0];
  const rest = parts.slice(1).join(" ");
  const ext = path.extname(file).toLowerCase();

  const resolved = path.resolve(file);
  const fileExists = fs.existsSync(resolved);

  if (!fileExists) {
    return input;
  }

  switch (ext) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return rest ? `node ${file} ${rest}` : `node ${file}`;

    case ".ts":
    case ".tsx":
    case ".mts": {
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
  const binPath = path.join(process.cwd(), "node_modules", ".bin");
  const currentPath = process.env.PATH || "";
  const augmentedPath = currentPath.includes(binPath) ? currentPath : `${binPath}${path.delimiter}${currentPath}`;
  const execOpts = { stdio: "ignore" as const, env: { ...process.env, PATH: augmentedPath } };

  try {
    execSync("tsx --version", execOpts);
    return "tsx";
  } catch {
    // not available
  }

  try {
    execSync("ts-node --version", execOpts);
    return "ts-node";
  } catch {
    // not available
  }

  try {
    execSync("bun --version", execOpts);
    return "bun";
  } catch {
    // not available
  }

  return "npx tsx";
}

/**
 * `trickle run <command>` — Run any command with universal type observation.
 *
 * Auto-detects JS or Python, injects the right instrumentation, and writes
 * captured types to .trickle/ so VSCode, Jupyter, and `trickle hints` can show them.
 */
export async function runCommand(
  command: string | undefined,
  opts: RunOptions,
): Promise<void> {
  if (!command) {
    const detected = autoDetectEntryPoint();
    if (detected) {
      command = detected;
      console.log(chalk.gray(`\n  Auto-detected: ${command}\n`));
    } else {
      console.error(chalk.red("\n  Usage: trickle run <command>\n"));
      console.error(chalk.gray("  Examples:"));
      console.error(chalk.gray('    trickle run "node app.js"'));
      console.error(chalk.gray("    trickle run app.ts              # auto-detects TypeScript runtime"));
      console.error(chalk.gray("    trickle run script.py            # auto-detects Python"));
      console.error(chalk.gray("    trickle run app.js --watch       # watch for changes and re-run"));
      console.error("");
      process.exit(1);
    }
  }

  const config = loadProjectConfig();
  opts = mergeConfigWithOpts(opts, config);

  const resolvedCommand = autoDetectCommand(command);

  const { instrumentedCommand, env: extraEnv } = injectObservation(
    resolvedCommand,
    opts,
  );

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
  if (config) {
    console.log(chalk.gray(`  Config:    .tricklerc.json`));
  }
  if (opts.include) {
    console.log(chalk.gray(`  Include:   ${opts.include}`));
  }
  if (opts.exclude) {
    console.log(chalk.gray(`  Exclude:   ${opts.exclude}`));
  }
  if (opts.watch) {
    console.log(chalk.gray(`  Watch:     enabled`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  const runEnv: Record<string, string> = {
    ...extraEnv,
    TRICKLE_LOCAL: "1",
    TRICKLE_DEBUG: process.env.TRICKLE_DEBUG || "",
  };
  if (process.env.TRICKLE_LOCAL_DIR) {
    runEnv.TRICKLE_LOCAL_DIR = process.env.TRICKLE_LOCAL_DIR;
  }

  const exitCode = await executeSingleRun(instrumentedCommand, runEnv);

  if (opts.watch) {
    await enterWatchLoop(command, instrumentedCommand, runEnv);
  }

  process.exit(exitCode);
}

async function executeSingleRun(
  instrumentedCommand: string,
  env: Record<string, string>,
): Promise<number> {
  const exitCode = await runProcess(instrumentedCommand, env);

  await sleep(500);

  const localDir = env.TRICKLE_LOCAL_DIR || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
  const varsJsonlPath = path.join(localDir, "variables.jsonl");

  if (fs.existsSync(varsJsonlPath)) {
    try {
      const { showVarsSummary } = await import("./vars");
      showVarsSummary(varsJsonlPath);
    } catch {
      // vars module not available, skip
    }
    console.log("");
    console.log(chalk.gray("  See types:"));
    console.log(chalk.gray("    trickle hints          ") + "source with inline types");
    console.log(chalk.gray("    trickle vars           ") + "table of captured variables");
    console.log("");
  } else {
    console.log(chalk.gray("\n  No variable types captured."));
    console.log(chalk.gray("  Open the file in VSCode after a successful run, or try:"));
    console.log(chalk.gray("    trickle hints\n"));
  }

  return exitCode;
}

// ── Watch mode ──

function findWatchTargets(command: string): { dir: string; file: string | null } {
  const parts = command.split(/\s+/);

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

async function enterWatchLoop(
  originalCommand: string,
  instrumentedCommand: string,
  env: Record<string, string>,
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
        await executeSingleRun(instrumentedCommand, env);
      } catch {
        console.log(chalk.red("  Run failed. Waiting for next change..."));
      }

      console.log("");
      console.log(chalk.gray("  Watching for changes..."));
    }, 300);
  };

  try {
    const watcher = fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      const ext = path.extname(filename).toLowerCase();
      if (!watchExts.has(ext)) return;

      const parts = filename.split(path.sep);
      if (parts.some(p => ignoreDirs.has(p))) return;

      const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log(chalk.gray(`  [${ts}] Changed: ${filename}`));
      triggerRerun();
    });

    const cleanup = () => {
      watcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      console.log(chalk.gray("\n  Watch stopped.\n"));
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    await new Promise<never>(() => {});
  } catch {
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
        console.log(chalk.gray("\n  Watch stopped.\n"));
        process.exit(0);
      };

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      await new Promise<never>(() => {});
    }

    console.error(chalk.red("  Could not set up file watcher."));
    process.exit(1);
  }
}

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

function extractFileFromCommand(command: string, runner: string): string | null {
  const rest = command.slice(runner.length).trim();
  const tokens = rest.split(/\s+/);
  const exts = [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts"];
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    if (exts.some(e => t.endsWith(e))) {
      return path.resolve(t);
    }
  }
  return null;
}

/**
 * Detect the language and inject the appropriate auto-observation mechanism.
 * Python → `trickle.observe_runner`. Node → `-r trickle/observe`.
 */
function injectObservation(
  command: string,
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
      const esmFile = extractFileFromCommand(command, runner);
      if (esmFile) {
        const tmpDir = os.tmpdir();
        const tmpWrapper = path.join(tmpDir, `.trickle_esm_${Date.now()}.mjs`);
        const esmUrl = `file://${esmFile}`;
        const wrapperContent = `await import('${esmUrl}');\n`;
        fs.writeFileSync(tmpWrapper, wrapperContent);
        const modified = `${runner} -r ${observePath} --import ${observeEsmPath} ${tmpWrapper}`;
        env.TRICKLE_ESM_WRAPPER = tmpWrapper;
        return { instrumentedCommand: modified, env };
      }
      const modified = command.replace(
        new RegExp(`^${runner}\\s`),
        `${runner} -r ${observePath} --import ${observeEsmPath} `,
      );
      return { instrumentedCommand: modified, env };
    } else if (runner === "tsx") {
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

  const pyMatch = command.match(/^((?:[\w./~-]+\/)?python3?(?:\.\d+)?)\s/);
  if (pyMatch) {
    const python = pyMatch[1];
    const rest = command.slice(pyMatch[0].length);
    if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
    if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;
    if (!process.env.TRICKLE_SUMMARY) env.TRICKLE_SUMMARY = "1";
    ensureTricklePythonPath(python, env);
    return {
      instrumentedCommand: `${python} -c "from trickle.observe_runner import main; main()" ${rest}`,
      env,
    };
  }

  if (/^(pytest|uvicorn|gunicorn|flask|django-admin)\b/.test(command)) {
    if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
    if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;
    ensureTricklePythonPath("python", env);
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

/**
 * Ensure the target Python can import trickle by creating an isolated temp
 * directory with a symlink to just the trickle package and adding it to PYTHONPATH.
 */
function ensureTricklePythonPath(
  targetPython: string,
  env: Record<string, string>,
): void {
  try {
    execSync(
      `${targetPython} -c "import trickle" 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    return;
  } catch {
    // Not available in target Python — find it elsewhere
  }

  const candidates = ["python3", "python", "python3.11", "python3.12", "python3.13", "python3.10"];
  for (const py of candidates) {
    try {
      const trickleDir = execSync(
        `${py} -c "import trickle, os; print(os.path.dirname(trickle.__file__))"`,
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (trickleDir && fs.existsSync(trickleDir)) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trickle-pypath-"));
        fs.symlinkSync(trickleDir, path.join(tmpDir, "trickle"));
        const existing = env.PYTHONPATH || process.env.PYTHONPATH || "";
        env.PYTHONPATH = existing ? `${tmpDir}:${existing}` : tmpDir;
        return;
      }
    } catch {
      continue;
    }
  }

  console.error(
    chalk.yellow(
      "\n  ⚠ trickle Python package not found. Install it with:\n\n" +
      "    pip install trickle-observe\n",
    ),
  );
}

function resolveObservePath(): string {
  try {
    return require.resolve("trickle/observe");
  } catch {
    // Not in node_modules
  }

  try {
    return require.resolve("trickle-observe/observe");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
