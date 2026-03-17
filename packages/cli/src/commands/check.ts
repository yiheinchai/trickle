import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchSnapshot, CheckSnapshot, SnapshotFunction } from "../api-client";
import { isLocalMode, getLocalFunctions, getLocalTypes } from "../local-data";

export interface CheckOptions {
  save?: string;
  against?: string;
  env?: string;
  local?: boolean;
}

interface BreakingChange {
  functionName: string;
  severity: "breaking" | "non-breaking";
  description: string;
  path: string;
}

/**
 * Recursively diff two type nodes and classify changes as breaking or non-breaking.
 *
 * Breaking changes (for responses):
 * - Field removed from response object
 * - Field type changed in response
 * - Array element type changed
 *
 * Non-breaking changes (for responses):
 * - Field added to response object
 *
 * Breaking changes (for requests/args):
 * - New required field added to request body
 * - Field type changed in request
 *
 * Non-breaking changes (for requests/args):
 * - Field removed from request (server no longer requires it)
 */
function classifyChanges(
  baseline: unknown,
  current: unknown,
  basePath: string,
  context: "request" | "response",
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const b = baseline as Record<string, unknown>;
  const c = current as Record<string, unknown>;

  if (!b || !c) return changes;

  // Different kinds
  if (b.kind !== c.kind) {
    changes.push({
      functionName: "",
      severity: "breaking",
      description: `Type changed from ${b.kind} to ${c.kind}`,
      path: basePath || "(root)",
    });
    return changes;
  }

  switch (b.kind) {
    case "primitive": {
      if (b.name !== (c as Record<string, unknown>).name) {
        changes.push({
          functionName: "",
          severity: "breaking",
          description: `Type changed from ${b.name} to ${(c as Record<string, unknown>).name}`,
          path: basePath || "(root)",
        });
      }
      break;
    }

    case "object": {
      const bProps = b.properties as Record<string, unknown>;
      const cProps = (c as Record<string, unknown>).properties as Record<string, unknown>;
      const bKeys = new Set(Object.keys(bProps || {}));
      const cKeys = new Set(Object.keys(cProps || {}));

      // Fields in baseline but not in current
      for (const key of bKeys) {
        const childPath = basePath ? `${basePath}.${key}` : key;
        if (!cKeys.has(key)) {
          if (context === "response") {
            // Removing a response field is breaking (clients may depend on it)
            changes.push({
              functionName: "",
              severity: "breaking",
              description: `Field removed from response`,
              path: childPath,
            });
          } else {
            // Removing a request field is non-breaking (server no longer needs it)
            changes.push({
              functionName: "",
              severity: "non-breaking",
              description: `Field removed from request (no longer required)`,
              path: childPath,
            });
          }
        } else {
          // Recursively check
          changes.push(...classifyChanges(bProps[key], cProps[key], childPath, context));
        }
      }

      // Fields in current but not in baseline
      for (const key of cKeys) {
        if (!bKeys.has(key)) {
          const childPath = basePath ? `${basePath}.${key}` : key;
          if (context === "response") {
            // Adding a response field is non-breaking
            changes.push({
              functionName: "",
              severity: "non-breaking",
              description: `Field added to response`,
              path: childPath,
            });
          } else {
            // Adding a request field is breaking (callers don't send it yet)
            changes.push({
              functionName: "",
              severity: "breaking",
              description: `New required field added to request`,
              path: childPath,
            });
          }
        }
      }
      break;
    }

    case "array": {
      const bEl = b.element as Record<string, unknown>;
      const cEl = (c as Record<string, unknown>).element as Record<string, unknown>;
      changes.push(...classifyChanges(bEl, cEl, `${basePath || "(root)"}[]`, context));
      break;
    }

    case "tuple": {
      const bEls = b.elements as unknown[];
      const cEls = (c as Record<string, unknown>).elements as unknown[];
      const maxLen = Math.max(bEls?.length || 0, cEls?.length || 0);
      for (let i = 0; i < maxLen; i++) {
        const elPath = `${basePath || "(root)"}[${i}]`;
        if (i >= (bEls?.length || 0)) {
          changes.push({
            functionName: "",
            severity: context === "response" ? "non-breaking" : "breaking",
            description: `Element added`,
            path: elPath,
          });
        } else if (i >= (cEls?.length || 0)) {
          changes.push({
            functionName: "",
            severity: "breaking",
            description: `Element removed`,
            path: elPath,
          });
        } else {
          changes.push(...classifyChanges(bEls[i], cEls[i], elPath, context));
        }
      }
      break;
    }

    case "union": {
      const bMembers = (b.members as unknown[]).map((m) => JSON.stringify(m));
      const cMembers = ((c as Record<string, unknown>).members as unknown[]).map((m) => JSON.stringify(m));
      const bSet = new Set(bMembers);
      const cSet = new Set(cMembers);

      for (const m of bMembers) {
        if (!cSet.has(m)) {
          changes.push({
            functionName: "",
            severity: "breaking",
            description: `Union member removed`,
            path: basePath || "(root)",
          });
        }
      }
      for (const m of cMembers) {
        if (!bSet.has(m)) {
          changes.push({
            functionName: "",
            severity: "non-breaking",
            description: `Union member added`,
            path: basePath || "(root)",
          });
        }
      }
      break;
    }

    case "map": {
      changes.push(...classifyChanges(b.value, (c as Record<string, unknown>).value, `${basePath}<value>`, context));
      break;
    }

    case "set": {
      changes.push(...classifyChanges(b.element, (c as Record<string, unknown>).element, `${basePath}<element>`, context));
      break;
    }

    case "promise": {
      changes.push(...classifyChanges(b.resolved, (c as Record<string, unknown>).resolved, basePath, context));
      break;
    }

    // unknown, function — no deep diff
  }

  return changes;
}

export async function checkCommand(opts: CheckOptions): Promise<void> {
  async function getSnapshot(env?: string): Promise<CheckSnapshot> {
    if (isLocalMode(opts)) {
      const { functions } = getLocalFunctions({ env });
      const snapshotFunctions: SnapshotFunction[] = functions.map((f) => {
        const types = getLocalTypes(f.function_name, { env });
        const latest = types.snapshots[types.snapshots.length - 1];
        return {
          name: f.function_name,
          module: f.module,
          argsType: latest?.args_type || {},
          returnType: latest?.return_type || {},
        };
      });
      return {
        version: 1,
        createdAt: new Date().toISOString(),
        functions: snapshotFunctions,
      };
    }
    return fetchSnapshot({ env });
  }
  try {
    // Mode 1: Save current snapshot
    if (opts.save) {
      const snapshot = await getSnapshot(opts.env);

      if (snapshot.functions.length === 0) {
        console.error(chalk.yellow("\n  No functions observed yet. Run your app first to populate types.\n"));
        process.exit(1);
      }

      const outPath = path.resolve(opts.save);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

      console.log("");
      console.log(chalk.green(`  Baseline saved to ${chalk.bold(opts.save)}`));
      console.log(chalk.gray(`  ${snapshot.functions.length} function${snapshot.functions.length !== 1 ? "s" : ""} captured at ${snapshot.createdAt}`));
      console.log("");
      return;
    }

    // Mode 2: Check against baseline
    if (opts.against) {
      const baselinePath = path.resolve(opts.against);
      if (!fs.existsSync(baselinePath)) {
        console.error(chalk.red(`\n  Baseline file not found: ${opts.against}\n`));
        process.exit(1);
      }

      let baseline: CheckSnapshot;
      try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      } catch {
        console.error(chalk.red(`\n  Invalid baseline file: ${opts.against}\n`));
        process.exit(1);
        return; // unreachable but satisfies TS
      }

      const current = await getSnapshot(opts.env);

      if (current.functions.length === 0) {
        console.error(chalk.yellow("\n  No functions observed yet. Run your app first to populate types.\n"));
        process.exit(1);
      }

      console.log("");
      console.log(chalk.white.bold("  trickle check"));
      console.log(chalk.gray(`  Baseline: ${opts.against} (${baseline.createdAt})`));
      console.log(chalk.gray(`  Current: ${current.functions.length} functions observed`));
      console.log(chalk.gray("  " + "─".repeat(50)));

      // Build lookup maps
      const baselineMap = new Map<string, SnapshotFunction>();
      for (const fn of baseline.functions) {
        baselineMap.set(fn.name, fn);
      }

      const currentMap = new Map<string, SnapshotFunction>();
      for (const fn of current.functions) {
        currentMap.set(fn.name, fn);
      }

      const allChanges: BreakingChange[] = [];
      const removedFunctions: string[] = [];
      const addedFunctions: string[] = [];

      // Check for removed functions
      for (const [name] of baselineMap) {
        if (!currentMap.has(name)) {
          removedFunctions.push(name);
          allChanges.push({
            functionName: name,
            severity: "breaking",
            description: "Function/route removed entirely",
            path: "(function)",
          });
        }
      }

      // Check for added functions
      for (const [name] of currentMap) {
        if (!baselineMap.has(name)) {
          addedFunctions.push(name);
          allChanges.push({
            functionName: name,
            severity: "non-breaking",
            description: "New function/route added",
            path: "(function)",
          });
        }
      }

      // Check for type changes in existing functions
      for (const [name, baselineFn] of baselineMap) {
        const currentFn = currentMap.get(name);
        if (!currentFn) continue;

        // Compare return types (response)
        const returnChanges = classifyChanges(
          baselineFn.returnType,
          currentFn.returnType,
          "response",
          "response",
        );
        for (const change of returnChanges) {
          change.functionName = name;
          allChanges.push(change);
        }

        // Compare args types (request)
        const argsChanges = classifyChanges(
          baselineFn.argsType,
          currentFn.argsType,
          "request",
          "request",
        );
        for (const change of argsChanges) {
          change.functionName = name;
          allChanges.push(change);
        }
      }

      // Separate breaking vs non-breaking
      const breaking = allChanges.filter((c) => c.severity === "breaking");
      const nonBreaking = allChanges.filter((c) => c.severity === "non-breaking");

      // Display results
      if (breaking.length === 0 && nonBreaking.length === 0) {
        console.log("");
        console.log(chalk.green("  No type changes detected. API is compatible with baseline."));
        console.log("");
        return;
      }

      if (breaking.length > 0) {
        console.log("");
        console.log(chalk.red.bold(`  ${breaking.length} BREAKING CHANGE${breaking.length !== 1 ? "S" : ""}`));
        console.log("");

        // Group by function
        const grouped = new Map<string, BreakingChange[]>();
        for (const change of breaking) {
          const list = grouped.get(change.functionName) || [];
          list.push(change);
          grouped.set(change.functionName, list);
        }

        for (const [fnName, changes] of grouped) {
          console.log(chalk.white(`  ${fnName}`));
          for (const change of changes) {
            console.log(
              chalk.red("    ✗ ") +
              chalk.gray(change.path) +
              chalk.red(` — ${change.description}`)
            );
          }
        }
      }

      if (nonBreaking.length > 0) {
        console.log("");
        console.log(chalk.yellow(`  ${nonBreaking.length} non-breaking change${nonBreaking.length !== 1 ? "s" : ""}`));
        console.log("");

        const grouped = new Map<string, BreakingChange[]>();
        for (const change of nonBreaking) {
          const list = grouped.get(change.functionName) || [];
          list.push(change);
          grouped.set(change.functionName, list);
        }

        for (const [fnName, changes] of grouped) {
          console.log(chalk.white(`  ${fnName}`));
          for (const change of changes) {
            console.log(
              chalk.green("    + ") +
              chalk.gray(change.path) +
              chalk.gray(` — ${change.description}`)
            );
          }
        }
      }

      console.log("");

      // Summary
      if (breaking.length > 0) {
        console.log(chalk.red.bold("  FAIL") + chalk.red(` — ${breaking.length} breaking change${breaking.length !== 1 ? "s" : ""} detected`));
        console.log("");
        process.exit(1);
      } else {
        console.log(chalk.green.bold("  PASS") + chalk.green(` — ${nonBreaking.length} non-breaking change${nonBreaking.length !== 1 ? "s" : ""}, no breaking changes`));
        console.log("");
      }

      return;
    }

    // No flags — show usage
    console.log("");
    console.log(chalk.white.bold("  trickle check") + chalk.gray(" — detect breaking API changes"));
    console.log("");
    console.log(chalk.white("  Save a baseline:"));
    console.log(chalk.cyan("    trickle check --save baseline.json"));
    console.log("");
    console.log(chalk.white("  Check against baseline:"));
    console.log(chalk.cyan("    trickle check --against baseline.json"));
    console.log("");
    console.log(chalk.gray("  Exit code 0 = compatible, exit code 1 = breaking changes"));
    console.log("");

  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
    process.exit(1);
  }
}
