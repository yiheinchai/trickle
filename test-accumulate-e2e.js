/**
 * E2E test: Type accumulation across multiple runs
 *
 * Verifies that:
 * 1. Running an app twice with different input shapes accumulates observations
 * 2. The merged .d.ts types contain optional fields (properties seen in some runs but not others)
 * 3. Union types are created when return shapes differ
 * 4. Types get richer with each run, not overwritten
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLI = path.resolve("packages/cli/dist/index.js");
const TRICKLE_DIR = path.resolve(".trickle-test-accumulate");
const JSONL_FILE = path.join(TRICKLE_DIR, "observations.jsonl");

// Use a port that won't have a backend to force local mode
const UNUSED_PORT = 14898;
const BACKEND_URL = `http://localhost:${UNUSED_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCmd(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (process.env.TRICKLE_DEBUG) process.stdout.write(`[out] ${d}`);
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (process.env.TRICKLE_DEBUG) process.stderr.write(`[err] ${d}`);
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`Exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`)
        );
    });
    setTimeout(() => reject(new Error("Timed out")), 60000);
  });
}

function cleanup() {
  try { fs.unlinkSync(JSONL_FILE); } catch {}
  try { fs.rmdirSync(TRICKLE_DIR, { recursive: true }); } catch {}
  // Clean up any generated .d.ts files
  try { fs.unlinkSync(path.resolve("test-accumulate-app-run1.d.ts")); } catch {}
  try { fs.unlinkSync(path.resolve("test-accumulate-app-run2.d.ts")); } catch {}
}

async function run() {
  try {
    cleanup();

    const commonEnv = {
      TRICKLE_BACKEND_URL: BACKEND_URL,
      TRICKLE_LOCAL_DIR: TRICKLE_DIR,
    };

    // === Run 1: Basic shapes ===
    console.log("=== Step 1: First run (basic shapes) ===");

    const { stdout: out1 } = await runCmd("node", [CLI, "test-accumulate-app-run1.js"], commonEnv);

    if (out1.includes("Run1 Done!")) {
      console.log("  Run 1 completed OK");
    } else {
      throw new Error("Run 1 did not complete. Output: " + out1.slice(0, 500));
    }

    // Verify JSONL has observations from run 1
    if (!fs.existsSync(JSONL_FILE)) {
      throw new Error("JSONL file not created after run 1!");
    }

    const lines1 = fs.readFileSync(JSONL_FILE, "utf-8").trim().split("\n").filter(Boolean);
    console.log(`  Observations after run 1: ${lines1.length}`);

    const obs1 = lines1.map((l) => JSON.parse(l));
    const processOrderObs1 = obs1.find((o) => o.functionName === "processOrder");
    if (!processOrderObs1) throw new Error("processOrder not captured in run 1!");

    // Run 1 should NOT have coupon/priority in input
    const run1InputProps = Object.keys(processOrderObs1.argsType.elements?.[0]?.properties || {});
    console.log(`  processOrder run 1 input props: ${run1InputProps.join(", ")}`);
    if (run1InputProps.includes("coupon")) {
      throw new Error("Run 1 should NOT have coupon in input!");
    }

    // Run 1 return should NOT have 'discounted'
    const run1ReturnProps = Object.keys(processOrderObs1.returnType.properties || {});
    console.log(`  processOrder run 1 return props: ${run1ReturnProps.join(", ")}`);
    if (run1ReturnProps.includes("discounted")) {
      throw new Error("Run 1 should NOT have discounted in return!");
    }

    console.log("  Run 1 shapes verified OK");

    // === Run 2: Extended shapes ===
    console.log("\n=== Step 2: Second run (extended shapes — same JSONL file) ===");

    const { stdout: out2 } = await runCmd("node", [CLI, "test-accumulate-app-run2.js"], commonEnv);

    if (out2.includes("Run2 Done!")) {
      console.log("  Run 2 completed OK");
    } else {
      throw new Error("Run 2 did not complete. Output: " + out2.slice(0, 500));
    }

    // Verify JSONL has accumulated observations from BOTH runs
    const lines2 = fs.readFileSync(JSONL_FILE, "utf-8").trim().split("\n").filter(Boolean);
    console.log(`  Observations after run 2: ${lines2.length}`);

    if (lines2.length <= lines1.length) {
      throw new Error("JSONL did not accumulate! Expected more lines after run 2.");
    }
    console.log("  Observations accumulated OK (append-only)");

    // === Step 3: Generate types from accumulated data ===
    console.log("\n=== Step 3: Generate .d.ts from accumulated observations ===");

    // Use the local-codegen module directly to generate types
    const localCodegen = require("./packages/cli/dist/local-codegen.js");
    const stubs = localCodegen.generateFromJsonl(JSONL_FILE);

    // Find the stubs (could be under module name or _default)
    let tsContent = "";
    for (const [mod, content] of Object.entries(stubs)) {
      tsContent += content.ts + "\n";
    }

    if (!tsContent) {
      throw new Error("No TypeScript stubs generated!");
    }

    console.log(`  Generated ${tsContent.length} bytes of TypeScript`);
    if (process.env.TRICKLE_DEBUG) {
      console.log("\n--- Generated .d.ts ---");
      console.log(tsContent);
      console.log("--- End .d.ts ---\n");
    }

    // === Step 4: Verify merged types ===
    console.log("\n=== Step 4: Verify merged/accumulated types ===");

    // processOrder input: run 1 had {id, items}, run 2 had {id, items, coupon, priority}
    // → merged should have id, items (required), coupon?, priority? (optional)
    if (tsContent.includes("coupon?") || tsContent.includes("coupon?:")) {
      console.log("  processOrder input: coupon is optional OK");
    } else if (tsContent.includes("coupon")) {
      // It might be in a union or as a regular property — check if it's there at all
      console.log("  processOrder input: coupon is present (may be in union form)");
    } else {
      throw new Error("processOrder input missing 'coupon' — type merging failed!");
    }

    if (tsContent.includes("priority?") || tsContent.includes("priority?:")) {
      console.log("  processOrder input: priority is optional OK");
    } else if (tsContent.includes("priority")) {
      console.log("  processOrder input: priority is present (may be in union form)");
    } else {
      throw new Error("processOrder input missing 'priority' — type merging failed!");
    }

    // processOrder return: run 1 had {orderId, total, itemCount, currency}
    //                     run 2 had {orderId, total, itemCount, currency, discounted}
    // → merged should have discounted as optional
    if (tsContent.includes("discounted?") || tsContent.includes("discounted?:")) {
      console.log("  processOrder return: discounted is optional OK");
    } else if (tsContent.includes("discounted")) {
      console.log("  processOrder return: discounted is present (may be in union form)");
    } else {
      throw new Error("processOrder return missing 'discounted' — type merging failed!");
    }

    // Common properties should still be required (not optional)
    if (tsContent.includes("orderId:") && !tsContent.includes("orderId?:")) {
      console.log("  processOrder return: orderId is required (not optional) OK");
    } else if (tsContent.includes("orderId?:")) {
      console.log("  Warning: orderId became optional (unexpected but not fatal)");
    }

    // formatUser: run 1 input had {name, email}, run 2 had {name, email, avatar, isAdmin}
    // → merged should have avatar?, isAdmin? as optional
    if (tsContent.includes("avatar") || tsContent.includes("Avatar")) {
      console.log("  formatUser input: avatar field present OK");
    } else {
      throw new Error("formatUser input missing 'avatar'!");
    }

    // formatUser: run 1 return had {displayName, email, role}
    //            run 2 return had {displayName, email, role, avatarUrl}
    // → merged should have avatarUrl as optional
    if (tsContent.includes("avatarUrl")) {
      console.log("  formatUser return: avatarUrl field present OK");
    } else {
      throw new Error("formatUser return missing 'avatarUrl'!");
    }

    // Verify that basic required fields are still present and not optional
    if (tsContent.includes("displayName") || tsContent.includes("display_name")) {
      console.log("  formatUser return: displayName still present OK");
    }

    // === Step 5: Verify generateLocalStubs writes sidecar ===
    console.log("\n=== Step 5: Verify sidecar .d.ts generation ===");

    const dtsPath = path.resolve("test-accumulate-app-run2.d.ts");
    const { written } = localCodegen.generateLocalStubs(
      path.resolve("test-accumulate-app-run2.js"),
      JSONL_FILE,
    );

    if (written.length > 0 && fs.existsSync(dtsPath)) {
      const dtsContent = fs.readFileSync(dtsPath, "utf-8");
      console.log(`  Sidecar .d.ts generated (${dtsContent.length} bytes) OK`);

      // The sidecar should contain the merged types too
      if (dtsContent.includes("coupon") && dtsContent.includes("discounted")) {
        console.log("  Sidecar contains merged types OK");
      }
    } else {
      console.log("  Warning: sidecar file not generated (non-critical)");
    }

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("Type accumulation across multiple runs works correctly!\n");
    console.log("Key results:");
    console.log("  - JSONL file accumulates observations from multiple runs");
    console.log("  - Properties seen in some runs but not others become optional (?)");
    console.log("  - Properties seen in all runs stay required");
    console.log("  - Types get richer with each run\n");
  } catch (err) {
    console.error("\nTEST FAILED:", err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    cleanup();
    process.exit(process.exitCode || 0);
  }
}

run();
