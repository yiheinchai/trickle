"""Test: with...as and except...as variable tracing.

Verifies that variables bound by `with ... as x:` and `except ... as e:`
are traced, completing coverage of all Python variable binding forms.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def main():
    test_script = r'''
import tempfile
import os

# Test 1: with...as at top level
with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as tmp:
    tmp.write("hello")

# Test 2: with...as inside a function
def process_file(path):
    with open(path, 'r') as f:
        content = f.read()
    return content

result = process_file(tmp.name)

# Test 3: Multiple with targets
with open(tmp.name, 'r') as reader, open(os.devnull, 'w') as writer:
    data = reader.read()
    writer.write(data)

# Test 4: except...as
def safe_divide(a, b):
    try:
        result = a / b
        return result
    except ZeroDivisionError as err:
        return str(err)

val1 = safe_divide(10, 2)
val2 = safe_divide(10, 0)

# Test 5: except...as at top level
try:
    bad = int("not_a_number")
except ValueError as top_err:
    fallback = str(top_err)

# Test 6: Nested with inside try
def load_config(path):
    try:
        with open(path, 'r') as cfg:
            return cfg.read()
    except FileNotFoundError as fnf:
        return f"Not found: {fnf}"

config_result = load_config("/nonexistent/path")

os.unlink(tmp.name)
print("WITH_EXCEPT_OK")
'''

    test_dir = tempfile.mkdtemp(prefix="trickle_withexcept_")
    test_file = os.path.join(test_dir, "test_with_except.py")
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
        cwd=test_dir, env=env, capture_output=True, text=True, timeout=60,
    )

    if result.returncode != 0 or "WITH_EXCEPT_OK" not in result.stdout:
        print(f"FAIL: exit code {result.returncode}")
        print("STDOUT:", result.stdout[:1000])
        print("STDERR:", result.stderr[:3000])
        sys.exit(1)

    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    with open(vars_file) as f:
        records = [json.loads(l) for l in f if l.strip()]

    print("=== with...as / except...as Tracing ===\n")

    var_names = {r["varName"] for r in records}
    print(f"  All traced var names: {sorted(var_names)}")

    # 1. with...as at top level: tmp should be traced
    assert "tmp" in var_names, f"FAIL: 'tmp' from with...as not traced. Got: {var_names}"
    print("  tmp (with...as top-level): traced")

    # 2. with...as inside function: f should be traced
    f_records = [r for r in records if r["varName"] == "f"]
    assert len(f_records) > 0, "FAIL: 'f' from with open() as f not traced"
    assert any(r.get("funcName") == "process_file" for r in f_records), \
        "FAIL: 'f' should have funcName=process_file"
    print("  f (with...as in function): traced with funcName=process_file")

    # 3. Multiple with targets: reader and writer
    assert "reader" in var_names, "FAIL: 'reader' from multiple with not traced"
    assert "writer" in var_names, "FAIL: 'writer' from multiple with not traced"
    print("  reader, writer (multiple with targets): traced")

    # 4. except...as inside function: err should be traced
    err_records = [r for r in records if r["varName"] == "err"]
    assert len(err_records) > 0, "FAIL: 'err' from except...as not traced"
    assert any(r.get("funcName") == "safe_divide" for r in err_records), \
        "FAIL: 'err' should have funcName=safe_divide"
    # Check it captured the exception type
    err_type = err_records[0]["type"]
    print(f"  err (except...as in function): traced, type={err_type.get('class_name', err_type.get('name', '?'))}")

    # 5. except...as at top level
    assert "top_err" in var_names, "FAIL: 'top_err' from top-level except not traced"
    print("  top_err (except...as top-level): traced")

    # 6. Nested with inside try: cfg and fnf
    assert "cfg" in var_names or "fnf" in var_names, \
        "FAIL: neither 'cfg' nor 'fnf' from nested with/except traced"
    fnf_records = [r for r in records if r["varName"] == "fnf"]
    if fnf_records:
        assert any(r.get("funcName") == "load_config" for r in fnf_records), \
            "FAIL: 'fnf' should have funcName=load_config"
        print("  fnf (nested except in function): traced with funcName=load_config")

    shutil.rmtree(test_dir)
    print("\nPASS: with...as and except...as tracing works!")


if __name__ == "__main__":
    main()
