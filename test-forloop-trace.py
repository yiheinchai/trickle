"""Test: for-loop iteration variable tracing.

Verifies that variables from for-loop headers (e.g., `for batch_idx, (data, target) in ...`)
are traced with their runtime types and shapes.

This is critical for ML debugging where dataloader iteration variables
are key to understanding tensor shapes flowing through the pipeline.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    test_script = r'''
import torch

# Create batched data manually (avoids DataLoader/optim which trigger torch._dynamo)
batches = [
    (torch.randn(8, 3, 8, 8), torch.randint(0, 10, (8,)))
    for _ in range(4)
]

# Simple linear layer (no optimizer needed)
weight = torch.randn(10, 3 * 8 * 8)

# Training-like loop — for-loop variables should be traced
for epoch in range(2):
    for batch_idx, (data, target) in enumerate(batches):
        flat = data.reshape(data.shape[0], -1)
        logits = flat @ weight.T
        pred = logits.argmax(dim=1)
        correct = (pred == target).sum()

    print(f"Epoch {epoch} done, last batch correct: {correct.item()}")

# Also test simple for-loop with destructuring
items = [(torch.randn(4, 4), i) for i in range(3)]
for tensor_val, idx_val in items:
    result = tensor_val.sum()

# Test nested for-loop
matrices = [torch.randn(3, 3) for _ in range(2)]
for mat in matrices:
    eigenvalues = torch.linalg.eigvalsh(mat @ mat.T)

print("TRAINING LOOP OK")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_forloop_test_")
    test_file = os.path.join(test_dir, "test_training.py")
    with open(test_file, "w") as f:
        f.write(test_script)

    trickle_dir = os.path.join(test_dir, ".trickle")
    if os.path.exists(trickle_dir):
        shutil.rmtree(trickle_dir)

    python = sys.executable
    trickle_src = os.path.join(os.path.dirname(__file__), "packages", "client-python", "src")

    env = os.environ.copy()
    env["PYTHONPATH"] = trickle_src + (os.pathsep + env.get("PYTHONPATH", ""))
    env["TRICKLE_LOCAL"] = "1"
    env["TRICKLE_LOCAL_DIR"] = trickle_dir
    env["TRICKLE_TRACE_VARS"] = "1"

    print(f"Running training loop test...")
    print(f"Test dir: {test_dir}")

    result = subprocess.run(
        [python, "-c", "from trickle.observe_runner import main; main()", test_file],
        cwd=test_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )

    print("=== STDOUT ===")
    print(result.stdout)
    if result.stderr:
        print("=== STDERR ===")
        print(result.stderr[:3000])

    if result.returncode != 0:
        print(f"FAIL: process exited with code {result.returncode}")
        sys.exit(1)

    if "TRAINING LOOP OK" not in result.stdout:
        print("FAIL: training loop did not complete")
        sys.exit(1)

    # Check variables.jsonl
    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    if not os.path.exists(vars_file):
        print(f"FAIL: {vars_file} not found")
        sys.exit(1)

    with open(vars_file) as f:
        lines = f.readlines()

    print(f"\n=== TRACED VARIABLES ({len(lines)} entries) ===")

    all_records = []
    for line in lines:
        record = json.loads(line)
        all_records.append(record)

    all_var_names = {r["varName"] for r in all_records}
    tensor_records = [r for r in all_records if r.get("type", {}).get("class_name") in ("Tensor", "ndarray")]
    tensor_var_names = {r["varName"] for r in tensor_records}

    print(f"All variables: {sorted(all_var_names)}")
    print(f"Tensor variables: {sorted(tensor_var_names)}")

    for r in tensor_records:
        shape = r.get("type", {}).get("properties", {}).get("shape", {}).get("name", "?")
        print(f"  {r['varName']:20s} line {r['line']:4d}  shape={shape}")

    # KEY ASSERTIONS: for-loop iteration variables must be traced
    expected_for_vars = {"data", "target", "batch_idx", "epoch"}
    found_for_vars = expected_for_vars & all_var_names
    print(f"\nExpected for-loop vars: {sorted(expected_for_vars)}")
    print(f"Found for-loop vars: {sorted(found_for_vars)}")

    if "data" not in tensor_var_names:
        print("FAIL: 'data' from for-loop not traced as tensor!")
        sys.exit(1)

    if "target" not in tensor_var_names:
        print("FAIL: 'target' from for-loop not traced as tensor!")
        sys.exit(1)

    if "epoch" not in all_var_names:
        print("FAIL: 'epoch' from for-loop not traced!")
        sys.exit(1)

    # Check that data has the expected shape [8, 3, 8, 8]
    data_records = [r for r in tensor_records if r["varName"] == "data"]
    if data_records:
        shape = data_records[0].get("type", {}).get("properties", {}).get("shape", {}).get("name", "")
        print(f"  data shape: {shape}")
        if "[8, 3, 8, 8]" not in shape:
            print(f"WARNING: unexpected data shape: {shape} (expected [8, 3, 8, 8])")

    # Check destructured for-loop
    if "tensor_val" not in tensor_var_names:
        print("FAIL: 'tensor_val' from destructured for-loop not traced!")
        sys.exit(1)

    # Verify deduplication: should NOT have 4*2=8 entries for data (4 batches x 2 epochs)
    # because the cache deduplicates by (file, line, var, type_hash)
    data_count = sum(1 for r in all_records if r["varName"] == "data")
    print(f"\n'data' entries: {data_count} (should be 1 due to dedup, same shape each batch)")
    if data_count > 2:
        print(f"WARNING: expected dedup to keep <=2 entries for 'data', got {data_count}")

    print(f"\nOK: for-loop vars traced — {len(found_for_vars)}/{len(expected_for_vars)} expected vars found")

    shutil.rmtree(test_dir)
    print("\nPASS: For-loop iteration variable tracing works!")


if __name__ == "__main__":
    main()
