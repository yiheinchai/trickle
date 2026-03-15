import chalk from "chalk";
import Table from "cli-table3";
import { listFunctions } from "../api-client";
import { envBadge, langBadge, timeBadge } from "../ui/badges";
import { relativeTime } from "../ui/helpers";
import { isLocalMode, getLocalFunctions } from "../local-data";

export interface FunctionsOptions {
  env?: string;
  lang?: string;
  search?: string;
  local?: boolean;
}

export async function functionsCommand(opts: FunctionsOptions): Promise<void> {
  const result = isLocalMode(opts)
    ? getLocalFunctions({
        env: opts.env,
        language: opts.lang,
        search: opts.search,
      })
    : await listFunctions({
        env: opts.env,
        language: opts.lang,
        search: opts.search,
      });

  const { functions } = result;

  if (functions.length === 0) {
    console.log(chalk.yellow("\n  No functions found.\n"));
    if (opts.env || opts.lang || opts.search) {
      console.log(chalk.gray("  Try adjusting your filters.\n"));
    }
    return;
  }

  console.log("");

  const table = new Table({
    head: [
      chalk.cyan.bold("Name"),
      chalk.cyan.bold("Module"),
      chalk.cyan.bold("Language"),
      chalk.cyan.bold("Environment"),
      chalk.cyan.bold("Last Seen"),
    ],
    style: {
      head: [],
      border: ["gray"],
    },
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

  for (const fn of functions) {
    table.push([
      chalk.white.bold(fn.function_name),
      chalk.gray(fn.module),
      langBadge(fn.language),
      envBadge(fn.environment),
      timeBadge(fn.last_seen_at),
    ]);
  }

  console.log(table.toString());
  console.log(
    chalk.gray(`\n  Showing ${chalk.white.bold(String(functions.length))} functions`) +
      (result.total > functions.length
        ? chalk.gray(` of ${result.total} total`)
        : "") +
      "\n"
  );
}
