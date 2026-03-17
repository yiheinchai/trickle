import chalk from "chalk";
import { fetchDiffReport, DiffReportEntry } from "../api-client";
import { formatDiffs } from "../formatters/diff-formatter";
import { envBadge, timeBadge } from "../ui/badges";
import { parseSince } from "../ui/helpers";
import { isLocalMode } from "../local-data";

export interface DiffOptions {
  since?: string;
  env?: string;
  env1?: string;
  env2?: string;
  local?: boolean;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
  try {
    if (isLocalMode(opts)) {
      // Local mode: diff is not meaningful without historical data from backend
      console.log("");
      console.log(chalk.yellow("  Type drift analysis requires the backend for historical snapshots."));
      console.log(chalk.gray("  Local .trickle/observations.jsonl only contains the latest run."));
      console.log(chalk.gray("  Use `trickle diff-runs` to compare two local runs instead.\n"));
      return;
    }

    // Parse --since into a datetime string for the backend
    let sinceStr: string | undefined;
    if (opts.since) {
      sinceStr = parseSince(opts.since);
    }

    const result = await fetchDiffReport({
      since: sinceStr,
      env: opts.env,
      env1: opts.env1,
      env2: opts.env2,
    });

    console.log("");

    if (result.mode === "cross-env") {
      console.log(
        chalk.white.bold("  Type drift: ") +
          envBadge(result.env1!) +
          chalk.gray(" → ") +
          envBadge(result.env2!)
      );
    } else {
      const label = opts.since
        ? `changes in the last ${opts.since}`
        : "all type changes";
      console.log(chalk.white.bold(`  Type drift: ${label}`));
      if (opts.env) {
        console.log(chalk.gray(`  Environment: ${opts.env}`));
      }
    }

    console.log(chalk.gray("  " + "─".repeat(50)));

    if (result.total === 0) {
      console.log("");
      console.log(chalk.green("  No type drift detected."));
      if (opts.since) {
        console.log(chalk.gray(`  No functions had type changes in the last ${opts.since}.`));
      }
      console.log("");
      return;
    }

    console.log(
      chalk.gray(`  ${result.total} function${result.total === 1 ? "" : "s"} with type changes`)
    );

    for (const entry of result.entries) {
      console.log("");
      console.log(
        chalk.white.bold(`  ${entry.functionName}`) +
          chalk.gray(` (${entry.module})`)
      );

      // Show from/to metadata
      console.log(
        chalk.gray("    from: ") +
          envBadge(entry.from.env) +
          chalk.gray("  " + timeBadge(entry.from.observed_at))
      );
      console.log(
        chalk.gray("    to:   ") +
          envBadge(entry.to.env) +
          chalk.gray("  " + timeBadge(entry.to.observed_at))
      );
      console.log("");

      // Indent diffs by 2 extra spaces
      const formattedDiffs = formatDiffs(entry.diffs);
      const indented = formattedDiffs
        .split("\n")
        .map((line) => "  " + line)
        .join("\n");
      console.log(indented);
    }

    console.log("");
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
  }
}
