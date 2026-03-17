/**
 * trickle layers — per-layer activation and gradient observability for nn.Sequential models.
 *
 * Reads activation_stats and gradient records from .trickle/variables.jsonl
 * and displays a formatted per-layer breakdown table. Solves the problem where
 * nn.Sequential layers all map to the same source line, making inline hints useless.
 */

import chalk from "chalk";
import Table from "cli-table3";
import * as fs from "fs";
import * as path from "path";

// ── Types ──

interface ActivationRecord {
  kind: "activation_stats";
  file: string;
  line: number;
  module_name: string;
  call_count: number;
  timestamp: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  numel: number;
  shape: number[];
  zero_frac?: number;
  sat_frac?: number;
  vanishing?: boolean;
  exploding?: boolean;
}

interface GradientLayer {
  name: string;
  norm: number;
  vanishing: boolean;
  exploding: boolean;
}

interface GradientRecord {
  kind: "gradient";
  file: string;
  line: number;
  model_var: string;
  layers: GradientLayer[];
  max_norm: number;
  min_norm: number;
  num_layers: number;
  vanishing: string[];
  exploding: string[];
  timestamp: number;
}

export interface LayersOptions {
  file?: string;
  watch?: boolean;
  json?: boolean;
}

// ── Helpers ──

function formatShape(shape: number[]): string {
  return `[${shape.join(",")}]`;
}

function formatMean(mean: number): string {
  return mean >= 0 ? `+${mean.toFixed(2)}` : mean.toFixed(2);
}

function colorMean(mean: number): string {
  const formatted = formatMean(mean);
  const abs = Math.abs(mean);
  if (abs > 10) return chalk.red(formatted);
  if (abs > 5) return chalk.yellow(formatted);
  return chalk.white(formatted);
}

function colorStd(std: number): string {
  const formatted = std.toFixed(2);
  if (std > 10) return chalk.red(formatted);
  if (std > 5) return chalk.yellow(formatted);
  return chalk.white(formatted);
}

function buildFlags(rec: ActivationRecord): string[] {
  const flags: string[] = [];
  if (rec.zero_frac !== undefined && rec.zero_frac > 0.4) {
    flags.push(chalk.yellow(`dead:${Math.round(rec.zero_frac * 100)}%`));
  }
  if (rec.sat_frac !== undefined && rec.sat_frac > 0.5) {
    flags.push(chalk.red(`sat:${Math.round(rec.sat_frac * 100)}%`));
  }
  if (rec.vanishing) {
    flags.push(chalk.red("vanishing"));
  }
  if (rec.exploding) {
    flags.push(chalk.red.bold("EXPLODING"));
  }
  return flags;
}

function gradientStatus(layer: GradientLayer): string {
  if (layer.exploding) return chalk.red.bold("EXPLODING");
  if (layer.vanishing) return chalk.red("vanishing");
  if (layer.norm < 0.01) return chalk.yellow("low");
  return chalk.green("ok");
}

function formatNorm(norm: number): string {
  if (norm < 0.001) return norm.toExponential(2);
  return norm.toFixed(4);
}

// ── Data reading ──

function readRecords(varsFile: string): { activations: ActivationRecord[]; gradients: GradientRecord[] } {
  const content = fs.readFileSync(varsFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const activations: ActivationRecord[] = [];
  const gradients: GradientRecord[] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.kind === "activation_stats") {
        activations.push(rec as ActivationRecord);
      } else if (rec.kind === "gradient") {
        gradients.push(rec as GradientRecord);
      }
    } catch {
      // skip malformed lines
    }
  }

  return { activations, gradients };
}

/** Container module names to skip (we want individual layers, not wrappers). */
const CONTAINER_PATTERNS = ["Sequential", "ModuleList", "ModuleDict"];
function isContainerModule(name: string): boolean {
  if (CONTAINER_PATTERNS.includes(name)) return true;
  // Skip model-level modules (e.g. SpiralNet, ResNet, MyModel)
  if (name.endsWith("Net") || name.endsWith("Model") || name.endsWith("Block")) return true;
  return false;
}

/**
 * Extract the latest forward pass from activation records.
 *
 * Strategy: sort by timestamp, then detect the repeating forward-pass structure
 * by finding where the sequence pattern restarts. Take the last complete pass.
 */
function getLatestActivations(activations: ActivationRecord[], fileFilter?: string): ActivationRecord[] {
  let filtered = activations;
  if (fileFilter) {
    filtered = filtered.filter((r) => r.file.includes(fileFilter));
  }

  if (filtered.length === 0) return [];

  // Filter out container modules
  filtered = filtered.filter((r) => !isContainerModule(r.module_name));

  if (filtered.length === 0) return [];

  // Sort by timestamp to get execution order
  filtered.sort((a, b) => a.timestamp - b.timestamp);

  // Detect forward pass length by finding the shortest repeating period of module names.
  // A candidate period must repeat consistently across at least 3 passes (or the entire array).
  const names = filtered.map((r) => r.module_name);

  let passLength = 0;
  outer:
  for (let len = 3; len <= Math.floor(names.length / 2); len++) {
    // Check that this period repeats for ALL subsequent complete passes
    const numFullPasses = Math.floor(names.length / len);
    if (numFullPasses < 2) continue;

    for (let pass = 1; pass < numFullPasses; pass++) {
      for (let j = 0; j < len; j++) {
        if (names[j] !== names[pass * len + j]) {
          continue outer;
        }
      }
    }
    passLength = len;
    break;
  }

  // If no repeat found, all records are a single pass
  if (passLength === 0) {
    return filtered;
  }

  // Take the last complete forward pass
  const totalPasses = Math.floor(filtered.length / passLength);
  if (totalPasses === 0) return filtered;

  const startIdx = (totalPasses - 1) * passLength;
  const lastPass = filtered.slice(startIdx, startIdx + passLength);

  return lastPass;
}

function getLatestGradient(gradients: GradientRecord[]): GradientRecord | null {
  if (gradients.length === 0) return null;
  return gradients.reduce((latest, g) =>
    g.timestamp > latest.timestamp ? g : latest
  );
}

// ── Display ──

function displayActivations(activations: ActivationRecord[]): void {
  const line = chalk.gray("─".repeat(72));

  console.log("");
  console.log(chalk.cyan.bold("  Model Layer Activations"));
  console.log(`  ${line}`);

  const table = new Table({
    head: [
      chalk.gray("Layer"),
      chalk.gray("Shape"),
      chalk.gray("Mean"),
      chalk.gray("Std"),
      chalk.gray("Flags"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [20, 14, 10, 10, 22],
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

  let deadCount = 0;
  let satCount = 0;
  let vanishingCount = 0;
  let explodingCount = 0;

  for (const rec of activations) {
    const flags = buildFlags(rec);
    if (rec.zero_frac !== undefined && rec.zero_frac > 0.4) deadCount++;
    if (rec.sat_frac !== undefined && rec.sat_frac > 0.5) satCount++;
    if (rec.vanishing) vanishingCount++;
    if (rec.exploding) explodingCount++;

    table.push([
      chalk.white.bold(rec.module_name),
      chalk.gray(formatShape(rec.shape)),
      colorMean(rec.mean),
      colorStd(rec.std),
      flags.join(" "),
    ]);
  }

  console.log(table.toString());

  // Warnings summary
  const warnings: string[] = [];
  if (deadCount > 0) {
    warnings.push(chalk.yellow(`  ${deadCount} layer(s) with >40% dead neurons`));
  }
  if (satCount > 0) {
    warnings.push(chalk.red(`  ${satCount} layer(s) with >50% saturation`));
  }
  if (vanishingCount > 0) {
    warnings.push(chalk.red(`  ${vanishingCount} layer(s) with vanishing activations`));
  }
  if (explodingCount > 0) {
    warnings.push(chalk.red.bold(`  ${explodingCount} layer(s) with exploding activations`));
  }

  if (warnings.length > 0) {
    console.log("");
    for (const w of warnings) {
      console.log(w);
    }
  }
}

function displayGradients(gradient: GradientRecord): void {
  const line = chalk.gray("─".repeat(72));

  console.log("");
  console.log(chalk.cyan.bold("  Gradient Norms (after backward)"));
  console.log(`  ${line}`);

  const table = new Table({
    head: [
      chalk.gray("Layer"),
      chalk.gray("Norm"),
      chalk.gray("Status"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [30, 16, 20],
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

  // Sort by norm descending
  const sorted = [...gradient.layers].sort((a, b) => b.norm - a.norm);

  for (const layer of sorted) {
    table.push([
      chalk.white.bold(layer.name),
      chalk.gray(formatNorm(layer.norm)),
      gradientStatus(layer),
    ]);
  }

  console.log(table.toString());

  // Warnings
  if (gradient.vanishing.length > 0) {
    console.log(chalk.red(`\n  Vanishing gradients in: ${gradient.vanishing.join(", ")}`));
  }
  if (gradient.exploding.length > 0) {
    console.log(chalk.red.bold(`\n  Exploding gradients in: ${gradient.exploding.join(", ")}`));
  }
}

function displayJson(activations: ActivationRecord[], gradient: GradientRecord | null): void {
  const output: Record<string, unknown> = {
    activations: activations.map((r) => ({
      layer: r.module_name,
      shape: r.shape,
      mean: r.mean,
      std: r.std,
      min: r.min,
      max: r.max,
      zero_frac: r.zero_frac,
      sat_frac: r.sat_frac,
      vanishing: r.vanishing || false,
      exploding: r.exploding || false,
      call_count: r.call_count,
      timestamp: r.timestamp,
    })),
  };

  if (gradient) {
    output.gradients = {
      layers: gradient.layers,
      max_norm: gradient.max_norm,
      min_norm: gradient.min_norm,
      vanishing: gradient.vanishing,
      exploding: gradient.exploding,
      timestamp: gradient.timestamp,
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

// ── Main ──

function runLayers(varsFile: string, opts: LayersOptions): void {
  const { activations, gradients } = readRecords(varsFile);

  if (activations.length === 0 && gradients.length === 0) {
    console.log(chalk.yellow("\n  No activation or gradient data found."));
    console.log(chalk.gray("  Run your ML training with: trickle run python train.py\n"));
    return;
  }

  const latestActivations = getLatestActivations(activations, opts.file);
  const latestGradient = getLatestGradient(gradients);

  if (opts.json) {
    displayJson(latestActivations, latestGradient);
    return;
  }

  if (latestActivations.length > 0) {
    displayActivations(latestActivations);
  } else {
    console.log(chalk.yellow("\n  No activation stats found."));
  }

  if (latestGradient) {
    displayGradients(latestGradient);
  }

  console.log("");

  // Summary line
  const parts: string[] = [];
  parts.push(`${latestActivations.length} layer(s)`);
  if (latestGradient) {
    parts.push(`${latestGradient.num_layers} gradient parameter(s)`);
  }
  console.log(chalk.gray(`  ${parts.join(", ")}`));
  console.log(chalk.gray(`  Run ${chalk.white("trickle layers --json")} for structured output\n`));
}

export async function layersCommand(opts: LayersOptions): Promise<void> {
  const trickleDir = path.join(process.cwd(), ".trickle");
  const varsFile = path.join(trickleDir, "variables.jsonl");

  if (!fs.existsSync(varsFile)) {
    console.log(chalk.yellow("\n  No observability data found."));
    console.log(chalk.gray("  Run your ML training with: trickle run python train.py\n"));
    return;
  }

  if (opts.watch) {
    console.log(chalk.gray("\n  Watching for changes...") + chalk.gray(" (Ctrl+C to stop)\n"));
    runLayers(varsFile, opts);

    fs.watchFile(varsFile, { interval: 2000 }, () => {
      // Clear screen and re-render
      process.stdout.write("\x1B[2J\x1B[0f");
      runLayers(varsFile, opts);
    });

    // Keep alive
    const onSignal = () => {
      fs.unwatchFile(varsFile);
      console.log(chalk.gray("\n  Stopped watching.\n"));
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    await new Promise<void>(() => {});
  } else {
    runLayers(varsFile, opts);
  }
}
