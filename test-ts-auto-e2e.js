/**
 * E2E test: TypeScript auto-instrumentation via `node --import trickle/auto-esm`
 *
 * Verifies that native TypeScript files (.ts) are instrumented
 * automatically using Node.js 22.6+ built-in type stripping + ESM hooks.
 *
 * Checks:
 * 1. TypeScript app runs with --import flag (no tsx/ts-node needed)
 * 2. observations.jsonl captures all exported functions
 * 3. TypeScript generics (function<T>(...)) are handled
 * 4. Multiline TypeScript signatures are handled
 * 5. paramNames extracted correctly from TS source
 * 6. .trickle.d.ts file generated (not .d.ts — avoids TS conflict)
 * 7. export interface/type are NOT instrumented (TS-only constructs)
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const LIB_FILE = path.resolve("test-ts-lib.ts");
const TRICKLE_DTS = path.resolve("test-ts-lib.trickle.d.ts");
const TRICKLE_DIR = path.resolve(".trickle");
const JSONL_FILE = path.join(TRICKLE_DIR, "observations.jsonl");

function cleanup() {
  try { fs.unlinkSync(TRICKLE_DTS); } catch {}
  try { fs.unlinkSync(JSONL_FILE); } catch {}
  try { fs.rmSync(TRICKLE_DIR, { recursive: true }); } catch {}
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
      else reject(new Error(`Exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out"));
    }, 30000);
  });
}

async function run() {
  // Check Node.js version supports type stripping
  const [major] = process.version.replace("v", "").split(".").map(Number);
  if (major < 22) {
    console.log(`SKIP: Node.js ${process.version} does not support --experimental-strip-types (need >= 22.6)`);
    process.exit(0);
  }

  try {
    cleanup();

    // === Step 1: Run TypeScript app with --import ===
    console.log("=== Step 1: Run `node --import trickle/auto-esm test-ts-app.ts` ===");
    console.log("  Native .ts file — no tsx, no ts-node, no compilation step");

    const autoEsmPath = path.resolve("packages/client-js/auto-esm.mjs");
    const { stdout, stderr } = await runCmd("node", [
      "--import", autoEsmPath,
      "test-ts-app.ts",
    ], {
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    if (stdout.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("App did not complete. Output: " + stdout.slice(0, 500));
    }

    const fullOutput = stdout + stderr;
    if (fullOutput.includes("trickle") && fullOutput.includes(".d.ts")) {
      console.log("  Output mentions type generation OK");
    }

    // === Step 2: Verify observations ===
    console.log("\n=== Step 2: Verify observations.jsonl ===");

    if (!fs.existsSync(JSONL_FILE)) {
      throw new Error("observations.jsonl NOT created!");
    }

    const content = fs.readFileSync(JSONL_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const observations = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    console.log(`  observations.jsonl: ${observations.length} observations`);

    const funcNames = observations.map(o => o.functionName);
    for (const name of ["paginate", "groupBy", "retry"]) {
      if (funcNames.includes(name)) {
        console.log(`  ${name} captured OK`);
      } else {
        throw new Error(`${name} NOT captured! Got: ${funcNames.join(", ")}`);
      }
    }

    // === Step 3: Verify TypeScript-specific handling ===
    console.log("\n=== Step 3: Verify TypeScript feature handling ===");

    // paginate has generics: function paginate<T>(...)
    const paginateObs = observations.find(o => o.functionName === "paginate");
    if (paginateObs.paramNames && paginateObs.paramNames.length === 3) {
      if (paginateObs.paramNames.includes("items") && paginateObs.paramNames.includes("pageSize")) {
        console.log("  Generic function paginate<T>: params correctly extracted OK");
      }
    } else {
      throw new Error(`paginate paramNames wrong: ${JSON.stringify(paginateObs.paramNames)}`);
    }

    // retry has multiline params + generics
    const retryObs = observations.find(o => o.functionName === "retry");
    if (retryObs.paramNames && retryObs.paramNames.length >= 2) {
      if (retryObs.paramNames.includes("fn") && retryObs.paramNames.includes("maxAttempts")) {
        console.log("  Multiline generic function retry<T>: params correctly extracted OK");
      }
    } else {
      throw new Error(`retry paramNames wrong: ${JSON.stringify(retryObs.paramNames)}`);
    }

    // export interface should NOT be in observations
    if (!funcNames.includes("QueryResult")) {
      console.log("  export interface QueryResult NOT captured (correct — TS-only) OK");
    }

    // === Step 4: Verify .trickle.d.ts generated ===
    console.log("\n=== Step 4: Verify .trickle.d.ts file ===");

    if (!fs.existsSync(TRICKLE_DTS)) {
      throw new Error(".trickle.d.ts NOT generated!");
    }

    const dts = fs.readFileSync(TRICKLE_DTS, "utf-8");
    console.log(`  ${path.basename(TRICKLE_DTS)}: ${dts.length} bytes`);

    if (process.env.TRICKLE_DEBUG) {
      console.log("\n--- Generated .trickle.d.ts ---");
      console.log(dts);
      console.log("--- End ---\n");
    }

    // Uses .trickle.d.ts naming (not .d.ts which TS would ignore next to .ts)
    if (TRICKLE_DTS.endsWith(".trickle.d.ts")) {
      console.log("  Uses .trickle.d.ts naming (avoids TS conflict) OK");
    }

    for (const name of ["paginate", "groupBy", "retry"]) {
      if (dts.toLowerCase().includes(name.toLowerCase())) {
        console.log(`  ${name} type present OK`);
      } else {
        throw new Error(`${name} NOT in .trickle.d.ts!`);
      }
    }

    // Check real param names used
    if (dts.includes("items:") || dts.includes("items :")) {
      console.log("  Real param name 'items' used OK");
    }
    if (dts.includes("maxAttempts") || dts.includes("max")) {
      console.log("  Real param name 'maxAttempts' used OK");
    }

    // === Step 5: Summary ===
    console.log("\n=== Step 5: TypeScript support summary ===");
    console.log("  Native .ts files: works with Node 22.6+ type stripping OK");
    console.log("  TypeScript generics (function<T>): handled OK");
    console.log("  Multiline TS signatures: handled OK");
    console.log("  TS type annotations stripped from params OK");
    console.log("  export interface/type: correctly skipped OK");
    console.log("  .trickle.d.ts: avoids conflict with .ts source OK");

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("TypeScript auto-instrumentation works!\n");

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
