"""Print a concise tensor shape summary after trickle run completes.

Groups tensor variables by file and function, showing shapes in a
readable tree format so the ML engineer can see data flow at a glance.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional


def print_run_summary() -> None:
    """Print a tensor shape summary from variables.jsonl."""
    try:
        _print_summary()
    except Exception:
        pass  # Never break user code


def _print_summary() -> None:
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    vars_file = os.path.join(local_dir, "variables.jsonl")
    if not os.path.exists(vars_file):
        return

    records = _read_records(vars_file)
    if not records:
        return

    tensors = [r for r in records if r.get("type", {}).get("class_name") in ("Tensor", "ndarray")]
    modules = [r for r in records if _is_nn_module(r)]
    total = len(records)

    if total == 0:
        return

    print(file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)
    print(f"\033[36m  trickle: {total} variables traced ({len(tensors)} tensors)\033[0m", file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)

    # Group tensors by file, then by function
    by_file: Dict[str, Dict[Optional[str], List[Dict[str, Any]]]] = {}
    for r in tensors:
        f = r.get("file", "?")
        func = r.get("funcName")
        if f not in by_file:
            by_file[f] = {}
        if func not in by_file[f]:
            by_file[f][func] = []
        by_file[f][func].append(r)

    for filepath, funcs in by_file.items():
        try:
            rel_path = os.path.relpath(filepath, os.getcwd())
        except ValueError:
            rel_path = filepath
        if rel_path.startswith("../" * 3):
            rel_path = os.path.basename(filepath)
        print(f"\033[1m  {rel_path}\033[0m", file=sys.stderr)

        for func_name, func_tensors in funcs.items():
            if func_name:
                print(f"    \033[90m{func_name}\033[0m", file=sys.stderr)
                indent = "      "
            else:
                indent = "    "

            # Sort by line, deduplicate by (varName, shape)
            func_tensors.sort(key=lambda r: r.get("line", 0))
            seen = set()
            for r in func_tensors:
                key = (r["varName"], _format_shape(r["type"]))
                if key in seen:
                    continue
                seen.add(key)

                line = r.get("line", 0)
                name = r.get("varName", "?")
                shape_str = _format_type_concise(r.get("type", {}))

                # Warnings
                warnings = _format_warnings(r.get("type", {}))

                print(
                    f"{indent}\033[90mL{line:<4d}\033[0m "
                    f"\033[1m{name:20s}\033[0m "
                    f"\033[32m{shape_str}\033[0m"
                    f"{warnings}",
                    file=sys.stderr,
                )

        print(file=sys.stderr)

    # Show nn.Module summary if any
    if modules:
        seen_modules = set()
        module_lines = []
        for r in modules:
            name = r.get("varName", "?")
            type_str = _format_module_concise(r.get("type", {}))
            key = (name, type_str)
            if key in seen_modules:
                continue
            seen_modules.add(key)
            module_lines.append(f"    \033[1m{name:20s}\033[0m \033[33m{type_str}\033[0m")

        if module_lines:
            print("  \033[90mnn.Modules:\033[0m", file=sys.stderr)
            for ml in module_lines[:10]:
                print(ml, file=sys.stderr)
            if len(module_lines) > 10:
                print(f"    \033[90m... and {len(module_lines) - 10} more\033[0m", file=sys.stderr)
            print(file=sys.stderr)

    print("\033[90m  Data: .trickle/variables.jsonl\033[0m", file=sys.stderr)
    print("\033[36m" + "─" * 60 + "\033[0m", file=sys.stderr)
    print(file=sys.stderr)


def _read_records(vars_file: str) -> List[Dict[str, Any]]:
    records = []
    try:
        with open(vars_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    if r.get("kind") == "variable":
                        records.append(r)
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return records


def _is_nn_module(r: Dict[str, Any]) -> bool:
    t = r.get("type", {})
    return bool(t.get("class_name") and t.get("properties", {}).get("params"))


def _format_shape(t: Dict[str, Any]) -> str:
    props = t.get("properties", {})
    shape = props.get("shape", {})
    return shape.get("name", "")


def _format_type_concise(t: Dict[str, Any]) -> str:
    if not t:
        return "unknown"
    class_name = t.get("class_name", "")
    props = t.get("properties", {})

    parts = [class_name or "Tensor"]

    shape = props.get("shape", {})
    if shape.get("kind") == "primitive" and shape.get("name"):
        parts[0] = f"{parts[0]}{shape['name']}"

    dtype = props.get("dtype", {})
    if dtype.get("kind") == "primitive" and dtype.get("name"):
        d = dtype["name"].replace("torch.", "").replace("numpy.", "")
        parts.append(d)

    device = props.get("device", {})
    if device.get("kind") == "primitive" and device.get("name") and device["name"] != "cpu":
        parts.append(f"@{device['name']}")

    grad_fn = props.get("grad_fn", {})
    if grad_fn.get("kind") == "primitive" and grad_fn.get("name"):
        parts.append(f"({grad_fn['name']})")

    value = props.get("value", {})
    if value.get("kind") == "primitive" and value.get("name"):
        parts.append(f"= {value['name']}")

    return " ".join(parts)


def _format_warnings(t: Dict[str, Any]) -> str:
    props = t.get("properties", {})
    parts = []
    nan = props.get("nan_count", {})
    if nan.get("kind") == "primitive" and nan.get("name") and nan["name"] != "0":
        parts.append(f"\033[31m NaN!({nan['name']})\033[0m")
    inf = props.get("inf_count", {})
    if inf.get("kind") == "primitive" and inf.get("name") and inf["name"] != "0":
        parts.append(f"\033[33m [{inf['name']} inf]\033[0m")
    return "".join(parts)


def _format_module_concise(t: Dict[str, Any]) -> str:
    class_name = t.get("class_name", "Module")
    props = t.get("properties", {})
    params = props.get("params", {}).get("name", "")
    grad_norm = props.get("grad_norm", {}).get("name", "")
    # Only show short primitive properties (skip bias/weight tensor representations)
    _skip_keys = {"params", "grad_norm", "grad_nan", "grad_inf", "grad_top"}
    display = []
    for k, v in props.items():
        if k in _skip_keys:
            continue
        if v.get("kind") == "primitive" and v.get("name"):
            val = v["name"]
            # Skip values that look like tensor reprs or are too long
            if len(val) > 30 or "tensor(" in val.lower() or "parameter" in val.lower():
                continue
            display.append(f"{k}={val}")
    if display:
        inner = ", ".join(display[:4])
        suffix = f", {params} params" if params else ""
        result = f"{class_name}({inner}{suffix})"
    elif params:
        result = f"{class_name}({params} params)"
    else:
        result = class_name
    # Append gradient norm badge
    if grad_norm:
        result += f" |∇|={grad_norm}"
    return result
