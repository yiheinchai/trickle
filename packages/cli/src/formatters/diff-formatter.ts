import chalk from "chalk";
import { TypeDiff } from "../api-client";
import { formatType } from "./type-formatter";

/**
 * Format an array of TypeDiff entries as colorized diff output.
 */
export function formatDiffs(diffs: TypeDiff[]): string {
  if (diffs.length === 0) {
    return chalk.gray("  No differences found.");
  }

  const lines: string[] = [];

  for (const diff of diffs) {
    const pathStr = chalk.gray(diff.path);

    switch (diff.kind) {
      case "added":
        lines.push(
          chalk.green("  + added  ") +
            pathStr +
            chalk.gray(": ") +
            formatType(diff.type, 0)
        );
        break;

      case "removed":
        lines.push(
          chalk.red("  - removed  ") +
            pathStr +
            chalk.gray(": ") +
            formatType(diff.type, 0)
        );
        break;

      case "changed":
        lines.push(
          chalk.yellow("  ~ changed  ") +
            pathStr +
            chalk.gray(": ") +
            formatType(diff.from, 0) +
            chalk.gray(" -> ") +
            formatType(diff.to, 0)
        );
        break;
    }
  }

  return lines.join("\n");
}
