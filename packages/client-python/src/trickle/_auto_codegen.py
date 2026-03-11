"""Auto codegen for trickle/auto — reads JSONL observations and generates .pyi stubs.

Self-contained Python stub generator with no CLI or backend dependency.
Reads .trickle/observations.jsonl and writes .pyi files next to source files.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple


# ── TypeNode helpers ──

def _type_node_key(node: Dict[str, Any]) -> str:
    """Generate a string key for a TypeNode (for deduplication)."""
    kind = node.get("kind", "unknown")
    if kind == "primitive":
        return f"p:{node.get('name', 'unknown')}"
    if kind == "unknown":
        return "unknown"
    if kind == "array":
        return f"a:{_type_node_key(node.get('element', {}))}"
    if kind == "tuple":
        els = ",".join(_type_node_key(e) for e in node.get("elements", []))
        return f"t:[{els}]"
    if kind == "object":
        props = node.get("properties", {})
        entries = ",".join(f"{k}:{_type_node_key(props[k])}" for k in sorted(props))
        return f"o:{{{entries}}}"
    if kind == "union":
        members = sorted(_type_node_key(m) for m in node.get("members", []))
        return f"u:({'|'.join(members)})"
    return json.dumps(node, sort_keys=True)


def _make_optional(node: Dict[str, Any]) -> Dict[str, Any]:
    """Make a type optional by adding None/undefined to it."""
    if node.get("kind") == "primitive" and node.get("name") in ("undefined", "null"):
        return node
    if node.get("kind") == "union":
        members = node.get("members", [])
        if any(m.get("kind") == "primitive" and m.get("name") in ("undefined", "null") for m in members):
            return node
        return {"kind": "union", "members": [*members, {"kind": "primitive", "name": "null"}]}
    return {"kind": "union", "members": [node, {"kind": "primitive", "name": "null"}]}


def _deduplicate_union(members: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Create a union type with deduplicated members."""
    seen: Set[str] = set()
    unique: List[Dict[str, Any]] = []
    for m in members:
        if m.get("kind") == "union":
            for inner in m.get("members", []):
                key = _type_node_key(inner)
                if key not in seen:
                    seen.add(key)
                    unique.append(inner)
        else:
            key = _type_node_key(m)
            if key not in seen:
                seen.add(key)
                unique.append(m)
    if len(unique) == 1:
        return unique[0]
    return {"kind": "union", "members": unique}


def _merge_type_nodes(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """Merge two TypeNodes into a single type that represents both."""
    if _type_node_key(a) == _type_node_key(b):
        return a

    # Both objects: merge properties
    if a.get("kind") == "object" and b.get("kind") == "object":
        a_props = a.get("properties", {})
        b_props = b.get("properties", {})
        all_keys = set(a_props) | set(b_props)
        merged: Dict[str, Any] = {}
        for key in all_keys:
            in_a = key in a_props
            in_b = key in b_props
            if in_a and in_b:
                merged[key] = _merge_type_nodes(a_props[key], b_props[key])
            elif in_a:
                merged[key] = _make_optional(a_props[key])
            else:
                merged[key] = _make_optional(b_props[key])
        return {"kind": "object", "properties": merged}

    # Both arrays: merge element types
    if a.get("kind") == "array" and b.get("kind") == "array":
        if a.get("element") and b.get("element"):
            return {"kind": "array", "element": _merge_type_nodes(a["element"], b["element"])}

    # Both tuples with same length
    if a.get("kind") == "tuple" and b.get("kind") == "tuple":
        a_els = a.get("elements", [])
        b_els = b.get("elements", [])
        if len(a_els) == len(b_els):
            return {"kind": "tuple", "elements": [_merge_type_nodes(ae, be) for ae, be in zip(a_els, b_els)]}

    # Both unions: flatten
    if a.get("kind") == "union" and b.get("kind") == "union":
        return _deduplicate_union([*(a.get("members", [])), *(b.get("members", []))])

    # One union: add other
    if a.get("kind") == "union":
        return _deduplicate_union([*(a.get("members", [])), b])
    if b.get("kind") == "union":
        return _deduplicate_union([a, *(b.get("members", []))])

    return _deduplicate_union([a, b])


# ── Naming helpers ──

def _to_pascal_case(name: str) -> str:
    """Convert a name to PascalCase."""
    # Split on non-alphanumeric + camelCase boundaries
    name = re.sub(r"[^a-zA-Z0-9]+", " ", name)
    name = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", name)
    return "".join(w.capitalize() for w in name.strip().split())


def _to_snake_case(name: str) -> str:
    """Convert a name to snake_case."""
    name = re.sub(r"([a-z])([A-Z])", r"\1_\2", name)
    name = re.sub(r"[-\s]+", "_", name)
    return name.lower()


# ── Python type rendering ──

def _extract_optional(node: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
    """Check if a TypeNode is optional (union containing None/undefined)."""
    if node.get("kind") != "union":
        return False, node
    members = node.get("members", [])
    has_none = any(
        m.get("kind") == "primitive" and m.get("name") in ("undefined", "null")
        for m in members
    )
    if not has_none:
        return False, node
    without_none = [m for m in members if not (m.get("kind") == "primitive" and m.get("name") in ("undefined", "null"))]
    if not without_none:
        return True, {"kind": "primitive", "name": "null"}
    if len(without_none) == 1:
        return True, without_none[0]
    return True, {"kind": "union", "members": without_none}


def _type_to_python(
    node: Dict[str, Any],
    extracted: List[Tuple[str, Dict[str, Any]]],
    parent_name: str,
    prop_name: Optional[str],
) -> str:
    """Convert a TypeNode to a Python type string."""
    kind = node.get("kind", "unknown")

    if kind == "primitive":
        name = node.get("name", "unknown")
        mapping = {
            "string": "str",
            "number": "float",
            "boolean": "bool",
            "null": "None",
            "undefined": "None",
            "bigint": "int",
            "bytes": "bytes",
            "datetime": "datetime",
            "date": "date",
            "time": "time",
        }
        return mapping.get(name, "Any")

    if kind == "unknown":
        return "Any"

    if kind == "array":
        inner = _type_to_python(node.get("element", {}), extracted, parent_name, prop_name)
        return f"List[{inner}]"

    if kind == "tuple":
        els = [_type_to_python(e, extracted, parent_name, f"arg{i}") for i, e in enumerate(node.get("elements", []))]
        return f"Tuple[{', '.join(els)}]"

    if kind == "union":
        members = [_type_to_python(m, extracted, parent_name, prop_name) for m in node.get("members", [])]
        if len(members) == 2 and "None" in members:
            non_none = next(m for m in members if m != "None")
            return f"Optional[{non_none}]"
        return f"Union[{', '.join(members)}]"

    if kind == "set":
        inner = _type_to_python(node.get("element", {}), extracted, parent_name, prop_name)
        return f"Set[{inner}]"

    if kind == "function":
        return "Callable[..., Any]"

    if kind == "object":
        props = node.get("properties", {})
        if not props:
            return "Dict[str, Any]"
        if prop_name:
            class_name = _to_pascal_case(parent_name) + _to_pascal_case(prop_name)
            if not any(n == class_name for n, _ in extracted):
                extracted.append((class_name, node))
            return class_name
        return "Dict[str, Any]"

    return "Any"


def _render_typed_dict(
    name: str,
    node: Dict[str, Any],
    extracted: List[Tuple[str, Dict[str, Any]]],
) -> str:
    """Render a TypedDict class from a TypeNode."""
    props = node.get("properties", {})
    keys = list(props.keys())
    lines: List[str] = []

    # Check for optional fields
    has_optional = any(_extract_optional(props[k])[0] for k in keys)

    if has_optional:
        required: List[str] = []
        optional: List[str] = []

        for key in keys:
            prop_type = props[key]
            is_opt, inner_type = _extract_optional(prop_type)
            py_type = _type_to_python(inner_type if is_opt else prop_type, extracted, name, key)
            if is_opt:
                optional.append(f"    {_to_snake_case(key)}: {py_type}")
            else:
                required.append(f"    {_to_snake_case(key)}: {py_type}")

        if required and optional:
            base_name = f"_{name}Required"
            lines.append(f"class {base_name}(TypedDict):")
            lines.extend(required)
            lines.append("")
            lines.append("")
            lines.append(f"class {name}({base_name}, total=False):")
            lines.extend(optional)
        elif optional:
            lines.append(f"class {name}(TypedDict, total=False):")
            lines.extend(optional)
        else:
            lines.append(f"class {name}(TypedDict):")
            lines.extend(required)
    else:
        entries = [f"    {_to_snake_case(k)}: {_type_to_python(props[k], extracted, name, k)}" for k in keys]
        lines.append(f"class {name}(TypedDict):")
        if entries:
            lines.extend(entries)
        else:
            lines.append("    pass")

    return "\n".join(lines)


def _generate_py_for_function(fn: Dict[str, Any]) -> str:
    """Generate Python stub for a single function."""
    name = fn["name"]
    base_name = _to_pascal_case(name)
    extracted: List[Tuple[str, Dict[str, Any]]] = []
    sections: List[str] = []

    args_type = fn["argsType"]
    return_type = fn["returnType"]

    # Input type
    if args_type.get("kind") == "tuple":
        elements = args_type.get("elements", [])
        if len(elements) == 1 and elements[0].get("kind") == "object":
            sections.append(_render_typed_dict(f"{base_name}Input", elements[0], extracted))
        else:
            py_type = _type_to_python(args_type, extracted, base_name, None)
            sections.append(f"{base_name}Input = {py_type}")
    elif args_type.get("kind") == "object":
        sections.append(_render_typed_dict(f"{base_name}Input", args_type, extracted))
    else:
        py_type = _type_to_python(args_type, extracted, base_name, None)
        sections.append(f"{base_name}Input = {py_type}")
    sections.append("")
    sections.append("")

    # Output type
    if return_type.get("kind") == "object" and return_type.get("properties"):
        sections.append(_render_typed_dict(f"{base_name}Output", return_type, extracted))
    else:
        py_type = _type_to_python(return_type, extracted, base_name, None)
        sections.append(f"{base_name}Output = {py_type}")

    # Emit extracted TypedDicts
    emitted: Set[str] = set()
    extracted_lines: List[str] = []
    i = 0
    while i < len(extracted):
        ex_name, ex_node = extracted[i]
        i += 1
        if ex_name in emitted:
            continue
        emitted.add(ex_name)
        extracted_lines.append(_render_typed_dict(ex_name, ex_node, extracted))
        extracted_lines.append("")
        extracted_lines.append("")

    # Function signature
    func_name = _to_snake_case(name)
    if args_type.get("kind") == "tuple":
        elements = args_type.get("elements", [])
        if len(elements) == 1 and elements[0].get("kind") == "object":
            sig = f"def {func_name}(input: {base_name}Input) -> {base_name}Output: ..."
        else:
            params = []
            for idx, el in enumerate(elements):
                py_type = _type_to_python(el, extracted, base_name, f"arg{idx}")
                params.append(f"arg{idx}: {py_type}")
            sig = f"def {func_name}({', '.join(params)}) -> {base_name}Output: ..."
    elif args_type.get("kind") == "object" and args_type.get("properties"):
        sig = f"def {func_name}(input: {base_name}Input) -> {base_name}Output: ..."
    else:
        sig = f"def {func_name}() -> {base_name}Output: ..."

    result: List[str] = []
    if extracted_lines:
        result.extend(extracted_lines)
    result.extend(sections)
    result.append("")
    result.append(sig)

    return "\n".join(result)


# ── Public API ──

_last_size: int = 0


def generate_types() -> int:
    """Read JSONL observations and generate .pyi files next to source files.

    Returns the number of functions with types generated, or -1 if nothing changed.
    """
    global _last_size

    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    jsonl_path = os.path.join(local_dir, "observations.jsonl")

    if not os.path.exists(jsonl_path):
        return 0

    # Skip if file hasn't changed
    try:
        current_size = os.path.getsize(jsonl_path)
    except OSError:
        return 0

    if current_size == _last_size:
        return -1
    _last_size = current_size

    # Read observations
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return 0

    lines = [line for line in content.strip().split("\n") if line.strip()]

    # Group by function, merge types
    by_function: Dict[str, List[Dict[str, Any]]] = {}
    for line in lines:
        try:
            payload = json.loads(line)
            fn_name = payload.get("functionName")
            if fn_name and payload.get("argsType") and payload.get("returnType"):
                by_function.setdefault(fn_name, []).append(payload)
        except (json.JSONDecodeError, KeyError):
            continue

    if not by_function:
        return 0

    # Merge types for each function
    functions: List[Dict[str, Any]] = []
    for fn_name, payloads in by_function.items():
        merged_args = payloads[0]["argsType"]
        merged_return = payloads[0]["returnType"]
        first_hash = payloads[0].get("typeHash", "")

        for p in payloads[1:]:
            if p.get("typeHash", "") != first_hash:
                merged_args = _merge_type_nodes(merged_args, p["argsType"])
                merged_return = _merge_type_nodes(merged_return, p["returnType"])

        functions.append({
            "name": fn_name,
            "argsType": merged_args,
            "returnType": merged_return,
            "module": payloads[-1].get("module", ""),
        })

    # Group by module
    by_module: Dict[str, List[Dict[str, Any]]] = {}
    for fn in functions:
        mod = fn.get("module") or "_default"
        by_module.setdefault(mod, []).append(fn)

    # Generate .pyi files
    total_functions = 0
    for mod, fns in by_module.items():
        total_functions += len(fns)

        # Generate Python stubs
        sections: List[str] = [
            "# Auto-generated by trickle.auto from runtime observations",
            f"# Generated at {_iso_now()}",
            "# Do not edit — types update automatically as your code runs",
            "",
            "from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple, TypedDict, Union",
            "",
            "",
        ]
        for fn in fns:
            sections.append(_generate_py_for_function(fn))
            sections.append("")
            sections.append("")

        stub_content = "\n".join(sections).rstrip() + "\n"

        # Find source file for this module
        source_file = _find_source_file(mod)
        if source_file:
            pyi_path = os.path.splitext(source_file)[0] + ".pyi"
            try:
                os.makedirs(os.path.dirname(pyi_path) or ".", exist_ok=True)
                with open(pyi_path, "w", encoding="utf-8") as f:
                    f.write(stub_content)
            except OSError:
                pass

    return total_functions


def _find_source_file(module_name: str) -> Optional[str]:
    """Try to find the source file for a module name."""
    import sys as _sys

    # Check sys.modules for the actual file
    mod = _sys.modules.get(module_name)
    if mod and hasattr(mod, "__file__") and mod.__file__:
        return mod.__file__

    # Check __main__ module (entry file) — its module name in observations
    # is the filename stem, not "__main__"
    main_mod = _sys.modules.get("__main__")
    if main_mod and hasattr(main_mod, "__file__") and main_mod.__file__:
        main_stem = os.path.basename(main_mod.__file__).rsplit(".", 1)[0]
        if main_stem == module_name:
            return main_mod.__file__

    # Try common patterns in cwd
    cwd = os.getcwd()
    candidates = [
        os.path.join(cwd, f"{module_name}.py"),
        os.path.join(cwd, module_name, "__init__.py"),
        os.path.join(cwd, "src", f"{module_name}.py"),
        os.path.join(cwd, "src", module_name, "__init__.py"),
    ]

    # Also try snake_case version
    snake = _to_snake_case(module_name)
    if snake != module_name:
        candidates.extend([
            os.path.join(cwd, f"{snake}.py"),
            os.path.join(cwd, "src", f"{snake}.py"),
        ])

    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate

    return None


def _iso_now() -> str:
    """Get current time in ISO format."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
