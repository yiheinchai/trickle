import chalk from "chalk";
import { getBackendUrl } from "../config";
import { isLocalMode, getLocalFunctions } from "../local-data";

export interface CoverageOptions {
  env?: string;
  json?: boolean;
  failUnder?: string;
  staleHours?: string;
  local?: boolean;
}

interface CoverageEntry {
  functionName: string;
  module: string;
  language: string;
  environment: string;
  firstSeen: string;
  lastObserved: string;
  snapshots: number;
  variants: number;
  errors: number;
  isStale: boolean;
  hasTypes: boolean;
  health: number;
}

interface CoverageSummary {
  total: number;
  withTypes: number;
  withoutTypes: number;
  fresh: number;
  stale: number;
  withErrors: number;
  withMultipleVariants: number;
  health: number;
  staleThresholdHours: number;
}

interface CoverageResponse {
  summary: CoverageSummary;
  entries: CoverageEntry[];
}

/**
 * `trickle coverage` — Type observation health report.
 *
 * Shows per-function type coverage, staleness, variant counts,
 * error counts, and an overall health score. Useful for CI gates.
 */
export async function coverageCommand(opts: CoverageOptions): Promise<void> {
  let data: CoverageResponse;

  if (isLocalMode(opts)) {
    // Build coverage data from local observations
    const staleThresholdHours = opts.staleHours ? parseInt(opts.staleHours, 10) : 24;
    const { functions } = getLocalFunctions({ env: opts.env });
    const entries: CoverageEntry[] = functions.map((f) => ({
      functionName: f.function_name,
      module: f.module,
      language: f.language,
      environment: f.environment,
      firstSeen: f.first_seen_at,
      lastObserved: f.last_seen_at,
      snapshots: 1,
      variants: 1,
      errors: 0,
      isStale: false,
      hasTypes: true,
      health: 100,
    }));
    const total = entries.length;
    data = {
      summary: {
        total,
        withTypes: total,
        withoutTypes: 0,
        fresh: total,
        stale: 0,
        withErrors: 0,
        withMultipleVariants: 0,
        health: total > 0 ? 100 : 0,
        staleThresholdHours,
      },
      entries,
    };
  } else {
    const backendUrl = getBackendUrl();

    // Fetch coverage data
    const url = new URL("/api/coverage", backendUrl);
    if (opts.env) url.searchParams.set("env", opts.env);
    if (opts.staleHours) url.searchParams.set("stale_hours", opts.staleHours);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      data = (await res.json()) as CoverageResponse;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("HTTP ")) {
        console.error(chalk.red(`\n  Error: ${err.message}\n`));
      } else {
        console.error(chalk.red(`\n  Cannot connect to trickle backend at ${chalk.bold(backendUrl)}.`));
        console.error(chalk.red("  Is the backend running?\n"));
      }
      process.exit(1);
    }
  }

  // JSON output mode
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    checkThreshold(data.summary.health, opts.failUnder);
    return;
  }

  const { summary, entries } = data;

  // Header
  console.log("");
  console.log(chalk.bold("  trickle coverage"));
  console.log(chalk.gray("  " + "─".repeat(60)));
  if (opts.env) {
    console.log(chalk.gray(`  Environment: ${opts.env}`));
  }
  console.log(chalk.gray(`  Stale threshold: ${summary.staleThresholdHours}h`));
  console.log(chalk.gray("  " + "─".repeat(60)));
  console.log("");

  if (entries.length === 0) {
    console.log(chalk.yellow("  No functions observed yet."));
    console.log(chalk.gray("  Instrument your app and make some requests first.\n"));
    checkThreshold(0, opts.failUnder);
    return;
  }

  // Health score bar
  const healthColor = summary.health >= 80 ? chalk.green : summary.health >= 50 ? chalk.yellow : chalk.red;
  const barFilled = Math.round(summary.health / 5);
  const barEmpty = 20 - barFilled;
  const healthBar = healthColor("█".repeat(barFilled)) + chalk.gray("░".repeat(barEmpty));
  console.log(`  Health: ${healthBar} ${healthColor(chalk.bold(`${summary.health}%`))}`);
  console.log("");

  // Summary stats
  console.log(chalk.bold("  Summary"));
  console.log(`  ${chalk.cyan(String(summary.total))} functions observed`);
  console.log(`  ${chalk.green(String(summary.withTypes))} with types  ${chalk.gray(`${summary.withoutTypes} without`)}`);
  console.log(`  ${chalk.green(String(summary.fresh))} fresh  ${summary.stale > 0 ? chalk.yellow(`${summary.stale} stale`) : chalk.gray("0 stale")}`);
  if (summary.withErrors > 0) {
    console.log(`  ${chalk.red(String(summary.withErrors))} with errors`);
  }
  if (summary.withMultipleVariants > 0) {
    console.log(`  ${chalk.yellow(String(summary.withMultipleVariants))} with multiple type variants`);
  }
  console.log("");

  // Per-function table
  console.log(chalk.bold("  Functions"));
  console.log(chalk.gray("  " + "─".repeat(60)));

  for (const entry of entries) {
    const statusIcon = !entry.hasTypes
      ? chalk.red("✗")
      : entry.isStale
        ? chalk.yellow("◦")
        : chalk.green("✓");

    const nameStr = chalk.bold(entry.functionName);
    const moduleStr = entry.module !== "api" && entry.module !== "default" ? chalk.gray(` [${entry.module}]`) : "";

    const badges: string[] = [];
    if (entry.snapshots > 0) badges.push(chalk.gray(`${entry.snapshots} snap`));
    if (entry.variants > 1) badges.push(chalk.yellow(`${entry.variants} variants`));
    if (entry.errors > 0) badges.push(chalk.red(`${entry.errors} err`));
    if (entry.isStale) badges.push(chalk.yellow("stale"));

    const healthStr = entry.health >= 80
      ? chalk.green(`${entry.health}%`)
      : entry.health >= 50
        ? chalk.yellow(`${entry.health}%`)
        : chalk.red(`${entry.health}%`);

    console.log(`  ${statusIcon} ${nameStr}${moduleStr}  ${badges.join(" ")}  ${healthStr}`);
  }

  console.log(chalk.gray("  " + "─".repeat(60)));
  console.log("");

  checkThreshold(summary.health, opts.failUnder);
}

function checkThreshold(health: number, failUnder?: string): void {
  if (!failUnder) return;
  const threshold = parseInt(failUnder, 10);
  if (isNaN(threshold)) return;

  if (health < threshold) {
    console.error(
      chalk.red(`  Coverage health ${health}% is below threshold ${threshold}%`),
    );
    console.error("");
    process.exit(1);
  }
}
