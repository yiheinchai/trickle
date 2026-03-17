import * as fs from "fs";
import chalk from "chalk";
import { listFunctions, listTypes } from "../api-client";
import { getBackendUrl } from "../config";

export interface PackOptions {
  out?: string;
  env?: string;
}

interface PackedFunction {
  functionName: string;
  module: string;
  language: string;
  environment: string;
  snapshots: PackedSnapshot[];
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

interface PackBundle {
  version: 1;
  createdAt: string;
  source: string;
  functions: PackedFunction[];
  stats: {
    totalFunctions: number;
    totalSnapshots: number;
  };
}

/**
 * `trickle pack` — Export all observed types as a portable bundle.
 *
 * Creates a JSON file containing all functions and their type snapshots
 * that can be shared, committed to version control, or imported elsewhere.
 */
export async function packCommand(opts: PackOptions): Promise<void> {
  const backendUrl = getBackendUrl();

  // Check backend
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}\n`));
    process.exit(1);
  }

  // Use stderr for status when writing JSON to stdout
  const log = opts.out ? console.log : (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

  log("");
  log(chalk.bold("  trickle pack"));
  log(chalk.gray("  " + "─".repeat(50)));

  // Fetch all functions
  const result = await listFunctions({ env: opts.env, limit: 10000 });
  const { functions } = result;

  if (functions.length === 0) {
    log(chalk.yellow("  No observed types to pack."));
    log(chalk.gray("  Run ") + chalk.white("trickle capture") + chalk.gray(" or ") + chalk.white("trickle dev") + chalk.gray(" first.\n"));
    process.exit(1);
  }

  log(chalk.gray(`  Packing ${functions.length} functions...`));

  // Fetch snapshots for each function
  const packedFunctions: PackedFunction[] = [];
  let totalSnapshots = 0;

  for (const fn of functions) {
    const typesResult = await listTypes(fn.id, { env: opts.env, limit: 100 });
    const snapshots: PackedSnapshot[] = [];

    for (const snap of typesResult.snapshots) {
      snapshots.push({
        typeHash: snap.type_hash,
        env: snap.env,
        argsType: snap.args_type,
        returnType: snap.return_type,
        sampleInput: snap.sample_input || undefined,
        sampleOutput: snap.sample_output || undefined,
        observedAt: snap.observed_at,
      });
    }

    if (snapshots.length > 0) {
      packedFunctions.push({
        functionName: fn.function_name,
        module: fn.module,
        language: fn.language,
        environment: fn.environment,
        snapshots,
      });
      totalSnapshots += snapshots.length;
    }
  }

  const bundle: PackBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: backendUrl,
    functions: packedFunctions,
    stats: {
      totalFunctions: packedFunctions.length,
      totalSnapshots,
    },
  };

  const json = JSON.stringify(bundle, null, 2);

  if (opts.out) {
    fs.writeFileSync(opts.out, json, "utf-8");
    log(chalk.green(`  Packed ${packedFunctions.length} functions (${totalSnapshots} snapshots)`));
    log(chalk.gray(`  Written to ${opts.out}`));
    const sizeKb = (Buffer.byteLength(json, "utf-8") / 1024).toFixed(1);
    log(chalk.gray(`  Size: ${sizeKb}KB`));
    log("");
    log(chalk.gray("  Share this file or import it with:"));
    log(chalk.white(`  trickle unpack ${opts.out}`));
    log("");
  } else {
    // Write JSON to stdout for piping
    process.stdout.write(json + "\n");
    // Summary to stderr
    log(chalk.green(`  Packed ${packedFunctions.length} functions (${totalSnapshots} snapshots)`));
    log("");
  }
}
