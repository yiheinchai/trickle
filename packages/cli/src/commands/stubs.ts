import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchStubs } from "../api-client";

export interface StubsOptions {
  env?: string;
  dryRun?: boolean;
  silent?: boolean;
}

/**
 * Map of file extensions to their stub extension.
 */
const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const PY_EXTS = new Set([".py"]);

/**
 * Normalize a module name for matching against file stems.
 * Module names from trickle may use dashes or underscores.
 * File stems use whatever the OS has.
 */
function normalizeForMatch(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

/**
 * Recursively find all source files in a directory.
 */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, __pycache__, .git, etc.
      if (
        entry.name === "node_modules" ||
        entry.name === "__pycache__" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".trickle"
      ) {
        continue;
      }
      results.push(...findSourceFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (JS_EXTS.has(ext) || PY_EXTS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

export async function stubsCommand(
  dir: string,
  opts: StubsOptions,
): Promise<void> {
  const targetDir = path.resolve(dir);

  if (!fs.existsSync(targetDir)) {
    console.error(chalk.red(`\n  Directory not found: ${targetDir}\n`));
    process.exit(1);
  }

  if (!fs.statSync(targetDir).isDirectory()) {
    console.error(chalk.red(`\n  Not a directory: ${targetDir}\n`));
    process.exit(1);
  }

  // Fetch per-module stubs from backend
  const { stubs } = await fetchStubs({ env: opts.env });

  if (!stubs || Object.keys(stubs).length === 0) {
    if (!opts.silent) {
      console.log(
        chalk.yellow(
          "\n  No observed types found. Run your code with trickle first.\n",
        ),
      );
    }
    return;
  }

  // Find all source files in the target directory
  const sourceFiles = findSourceFiles(targetDir);

  if (sourceFiles.length === 0) {
    if (!opts.silent) {
      console.log(
        chalk.yellow(`\n  No source files found in ${targetDir}\n`),
      );
    }
    return;
  }

  // Build a map: normalized stem → source file path
  const fileMap: Map<string, string[]> = new Map();
  for (const filePath of sourceFiles) {
    const ext = path.extname(filePath);
    const stem = path.basename(filePath, ext);
    const key = normalizeForMatch(stem);
    if (!fileMap.has(key)) fileMap.set(key, []);
    fileMap.get(key)!.push(filePath);
  }

  const written: string[] = [];
  const writtenPaths = new Set<string>();
  const skipped: string[] = [];

  for (const [moduleName, moduleStubs] of Object.entries(stubs)) {
    const normalizedModule = normalizeForMatch(moduleName);

    // Find matching source files
    const matchingFiles = fileMap.get(normalizedModule);

    if (!matchingFiles || matchingFiles.length === 0) {
      skipped.push(moduleName);
      continue;
    }

    for (const sourceFile of matchingFiles) {
      const ext = path.extname(sourceFile).toLowerCase();
      const isPython = PY_EXTS.has(ext);
      const stubContent = isPython ? moduleStubs.python : moduleStubs.ts;
      const stubExt = isPython ? ".pyi" : ".d.ts";

      // Generate stub file path next to source file
      const sourceDir = path.dirname(sourceFile);
      const sourceStem = path.basename(sourceFile, ext);
      const stubPath = path.join(sourceDir, `${sourceStem}${stubExt}`);

      // Skip if already written (multiple modules may normalize to same name)
      if (writtenPaths.has(stubPath)) continue;
      writtenPaths.add(stubPath);

      if (opts.dryRun) {
        const relPath = path.relative(process.cwd(), stubPath);
        console.log(chalk.cyan(`  Would create: ${relPath}`));
        console.log(
          chalk.gray(
            `    (from module "${moduleName}" → ${path.basename(sourceFile)})`,
          ),
        );
        written.push(relPath);
        continue;
      }

      // Write stub file
      fs.writeFileSync(stubPath, stubContent, "utf-8");
      const relPath = path.relative(process.cwd(), stubPath);
      written.push(relPath);
    }
  }

  // Output summary
  if (opts.silent) return;
  console.log();
  if (opts.dryRun) {
    console.log(chalk.cyan("  Dry run — no files written.\n"));
    if (written.length > 0) {
      console.log(chalk.gray(`  ${written.length} stub file(s) would be created.\n`));
    }
  } else if (written.length > 0) {
    console.log(chalk.green(`  Generated ${written.length} type stub file(s):\n`));
    for (const f of written) {
      console.log(chalk.gray(`    ${f}`));
    }
    console.log();
    console.log(
      chalk.gray(
        "  Your IDE should now pick up these types automatically.",
      ),
    );
    console.log(
      chalk.gray(
        "  Add *.d.ts / *.pyi to .gitignore if you don't want to commit them.",
      ),
    );
    console.log();
  } else {
    console.log(
      chalk.yellow(
        "  No matching source files found for observed modules.\n",
      ),
    );
    if (skipped.length > 0) {
      console.log(
        chalk.gray(
          `  Observed modules: ${skipped.join(", ")}`,
        ),
      );
      console.log(
        chalk.gray(
          `  Source files in: ${path.relative(process.cwd(), targetDir) || "."}`,
        ),
      );
      console.log(
        chalk.gray(
          "  Make sure module names match file names (e.g., module 'helpers' → helpers.js)\n",
        ),
      );
    }
  }
}
