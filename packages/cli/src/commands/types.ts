import chalk from "chalk";
import { listFunctions, listTypes, getTypeDiff } from "../api-client";
import { formatType } from "../formatters/type-formatter";
import { formatDiffs } from "../formatters/diff-formatter";
import { envBadge, timeBadge } from "../ui/badges";

export interface TypesOptions {
  env?: string;
  diff?: boolean;
  env1?: string;
  env2?: string;
}

export async function typesCommand(functionName: string, opts: TypesOptions): Promise<void> {
  // Look up function by name (partial match)
  const result = await listFunctions({ search: functionName });
  const { functions } = result;

  if (functions.length === 0) {
    console.log(chalk.yellow(`\n  No function found matching "${functionName}".\n`));
    return;
  }

  // Prefer exact match, then first partial match
  const exactMatch = functions.find(
    (f) => f.function_name === functionName || f.function_name.toLowerCase() === functionName.toLowerCase()
  );
  const fn = exactMatch || functions[0];

  if (!exactMatch && functions.length > 1) {
    console.log(
      chalk.gray(`\n  Multiple matches found, showing results for "${chalk.white(fn.function_name)}"`)
    );
    console.log(
      chalk.gray(
        `  Other matches: ${functions
          .slice(1, 5)
          .map((f) => f.function_name)
          .join(", ")}${functions.length > 5 ? "..." : ""}\n`
      )
    );
  }

  // Diff mode
  if (opts.diff) {
    await showDiff(fn.id, fn.function_name, opts);
    return;
  }

  // Normal mode: show type snapshots
  const typesResult = await listTypes(fn.id, { env: opts.env });
  const { snapshots } = typesResult;

  if (snapshots.length === 0) {
    console.log(chalk.yellow(`\n  No type snapshots found for "${fn.function_name}".\n`));
    return;
  }

  console.log("");
  console.log(chalk.white.bold(`  ${fn.function_name}`) + chalk.gray(` (${fn.module})`));
  console.log(chalk.gray("  " + "─".repeat(50)));

  for (const snapshot of snapshots) {
    console.log("");
    console.log(
      `  ${envBadge(snapshot.env)}  ${timeBadge(snapshot.observed_at)}`
    );
    console.log("");

    // Display function signature
    console.log(chalk.gray("  args: ") + formatType(snapshot.args_type, 4));
    console.log(chalk.gray("  returns: ") + formatType(snapshot.return_type, 4));

    if (snapshot.sample_input !== undefined && snapshot.sample_input !== null) {
      console.log("");
      console.log(chalk.gray("  sample input:"));
      console.log(chalk.gray("  ") + colorizeJson(snapshot.sample_input, 4));
    }

    if (snapshot.sample_output !== undefined && snapshot.sample_output !== null) {
      console.log(chalk.gray("  sample output:"));
      console.log(chalk.gray("  ") + colorizeJson(snapshot.sample_output, 4));
    }
  }

  console.log("");
}

async function showDiff(functionId: number, functionName: string, opts: TypesOptions): Promise<void> {
  try {
    let diffResult;

    if (opts.env1 && opts.env2) {
      diffResult = await getTypeDiff(functionId, {
        fromEnv: opts.env1,
        toEnv: opts.env2,
      });
    } else {
      // Get latest two snapshots and diff by their IDs
      const typesResult = await listTypes(functionId, { limit: 2 });
      const { snapshots } = typesResult;

      if (snapshots.length < 2) {
        console.log(chalk.yellow(`\n  Not enough snapshots to diff for "${functionName}".`));
        console.log(chalk.gray("  Need at least 2 snapshots. Try specifying --env1 and --env2.\n"));
        return;
      }

      diffResult = await getTypeDiff(functionId, {
        from: snapshots[1].id,
        to: snapshots[0].id,
      });
    }

    console.log("");
    console.log(chalk.white.bold(`  Type diff for ${functionName}`));
    console.log(chalk.gray("  " + "─".repeat(50)));
    console.log("");

    console.log(
      chalk.gray("  from: ") +
        envBadge(diffResult.from.env) +
        chalk.gray("  " + diffResult.from.observed_at)
    );
    console.log(
      chalk.gray("  to:   ") +
        envBadge(diffResult.to.env) +
        chalk.gray("  " + diffResult.to.observed_at)
    );
    console.log("");

    if (diffResult.diffs.length === 0) {
      console.log(chalk.green("  No type differences found.\n"));
    } else {
      console.log(formatDiffs(diffResult.diffs));
      console.log("");
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
  }
}

function colorizeJson(value: unknown, indent: number = 0): string {
  const json = JSON.stringify(value, null, 2);
  if (!json) return chalk.gray("null");

  return json
    .split("\n")
    .map((line, i) => {
      const padded = i === 0 ? line : " ".repeat(indent) + line;
      return padded
        .replace(/"([^"]+)":/g, (_, key) => `${chalk.white(`"${key}"`)}:`)
        .replace(/: "([^"]*)"/g, (_, val) => `: ${chalk.green(`"${val}"`)}`)
        .replace(/: (\d+\.?\d*)/g, (_, val) => `: ${chalk.yellow(val)}`)
        .replace(/: (true|false)/g, (_, val) => `: ${chalk.blue(val)}`)
        .replace(/: (null)/g, (_, val) => `: ${chalk.gray(val)}`);
    })
    .join("\n");
}
