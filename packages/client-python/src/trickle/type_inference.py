"""Infer a TypeNode dict from an arbitrary Python runtime value."""

from __future__ import annotations

import dataclasses
import datetime
import enum
import inspect
from typing import Any, Dict, Set


def infer_type(value: Any, max_depth: int = 5, _seen: Set[int] | None = None) -> Dict[str, Any]:
    """Infer a TypeNode dictionary for *value*.

    Parameters
    ----------
    value:
        Any Python object.
    max_depth:
        Maximum recursion depth to prevent runaway inference on deeply nested
        structures.  Once exhausted the function returns a generic
        ``{"kind": "primitive", "name": "unknown"}`` node.
    _seen:
        Internal set of ``id()`` values used for circular-reference detection.
    """
    if max_depth <= 0:
        return {"kind": "primitive", "name": "unknown"}

    if _seen is None:
        _seen = set()

    # --- Circular reference guard (only for mutable containers / objects) ---
    obj_id = id(value)
    if obj_id in _seen:
        return {"kind": "primitive", "name": "circular_ref"}

    # --- None ---
    if value is None:
        return {"kind": "primitive", "name": "null"}

    # --- bool (MUST come before int — bool is a subclass of int) ---
    if isinstance(value, bool):
        return {"kind": "primitive", "name": "boolean"}

    # --- int / float ---
    if isinstance(value, (int, float)):
        return {"kind": "primitive", "name": "number"}

    # --- str ---
    if isinstance(value, str):
        return {"kind": "primitive", "name": "string"}

    # --- bytes / bytearray ---
    if isinstance(value, (bytes, bytearray)):
        return {"kind": "primitive", "name": "bytes"}

    # --- datetime family ---
    if isinstance(value, datetime.datetime):
        return {"kind": "primitive", "name": "datetime"}
    if isinstance(value, datetime.date):
        return {"kind": "primitive", "name": "date"}
    if isinstance(value, datetime.time):
        return {"kind": "primitive", "name": "time"}

    # --- Enum ---
    if isinstance(value, enum.Enum):
        return {"kind": "primitive", "name": "string"}

    # --- Callable (functions, methods, lambdas, built-ins) ---
    if callable(value) and not isinstance(value, type):
        name = getattr(value, "__name__", getattr(value, "__qualname__", "anonymous"))
        return {"kind": "function", "name": name}

    # -- From here on, structures may be recursive, so register id --
    _seen = _seen | {obj_id}  # copy so siblings don't interfere

    # --- list ---
    if isinstance(value, list):
        element_type = _unify_element_types(value[:20], max_depth - 1, _seen)
        return {"kind": "array", "element": element_type}

    # --- tuple ---
    if isinstance(value, tuple):
        # Named tuples (typing.NamedTuple or collections.namedtuple)
        if hasattr(value, "_fields"):
            props: Dict[str, Any] = {}
            for field_name in value._fields:
                props[field_name] = infer_type(getattr(value, field_name), max_depth - 1, _seen)
            return {"kind": "object", "properties": props, "class_name": type(value).__name__}
        elements = [infer_type(el, max_depth - 1, _seen) for el in value]
        return {"kind": "tuple", "elements": elements}

    # --- set / frozenset ---
    if isinstance(value, (set, frozenset)):
        sampled = list(value)[:20]
        element_type = _unify_element_types(sampled, max_depth - 1, _seen)
        return {"kind": "set", "element": element_type}

    # --- dict ---
    if isinstance(value, dict):
        props = {}
        for k, v in value.items():
            props[str(k)] = infer_type(v, max_depth - 1, _seen)
        return {"kind": "object", "properties": props}

    # --- dataclass ---
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        props = {}
        for field in dataclasses.fields(value):
            props[field.name] = infer_type(getattr(value, field.name), max_depth - 1, _seen)
        return {"kind": "object", "properties": props, "class_name": type(value).__name__}

    # --- Pydantic models ---
    pydantic_fields = _get_pydantic_fields(value)
    if pydantic_fields is not None:
        props = {}
        for field_name in pydantic_fields:
            try:
                props[field_name] = infer_type(getattr(value, field_name), max_depth - 1, _seen)
            except Exception:
                props[field_name] = {"kind": "primitive", "name": "unknown"}
        return {"kind": "object", "properties": props, "class_name": type(value).__name__}

    # --- Fallback: generic object with public attributes ---
    try:
        attrs = {
            k: v
            for k, v in inspect.getmembers(value)
            if not k.startswith("_") and not callable(v)
        }
        if attrs:
            props = {}
            for k, v in attrs.items():
                props[k] = infer_type(v, max_depth - 1, _seen)
            return {"kind": "object", "properties": props, "class_name": type(value).__name__}
    except Exception:
        pass

    return {"kind": "primitive", "name": "unknown"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_pydantic_fields(value: Any) -> list[str] | None:
    """Return field names for a Pydantic model instance, or None."""
    cls = type(value)
    # Pydantic v2
    if hasattr(cls, "model_fields"):
        return list(cls.model_fields.keys())
    # Pydantic v1
    if hasattr(cls, "__fields__"):
        return list(cls.__fields__.keys())
    return None


def _unify_element_types(elements: list, max_depth: int, _seen: Set[int]) -> Dict[str, Any]:
    """Infer the unified type for a collection of elements.

    If all elements share the same type node, return that single type.
    Otherwise return a union of the distinct types.
    """
    if not elements:
        return {"kind": "primitive", "name": "unknown"}

    types: list[Dict[str, Any]] = []
    seen_reprs: set[str] = set()
    for el in elements:
        t = infer_type(el, max_depth, _seen)
        # Deduplicate by repr (cheap canonical form)
        r = _stable_repr(t)
        if r not in seen_reprs:
            seen_reprs.add(r)
            types.append(t)

    if len(types) == 1:
        return types[0]
    return {"kind": "union", "members": types}


def _stable_repr(node: Dict[str, Any]) -> str:
    """Produce a deterministic string for a type node (for dedup only)."""
    import json
    return json.dumps(node, sort_keys=True)
