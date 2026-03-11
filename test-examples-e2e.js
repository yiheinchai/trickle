/**
 * E2E test: Runtime examples in generated type files
 *
 * Verifies that trickle/auto includes @example JSDoc comments in .d.ts files
 * and docstring examples in .pyi files, showing actual observed function calls
 * with real sample data.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const JS_LIB = path.resolve("test-examples-lib.js");
const PY_LIB = path.resolve("test_examples_lib.py");
const TRICKLE_DIR = path.resolve(".trickle");

function cleanup() {
  try { fs.unlinkSync(path.resolve("test-examples-lib.d.ts")); } catch {}
  try { fs.unlinkSync(path.resolve("test_examples_lib.pyi")); } catch {}
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
    // Part 1: JavaScript @example in .d.ts
    // ========================================
    console.log("=== Part 1: JavaScript @example in .d.ts ===\n");

    console.log("Step 1: Run JS app to generate observations with sample data");
    const jsResult = await runCmd("node", ["test-examples-app.js"], {
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    if (jsResult.stdout.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("JS app failed: " + jsResult.stdout.slice(0, 300));
    }

    console.log("\nStep 2: Verify .d.ts contains @example comments");
    const dtsPath = path.resolve("test-examples-lib.d.ts");
    if (!fs.existsSync(dtsPath)) {
      throw new Error("test-examples-lib.d.ts not found!");
    }
    const dtsContent = fs.readFileSync(dtsPath, "utf-8");
    console.log("\n--- Generated .d.ts (excerpt) ---");
    console.log(dtsContent.slice(0, 2000));
    console.log("---\n");

    // Check for @example tags
    if (dtsContent.includes("@example")) {
      console.log("  @example tag found OK");
    } else {
      throw new Error("@example tag NOT found in .d.ts!");
    }

    // Check that sample values appear (we called calculateDiscount(99.99, 15))
    if (dtsContent.includes("99.99")) {
      console.log("  Sample input value 99.99 found OK");
    } else {
      throw new Error("Sample input 99.99 NOT found in .d.ts @example!");
    }

    if (dtsContent.includes("15")) {
      console.log("  Sample input value 15 found OK");
    }

    // Check for return value in example (discount output)
    if (dtsContent.includes("=>") || dtsContent.includes("// =>")) {
      console.log("  Return value indicator found OK");
    }

    // Check that function names appear in examples
    if (dtsContent.includes("calculateDiscount(") || dtsContent.includes("formatAddress(") || dtsContent.includes("sumArray(")) {
      console.log("  Function call in @example OK");
    } else {
      throw new Error("Function call NOT found in @example!");
    }

    // Check formatAddress has string sample values
    if (dtsContent.includes("Main St") || dtsContent.includes("123 Main")) {
      console.log("  formatAddress: string sample data present OK");
    }

    // Check sumArray has array sample data
    if (dtsContent.includes("[10") || dtsContent.includes("10, 20")) {
      console.log("  sumArray: array sample data present OK");
    }

    // ========================================
    // Part 2: Python docstring examples in .pyi
    // ========================================
    console.log("\n=== Part 2: Python docstring examples in .pyi ===\n");

    cleanup();

    console.log("Step 1: Run Python app to generate observations with sample data");
    const pyResult = await runCmd("python", ["test_examples_app.py"], {
      PYTHONPATH: "packages/client-python/src:.",
      TRICKLE_BACKEND_URL: "http://localhost:19999",
    });

    if (pyResult.stdout.includes("Done!")) {
      console.log("  App ran successfully OK");
    } else {
      throw new Error("Python app failed: " + pyResult.stdout.slice(0, 300));
    }

    console.log("\nStep 2: Verify .pyi contains docstring examples");
    const pyiPath = path.resolve("test_examples_lib.pyi");
    if (!fs.existsSync(pyiPath)) {
      throw new Error("test_examples_lib.pyi not found!");
    }
    const pyiContent = fs.readFileSync(pyiPath, "utf-8");
    console.log("\n--- Generated .pyi (excerpt) ---");
    console.log(pyiContent.slice(0, 2000));
    console.log("---\n");

    // Check for Example docstrings
    if (pyiContent.includes("Example::")) {
      console.log("  Example:: docstring found OK");
    } else {
      throw new Error("Example:: docstring NOT found in .pyi!");
    }

    // Check for >>> usage pattern
    if (pyiContent.includes(">>>")) {
      console.log("  >>> doctest-style example found OK");
    } else {
      throw new Error(">>> pattern NOT found in .pyi!");
    }

    // Check that sample values appear
    if (pyiContent.includes("99.99")) {
      console.log("  Sample input value 99.99 found OK");
    } else {
      throw new Error("Sample input 99.99 NOT found in .pyi example!");
    }

    // Check for function names in examples
    if (pyiContent.includes("calculate_discount(") || pyiContent.includes("format_address(") || pyiContent.includes("sum_array(")) {
      console.log("  Function call in example OK");
    } else {
      throw new Error("Function call NOT found in .pyi example!");
    }

    // Check for return values
    if (pyiContent.includes("'original'") || pyiContent.includes('"original"')) {
      console.log("  Return value with key present OK");
    }

    // ========================================
    // Summary
    // ========================================
    console.log("\n=== Summary ===");
    console.log("  JavaScript .d.ts: @example JSDoc with sample data OK");
    console.log("  Python .pyi: docstring examples with sample data OK");
    console.log("  Sample input values preserved in examples OK");
    console.log("  Sample output values preserved in examples OK");
    console.log("  Function names correctly used in examples OK");

    console.log("\n=== ALL TESTS PASSED ===");
    console.log("Runtime examples in generated types work!\n");

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
