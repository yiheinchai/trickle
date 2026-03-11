import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import chalk from "chalk";
import { getBackendUrl } from "../config";
import { listFunctions, listErrors, FunctionRow, ErrorRow } from "../api-client";

export interface RunOptions {
  module?: string;
  include?: string;
  exclude?: string;
}

/**
 * `trickle run <command>` — Run any command with universal type observation.
 *
 * Auto-detects JS or Python, injects the right instrumentation, starts the
 * backend if needed, and shows a summary of captured types after exit.
 */
export async function runCommand(
  command: string | undefined,
  opts: RunOptions
): Promise<void> {
  if (!command) {
    console.error(
      chalk.red("\n  Usage: trickle run <command>\n")
    );
    console.error(chalk.gray("  Examples:"));
    console.error(chalk.gray('    trickle run "node app.js"'));
    console.error(chalk.gray('    trickle run "vitest run"'));
    console.error(chalk.gray('    trickle run "python script.py"'));
    console.error(chalk.gray('    trickle run "pytest tests/"'));
    console.error("");
    process.exit(1);
  }

  const backendUrl = getBackendUrl();

  // Auto-start backend if not running
  let backendProc: ChildProcess | null = null;
  const backendRunning = await checkBackend(backendUrl);
  if (!backendRunning) {
    backendProc = await autoStartBackend();
    if (!backendProc) {
      console.error(
        chalk.red(
          `\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`
        )
      );
      console.error(
        chalk.gray(
          "  Start the backend: cd packages/backend && npm start\n"
        )
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
    command,
    backendUrl,
    opts
  );

  // Print header
  console.log("");
  console.log(chalk.bold("  trickle run"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Command:   ${command}`));
  if (instrumentedCommand !== command) {
    console.log(chalk.gray(`  Injected:  ${instrumentedCommand}`));
  }
  console.log(chalk.gray(`  Backend:   ${backendUrl}`));
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

  // Show summary
  await showSummary(functionsBefore, errorsBefore);

  // Clean up
  if (backendProc) {
    backendProc.kill("SIGTERM");
    await sleep(500);
  }

  process.exit(exitCode);
}

/**
 * Detect the language and inject the appropriate auto-observation mechanism.
 */
function injectObservation(
  command: string,
  backendUrl: string,
  opts: RunOptions
): { instrumentedCommand: string; env: Record<string, string> } {
  const env: Record<string, string> = {};

  // Already instrumented?
  if (
    command.includes("trickle/observe") ||
    command.includes("trickle/register") ||
    command.includes("-m trickle")
  ) {
    return { instrumentedCommand: command, env };
  }

  // Resolve the observe entry point path
  const observePath = resolveObservePath();

  // Set observe config via env vars
  if (opts.include) env.TRICKLE_OBSERVE_INCLUDE = opts.include;
  if (opts.exclude) env.TRICKLE_OBSERVE_EXCLUDE = opts.exclude;

  // Node.js commands: inject -r directly
  const nodeMatch = command.match(/^(node|ts-node|tsx|nodemon)\s/);
  if (nodeMatch) {
    const runner = nodeMatch[1];
    const modified = command.replace(
      new RegExp(`^${runner}\\s`),
      `${runner} -r ${observePath} `
    );
    return { instrumentedCommand: modified, env };
  }

  // JS test runners / npx commands: use NODE_OPTIONS
  if (/^(vitest|jest|mocha|npx|bunx|bun)\b/.test(command)) {
    const existing = process.env.NODE_OPTIONS || "";
    env.NODE_OPTIONS = `${existing} -r ${observePath}`.trim();
    return { instrumentedCommand: command, env };
  }

  // Python: use python -m trickle
  const pyMatch = command.match(/^(python3?|python3?\.\d+)\s/);
  if (pyMatch) {
    const python = pyMatch[1];
    const rest = command.slice(pyMatch[0].length);
    return {
      instrumentedCommand: `${python} -m trickle ${rest}`,
      env,
    };
  }

  // Python test runners / tools: prefix with python -m trickle -m
  if (/^(pytest|uvicorn|gunicorn|flask|django-admin)\b/.test(command)) {
    return {
      instrumentedCommand: `python -m trickle -m ${command}`,
      env,
    };
  }

  // Unknown: try NODE_OPTIONS as best effort
  console.log(
    chalk.yellow(
      "  Could not detect language. Trying Node.js instrumentation..."
    )
  );
  const existing = process.env.NODE_OPTIONS || "";
  env.NODE_OPTIONS = `${existing} -r ${observePath}`.trim();
  return { instrumentedCommand: command, env };
}

/**
 * Resolve the absolute path to the observe entry point.
 */
function resolveObservePath(): string {
  // Try to find trickle/observe in node_modules
  try {
    const resolved = require.resolve("trickle/observe");
    return resolved;
  } catch {
    // Not in node_modules
  }

  // Try relative to this CLI package (monorepo)
  const monorepoPath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "client-js",
    "observe.js"
  );
  if (fs.existsSync(monorepoPath)) {
    return monorepoPath;
  }

  // Fallback: assume trickle is installed
  return "trickle/observe";
}

/**
 * Run a command as a child process. Returns the exit code.
 */
function runProcess(
  command: string,
  env: Record<string, string>
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
 * Show a summary of what was captured during the run.
 */
async function showSummary(
  functionsBefore: FunctionRow[],
  errorsBefore: ErrorRow[]
): Promise<void> {
  try {
    const { functions } = await listFunctions();
    const { errors } = await listErrors();

    const beforeIds = new Set(functionsBefore.map((f) => f.id));
    const newFunctions = functions.filter((f) => !beforeIds.has(f.id));

    const beforeErrorIds = new Set(errorsBefore.map((e) => e.id));
    const newErrors = errors.filter((e) => !beforeErrorIds.has(e.id));

    console.log("");
    console.log(chalk.bold("  Summary"));
    console.log(chalk.gray("  " + "─".repeat(50)));

    if (functions.length === 0) {
      console.log(
        chalk.yellow("  No functions captured. The command may not have")
      );
      console.log(
        chalk.yellow("  loaded any modules that could be instrumented.")
      );
    } else {
      console.log(
        `  Functions observed: ${chalk.bold(String(functions.length))} total, ${chalk.green(String(newFunctions.length) + " new")}`
      );

      // Show new functions
      if (newFunctions.length > 0) {
        console.log("");
        const shown = newFunctions.slice(0, 15);
        for (const fn of shown) {
          const moduleBadge = chalk.gray(`[${fn.module}]`);
          console.log(
            `    ${chalk.green("+")} ${fn.function_name} ${moduleBadge}`
          );
        }
        if (newFunctions.length > 15) {
          console.log(
            chalk.gray(`    ... and ${newFunctions.length - 15} more`)
          );
        }
      }

      // Show new errors
      if (newErrors.length > 0) {
        console.log("");
        console.log(
          `  Errors captured: ${chalk.red(String(newErrors.length))}`
        );
        const shownErrors = newErrors.slice(0, 5);
        for (const err of shownErrors) {
          const fn = functions.find((f) => f.id === err.function_id);
          const fnName = fn ? fn.function_name : "unknown";
          console.log(
            `    ${chalk.red("!")} ${fnName}: ${chalk.gray(err.error_message.substring(0, 80))}`
          );
        }
      }

      console.log("");
      console.log(chalk.gray("  Explore results:"));
      console.log(chalk.gray("    trickle functions          # list all captured functions"));
      if (newFunctions.length > 0) {
        const example = newFunctions[0].function_name;
        console.log(chalk.gray(`    trickle types ${example}  # see types + sample data`));
      }
      if (newErrors.length > 0) {
        console.log(chalk.gray("    trickle errors             # see captured errors"));
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
  // Try to find and start the backend
  const backendPaths = [
    path.resolve("packages/backend/dist/index.js"),
    path.resolve("node_modules/trickle-backend/dist/index.js"),
  ];

  // Also check for global trickle-backend
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

      // Prevent keeping process alive
      proc.unref();

      // Wait for it to be ready
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
