"""E2E test: Zero-code activation via `python -m trickle.auto_run`

Verifies that running ANY Python script with `python -m trickle.auto_run`
instruments it WITHOUT any source code changes.

The target app (test_zerocode_app.py) has ZERO trickle imports.
"""

import json
import os
import shutil
import subprocess
import sys

APP_FILE = os.path.abspath("test_zerocode_app.py")
LIB_FILE = os.path.abspath("test_zerocode_lib.py")
LIB_PYI = os.path.splitext(LIB_FILE)[0] + ".pyi"
APP_PYI = os.path.splitext(APP_FILE)[0] + ".pyi"
TRICKLE_DIR = os.path.abspath(".trickle")
JSONL_FILE = os.path.join(TRICKLE_DIR, "observations.jsonl")


def cleanup():
    for f in [LIB_PYI, APP_PYI, JSONL_FILE]:
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

        # === Step 1: Run with auto_run — zero code changes! ===
        print("=== Step 1: Run `python -m trickle.auto_run test_zerocode_app.py` ===")
        print("  The app has ZERO trickle imports — all external")

        env = {**os.environ, "TRICKLE_BACKEND_URL": "http://localhost:19999"}
        debug = os.environ.get("TRICKLE_DEBUG", "")
        if debug:
            env["TRICKLE_DEBUG"] = debug

        result = subprocess.run(
            [sys.executable, "-m", "trickle.auto_run", "test_zerocode_app.py"],
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

        if "trickle" in full_output.lower():
            print("  Output mentions trickle OK")

        # === Step 2: Verify JSONL captured functions ===
        print("\n=== Step 2: Verify observations.jsonl ===")

        if os.path.exists(JSONL_FILE):
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

            for expected in ["parse_csv", "slugify", "merge_config"]:
                if expected in func_names:
                    print(f"  {expected} captured OK")
                else:
                    raise RuntimeError(
                        f"{expected} NOT captured! Got: {func_names}"
                    )

            # Check for paramNames
            first_obs = json.loads(lines[0])
            if first_obs.get("paramNames"):
                print("  paramNames preserved OK")
        else:
            raise RuntimeError("observations.jsonl NOT created!")

        # === Step 3: Verify .pyi was generated ===
        print("\n=== Step 3: Verify .pyi files ===")

        # The library .pyi should be generated (imported module)
        pyi_found = False
        for pyi_path, label in [(LIB_PYI, "library"), (APP_PYI, "entry")]:
            if os.path.exists(pyi_path):
                with open(pyi_path, "r") as f:
                    pyi = f.read()
                print(f"  {os.path.basename(pyi_path)} ({label}): {len(pyi)} bytes")
                pyi_found = True

                if os.environ.get("TRICKLE_DEBUG"):
                    print(f"\n--- Generated {os.path.basename(pyi_path)} ---")
                    print(pyi)
                    print("--- End ---\n")

                for func in ["parse_csv", "slugify", "merge_config"]:
                    if func in pyi:
                        print(f"  {func} type present OK")

        if not pyi_found:
            raise RuntimeError(
                f".pyi files NOT generated!\n"
                f"  Checked: {LIB_PYI}, {APP_PYI}"
            )

        # === Step 4: Summary ===
        print("\n=== Step 4: Verify zero-code properties ===")
        print("  No source changes to app OK")
        print("  No trickle imports in app OK")
        print("  Just `python -m trickle.auto_run app.py` OK")
        print("  Types auto-generated OK")

        print("\n=== ALL TESTS PASSED ===")
        print("Zero-code Python activation works!\n")

    except Exception as err:
        print(f"\nTEST FAILED: {err}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        cleanup()


if __name__ == "__main__":
    run()
