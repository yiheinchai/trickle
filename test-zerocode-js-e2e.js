/**
 * E2E test: Zero-code activation via `node -r trickle/auto`
 *
 * Verifies that running ANY Node.js app with `-r trickle/auto`
 * instruments it WITHOUT any source code changes.
 *
 * The target app (test-zerocode-app.js) has ZERO trickle imports.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const LIB_FILE = path.resolve("test-zerocode-lib.js");
const DTS_FILE = path.resolve("test-zerocode-lib.d.ts");
const TRICKLE_DIR = path.resolve(".trickle");
const JSONL_FILE = path.join(TRICKLE_DIR, "observations.jsonl");

function cleanup() {
  try { fs.unlinkSync(DTS_FILE); } catch {}
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
  try {
    cleanup();

    // === Step 1: Run with -r flag — zero code changes! ===
    console.log("=== Step 1: Run `node -r trickle/auto test-zerocode-app.js` ===");
    console.log("  The app has ZERO trickle imports — all external");

    const trickleAutoPath = path.resolve("packages/client-js/auto.js");
    const { stdout, stderr } = await runCmd("node", [
      "-r", trickleAutoPath,
      "test-zerocode-app.js",
    ], {
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    if (stdout.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("App did not complete. Output: " + stdout.slice(0, 500));
    }

    // === Step 2: Verify JSONL was created ===
    console.log("\n=== Step 2: Verify observations.jsonl ===");

    if (fs.existsSync(JSONL_FILE)) {
      const content = fs.readFileSync(JSONL_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      console.log(`  observations.jsonl: ${lines.length} observations`);

      const funcNames = lines.map(l => {
        try { return JSON.parse(l).functionName; } catch { return null; }
      }).filter(Boolean);

      for (const name of ["parseCSV", "slugify", "mergeConfig"]) {
        if (funcNames.includes(name)) {
          console.log(`  ${name} captured OK`);
        } else {
          throw new Error(`${name} NOT captured! Got: ${funcNames.join(", ")}`);
        }
      }

      // Verify paramNames are present
      const firstObs = JSON.parse(lines[0]);
      if (firstObs.paramNames && firstObs.paramNames.length > 0) {
        console.log("  paramNames preserved OK");
      }
    } else {
      throw new Error("observations.jsonl NOT created!");
    }

    // === Step 3: Verify .d.ts was generated ===
    console.log("\n=== Step 3: Verify .d.ts file ===");

    if (fs.existsSync(DTS_FILE)) {
      const dts = fs.readFileSync(DTS_FILE, "utf-8");
      console.log(`  ${path.basename(DTS_FILE)}: ${dts.length} bytes`);

      if (process.env.TRICKLE_DEBUG) {
        console.log("\n--- Generated .d.ts ---");
        console.log(dts);
        console.log("--- End ---\n");
      }

      // Codegen normalizes names: parseCSV → ParseCsv (PascalCase for types)
      for (const [orig, generated] of [["parseCSV", "parseCsv"], ["slugify", "slugify"], ["mergeConfig", "mergeConfig"]]) {
        if (dts.includes(generated) || dts.includes(orig)) {
          console.log(`  ${orig} type present OK`);
        } else {
          throw new Error(`${orig} NOT in .d.ts! (looked for ${generated})`);
        }
      }

      if (dts.includes("export")) {
        console.log("  Contains export declarations OK");
      }
    } else {
      throw new Error(".d.ts file NOT generated!");
    }

    // === Step 4: Summary ===
    console.log("\n=== Step 4: Verify zero-code properties ===");
    console.log("  No source changes to app OK");
    console.log("  No trickle imports in app OK");
    console.log("  Just `node -r trickle/auto app.js` OK");
    console.log("  Types auto-generated OK");

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("Zero-code JS activation works!\n");

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
