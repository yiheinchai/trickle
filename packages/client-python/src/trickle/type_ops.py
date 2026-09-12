"""Algebraic operations on TypeNode dicts (unify, assignability, TS utilities).

TypeNodes are JSON-like dicts. This module mirrors TypeScript's structural
type algebra, operating on values already captured as TypeNodes.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

TypeNode = Dict[str, Any]
KeySpec = Union[str, Sequence[str], TypeNode]

DISPLAY_CLASSES = frozenset({
    "ndarray", "Tensor", "DataFrame", "Series",
    "DatasetDict", "Dataset", "mlx.array",
})

_MAX_LITERAL_UNION = 16


# ---------------------------------------------------------------------------
# Constructors
# ---------------------------------------------------------------------------

def primitive(name: str) -> TypeNode:
    return {"kind": "primitive", "name": name}


def literal(value: Any) -> TypeNode:
    return {"kind": "literal", "value": value}


def unknown() -> TypeNode:
    return {"kind": "primitive", "name": "unknown"}


def never() -> TypeNode:
    return {"kind": "primitive", "name": "never"}


def undefined() -> TypeNode:
    return {"kind": "primitive", "name": "undefined"}


def make_optional(inner: TypeNode) -> TypeNode:
    inner = normalize(inner)
    if inner.get("kind") == "optional":
        return inner
    return {"kind": "optional", "type": inner}


def make_union(members: Sequence[TypeNode]) -> TypeNode:
    flat = _flatten_members(members)
    if not flat:
        return never()
    if len(flat) == 1:
        return flat[0]
    return {"kind": "union", "members": flat}


# ---------------------------------------------------------------------------
# Normalize / equality / canonical form
# ---------------------------------------------------------------------------

def normalize(node: TypeNode | None) -> TypeNode:
    """Canonicalize equivalent encodings (kind:null vs primitive null, etc.)."""
    if not node or not isinstance(node, dict):
        return unknown()
    kind = node.get("kind")
    if kind == "null":
        return primitive("null")
    if kind == "unknown":
        return primitive("unknown")
    if kind == "never":
        return never()
    if kind == "optional":
        inner = normalize(node.get("type") or unknown())
        if inner.get("kind") == "optional":
            return inner
        return {"kind": "optional", "type": inner}
    if kind == "union":
        return make_union(node.get("members") or [])
    return node


def is_unknown(node: TypeNode) -> bool:
    node = normalize(node)
    return node.get("kind") == "primitive" and node.get("name") == "unknown"


def is_never(node: TypeNode) -> bool:
    node = normalize(node)
    if node.get("kind") == "primitive" and node.get("name") == "never":
        return True
    if node.get("kind") == "union" and not node.get("members"):
        return True
    return False


def is_null(node: TypeNode) -> bool:
    node = normalize(node)
    return node.get("kind") == "primitive" and node.get("name") == "null"


def is_undefined(node: TypeNode) -> bool:
    node = normalize(node)
    return node.get("kind") == "primitive" and node.get("name") == "undefined"


def is_optional(node: TypeNode) -> bool:
    return normalize(node).get("kind") == "optional"


def unwrap_optional(node: TypeNode) -> Tuple[TypeNode, bool]:
    node = normalize(node)
    if node.get("kind") == "optional":
        return normalize(node.get("type") or unknown()), True
    return node, False


def literal_base(node: TypeNode) -> TypeNode:
    """Widen a literal (or null) to its primitive base type."""
    node = normalize(node)
    if node.get("kind") != "literal":
        if is_null(node):
            return primitive("null")
        return node
    value = node.get("value")
    if value is None:
        return primitive("null")
    if isinstance(value, bool):
        return primitive("boolean")
    if isinstance(value, int):
        return primitive("integer")
    if isinstance(value, float):
        return primitive("number")
    if isinstance(value, str):
        return primitive("string")
    return unknown()


def types_equal(a: TypeNode, b: TypeNode) -> bool:
    """Structural equality after normalize. Display classes equal by class_name."""
    return _canonical(a) == _canonical(b)


def _canonical(node: TypeNode) -> str:
    return json.dumps(_canonical_obj(normalize(node)), sort_keys=True, default=str)


def _canonical_obj(node: TypeNode) -> Any:
    kind = node.get("kind")
    if kind == "primitive":
        return {"k": "prim", "n": node.get("name")}
    if kind == "literal":
        value = node.get("value")
        return {"k": "lit", "t": type(value).__name__, "v": value}
    if kind == "optional":
        return {"k": "opt", "t": _canonical_obj(normalize(node.get("type") or unknown()))}
    if kind == "union":
        members = [_canonical(m) for m in (node.get("members") or [])]
        members.sort()
        return {"k": "union", "m": members}
    if kind == "array":
        return {"k": "array", "e": _canonical_obj(normalize(node.get("element") or unknown()))}
    if kind == "set":
        return {"k": "set", "e": _canonical_obj(normalize(node.get("element") or unknown()))}
    if kind == "tuple":
        return {"k": "tuple", "e": [_canonical_obj(normalize(el)) for el in (node.get("elements") or [])]}
    if kind == "map":
        return {
            "k": "map",
            "key": _canonical_obj(normalize(node.get("key") or unknown())),
            "val": _canonical_obj(normalize(node.get("value") or unknown())),
        }
    if kind == "function":
        params = [_canonical_obj(normalize(p)) for p in (node.get("params") or [])]
        ret = _canonical_obj(normalize(node.get("returnType") or unknown()))
        return {"k": "fn", "p": params, "r": ret}
    if kind == "promise":
        return {"k": "promise", "r": _canonical_obj(normalize(node.get("resolved") or unknown()))}
    if kind == "enum":
        members = node.get("members") or {}
        if isinstance(members, dict):
            mem_canon = {k: _canonical_obj(normalize(v) if isinstance(v, dict) else literal(v))
                         for k, v in sorted(members.items())}
        else:
            mem_canon = members
        return {"k": "enum", "n": node.get("name"), "m": mem_canon}
    if kind == "object":
        cn = node.get("class_name")
        if cn in DISPLAY_CLASSES:
            return {"k": "display", "n": cn}
        props = node.get("properties") or {}
        return {
            "k": "object",
            "n": cn,
            "p": {k: _canonical_obj(normalize(v)) for k, v in sorted(props.items())},
        }
    return {"k": kind, "raw": node}


def _is_display(node: TypeNode) -> bool:
    node = normalize(node)
    return node.get("kind") == "object" and node.get("class_name") in DISPLAY_CLASSES


# ---------------------------------------------------------------------------
# Unify
# ---------------------------------------------------------------------------

def unify(a: TypeNode, b: TypeNode) -> TypeNode:
    """Best common type of two TypeNodes (TS-style)."""
    a = normalize(a)
    b = normalize(b)
    if types_equal(a, b):
        return a
    if is_never(a):
        return b
    if is_never(b):
        return a
    if is_unknown(a):
        return b
    if is_unknown(b):
        return a

    a_inner, a_opt = unwrap_optional(a)
    b_inner, b_opt = unwrap_optional(b)
    if a_opt or b_opt:
        return make_optional(unify(a_inner, b_inner))

    # Literal widening when mixed with its base primitive
    if a.get("kind") == "literal" or b.get("kind") == "literal":
        widened = _unify_literals(a, b)
        if widened is not None:
            return widened

    ka, kb = a.get("kind"), b.get("kind")

    if ka == "union" or kb == "union":
        members: List[TypeNode] = []
        members.extend(a.get("members") if ka == "union" else [a])
        members.extend(b.get("members") if kb == "union" else [b])
        return _collapse_members(members)

    if ka == "object" and kb == "object":
        return _unify_objects(a, b)

    if ka == "array" and kb == "array":
        return {"kind": "array", "element": unify(a.get("element") or unknown(), b.get("element") or unknown())}

    if ka == "set" and kb == "set":
        return {"kind": "set", "element": unify(a.get("element") or unknown(), b.get("element") or unknown())}

    if ka == "map" and kb == "map":
        return {
            "kind": "map",
            "key": unify(a.get("key") or unknown(), b.get("key") or unknown()),
            "value": unify(a.get("value") or unknown(), b.get("value") or unknown()),
        }

    if ka == "tuple" and kb == "tuple":
        return _unify_tuples(a, b)

    if {ka, kb} == {"tuple", "array"}:
        tup = a if ka == "tuple" else b
        arr = b if ka == "tuple" else a
        elems = list(tup.get("elements") or [])
        elem_u = unify_all(elems + [arr.get("element") or unknown()]) if elems else (arr.get("element") or unknown())
        return {"kind": "array", "element": elem_u}

    if {ka, kb} == {"object", "map"}:
        obj = a if ka == "object" else b
        mp = b if ka == "object" else a
        if _is_display(obj):
            return make_union([a, b])
        vals = list((obj.get("properties") or {}).values())
        val_u = unify_all(vals + [mp.get("value") or unknown()]) if vals else (mp.get("value") or unknown())
        key_u = unify(primitive("string"), mp.get("key") or primitive("string"))
        return {"kind": "map", "key": key_u, "value": val_u}

    if ka == "function" and kb == "function":
        return _unify_functions(a, b)

    if ka == "promise" and kb == "promise":
        return {"kind": "promise", "resolved": unify(a.get("resolved") or unknown(), b.get("resolved") or unknown())}

    if ka == "enum" and kb == "enum":
        if a.get("name") == b.get("name"):
            return a
        return make_union([a, b])

    return make_union([a, b])


def unify_all(nodes: Sequence[TypeNode]) -> TypeNode:
    if not nodes:
        return unknown()
    acc = normalize(nodes[0])
    for n in nodes[1:]:
        acc = unify(acc, n)
    return acc


def _unify_literals(a: TypeNode, b: TypeNode) -> Optional[TypeNode]:
    """Handle literal/literal and literal/primitive pairs. None → fall through."""
    if a.get("kind") == "literal" and b.get("kind") == "literal":
        if _literal_values_equal(a.get("value"), b.get("value")):
            return a
        base_a, base_b = literal_base(a), literal_base(b)
        if types_equal(base_a, base_b):
            return make_union([a, b])
        return make_union([a, b])
    lit, other = (a, b) if a.get("kind") == "literal" else (b, a)
    if lit.get("kind") != "literal":
        return None
    base = literal_base(lit)
    if other.get("kind") == "primitive":
        name = other.get("name")
        if types_equal(base, other):
            return other
        # int literal is assignable to number (TS widening)
        if name == "number" and base.get("name") in ("integer", "number"):
            return primitive("number")
        if name == "integer" and base.get("name") == "integer":
            return primitive("integer")
        if name == "boolean" and base.get("name") == "boolean":
            return primitive("boolean")
        if name == "string" and base.get("name") == "string":
            return primitive("string")
    return None


def _literal_values_equal(a: Any, b: Any) -> bool:
    return type(a) is type(b) and a == b


def _unify_objects(a: TypeNode, b: TypeNode) -> TypeNode:
    a_cn = a.get("class_name")
    b_cn = b.get("class_name")
    if a_cn in DISPLAY_CLASSES or b_cn in DISPLAY_CLASSES:
        if a_cn and a_cn == b_cn and a_cn in DISPLAY_CLASSES:
            return a
        return make_union([a, b])

    a_plain = (not a_cn) or a_cn == "dict"
    b_plain = (not b_cn) or b_cn == "dict"
    if a_cn and b_cn and a_cn != b_cn and not (a_plain and b_plain):
        return make_union([a, b])

    a_props: Dict[str, TypeNode] = dict(a.get("properties") or {})
    b_props: Dict[str, TypeNode] = dict(b.get("properties") or {})
    merged: Dict[str, TypeNode] = {}
    for key in set(a_props) | set(b_props):
        in_a = key in a_props
        in_b = key in b_props
        if in_a and in_b:
            ua = a_props[key]
            ub = b_props[key]
            merged_t = unify(ua, ub)
            if is_optional(ua) or is_optional(ub):
                merged_t = make_optional(unwrap_optional(merged_t)[0])
            merged[key] = merged_t
        elif in_a:
            merged[key] = make_optional(a_props[key])
        else:
            merged[key] = make_optional(b_props[key])

    result: TypeNode = {"kind": "object", "properties": merged}
    if a_cn == b_cn and a_cn:
        result["class_name"] = a_cn
    elif a_plain and b_plain and (a_cn == "dict" or b_cn == "dict"):
        result["class_name"] = "dict"
    elif a_cn and not b_cn:
        result["class_name"] = a_cn
    elif b_cn and not a_cn:
        result["class_name"] = b_cn
    return result


def _unify_tuples(a: TypeNode, b: TypeNode) -> TypeNode:
    a_els = list(a.get("elements") or [])
    b_els = list(b.get("elements") or [])
    if len(a_els) == len(b_els):
        return {"kind": "tuple", "elements": [unify(x, y) for x, y in zip(a_els, b_els)]}
    return {"kind": "array", "element": unify_all(a_els + b_els)}


def _unify_functions(a: TypeNode, b: TypeNode) -> TypeNode:
    a_params = list(a.get("params") or [])
    b_params = list(b.get("params") or [])
    n = max(len(a_params), len(b_params))
    params = []
    for i in range(n):
        pa = a_params[i] if i < len(a_params) else unknown()
        pb = b_params[i] if i < len(b_params) else unknown()
        params.append(unify(pa, pb))
    ret = unify(a.get("returnType") or unknown(), b.get("returnType") or unknown())
    result: TypeNode = {"kind": "function", "params": params, "returnType": ret}
    a_name, b_name = a.get("name"), b.get("name")
    if a_name and a_name == b_name:
        result["name"] = a_name
    return result


def _flatten_members(nodes: Sequence[TypeNode]) -> List[TypeNode]:
    out: List[TypeNode] = []
    seen: Set[str] = set()
    stack = [normalize(n) for n in nodes]
    while stack:
        n = stack.pop()
        if n.get("kind") == "union":
            stack.extend(reversed(n.get("members") or []))
            continue
        if is_never(n):
            continue
        key = _canonical(n)
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    # Drop unknown when anything else is present (unknown is bottom for inference)
    if any(not is_unknown(m) for m in out):
        out = [m for m in out if not is_unknown(m)]
    return _collapse_member_list(out)


def _collapse_members(nodes: Sequence[TypeNode]) -> TypeNode:
    collapsed = _flatten_members(nodes)
    if not collapsed:
        return never()
    if len(collapsed) == 1:
        return collapsed[0]
    return {"kind": "union", "members": collapsed}


def _collapse_member_list(members: List[TypeNode]) -> List[TypeNode]:
    """Merge compatible objects; absorb literals into matching primitives."""
    if not members:
        return members

    primitives = [m for m in members if m.get("kind") == "primitive"]
    prim_names = {m.get("name") for m in primitives}

    kept: List[TypeNode] = []
    literals_by_base: Dict[str, List[TypeNode]] = {}
    plain_objects: List[TypeNode] = []
    rest: List[TypeNode] = []

    for m in members:
        kind = m.get("kind")
        if kind == "literal":
            base_name = literal_base(m).get("name") or "unknown"
            if base_name in prim_names:
                continue  # absorbed by the primitive
            if base_name == "integer" and "number" in prim_names:
                continue
            literals_by_base.setdefault(base_name, []).append(m)
        elif kind == "object" and not _is_display(m):
            plain_objects.append(m)
        else:
            rest.append(m)

    for base_name, lits in literals_by_base.items():
        # Dedup
        uniq: List[TypeNode] = []
        seen: Set[str] = set()
        for lit in lits:
            k = _canonical(lit)
            if k not in seen:
                seen.add(k)
                uniq.append(lit)
        if len(uniq) > _MAX_LITERAL_UNION:
            rest.append(primitive(base_name))
        else:
            kept.extend(uniq)

    if plain_objects:
        merged = plain_objects[0]
        for obj in plain_objects[1:]:
            u = _unify_objects(merged, obj)
            if u.get("kind") == "union":
                # incompatible class names — keep as separate
                rest.append(obj)
            else:
                merged = u
        rest.append(merged)

    # Dedup rest
    final: List[TypeNode] = []
    seen_f: Set[str] = set()
    for m in kept + rest:
        k = _canonical(m)
        if k not in seen_f:
            seen_f.add(k)
            final.append(m)
    return final


# ---------------------------------------------------------------------------
# Assignability
# ---------------------------------------------------------------------------

def is_assignable(source: TypeNode, target: TypeNode) -> bool:
    """True iff *source* can be used where *target* is expected (structural)."""
    return _is_assignable(normalize(source), normalize(target), set())


def _is_assignable(source: TypeNode, target: TypeNode, seen: Set[Tuple[str, str]]) -> bool:
    pair = (_canonical(source), _canonical(target))
    if pair in seen:
        return True
    seen = seen | {pair}

    if types_equal(source, target):
        return True
    if is_never(source):
        return True
    if is_unknown(target):
        return True
    if is_never(target):
        return False

    # optional T  ≡  T | undefined
    t_inner, t_opt = unwrap_optional(target)
    s_inner, s_opt = unwrap_optional(source)
    if t_opt:
        if is_undefined(source) or is_null(source):
            return True
        if s_opt:
            return _is_assignable(s_inner, t_inner, seen)
        return _is_assignable(source, t_inner, seen)
    if s_opt:
        # optional source only assignable if target accepts undefined
        return False

    if target.get("kind") == "union":
        return any(_is_assignable(source, m, seen) for m in (target.get("members") or []))
    if source.get("kind") == "union":
        members = source.get("members") or []
        return bool(members) and all(_is_assignable(m, target, seen) for m in members)

    if source.get("kind") == "literal":
        if target.get("kind") == "literal":
            return _literal_values_equal(source.get("value"), target.get("value"))
        base = literal_base(source)
        if _is_assignable(base, target, seen):
            return True
        # int literals also assignable to number
        if target.get("kind") == "primitive" and target.get("name") == "number":
            if base.get("name") in ("integer", "number"):
                return True
        if target.get("kind") == "enum":
            return _literal_in_enum(source, target)
        return False

    if source.get("kind") == "enum" and target.get("kind") == "enum":
        return source.get("name") == target.get("name")

    sk, tk = source.get("kind"), target.get("kind")

    if tk == "primitive":
        tname = target.get("name")
        if sk == "primitive":
            sname = source.get("name")
            if sname == tname:
                return True
            # integer is not number; they stay distinct except via literals
            return False
        return False

    if sk == "object" and tk == "object":
        return _object_assignable(source, target, seen)

    if sk == "array" and tk == "array":
        return _is_assignable(source.get("element") or unknown(), target.get("element") or unknown(), seen)

    if sk == "tuple" and tk == "tuple":
        s_els = source.get("elements") or []
        t_els = target.get("elements") or []
        if len(s_els) != len(t_els):
            return False
        return all(_is_assignable(s, t, seen) for s, t in zip(s_els, t_els))

    if sk == "tuple" and tk == "array":
        elem = target.get("element") or unknown()
        return all(_is_assignable(e, elem, seen) for e in (source.get("elements") or []))

    if sk == "set" and tk == "set":
        return _is_assignable(source.get("element") or unknown(), target.get("element") or unknown(), seen)

    if sk == "map" and tk == "map":
        return (
            _is_assignable(source.get("key") or unknown(), target.get("key") or unknown(), seen)
            and _is_assignable(source.get("value") or unknown(), target.get("value") or unknown(), seen)
        )

    if sk == "function" and tk == "function":
        return _function_assignable(source, target, seen)

    if sk == "promise" and tk == "promise":
        return _is_assignable(source.get("resolved") or unknown(), target.get("resolved") or unknown(), seen)

    if sk == "object" and tk == "map" and not _is_display(source):
        # string-keyed object assignable to Map<string, V> if all values match
        if not _is_assignable(primitive("string"), target.get("key") or unknown(), seen):
            return False
        val_t = target.get("value") or unknown()
        return all(_is_assignable(v, val_t, seen) for v in (source.get("properties") or {}).values())

    return False


def _object_assignable(source: TypeNode, target: TypeNode, seen: Set[Tuple[str, str]]) -> bool:
    s_cn, t_cn = source.get("class_name"), target.get("class_name")
    if t_cn in DISPLAY_CLASSES:
        return s_cn == t_cn
    if s_cn in DISPLAY_CLASSES:
        return False
    t_props: Dict[str, TypeNode] = target.get("properties") or {}
    s_props: Dict[str, TypeNode] = source.get("properties") or {}
    for key, t_prop in t_props.items():
        t_inner, t_opt = unwrap_optional(t_prop)
        if key not in s_props:
            if not t_opt:
                return False
            continue
        s_prop = s_props[key]
        s_inner, s_opt = unwrap_optional(s_prop)
        if s_opt and not t_opt:
            return False
        if not _is_assignable(s_inner, t_inner, seen):
            return False
    return True


def _function_assignable(source: TypeNode, target: TypeNode, seen: Set[Tuple[str, str]]) -> bool:
    # Source may have fewer params. Target params must be assignable to source params (contravariant).
    s_params = list(source.get("params") or [])
    t_params = list(target.get("params") or [])
    for i, s_p in enumerate(s_params):
        if i >= len(t_params):
            break
        if not _is_assignable(t_params[i], s_p, seen):
            return False
    return _is_assignable(source.get("returnType") or unknown(), target.get("returnType") or unknown(), seen)


def _literal_in_enum(lit: TypeNode, enum_node: TypeNode) -> bool:
    members = enum_node.get("members") or {}
    values = members.values() if isinstance(members, dict) else members
    for v in values:
        if isinstance(v, dict):
            if v.get("kind") == "literal" and _literal_values_equal(v.get("value"), lit.get("value")):
                return True
            if types_equal(v, lit):
                return True
        elif _literal_values_equal(v, lit.get("value")):
            return True
    return False


# ---------------------------------------------------------------------------
# Utility types
# ---------------------------------------------------------------------------

def keyof(node: TypeNode) -> TypeNode:
    """`keyof T` — union of string (or number) literal keys."""
    node = normalize(node)
    if node.get("kind") == "union":
        key_sets: List[Set[Any]] = []
        for m in node.get("members") or []:
            k = keyof(m)
            vals = _literal_key_values(k)
            if vals is None:
                return never()
            key_sets.append(vals)
        if not key_sets:
            return never()
        common = set.intersection(*key_sets)
        return _literals_from_values(common)
    if node.get("kind") == "object":
        keys = list((node.get("properties") or {}).keys())
        return _literals_from_values(keys)
    if node.get("kind") == "map":
        return normalize(node.get("key") or primitive("string"))
    if node.get("kind") == "tuple":
        n = len(node.get("elements") or [])
        return _literals_from_values(list(range(n)))
    if node.get("kind") == "array":
        return primitive("integer")
    return never()


def indexed_access(node: TypeNode, index: TypeNode | str | int) -> TypeNode:
    """`T[K]`."""
    node = normalize(node)
    if not isinstance(index, dict):
        index = literal(index)
    else:
        index = normalize(index)

    if index.get("kind") == "union":
        return unify_all([indexed_access(node, m) for m in (index.get("members") or [])])

    if node.get("kind") == "union":
        return unify_all([indexed_access(m, index) for m in (node.get("members") or [])])

    if node.get("kind") == "optional":
        inner, _ = unwrap_optional(node)
        return make_union([indexed_access(inner, index), undefined()])

    if node.get("kind") == "object":
        key = _as_str_key(index)
        if key is None:
            return unknown()
        props = node.get("properties") or {}
        if key not in props:
            return undefined()
        return normalize(props[key])

    if node.get("kind") == "tuple":
        if index.get("kind") == "literal" and isinstance(index.get("value"), int):
            els = node.get("elements") or []
            i = index["value"]
            if 0 <= i < len(els):
                return normalize(els[i])
            return undefined()
        if index.get("kind") == "primitive" and index.get("name") in ("integer", "number"):
            return unify_all(node.get("elements") or []) or unknown()
        return unknown()

    if node.get("kind") == "array":
        if index.get("kind") == "literal" and isinstance(index.get("value"), int):
            return normalize(node.get("element") or unknown())
        if index.get("kind") == "primitive" and index.get("name") in ("integer", "number"):
            return normalize(node.get("element") or unknown())
        return unknown()

    if node.get("kind") == "map":
        return normalize(node.get("value") or unknown())

    return unknown()


def Partial(node: TypeNode) -> TypeNode:
    """`Partial<T>` — all properties optional."""
    node = normalize(node)
    if node.get("kind") == "union":
        return make_union([Partial(m) for m in (node.get("members") or [])])
    if node.get("kind") != "object":
        return node
    props = {k: make_optional(v) for k, v in (node.get("properties") or {}).items()}
    result: TypeNode = {"kind": "object", "properties": props}
    if node.get("class_name"):
        result["class_name"] = node["class_name"]
    return result


def Required(node: TypeNode) -> TypeNode:
    """`Required<T>` — unwrap optional properties."""
    node = normalize(node)
    if node.get("kind") == "union":
        return make_union([Required(m) for m in (node.get("members") or [])])
    if node.get("kind") != "object":
        inner, opt = unwrap_optional(node)
        return inner if opt else node
    props = {k: unwrap_optional(v)[0] for k, v in (node.get("properties") or {}).items()}
    result: TypeNode = {"kind": "object", "properties": props}
    if node.get("class_name"):
        result["class_name"] = node["class_name"]
    return result


def Pick(node: TypeNode, keys: KeySpec) -> TypeNode:
    """`Pick<T, K>`."""
    node = normalize(node)
    if node.get("kind") == "union":
        return make_union([Pick(m, keys) for m in (node.get("members") or [])])
    key_set = _keys_from_spec(keys)
    if node.get("kind") != "object" or key_set is None:
        return never()
    props = {k: v for k, v in (node.get("properties") or {}).items() if k in key_set}
    result: TypeNode = {"kind": "object", "properties": props}
    if node.get("class_name"):
        result["class_name"] = node["class_name"]
    return result


def Omit(node: TypeNode, keys: KeySpec) -> TypeNode:
    """`Omit<T, K>`."""
    node = normalize(node)
    if node.get("kind") == "union":
        return make_union([Omit(m, keys) for m in (node.get("members") or [])])
    key_set = _keys_from_spec(keys)
    if node.get("kind") != "object" or key_set is None:
        return node
    props = {k: v for k, v in (node.get("properties") or {}).items() if k not in key_set}
    result: TypeNode = {"kind": "object", "properties": props}
    if node.get("class_name"):
        result["class_name"] = node["class_name"]
    return result


def Exclude(union_node: TypeNode, excluded: TypeNode) -> TypeNode:
    """`Exclude<T, U>` — drop union members assignable to U."""
    union_node = normalize(union_node)
    excluded = normalize(excluded)
    members = union_node.get("members") if union_node.get("kind") == "union" else [union_node]
    kept = [m for m in members if not is_assignable(m, excluded)]
    return make_union(kept) if kept else never()


def Extract(union_node: TypeNode, extracted: TypeNode) -> TypeNode:
    """`Extract<T, U>` — keep union members assignable to U."""
    union_node = normalize(union_node)
    extracted = normalize(extracted)
    members = union_node.get("members") if union_node.get("kind") == "union" else [union_node]
    kept = [m for m in members if is_assignable(m, extracted)]
    return make_union(kept) if kept else never()


def NonNullable(node: TypeNode) -> TypeNode:
    """`NonNullable<T>` — drop null and undefined."""
    node = normalize(node)
    if is_optional(node):
        inner, _ = unwrap_optional(node)
        return NonNullable(inner)
    if node.get("kind") == "union":
        kept = [
            m for m in (node.get("members") or [])
            if not is_null(m) and not is_undefined(m)
        ]
        return make_union(kept) if kept else never()
    if is_null(node) or is_undefined(node):
        return never()
    return node


def ReturnType(node: TypeNode) -> TypeNode:
    """`ReturnType<T>` for function types."""
    node = normalize(node)
    if node.get("kind") == "union":
        return unify_all([ReturnType(m) for m in (node.get("members") or [])])
    if node.get("kind") == "function":
        return normalize(node.get("returnType") or unknown())
    return unknown()


def Awaited(node: TypeNode) -> TypeNode:
    """`Awaited<T>` — unwrap Promise/thenable layers."""
    node = normalize(node)
    if node.get("kind") == "union":
        return unify_all([Awaited(m) for m in (node.get("members") or [])])
    if node.get("kind") == "promise":
        return Awaited(node.get("resolved") or unknown())
    return node


# ---------------------------------------------------------------------------
# Key helpers
# ---------------------------------------------------------------------------

def _keys_from_spec(spec: KeySpec) -> Optional[Set[str]]:
    if isinstance(spec, str):
        return {spec}
    if isinstance(spec, dict):
        spec = normalize(spec)
        vals = _literal_key_values(spec)
        if vals is None:
            return None
        return {str(v) for v in vals}
    if isinstance(spec, (list, tuple, set, frozenset)):
        out: Set[str] = set()
        for item in spec:
            if isinstance(item, str):
                out.add(item)
            elif isinstance(item, dict):
                nested = _keys_from_spec(item)
                if nested:
                    out |= nested
            else:
                out.add(str(item))
        return out
    return None


def _literal_key_values(node: TypeNode) -> Optional[Set[Any]]:
    node = normalize(node)
    if node.get("kind") == "literal":
        return {node.get("value")}
    if node.get("kind") == "union":
        acc: Set[Any] = set()
        for m in node.get("members") or []:
            inner = _literal_key_values(m)
            if inner is None:
                return None
            acc |= inner
        return acc
    if is_never(node):
        return set()
    return None


def _literals_from_values(values: Iterable[Any]) -> TypeNode:
    vals = list(values)
    if not vals:
        return never()
    return make_union([literal(v) for v in vals])


def _as_str_key(index: TypeNode) -> Optional[str]:
    if index.get("kind") == "literal":
        v = index.get("value")
        if isinstance(v, str):
            return v
        if isinstance(v, int) and not isinstance(v, bool):
            return str(v)
    return None
