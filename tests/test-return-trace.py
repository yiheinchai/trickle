"""Test: Return value tracing in ML model code.

Verifies that return values from functions (especially `return logits, loss`)
are traced with their tensor shapes, and that individual tuple elements
are traced separately (e.g. <return:logits>, <return:loss>).

Tests on nanoGPT's model.py to validate on real ML code.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    # Test script that imports nanoGPT's GPT model and runs a forward pass
    test_script = r'''
import sys
sys.path.insert(0, "/tmp/nanoGPT")

import torch
from model import GPTConfig, GPT

# Create a tiny GPT model
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
model.train()

# Forward pass with targets (triggers loss computation)
x = torch.randint(0, 64, (2, 16))
y = torch.randint(0, 64, (2, 16))
logits, loss = model(x, y)
print(f"logits shape: {logits.shape}")
print(f"loss: {loss.item():.4f}")

# Forward pass without targets (no loss)
model.eval()
with torch.no_grad():
    logits_only, no_loss = model(x)
    print(f"logits_only shape: {logits_only.shape}")
    print(f"no_loss: {no_loss}")

print("NANOGPT_RETURN_OK")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_return_test_")
    test_file = os.path.join(test_dir, "test_return.py")
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
    env["TRICKLE_DEBUG"] = "1"

    print("Running nanoGPT forward pass with return value tracing...")
    print(f"Test dir: {test_dir}")

    result = subprocess.run(
        [python, "-c", "from trickle.observe_runner import main; main()", test_file],
        cwd=test_dir, env=env, capture_output=True, text=True, timeout=120,
    )

    print("=== STDOUT ===")
    print(result.stdout)
    if result.stderr:
        lines = result.stderr.split("\n")
        relevant = [l for l in lines if not l.startswith("DEBUG:")]
        if relevant:
            print("=== STDERR (non-debug) ===")
            print("\n".join(relevant[:30]))

    if result.returncode != 0:
        print(f"FAIL: process exited with code {result.returncode}")
        if result.stderr:
            print("=== FULL STDERR ===")
            print(result.stderr[:5000])
        sys.exit(1)

    if "NANOGPT_RETURN_OK" not in result.stdout:
        print("FAIL: forward pass did not complete")
        sys.exit(1)

    # Check variables.jsonl
    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    if not os.path.exists(vars_file):
        print(f"FAIL: {vars_file} not found")
        sys.exit(1)

    with open(vars_file) as f:
        lines = f.readlines()

    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    # Find return value traces
    return_records = [r for r in records if r.get("varName", "").startswith("<return")]
    return_full = [r for r in records if r.get("varName") == "<return>"]
    return_elements = [r for r in records if r.get("varName", "").startswith("<return:")]

    print(f"\n=== RETURN VALUE TRACING RESULTS ===")
    print(f"Total variables: {len(records)}")
    print(f"Return traces: {len(return_records)} ({len(return_full)} full, {len(return_elements)} elements)")

    # Print return traces
    print("\n--- Return value traces ---")
    for r in sorted(return_records, key=lambda r: (r.get("file", ""), r.get("line", 0))):
        fname = os.path.basename(r.get("file", "?"))
        line = r.get("line", 0)
        varname = r.get("varName", "?")
        type_node = r.get("type", {})
        class_name = type_node.get("class_name", "")
        if class_name in ("Tensor", "ndarray"):
            shape = type_node.get("properties", {}).get("shape", {}).get("name", "?")
            print(f"  {fname:25s} line {line:4d}  {varname:25s} {class_name}{shape}")
        else:
            kind = type_node.get("kind", "?")
            name = type_node.get("name", "")
            print(f"  {fname:25s} line {line:4d}  {varname:25s} {kind}:{name}")

    # Check requires_grad and grad_fn in tensor records
    tensor_records = [r for r in records if r.get("type", {}).get("class_name") == "Tensor"]
    has_grad_info = any(
        r.get("type", {}).get("properties", {}).get("requires_grad", {}).get("name") in ("True", "False")
        for r in tensor_records
    )
    has_grad_fn = any(
        "grad_fn" in r.get("type", {}).get("properties", {})
        for r in tensor_records
    )
    print(f"\nTensor metadata:")
    print(f"  requires_grad values captured: {has_grad_info}")
    print(f"  grad_fn captured: {has_grad_fn}")

    # Print some tensors with grad info
    print("\n--- Tensors with gradient info ---")
    for r in tensor_records[:10]:
        props = r.get("type", {}).get("properties", {})
        shape = props.get("shape", {}).get("name", "?")
        rg = props.get("requires_grad", {}).get("name", "?")
        gfn = props.get("grad_fn", {}).get("name", "")
        fname = os.path.basename(r.get("file", "?"))
        print(f"  {fname:25s} {r['varName']:15s} shape={shape:20s} requires_grad={rg:5s} grad_fn={gfn}")

    # Assertions
    # 1. Should have <return> traces from model.py (the forward() method returns logits, loss)
    model_returns = [r for r in return_records if "model.py" in r.get("file", "")]
    assert len(model_returns) >= 1, f"FAIL: no return traces in model.py (found {len(model_returns)})"

    # 2. Should have <return:logits> element traces from forward()
    logits_returns = [r for r in return_elements if "logits" in r.get("varName", "")]
    assert len(logits_returns) >= 1, f"FAIL: no <return:logits> trace found"

    # 3. Should have <return:loss> element traces
    loss_returns = [r for r in return_elements if "loss" in r.get("varName", "")]
    assert len(loss_returns) >= 1, f"FAIL: no <return:loss> trace found"

    # 4. Return logits should be a Tensor
    logits_tensor = [r for r in logits_returns if r.get("type", {}).get("class_name") == "Tensor"]
    assert len(logits_tensor) >= 1, f"FAIL: <return:logits> is not traced as Tensor"

    # 5. requires_grad should have actual values (True/False), not just "boolean"
    assert has_grad_info, "FAIL: requires_grad doesn't have actual True/False values"

    # 6. Some tensors should have grad_fn (computed tensors)
    assert has_grad_fn, "FAIL: no grad_fn captured for any tensor"

    # 7. Check return traces from other methods (CausalSelfAttention.forward returns y)
    attention_returns = [r for r in return_records
                        if "model.py" in r.get("file", "") and
                        r.get("type", {}).get("class_name") == "Tensor"]
    assert len(attention_returns) >= 2, f"FAIL: expected >=2 tensor returns from model.py, got {len(attention_returns)}"

    print(f"\nOK: {len(return_records)} return traces, {len(return_elements)} element traces")
    print(f"  model.py returns: {len(model_returns)}")
    print(f"  Tensor returns: {len(attention_returns)}")

    shutil.rmtree(test_dir)
    print("\nPASS: Return value tracing works!")


if __name__ == "__main__":
    main()
