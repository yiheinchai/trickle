import chalk from "chalk";
import Table from "cli-table3";
import { listErrors, getError, listFunctions, listTypes } from "../api-client";
import { envBadge, errorTypeBadge, timeBadge } from "../ui/badges";
import { parseSince, truncate, relativeTime } from "../ui/helpers";
import { formatType } from "../formatters/type-formatter";
import { isLocalMode, getLocalErrors } from "../local-data";

export interface ErrorsListOptions {
  env?: string;
  since?: string;
  function?: string;
  limit?: string;
  local?: boolean;
}

export async function errorsCommand(idOrUndefined: string | undefined, opts: ErrorsListOptions): Promise<void> {
  // If an ID was provided, show detail mode
  if (idOrUndefined !== undefined) {
    const id = parseInt(idOrUndefined, 10);
    if (isNaN(id)) {
      console.error(chalk.red(`\n  Invalid error ID: "${idOrUndefined}"\n`));
      process.exit(1);
    }
    await showErrorDetail(id);
    return;
  }

  // List mode
  let sinceIso: string | undefined;
  if (opts.since) {
    try {
      sinceIso = parseSince(opts.since);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(chalk.red(`\n  ${err.message}\n`));
      }
      process.exit(1);
    }
  }

  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

  const result = isLocalMode(opts)
    ? getLocalErrors({
        env: opts.env,
        functionName: opts.function,
        limit,
      })
    : await listErrors({
        env: opts.env,
        functionName: opts.function,
        since: sinceIso,
        limit,
      });

  const { errors } = result;

  if (errors.length === 0) {
    console.log(chalk.yellow("\n  No errors found.\n"));
    if (opts.env || opts.since || opts.function) {
      console.log(chalk.gray("  Try adjusting your filters.\n"));
    }
    return;
  }

  console.log("");

  const table = new Table({
    head: [
      chalk.cyan.bold("ID"),
      chalk.cyan.bold("Function"),
      chalk.cyan.bold("Error Type"),
      chalk.cyan.bold("Message"),
      chalk.cyan.bold("Env"),
      chalk.cyan.bold("Time"),
    ],
    style: {
      head: [],
      border: ["gray"],
    },
    colWidths: [8, 22, 18, 36, 12, 12],
    wordWrap: true,
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });

  for (const err of errors) {
    table.push([
      chalk.gray(String(err.id)),
      chalk.white(truncate(err.function_name || "", 20)),
      errorTypeBadge(err.error_type),
      truncate(err.error_message, 34),
      envBadge(err.env),
      timeBadge(err.occurred_at),
    ]);
  }

  console.log(table.toString());
  console.log(
    chalk.gray(`\n  Showing ${chalk.white.bold(String(errors.length))} errors`) +
      (result.total > errors.length
        ? chalk.gray(` of ${result.total} total`)
        : "") +
      "\n"
  );
}

async function showErrorDetail(id: number): Promise<void> {
  const result = await getError(id);
  const { error: err, snapshot } = result;

  console.log("");
  console.log(chalk.red.bold("  ━━━ Error Detail ━━━"));
  console.log("");

  // Error header
  console.log(`  ${errorTypeBadge(err.error_type)}  ${envBadge(err.env)}`);
  console.log("");
  console.log(chalk.white.bold(`  ${err.error_message}`));
  console.log(chalk.gray(`  ${relativeTime(err.occurred_at)} (${err.occurred_at})`));

  // Stack trace
  if (err.stack_trace) {
    console.log("");
    console.log(chalk.gray("  ── Stack Trace ──"));
    console.log("");
    const lines = err.stack_trace.split("\n");
    for (const line of lines) {
      if (line.trim().startsWith("at ")) {
        console.log(chalk.gray(`    ${line.trim()}`));
      } else {
        console.log(chalk.red(`    ${line.trim()}`));
      }
    }
  }

  // Type context
  console.log("");
  console.log(chalk.cyan.bold("  ── Type Context at Point of Failure ──"));
  console.log("");

  console.log(chalk.gray("  Function: ") + chalk.white.bold(err.function_name || `id:${err.function_id}`));
  console.log(chalk.gray("  Module:   ") + chalk.white(err.module || "unknown"));

  if (err.args_type) {
    console.log("");
    console.log(chalk.gray("  Input types:"));
    console.log(`    ${formatType(err.args_type, 4)}`);
  }

  if (err.return_type) {
    console.log("");
    console.log(chalk.gray("  Return type:"));
    console.log(`    ${formatType(err.return_type, 4)}`);
  }

  if (err.args_snapshot !== undefined && err.args_snapshot !== null) {
    console.log("");
    console.log(chalk.gray("  Sample data:"));
    const json = JSON.stringify(err.args_snapshot, null, 2);
    if (json) {
      const lines = json.split("\n");
      for (const line of lines) {
        const colored = line
          .replace(/"([^"]+)":/g, (_, key) => `${chalk.white(`"${key}"`)}:`)
          .replace(/: "([^"]*)"/g, (_, val) => `: ${chalk.green(`"${val}"`)}`)
          .replace(/: (\d+\.?\d*)/g, (_, val) => `: ${chalk.yellow(val)}`)
          .replace(/: (true|false)/g, (_, val) => `: ${chalk.blue(val)}`)
          .replace(/: (null)/g, (_, val) => `: ${chalk.gray(val)}`);
        console.log(`    ${colored}`);
      }
    }
  }

  // Expected types (from the latest non-error snapshot)
  if (snapshot) {
    console.log("");
    console.log(chalk.green.bold("  ── Expected Types (Happy Path) ──"));
    console.log("");

    console.log(chalk.gray("  Last successful snapshot:") + `  ${envBadge(snapshot.env as string)}  ${timeBadge(snapshot.observed_at as string)}`);

    if (snapshot.args_type) {
      console.log("");
      console.log(chalk.gray("  Expected input types:"));
      console.log(`    ${formatType(snapshot.args_type, 4)}`);
    }

    if (snapshot.return_type) {
      console.log("");
      console.log(chalk.gray("  Expected return type:"));
      console.log(`    ${formatType(snapshot.return_type, 4)}`);
    }
  }

  console.log("");
}
