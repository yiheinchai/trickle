import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import chalk from "chalk";
import { getBackendUrl } from "../config";
import { fetchCodegen } from "../api-client";

export interface DevOptions {
  port?: string;
  out?: string;
  client?: boolean;
  python?: boolean;
}

/**
 * `trickle dev` — All-in-one development command.
 *
 * Starts your app with auto-instrumentation and watches for type changes,
 * regenerating type files as requests flow through. One command replaces
 * the 2-terminal setup of `trickle:start` + `trickle:dev`.
 */
export async function devCommand(command: string | undefined, opts: DevOptions): Promise<void> {
  const backendUrl = getBackendUrl();

  // Resolve the app command to run
  const appCommand = resolveAppCommand(command);
  if (!appCommand) {
    console.error(chalk.red("\n  Could not determine app command to run."));
    console.error(chalk.gray("  Provide a command: trickle dev \"node app.js\""));
    console.error(chalk.gray("  Or ensure package.json has a start or dev script.\n"));
    process.exit(1);
  }

  // Determine output paths
  const isPython = opts.python === true;
  const typesOut = opts.out || (isPython ? ".trickle/types.pyi" : ".trickle/types.d.ts");
  const clientOut = opts.client ? ".trickle/api-client.ts" : undefined;

  // Ensure .trickle directory exists
  const trickleDir = path.resolve(".trickle");
  if (!fs.existsSync(trickleDir)) {
    fs.mkdirSync(trickleDir, { recursive: true });
  }

  // Check backend connectivity
  const backendReachable = await checkBackend(backendUrl);
  if (!backendReachable) {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`));
    console.error(chalk.gray("  Start the backend first: cd packages/backend && npm start"));
    console.error(chalk.gray("  Or set TRICKLE_BACKEND_URL to point to a running backend.\n"));
    process.exit(1);
  }

  // Print header
  console.log("");
  console.log(chalk.bold("  trickle dev"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  App command:  ${appCommand}`));
  console.log(chalk.gray(`  Backend:      ${backendUrl}`));
  console.log(chalk.gray(`  Types output: ${typesOut}`));
  if (clientOut) {
    console.log(chalk.gray(`  Client output: ${clientOut}`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Inject -r trickle-observe/register into the command
  const instrumentedCommand = injectRegister(appCommand);

  // Start the app process
  const appProc = startApp(instrumentedCommand, backendUrl);

  // Start the codegen watcher
  const stopWatcher = startCodegenWatcher(typesOut, clientOut, isPython);

  // Handle cleanup
  let shuttingDown = false;
  function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.gray("\n  Shutting down..."));
    stopWatcher();
    if (!appProc.killed) {
      appProc.kill("SIGTERM");
    }
    // Give processes time to clean up
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  appProc.on("exit", (code) => {
    if (!shuttingDown) {
      if (code !== null && code !== 0) {
        console.log(chalk.red(`\n  App exited with code ${code}`));
      } else {
        console.log(chalk.gray("\n  App exited."));
      }
      cleanup();
    }
  });
}

/**
 * Resolve the command to run. Checks:
 * 1. Explicit command argument
 * 2. package.json scripts.start
 * 3. package.json scripts.dev
 */
function resolveAppCommand(explicitCommand: string | undefined): string | null {
  if (explicitCommand) {
    return explicitCommand;
  }

  // Try reading package.json
  const pkgPath = path.resolve("package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      // Prefer trickle:start if it exists (already instrumented)
      if (scripts["trickle:start"]) {
        return scripts["trickle:start"];
      }
      if (scripts.start) {
        return scripts.start;
      }
      if (scripts.dev) {
        return scripts.dev;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Inject `-r trickle-observe/register` into a node/ts-node/nodemon command.
 * If the command already has it, return as-is.
 */
function injectRegister(command: string): string {
  // Already instrumented
  if (command.includes("trickle-observe/register") || command.includes("trickle\\register")) {
    return command;
  }

  // Inject -r flag
  if (/\bnode\s/.test(command)) {
    return command.replace(/\bnode\s/, "node -r trickle-observe/register ");
  }
  if (/\bts-node\s/.test(command)) {
    return command.replace(/\bts-node\s/, "ts-node -r trickle-observe/register ");
  }
  if (/\bnodemon\s/.test(command)) {
    return command.replace(/\bnodemon\s/, "nodemon -r trickle-observe/register ");
  }

  // Can't inject — run as-is with a warning
  console.log(chalk.yellow("  Warning: Could not inject -r trickle-observe/register into command."));
  console.log(chalk.yellow("  Auto-instrumentation may not work. Consider using:"));
  console.log(chalk.yellow(`    node -r trickle-observe/register ${command}\n`));
  return command;
}

/**
 * Start the app as a child process with environment variables set.
 */
function startApp(command: string, backendUrl: string): ChildProcess {
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const prefix = chalk.cyan("[app]");

  const proc = spawn(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      TRICKLE_BACKEND_URL: backendUrl,
    },
    shell: true,
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        console.log(`${prefix} ${line}`);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        console.error(`${prefix} ${chalk.red(line)}`);
      }
    }
  });

  return proc;
}

/**
 * Start a codegen watcher that polls for type changes.
 * Returns a stop function.
 */
function startCodegenWatcher(
  typesOut: string,
  clientOut: string | undefined,
  isPython: boolean,
): () => void {
  const prefix = chalk.magenta("[types]");
  const language = isPython ? "python" : undefined;
  let lastTypesContent = "";
  let lastClientContent = "";
  let stopped = false;
  let firstRun = true;

  // Wait a bit before first poll to let the app start
  let initialDelay = true;

  const poll = async () => {
    if (stopped) return;

    try {
      // Generate types
      const result = await fetchCodegen({ language });
      const types = result.types;

      if (types !== lastTypesContent) {
        lastTypesContent = types;
        const resolvedPath = path.resolve(typesOut);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolvedPath, types, "utf-8");

        if (!firstRun) {
          const count = countTypes(types);
          console.log(`${prefix} ${chalk.green("Updated")} ${chalk.bold(typesOut)} ${chalk.gray(`(${count} types)`)}`);
        } else {
          firstRun = false;
        }
      }

      // Generate client if requested
      if (clientOut) {
        const clientResult = await fetchCodegen({ format: "client" });
        if (clientResult.types !== lastClientContent) {
          lastClientContent = clientResult.types;
          const resolvedPath = path.resolve(clientOut);
          const dir = path.dirname(resolvedPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolvedPath, clientResult.types, "utf-8");

          if (!firstRun) {
            console.log(`${prefix} ${chalk.green("Updated")} ${chalk.bold(clientOut)}`);
          }
        }
      }
    } catch {
      // Backend might not be ready yet or app hasn't served requests — silently retry
      if (!initialDelay) {
        // Only log after initial startup period
      }
    }

    initialDelay = false;
  };

  // First poll after 3s (give app time to start), then every 3s
  const startTimeout = setTimeout(() => {
    poll();
    const interval = setInterval(poll, 3000);

    // Store interval for cleanup
    (startTimeout as unknown as Record<string, unknown>).__interval = interval;
  }, 3000);

  let intervalRef: ReturnType<typeof setInterval> | null = null;

  // Use a different approach: start polling immediately with setInterval
  const interval = setInterval(async () => {
    if (stopped) return;
    await poll();
  }, 3000);
  intervalRef = interval;

  // Initial poll after 2s delay
  const initTimer = setTimeout(poll, 2000);

  return () => {
    stopped = true;
    clearTimeout(startTimeout);
    clearTimeout(initTimer);
    if (intervalRef) clearInterval(intervalRef);
  };
}

function countTypes(code: string): number {
  const tsMatches = code.match(/export (interface|type) /g);
  const pyMatches = code.match(/class \w+\(TypedDict\)/g);
  return (tsMatches?.length ?? 0) + (pyMatches?.length ?? 0);
}

async function checkBackend(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
