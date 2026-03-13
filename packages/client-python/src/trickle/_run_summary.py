"""Print a comprehensive type summary after trickle.auto completes.

Shows all observed variables (with types and values) and function signatures
grouped by file and function. Activated by TRICKLE_SUMMARY=1.

Useful for developers who want instant type feedback in the terminal without
needing VSCode — just run your script and see what types were inferred.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional, Set, Tuple


_summary_printed = False


def print_run_summary() -> None:
    """Print a full type summary from variables.jsonl and observations.jsonl."""
    global _summary_printed
    if os.environ.get("TRICKLE_SUMMARY") != "1":
        return
    if _summary_printed:
        return
    _summary_printed = True
    try:
        _print_summary()
    except Exception:
        pass  # Never break user code


def _print_summary() -> None:
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    vars_file = os.path.join(local_dir, "variables.jsonl")
    obs_file = os.path.join(local_dir, "observations.jsonl")

    variables = _read_variables(vars_file)
    functions = _read_functions(obs_file)

    total_vars = len(variables)
    total_fns = len(functions)

    if total_vars == 0 and total_fns == 0:
        return

    C_RESET = "\033[0m"
    C_CYAN = "\033[36m"
    C_BOLD = "\033[1m"
    C_DIM = "\033[90m"
    C_GREEN = "\033[32m"
    C_YELLOW = "\033[33m"
    C_BLUE = "\033[34m"
    C_MAGENTA = "\033[35m"
    C_RED = "\033[31m"
    SEP = C_CYAN + "─" * 62 + C_RESET

    print(file=sys.stderr)
    print(SEP, file=sys.stderr)
    parts = []
    if total_vars:
        parts.append(f"{total_vars} variable{'s' if total_vars != 1 else ''}")
    if total_fns:
        parts.append(f"{total_fns} function{'s' if total_fns != 1 else ''} typed")
    print(f"{C_CYAN}  trickle: {' | '.join(parts)}{C_RESET}", file=sys.stderr)
    print(SEP, file=sys.stderr)

    # ── Variables section ─────────────────────────────────────────────────
    if variables:
        # Group by file → func_name
        by_file: Dict[str, Dict[Optional[str], List[Dict[str, Any]]]] = {}
        for r in variables:
            f = r.get("file", "?")
            var_name = r.get("varName", "")
            # Skip synthetic return-value variables
            if var_name.startswith("<"):
                continue
            # Skip function reference variables (type = Callable)
            t = r.get("type", {})
            if t.get("kind") == "function":
                continue
            # Skip trickle temp files (AST-transformed entry files)
            basename = os.path.basename(f)
            if basename.startswith(".trickle_") or basename.startswith("trickle_"):
                continue
            func = r.get("funcName") or None
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
            print(f"  {C_BOLD}{rel_path}{C_RESET}", file=sys.stderr)

            for func_name, func_vars in funcs.items():
                if func_name:
                    print(f"    {C_DIM}{func_name}(){C_RESET}", file=sys.stderr)
                    indent = "      "
                else:
                    indent = "    "

                func_vars.sort(key=lambda r: r.get("line", 0))
                seen: Set[str] = set()
                for r in func_vars:
                    var_name = r.get("varName", "?")
                    line_no = r.get("line", 0)
                    type_node = r.get("type", {})
                    sample = r.get("sample")

                    # Deduplicate by (name, type)
                    type_key = _compact_type(type_node)
                    key = f"{var_name}:{type_key}"
                    if key in seen:
                        continue
                    seen.add(key)

                    type_str = type_key
                    value_str = _format_value(sample, type_node)

                    line_badge = f"{C_DIM}L{line_no:<4d}{C_RESET}"
                    name_col = f"{C_BOLD}{var_name:<18s}{C_RESET}"
                    type_col = f"{C_GREEN}{type_str:<22s}{C_RESET}"
                    val_part = f" {C_DIM}={C_RESET} {value_str}" if value_str else ""

                    print(f"{indent}{line_badge} {name_col} {type_col}{val_part}", file=sys.stderr)

            print(file=sys.stderr)

    # ── Functions section ─────────────────────────────────────────────────
    if functions:
        print(f"  {C_DIM}Functions:{C_RESET}", file=sys.stderr)
        for fn in functions:
            sig = _build_sig(fn)
            print(f"    {C_BLUE}{sig}{C_RESET}", file=sys.stderr)
        print(file=sys.stderr)

    print(f"  {C_DIM}Data: .trickle/variables.jsonl{C_RESET}", file=sys.stderr)
    print(SEP, file=sys.stderr)
    print(file=sys.stderr)


# ── Readers ───────────────────────────────────────────────────────────────

def _read_variables(vars_file: str) -> List[Dict[str, Any]]:
    records = []
    if not os.path.exists(vars_file):
        return records
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


def _read_functions(obs_file: str) -> List[Dict[str, Any]]:
    """Read observations.jsonl and return merged function entries."""
    if not os.path.exists(obs_file):
        return []
    try:
        with open(obs_file, "r") as f:
            content = f.read()
    except Exception:
        return []

    by_fn: Dict[str, List[Dict[str, Any]]] = {}
    for line in content.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            p = json.loads(line)
            fn_name = p.get("functionName")
            if fn_name and p.get("argsType") and p.get("returnType"):
                by_fn.setdefault(fn_name, []).append(p)
        except (json.JSONDecodeError, KeyError):
            continue

    functions = []
    for fn_name, payloads in by_fn.items():
        merged_args = payloads[0]["argsType"]
        merged_ret = payloads[0]["returnType"]
        first_hash = payloads[0].get("typeHash", "")
        for p in payloads[1:]:
            if p.get("typeHash", "") != first_hash:
                merged_args = _merge_nodes(merged_args, p["argsType"])
                merged_ret = _merge_nodes(merged_ret, p["returnType"])

        # Filter spurious constructor observations:
        # zero-arg functions returning None are almost always dataclass/class __init__ calls
        elems = merged_args.get("elements", []) if merged_args.get("kind") == "tuple" else []
        ret_is_null = merged_ret.get("kind") == "primitive" and merged_ret.get("name") == "null"
        if ret_is_null and len(elems) == 0:
            continue

        param_names = next((p["paramNames"] for p in payloads if p.get("paramNames")), None)
        functions.append({
            "name": fn_name,
            "argsType": merged_args,
            "returnType": merged_ret,
            "paramNames": param_names,
            "isAsync": any(p.get("isAsync") for p in payloads),
        })

    functions.sort(key=lambda fn: fn["name"])
    return functions


# ── Type formatting ───────────────────────────────────────────────────────

_PY_NAMES: Dict[str, str] = {
    "integer": "int",
    "number": "float",
    "string": "str",
    "boolean": "bool",
    "null": "None",
    "undefined": "None",
    "unknown": "Any",
    "circular_ref": "Any",
    "bytes": "bytes",
    "datetime": "datetime",
    "date": "date",
    "time": "time",
}


def _compact_type(node: Dict[str, Any], depth: int = 0) -> str:
    """Convert a TypeNode to a compact Python type annotation string."""
    if not node:
        return "Any"

    # ML-style type with class_name (tensors, nn.Module, etc.)
    class_name = node.get("class_name")
    if class_name:
        props = node.get("properties", {})
        shape = props.get("shape", {})
        if shape.get("kind") == "primitive" and shape.get("name"):
            return f"{class_name}{shape['name']}"
        return class_name

    kind = node.get("kind", "unknown")

    if kind == "primitive":
        name = node.get("name", "Any") or "Any"
        return _PY_NAMES.get(name, name)

    if kind == "unknown":
        return "Any"

    if depth >= 3:
        return "..."

    if kind == "array":
        elem = _compact_type(node.get("element", {}), depth + 1)
        return f"list[{elem}]"

    if kind == "tuple":
        elements = node.get("elements", [])
        if not elements:
            return "tuple"
        if len(elements) <= 4:
            els = ", ".join(_compact_type(e, depth + 1) for e in elements)
            return f"tuple[{els}]"
        return f"tuple[{_compact_type(elements[0], depth + 1)}, ...]"

    if kind == "object":
        props = node.get("properties", {})
        if not props:
            return "dict"
        keys = list(props.keys())
        # infer value type from first few props
        val_types = list({_compact_type(props[k], depth + 1) for k in keys[:4]})
        val_t = val_types[0] if len(val_types) == 1 else "Any"
        return f"dict[str, {val_t}]"

    if kind == "union":
        members = [_compact_type(m, depth + 1) for m in node.get("members", [])]
        non_none = [m for m in members if m != "None"]
        if len(members) == 2 and "None" in members and non_none:
            return f"{non_none[0]} | None"
        return " | ".join(dict.fromkeys(members))  # deduplicate, preserve order

    if kind == "set":
        inner = _compact_type(node.get("element", {}), depth + 1)
        return f"set[{inner}]"

    if kind == "function":
        return "Callable"

    return "Any"


def _format_value(sample: Any, type_node: Dict[str, Any]) -> str:
    """Format a sample value for display — only show for scalars and short strings."""
    if sample is None:
        return ""
    # Show scalars inline
    if isinstance(sample, bool):
        return str(sample)
    if isinstance(sample, int):
        return str(sample)
    if isinstance(sample, float):
        # Trim overly-precise floats to 6 significant figures
        formatted = f"{sample:.6g}"
        return formatted
    # Short strings (not reprs of complex objects)
    if isinstance(sample, str):
        # Skip multi-line strings (DataFrame/table reprs)
        if "\n" in sample:
            return ""
        # Skip if it looks like a tensor/array/object repr
        if sample.startswith(("[", "{")):
            return ""
        # Skip tensor/ndarray repr strings: "Tensor(shape=...", "ndarray(shape=...", "float64(shape=..."
        if "shape=" in sample or "dtype=" in sample:
            return ""
        # Skip class instance reprs: "Foo(bar=..."
        import re as _re
        if _re.match(r"^[A-Z]\w*\(", sample):
            return ""
        if len(sample) <= 50:
            escaped = sample.replace('"', '\\"')
            return f'"{escaped}"'
        return f'"{sample[:47]}..."'
    # For dict samples, show a short preview
    if isinstance(sample, dict):
        preview = ", ".join(f"{k}: {repr(v)}" for k, v in list(sample.items())[:2])
        suffix = ", ..." if len(sample) > 2 else ""
        return "{" + preview + suffix + "}"
    # Skip lists — type annotation is enough
    return ""


def _build_sig(fn: Dict[str, Any]) -> str:
    """Build a one-line function signature for display."""
    name = fn["name"]
    param_names = fn.get("paramNames") or []
    args_type = fn.get("argsType", {})
    return_type = fn.get("returnType", {})
    is_async = fn.get("isAsync", False)

    params = []
    if args_type.get("kind") == "tuple":
        for i, el in enumerate(args_type.get("elements", [])):
            pname = param_names[i] if i < len(param_names) else f"arg{i}"
            params.append(f"{pname}: {_compact_type(el)}")

    ret = _compact_type(return_type)
    prefix = "async " if is_async else ""
    params_str = ", ".join(params)
    return f"{prefix}{name}({params_str}) → {ret}"


# ── Type merging (for overloads) ──────────────────────────────────────────

def _merge_nodes(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """Merge two TypeNodes into a union."""
    if a == b:
        return a
    if a.get("kind") == "union":
        members = a.get("members", [])
        if b not in members:
            members = members + [b]
        return {"kind": "union", "members": members}
    return {"kind": "union", "members": [a, b]}
