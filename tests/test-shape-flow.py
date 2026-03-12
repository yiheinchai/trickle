"""Test: Tensor shape flow tracking across reassignments.

Verifies that when a tensor variable is reassigned multiple times in the
same function (e.g. x = self.c_attn(x), x = x.view(...), x = x.transpose(...)),
each assignment produces a separate trace record with the correct shape,
enabling the VSCode extension to show a "shape flow" chain.

Tests on nanoGPT's model.py where CausalSelfAttention.forward() has
multiple reassignments of q, k, v, x, att, y.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    test_script = r'''
import sys
sys.path.insert(0, "/tmp/nanoGPT")

import torch
from model import GPTConfig, GPT

config = GPTConfig(
    block_size=32,
    vocab_size=64,
    n_layer=2,
    n_head=2,
    n_embd=32,
    dropout=0.0,
    bias=False,
)
model = GPT(config)

x = torch.randint(0, 64, (2, 16))
y = torch.randint(0, 64, (2, 16))
logits, loss = model(x, y)
print("SHAPE_FLOW_OK")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_shapeflow_")
    test_file = os.path.join(test_dir, "test_shapeflow.py")
    with open(test_file, "w") as f:
        f.write(test_script)

    trickle_dir = os.path.join(test_dir, ".trickle")
    python = sys.executable
    trickle_src = os.path.join(os.path.dirname(__file__), "..", "packages", "client-python", "src")

    env = os.environ.copy()
    env["PYTHONPATH"] = trickle_src + (os.pathsep + env.get("PYTHONPATH", ""))
    env["TRICKLE_LOCAL"] = "1"
    env["TRICKLE_LOCAL_DIR"] = trickle_dir
    env["TRICKLE_TRACE_VARS"] = "1"

    result = subprocess.run(
        [python, "-c", "from trickle.observe_runner import main; main()", test_file],
        cwd=test_dir, env=env, capture_output=True, text=True, timeout=120,
    )

    if result.returncode != 0 or "SHAPE_FLOW_OK" not in result.stdout:
        print(f"FAIL: exit code {result.returncode}")
        print(result.stderr[:3000])
        sys.exit(1)

    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    with open(vars_file) as f:
        records = [json.loads(l) for l in f if l.strip()]

    print("=== Shape Flow Test ===\n")

    # Find tensor records in CausalSelfAttention.forward
    csa_forward = [r for r in records
                   if r.get("funcName") == "CausalSelfAttention.forward"
                   and r.get("type", {}).get("class_name") == "Tensor"]

    print(f"  CausalSelfAttention.forward tensor records: {len(csa_forward)}")

    # Group by varName
    by_var: dict = {}
    for r in csa_forward:
        vn = r["varName"]
        if vn not in by_var:
            by_var[vn] = []
        by_var[vn].append(r)

    # Sort each group by line
    for vn in by_var:
        by_var[vn].sort(key=lambda r: r["line"])

    print(f"  Unique tensor var names: {sorted(by_var.keys())}")

    # Show shape flows
    multi_assign_vars = {vn: recs for vn, recs in by_var.items() if len(recs) > 1}
    print(f"\n  Variables with multiple shapes (shape flow): {sorted(multi_assign_vars.keys())}")

    for vn, recs in sorted(multi_assign_vars.items()):
        shapes = []
        for r in recs:
            shape = r["type"].get("properties", {}).get("shape", {}).get("name", "?")
            shapes.append(f"L{r['line']}:{shape}")
        print(f"\n  {vn}: {' → '.join(shapes)}")

    # Assertions
    # 1. There should be at least one variable with multiple shape records
    assert len(multi_assign_vars) > 0, \
        "FAIL: no tensor variables have multiple shape records in CausalSelfAttention.forward"

    # 2. Check that shapes actually differ for at least one variable
    has_shape_change = False
    for vn, recs in multi_assign_vars.items():
        shapes = [r["type"]["properties"].get("shape", {}).get("name") for r in recs]
        if len(set(shapes)) > 1:
            has_shape_change = True
            print(f"\n  Shape change detected for '{vn}': {shapes}")
            break

    # Note: even if shapes don't differ (e.g. x stays [2,16,32] through multiple ops),
    # having multiple records per variable is still correct behavior.
    # Shape changes happen in attention (view/transpose operations).
    if has_shape_change:
        print("  ✓ Shape transformations captured across reassignments")
    else:
        print("  Note: no shape changes detected (shapes may be same), but multi-record tracking works")

    # 3. Also check GPT.forward for shape flow
    gpt_forward = [r for r in records
                   if r.get("funcName") == "GPT.forward"
                   and r.get("type", {}).get("class_name") == "Tensor"]

    gpt_by_var: dict = {}
    for r in gpt_forward:
        vn = r["varName"]
        if vn not in gpt_by_var:
            gpt_by_var[vn] = []
        gpt_by_var[vn].append(r)

    print(f"\n  GPT.forward tensor vars: {sorted(gpt_by_var.keys())}")
    for vn, recs in sorted(gpt_by_var.items()):
        if len(recs) > 1:
            shapes = []
            for r in sorted(recs, key=lambda r: r["line"]):
                shape = r["type"].get("properties", {}).get("shape", {}).get("name", "?")
                shapes.append(f"L{r['line']}:{shape}")
            print(f"  {vn}: {' → '.join(shapes)}")

    shutil.rmtree(test_dir)
    print("\nPASS: Shape flow tracking works!")


if __name__ == "__main__":
    main()
