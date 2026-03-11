/**
 * E2E test: Type coverage report (TRICKLE_COVERAGE=1)
 *
 * Verifies that trickle/auto generates a coverage report showing:
 * - Which functions were typed vs untyped per file
 * - Percentage coverage per file and total
 * - Names of untyped functions
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const TRICKLE_DIR = path.resolve(".trickle");

function cleanup() {
  try { fs.unlinkSync(path.resolve("test-coverage-lib.d.ts")); } catch {}
  try { fs.unlinkSync(path.resolve("test_coverage_lib.pyi")); } catch {}
  try { fs.rmSync(TRICKLE_DIR, { recursive: true }); } catch {}
}

function runCmd(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    setTimeout(() => { proc.kill(); reject(new Error("Timeout")); }, 30000);
  });
}

async function run() {
  cleanup();

  try {
    // ========================================
    // Part 1: JavaScript coverage report
    // ========================================
    console.log("=== Part 1: JavaScript coverage report ===\n");

    console.log("Step 1: Run JS app with TRICKLE_COVERAGE=1");
    const jsResult = await runCmd("node", ["test-coverage-app.js"], {
      TRICKLE_COVERAGE: "1",
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    const jsOutput = jsResult.stdout + jsResult.stderr;
    console.log("\n--- JS Output ---");
    console.log(jsOutput);
    console.log("---\n");

    if (jsOutput.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("JS app failed");
    }

    // Verify coverage report appears
    if (jsOutput.includes("Type coverage:")) {
      console.log("  Coverage report header found OK");
    } else {
      throw new Error("Coverage report header NOT found!");
    }

    // Verify it shows the file
    if (jsOutput.includes("test-coverage-lib.js")) {
      console.log("  File name in coverage report OK");
    } else {
      throw new Error("File name NOT found in coverage report!");
    }

    // Verify it shows 3/5 (60%) — only 3 of 5 functions were called
    if (jsOutput.includes("3/5") || jsOutput.includes("60%")) {
      console.log("  Correct 3/5 or 60% coverage shown OK");
    } else {
      throw new Error("Expected 3/5 or 60% coverage NOT found!");
    }

    // Verify untyped functions are listed
    if (jsOutput.includes("divide") && jsOutput.includes("modulo")) {
      console.log("  Untyped functions (divide, modulo) listed OK");
    } else {
      throw new Error("Untyped functions NOT listed in report!");
    }

    // Verify "Untyped:" label
    if (jsOutput.includes("Untyped:")) {
      console.log("  'Untyped:' label present OK");
    }

    // ========================================
    // Part 2: Python coverage report
    // ========================================
    console.log("\n=== Part 2: Python coverage report ===\n");

    cleanup();

    console.log("Step 1: Run Python app with TRICKLE_COVERAGE=1");
    const pyResult = await runCmd("python", ["test_coverage_app.py"], {
      TRICKLE_COVERAGE: "1",
      PYTHONPATH: "packages/client-python/src:.",
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    const pyOutput = pyResult.stdout + pyResult.stderr;
    console.log("\n--- Python Output ---");
    console.log(pyOutput);
    console.log("---\n");

    if (pyOutput.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("Python app failed");
    }

    // Verify coverage report appears
    if (pyOutput.includes("Type coverage:")) {
      console.log("  Coverage report header found OK");
    } else {
      throw new Error("Coverage report header NOT found!");
    }

    // Verify file name
    if (pyOutput.includes("test_coverage_lib.py")) {
      console.log("  File name in coverage report OK");
    } else {
      throw new Error("File name NOT found in coverage report!");
    }

    // Verify 3/5 or 60%
    if (pyOutput.includes("3/5") || pyOutput.includes("60%")) {
      console.log("  Correct 3/5 or 60% coverage shown OK");
    } else {
      throw new Error("Expected 3/5 or 60% coverage NOT found!");
    }

    // Verify untyped functions listed
    if (pyOutput.includes("divide") && pyOutput.includes("modulo")) {
      console.log("  Untyped functions (divide, modulo) listed OK");
    } else {
      throw new Error("Untyped functions NOT listed in report!");
    }

    // ========================================
    // Part 3: No report when TRICKLE_COVERAGE is not set
    // ========================================
    console.log("\n=== Part 3: No report without TRICKLE_COVERAGE=1 ===\n");

    cleanup();

    console.log("Step 1: Run JS app WITHOUT TRICKLE_COVERAGE");
    const jsQuiet = await runCmd("node", ["test-coverage-app.js"], {
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    const jsQuietOutput = jsQuiet.stdout + jsQuiet.stderr;
    if (!jsQuietOutput.includes("Type coverage:")) {
      console.log("  No coverage report when flag is off OK");
    } else {
      throw new Error("Coverage report appeared WITHOUT TRICKLE_COVERAGE=1!");
    }

    // ========================================
    // Summary
    // ========================================
    console.log("\n=== Summary ===");
    console.log("  JavaScript: coverage report shows typed/untyped functions OK");
    console.log("  Python: coverage report shows typed/untyped functions OK");
    console.log("  Reports correctly identify untyped functions (divide, modulo) OK");
    console.log("  No report when TRICKLE_COVERAGE is not set OK");

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("Type coverage report works!\n");

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
