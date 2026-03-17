import * as fs from "fs";
import * as crypto from "crypto";
import chalk from "chalk";
import { getBackendUrl } from "../config";

export interface UnpackOptions {
  env?: string;
  dryRun?: boolean;
}

interface PackedSnapshot {
  typeHash: string;
  env: string;
  argsType: unknown;
  returnType: unknown;
  sampleInput?: unknown;
  sampleOutput?: unknown;
  observedAt: string;
}

interface PackedFunction {
  functionName: string;
  module: string;
  language: string;
  environment: string;
  snapshots: PackedSnapshot[];
}

interface PackBundle {
  version: number;
  createdAt: string;
  source: string;
  functions: PackedFunction[];
  stats: {
    totalFunctions: number;
    totalSnapshots: number;
  };
}

/**
 * `trickle unpack <file>` — Import types from a packed bundle into the backend.
 *
 * Reads a .trickle.json bundle (created by `trickle pack`) and ingests
 * all functions and their type snapshots into the backend.
 */
export async function unpackCommand(
  file: string,
  opts: UnpackOptions,
): Promise<void> {
  const backendUrl = getBackendUrl();

  // Read and parse the bundle
  if (!fs.existsSync(file)) {
    console.error(chalk.red(`\n  File not found: ${file}\n`));
    process.exit(1);
  }

  let bundle: PackBundle;
  try {
    const content = fs.readFileSync(file, "utf-8");
    bundle = JSON.parse(content) as PackBundle;
  } catch {
    console.error(chalk.red("\n  Invalid bundle file — expected JSON.\n"));
    process.exit(1);
  }

  // Validate bundle structure
  if (!bundle.version || !bundle.functions || !Array.isArray(bundle.functions)) {
    console.error(chalk.red("\n  Invalid bundle format — missing required fields.\n"));
    process.exit(1);
  }

  if (bundle.version !== 1) {
    console.error(chalk.red(`\n  Unsupported bundle version: ${bundle.version}\n`));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.bold("  trickle unpack"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  File:     ${file}`));
  console.log(chalk.gray(`  Created:  ${bundle.createdAt}`));
  console.log(chalk.gray(`  Source:   ${bundle.source}`));
  console.log(chalk.gray(`  Contains: ${bundle.functions.length} functions, ${bundle.stats.totalSnapshots} snapshots`));
  console.log(chalk.gray("  " + "─".repeat(50)));

  if (opts.dryRun) {
    console.log("");
    console.log(chalk.yellow("  Dry run — listing contents without importing:"));
    console.log("");
    for (const fn of bundle.functions) {
      console.log(
        chalk.white(`  ${fn.functionName}`) +
        chalk.gray(` (${fn.module}, ${fn.language}, ${fn.snapshots.length} snapshot${fn.snapshots.length === 1 ? "" : "s"})`),
      );
    }
    console.log("");
    console.log(chalk.gray(`  ${bundle.functions.length} functions would be imported.`));
    console.log(chalk.gray("  Remove --dry-run to import.\n"));
    return;
  }

  // Check backend connectivity
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
    process.exit(1);
  }

  console.log("");

  // Ingest each function's snapshots
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const fn of bundle.functions) {
    // Use the latest snapshot for ingest
    const snapshot = fn.snapshots[0];
    if (!snapshot) {
      skipped++;
      continue;
    }

    const env = opts.env || snapshot.env || fn.environment;
    const typeHash = snapshot.typeHash || computeTypeHash(snapshot.argsType, snapshot.returnType);

    const payload = {
      functionName: fn.functionName,
      module: fn.module,
      language: fn.language,
      environment: env,
      typeHash,
      argsType: snapshot.argsType,
      returnType: snapshot.returnType,
      sampleInput: snapshot.sampleInput,
      sampleOutput: snapshot.sampleOutput,
    };

    try {
      const res = await fetch(`${backendUrl}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      imported++;
      console.log(chalk.green("  ✓ ") + chalk.white(fn.functionName));
    } catch {
      errors++;
      console.log(chalk.red("  ✗ ") + chalk.white(fn.functionName) + chalk.gray(" (failed)"));
    }
  }

  console.log("");
  console.log(chalk.gray("  " + "─".repeat(50)));

  if (imported > 0) {
    console.log(chalk.green(`  ${imported} functions imported successfully`));
  }
  if (skipped > 0) {
    console.log(chalk.yellow(`  ${skipped} skipped (no snapshots)`));
  }
  if (errors > 0) {
    console.log(chalk.red(`  ${errors} failed`));
  }

  console.log("");
  console.log(chalk.gray("  Run ") + chalk.white("trickle overview") + chalk.gray(" to see imported types."));
  console.log("");
}

function computeTypeHash(argsType: unknown, returnType: unknown): string {
  const data = JSON.stringify({ a: argsType, r: returnType });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}
