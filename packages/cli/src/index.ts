#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { initCommand } from "./commands/init";
import { runCommand } from "./commands/run";
import { varsCommand } from "./commands/vars";
import { hintsCommand } from "./commands/hints";

const program = new Command();

program
  .name("trickle")
  .description("Runtime type annotations for Python and JavaScript — see tensor shapes, variable types, and crash-time values as you code")
  .version((() => { try { return require("../package.json").version; } catch { return "0.0.0"; } })());

program
  .command("init")
  .description("Set up trickle so you can see runtime types in VSCode, Jupyter, or the terminal")
  .option("--dir <path>", "Project directory (defaults to current directory)")
  .option("--python", "Set up for a Python project")
  .action(async (opts: { dir?: string; python?: boolean }) => {
    await initCommand(opts);
  });

program
  .command("run [command...]")
  .description("Run a file or command with runtime type observation — zero code changes needed")
  .option("--module <name>", "Module name for captured functions")
  .option("--include <patterns>", "Comma-separated substrings — only observe matching modules")
  .option("--exclude <patterns>", "Comma-separated substrings — skip matching modules")
  .option("-w, --watch", "Watch source files and re-run on changes")
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (commandParts: string[], opts: { module?: string; include?: string; exclude?: string; watch?: boolean }) => {
    const command = commandParts.length > 0 ? commandParts.join(" ") : undefined;
    await runCommand(command, opts);
  });

program
  .command("vars")
  .description("Show captured variable types and sample values from runtime observations")
  .option("-f, --file <file>", "Filter by file path or module name")
  .option("-m, --module <module>", "Filter by module name")
  .option("--json", "Output raw JSON")
  .option("--tensors", "Show only tensor/ndarray variables")
  .action(async (opts: { file?: string; module?: string; json?: boolean; tensors?: boolean }) => {
    await varsCommand(opts);
  });

program
  .command("hints [file]")
  .description("Print source with inline runtime types (or crash-time values in --errors mode)")
  .option("--values", "Include sample values alongside types")
  .option("--errors", "Show error mode — variables at crash time with values that caused the error")
  .option("--show <mode>", "What to show inline: types, values, or both (default: both in error mode, types otherwise)")
  .action(async (file: string | undefined, opts: { values?: boolean; errors?: boolean; show?: string }) => {
    await hintsCommand(file, opts);
  });

process.on("unhandledRejection", (err) => {
  if (err instanceof Error) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
  } else {
    console.error(chalk.red("\n  An unexpected error occurred.\n"));
  }
  process.exit(1);
});

// `trickle app.js` → `trickle run app.js`
// `trickle script.py --watch` → `trickle run script.py --watch`
const CODE_EXTENSIONS = /\.(js|ts|tsx|jsx|mjs|cjs|mts|py)$/i;
const firstArg = process.argv[2];
if (
  firstArg &&
  !firstArg.startsWith("-") &&
  CODE_EXTENSIONS.test(firstArg)
) {
  process.argv.splice(2, 0, "run");
}

program.parse();
