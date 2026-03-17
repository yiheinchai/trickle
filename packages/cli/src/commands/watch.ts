import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { listFunctions, fetchCodegen, FunctionRow } from "../api-client";
import { getBackendUrl } from "../config";

export interface WatchOptions {
  dir?: string;
  env?: string;
  interval?: string;
}

interface DetectedFormat {
  format: string;
  fileName: string;
  label: string;
}

/**
 * Detect which codegen formats are relevant based on package.json dependencies.
 */
function detectFormats(projectDir: string): DetectedFormat[] {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return [
      { format: "", fileName: "types.d.ts", label: "TypeScript types" },
      { format: "guards", fileName: "guards.ts", label: "Type guards" },
    ];
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return [
      { format: "", fileName: "types.d.ts", label: "TypeScript types" },
      { format: "guards", fileName: "guards.ts", label: "Type guards" },
    ];
  }

  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> || {}),
    ...(pkg.devDependencies as Record<string, string> || {}),
  };

  const formats: DetectedFormat[] = [];

  formats.push({ format: "", fileName: "types.d.ts", label: "TypeScript types" });

  if (deps["axios"]) {
    formats.push({ format: "axios", fileName: "axios-client.ts", label: "Axios client" });
  } else {
    formats.push({ format: "client", fileName: "api-client.ts", label: "Fetch API client" });
  }

  if (deps["@tanstack/react-query"] || deps["react-query"]) {
    formats.push({ format: "react-query", fileName: "hooks.ts", label: "React Query hooks" });
  }
  if (deps["swr"]) {
    formats.push({ format: "swr", fileName: "swr-hooks.ts", label: "SWR hooks" });
  }
  if (deps["zod"]) {
    formats.push({ format: "zod", fileName: "schemas.ts", label: "Zod schemas" });
  }
  if (deps["@trpc/server"] || deps["@trpc/client"]) {
    formats.push({ format: "trpc", fileName: "trpc-router.ts", label: "tRPC router" });
  }
  if (deps["class-validator"] || deps["@nestjs/common"]) {
    formats.push({ format: "class-validator", fileName: "dtos.ts", label: "class-validator DTOs" });
  }
  if (deps["express"] || deps["@types/express"]) {
    formats.push({ format: "handlers", fileName: "handlers.d.ts", label: "Express handler types" });
  }
  if (deps["msw"]) {
    formats.push({ format: "msw", fileName: "msw-handlers.ts", label: "MSW mock handlers" });
  }

  formats.push({ format: "guards", fileName: "guards.ts", label: "Type guards" });

  return formats;
}

/**
 * Build a fingerprint from the functions list to detect changes.
 * Uses function names + type hashes + last_seen timestamps.
 */
function buildFingerprint(functions: FunctionRow[]): string {
  const parts = functions
    .map((f) => `${f.function_name}:${f.last_seen_at}`)
    .sort();
  return parts.join("|");
}

/**
 * Generate all relevant type files to the output directory.
 */
async function regenerate(
  formats: DetectedFormat[],
  outDir: string,
  env?: string,
): Promise<{ generated: number; files: string[] }> {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const files: string[] = [];
  let generated = 0;

  for (const f of formats) {
    try {
      const result = await fetchCodegen({
        env,
        format: f.format || undefined,
      });

      const content = result.types;
      if (!content || content.includes("No functions found") || content.includes("No API routes found")) {
        continue;
      }

      const filePath = path.join(outDir, f.fileName);
      fs.writeFileSync(filePath, content, "utf-8");
      generated++;
      files.push(f.fileName);
    } catch {
      // Skip failed formats silently
    }
  }

  return { generated, files };
}

function timestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString("en-US", { hour12: false });
}

/**
 * `trickle watch` — Watch for new type observations and auto-regenerate type files.
 */
export async function watchCommand(opts: WatchOptions): Promise<void> {
  const backendUrl = getBackendUrl();
  const projectDir = process.cwd();
  const outDir = path.resolve(opts.dir || ".trickle");
  const intervalMs = parseInterval(opts.interval || "3s");

  // Check backend connectivity
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
    process.exit(1);
  }

  // Detect formats from project deps
  const formats = detectFormats(projectDir);

  console.log("");
  console.log(chalk.bold("  trickle watch"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Backend:  ${backendUrl}`));
  console.log(chalk.gray(`  Output:   ${outDir}`));
  console.log(chalk.gray(`  Interval: ${opts.interval || "3s"}`));
  if (opts.env) {
    console.log(chalk.gray(`  Env:      ${opts.env}`));
  }
  console.log(chalk.gray(`  Formats:  ${formats.map((f) => f.fileName).join(", ")}`));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Initial generation
  console.log(chalk.gray(`  [${timestamp()}]`) + " Performing initial type generation...");
  let lastFingerprint = "";

  try {
    const { functions } = await listFunctions({ env: opts.env, limit: 1000 });
    if (functions.length > 0) {
      lastFingerprint = buildFingerprint(functions);
      const { generated, files } = await regenerate(formats, outDir, opts.env);
      if (generated > 0) {
        console.log(
          chalk.green(`  [${timestamp()}]`) +
          ` Generated ${generated} files: ${chalk.white(files.join(", "))}`,
        );
      } else {
        console.log(chalk.gray(`  [${timestamp()}]`) + " No types to generate yet.");
      }
    } else {
      console.log(chalk.gray(`  [${timestamp()}]`) + " No observed functions yet. Waiting...");
    }
  } catch {
    console.log(chalk.yellow(`  [${timestamp()}]`) + " Could not fetch initial types. Will retry...");
  }

  console.log("");
  console.log(chalk.gray("  Watching for type changes... (Ctrl+C to stop)"));
  console.log("");

  // Poll loop
  const poll = async () => {
    try {
      const { functions } = await listFunctions({ env: opts.env, limit: 1000 });
      const fingerprint = buildFingerprint(functions);

      if (fingerprint !== lastFingerprint && fingerprint !== "") {
        // Types changed — find what's new
        const newFunctions = functions.filter((f) => {
          // A function is "new" if it wasn't in the last fingerprint
          return !lastFingerprint.includes(`${f.function_name}:`);
        });
        const updatedFunctions = functions.filter((f) => {
          // A function is "updated" if its timestamp changed
          const oldEntry = `${f.function_name}:${f.last_seen_at}`;
          return lastFingerprint.includes(`${f.function_name}:`) && !lastFingerprint.includes(oldEntry);
        });

        lastFingerprint = fingerprint;

        // Show what changed
        for (const f of newFunctions) {
          console.log(
            chalk.cyan(`  [${timestamp()}]`) +
            chalk.gray(" New: ") +
            chalk.white(f.function_name),
          );
        }
        for (const f of updatedFunctions) {
          console.log(
            chalk.blue(`  [${timestamp()}]`) +
            chalk.gray(" Updated: ") +
            chalk.white(f.function_name),
          );
        }

        // Regenerate
        const { generated, files } = await regenerate(formats, outDir, opts.env);
        if (generated > 0) {
          console.log(
            chalk.green(`  [${timestamp()}]`) +
            ` Regenerated ${generated} files: ${chalk.white(files.join(", "))}`,
          );
        }
      }
    } catch {
      // Silently skip poll failures
    }
  };

  // Set up interval
  const timer = setInterval(poll, intervalMs);

  // Handle graceful shutdown
  const cleanup = () => {
    clearInterval(timer);
    console.log(chalk.gray(`\n  [${timestamp()}]`) + " Watch stopped.\n");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function parseInterval(input: string): number {
  const match = input.match(/^(\d+)(s|ms|m)?$/);
  if (!match) return 3000;

  const value = parseInt(match[1], 10);
  const unit = match[2] || "s";

  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    default: return value * 1000;
  }
}
