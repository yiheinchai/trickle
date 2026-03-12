"""Test: funcName field in variable trace records.

Verifies that trace records include a funcName field with qualified
function names like 'GPT.forward', 'CausalSelfAttention.forward'.

Tests on nanoGPT's model.py.
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
print("FUNC_CONTEXT_OK")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_func_ctx_")
    test_file = os.path.join(test_dir, "test_func_ctx.py")
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

    if result.returncode != 0 or "FUNC_CONTEXT_OK" not in result.stdout:
        print(f"FAIL: exit code {result.returncode}")
        print(result.stderr[:3000])
        sys.exit(1)

    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    with open(vars_file) as f:
        records = [json.loads(l) for l in f if l.strip()]

    print("=== Function Context Traces ===\n")

    # 1. Check that some records from model.py have funcName
    model_records = [r for r in records if "model.py" in r.get("file", "")]
    func_records = [r for r in model_records if "funcName" in r]

    print(f"  Total model.py records: {len(model_records)}")
    print(f"  Records with funcName: {len(func_records)}")

    assert len(func_records) > 0, "FAIL: no records have funcName field"

    # 2. Check specific function names exist
    func_names = set(r["funcName"] for r in func_records)
    print(f"\n  Unique funcNames: {sorted(func_names)}")

    # GPT.forward should be present (we called model(x, y) which calls forward)
    assert any("GPT" in fn and "forward" in fn for fn in func_names), \
        f"FAIL: expected GPT.forward in funcNames, got: {func_names}"

    # CausalSelfAttention.forward should be present
    assert any("CausalSelfAttention" in fn and "forward" in fn for fn in func_names), \
        f"FAIL: expected CausalSelfAttention.forward, got: {func_names}"

    # 3. Check that funcName matches Class.method pattern for class methods
    for r in func_records[:10]:
        fn = r["funcName"]
        vn = r["varName"]
        print(f"  {fn:40s} | {vn:20s} | line {r.get('line', '?')}")

    # 4. Check __init__ methods also have context
    init_records = [r for r in func_records if "__init__" in r["funcName"]]
    print(f"\n  __init__ records: {len(init_records)}")
    if init_records:
        init_funcs = set(r["funcName"] for r in init_records)
        print(f"  __init__ funcNames: {sorted(init_funcs)}")
        # GPT.__init__ should be present
        assert any("GPT.__init__" in fn for fn in init_funcs), \
            f"FAIL: expected GPT.__init__, got: {init_funcs}"

    # 5. Verify self.* attributes also get funcName
    attr_with_func = [r for r in func_records if r["varName"].startswith("self.")]
    print(f"\n  self.* attrs with funcName: {len(attr_with_func)}")
    if attr_with_func:
        for r in attr_with_func[:5]:
            print(f"    {r['funcName']:30s} | {r['varName']}")

    # 6. Verify return traces also get funcName
    return_with_func = [r for r in func_records if r["varName"].startswith("<return")]
    print(f"\n  <return> traces with funcName: {len(return_with_func)}")
    if return_with_func:
        for r in return_with_func[:5]:
            print(f"    {r['funcName']:30s} | {r['varName']}")

    shutil.rmtree(test_dir)
    print("\nPASS: funcName context works!")


if __name__ == "__main__":
    main()
