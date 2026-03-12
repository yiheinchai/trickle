"""Test: automatic tensor shape context on crash.

Verifies that when user code crashes with a shape mismatch (or other error),
trickle prints the tensor shapes of variables near the crash site.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    # Script that deliberately crashes with a shape mismatch
    test_script = r'''
import torch

def build_model(in_features, out_features):
    weight = torch.randn(out_features, in_features)
    bias = torch.randn(out_features)
    return weight, bias

def forward(x, weight, bias):
    # This will crash: x is [4, 8] but weight is [16, 32] — incompatible matmul
    h = x @ weight.T
    return h + bias

# Build model with wrong dimensions
batch = torch.randn(4, 8)       # [4, 8]
w, b = build_model(32, 16)       # weight=[16, 32], bias=[16]

# This call will fail: can't multiply [4, 8] @ [32, 16]
output = forward(batch, w, b)
print("Should not reach here")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_error_test_")
    test_file = os.path.join(test_dir, "test_crash.py")
    with open(test_file, "w") as f:
        f.write(test_script)

    trickle_dir = os.path.join(test_dir, ".trickle")
    python = sys.executable
    trickle_src = os.path.join(os.path.dirname(__file__), "packages", "client-python", "src")

    env = os.environ.copy()
    env["PYTHONPATH"] = trickle_src + (os.pathsep + env.get("PYTHONPATH", ""))
    env["TRICKLE_LOCAL"] = "1"
    env["TRICKLE_LOCAL_DIR"] = trickle_dir
    env["TRICKLE_TRACE_VARS"] = "1"
    # Force color output even in subprocess
    env["FORCE_COLOR"] = "1"

    print("Running script that crashes with shape mismatch...")

    result = subprocess.run(
        [python, "-c", "from trickle.observe_runner import main; main()", test_file],
        cwd=test_dir, env=env, capture_output=True, text=True, timeout=60,
    )

    print("=== STDOUT ===")
    print(result.stdout)
    print("=== STDERR ===")
    print(result.stderr)

    # The script SHOULD fail
    if result.returncode == 0:
        print("FAIL: script should have crashed but exited successfully")
        sys.exit(1)

    # Check that the error context is in stderr
    stderr = result.stderr

    # Should contain the trickle context header
    if "trickle" not in stderr.lower() or "tensor" not in stderr.lower():
        print("FAIL: trickle error context not found in stderr")
        print("Expected to see tensor shape context near the error")
        sys.exit(1)

    # Should contain tensor shape info
    has_shape_info = any(s in stderr for s in ["Tensor[", "Tensor(", "[4, 8]", "[16, 32]", "[4,"])
    if not has_shape_info:
        print("FAIL: no tensor shape info found in error context")
        sys.exit(1)

    # Should contain variable names from the crash site
    has_var_names = any(name in stderr for name in ["batch", "weight", "x", "w"])
    if not has_var_names:
        print("FAIL: no variable names found in error context")
        sys.exit(1)

    # Should still contain the original traceback
    if "RuntimeError" not in stderr:
        print("FAIL: original RuntimeError not preserved in output")
        sys.exit(1)

    # Check that variables.jsonl was created with tensor data
    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    if os.path.exists(vars_file):
        with open(vars_file) as f:
            records = [json.loads(l) for l in f if l.strip()]
        tensor_names = {r["varName"] for r in records if r.get("type", {}).get("class_name") == "Tensor"}
        print(f"\nTraced tensors: {sorted(tensor_names)}")
    else:
        print("\nWARNING: no variables.jsonl (context came from other source)")

    shutil.rmtree(test_dir)
    print("\nPASS: Error context with tensor shapes works!")


if __name__ == "__main__":
    main()
