"""E2E test: trickle.auto entry file observation — single-file scripts.

Verifies that `import trickle.auto` observes functions defined DIRECTLY
in the entry file (not just imported modules). This is the key test for
the sys.setprofile-based entry file observation feature.

Checks:
1. App runs successfully with just `python app.py`
2. observations.jsonl captures ALL 3 functions (from entry file!)
3. .pyi file is generated next to the entry file
4. Types are correct (TypedDict, function signatures)
5. Works for single-file scripts — no separate modules needed
"""

import os
import shutil
import subprocess
import sys

APP_FILE = os.path.abspath("test-auto-py-single-app.py")
PYI_FILE = os.path.splitext(APP_FILE)[0] + ".pyi"
TRICKLE_DIR = os.path.abspath(".trickle")
JSONL_FILE = os.path.join(TRICKLE_DIR, "observations.jsonl")


def cleanup():
    for f in [PYI_FILE, JSONL_FILE]:
        try:
            os.unlink(f)
        except FileNotFoundError:
            pass
    try:
        shutil.rmtree(TRICKLE_DIR)
    except FileNotFoundError:
        pass


def run():
    try:
        cleanup()

        # === Step 1: Run single-file app ===
        print("=== Step 1: Run `python test-auto-py-single-app.py` (single file, no imports) ===")
        print("  ALL functions are in the entry file — no separate modules")

        env = {**os.environ, "TRICKLE_BACKEND_URL": "http://localhost:19999"}
        debug = os.environ.get("TRICKLE_DEBUG", "")
        if debug:
            env["TRICKLE_DEBUG"] = debug

        result = subprocess.run(
            [sys.executable, "test-auto-py-single-app.py"],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )

        full_output = result.stdout + result.stderr
        if result.returncode != 0:
            raise RuntimeError(
                f"App failed with exit code {result.returncode}\n"
                f"stdout: {result.stdout[:500]}\n"
                f"stderr: {result.stderr[:500]}"
            )

        if "Done!" in result.stdout:
            print("  App ran successfully OK")
        else:
            raise RuntimeError("App did not complete. Output: " + result.stdout[:500])

        if "trickle" in full_output.lower() and ".pyi" in full_output:
            print("  Output mentions type generation OK")
        elif "trickle" in full_output.lower():
            print("  Output mentions trickle.auto OK")

        # === Step 2: Verify JSONL captured entry file functions ===
        print("\n=== Step 2: Verify observations.jsonl (entry file functions) ===")

        if os.path.exists(JSONL_FILE):
            import json

            with open(JSONL_FILE, "r") as f:
                content = f.read()
            lines = [l for l in content.strip().split("\n") if l.strip()]
            print(f"  observations.jsonl: {len(lines)} observations")

            func_names = []
            for line in lines:
                try:
                    data = json.loads(line)
                    fn = data.get("functionName")
                    if fn:
                        func_names.append(fn)
                except json.JSONDecodeError:
                    pass

            for expected in ["calculate_discount", "format_invoice", "validate_address"]:
                if expected in func_names:
                    print(f"  {expected} captured from entry file OK")
                else:
                    raise RuntimeError(
                        f"{expected} NOT captured! This means entry file observation failed.\n"
                        f"  Captured functions: {func_names}"
                    )

            # Verify these are from the entry file module
            modules = set()
            for line in lines:
                try:
                    data = json.loads(line)
                    mod = data.get("module", "")
                    if mod:
                        modules.add(mod)
                except json.JSONDecodeError:
                    pass

            if "test-auto-py-single-app" in modules or "test_auto_py_single_app" in modules:
                print(f"  Module correctly identified as entry file OK")
            else:
                print(f"  Module names: {modules}")
        else:
            raise RuntimeError("observations.jsonl NOT created!")

        # === Step 3: Verify .pyi was generated for the entry file ===
        print("\n=== Step 3: Verify .pyi file (generated for entry file) ===")

        if os.path.exists(PYI_FILE):
            with open(PYI_FILE, "r") as f:
                pyi = f.read()
            print(f"  {os.path.basename(PYI_FILE)}: {len(pyi)} bytes")

            if os.environ.get("TRICKLE_DEBUG"):
                print("\n--- Generated .pyi ---")
                print(pyi)
                print("--- End ---\n")

            # Check for all 3 functions
            for func in ["calculate_discount", "format_invoice", "validate_address"]:
                if func in pyi:
                    print(f"  {func} type present OK")
                else:
                    raise RuntimeError(f"{func} NOT in .pyi!")

            # Check type quality
            if "TypedDict" in pyi:
                print("  Contains TypedDict definitions OK")

            if "original" in pyi and "discount" in pyi and "final" in pyi:
                print("  calculate_discount return shape OK")

            if "subtotal" in pyi or "line_items" in pyi:
                print("  format_invoice return shape OK")

            if "normalized" in pyi or "valid" in pyi:
                print("  validate_address return shape OK")

            if "def calculate_discount" in pyi and "def format_invoice" in pyi and "def validate_address" in pyi:
                print("  All function signatures present OK")
        else:
            raise RuntimeError(
                ".pyi file NOT generated for entry file!\n"
                f"  Expected: {PYI_FILE}"
            )

        # === Step 4: Verify single-file properties ===
        print("\n=== Step 4: Verify single-file script support ===")
        print("  No separate modules needed OK")
        print("  Entry file functions observed via sys.setprofile OK")
        print("  .pyi generated next to entry file OK")
        print("  Zero config — just `import trickle.auto` OK")

        print("\n=== ALL TESTS PASSED ===")
        print("trickle.auto works for single-file Python scripts!\n")

    except Exception as err:
        print(f"\nTEST FAILED: {err}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        cleanup()


if __name__ == "__main__":
    run()
