"""Produce a stable hash for a function's type signature."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List


def hash_type(args_type: Dict[str, Any], return_type: Dict[str, Any]) -> str:
    """Return the first 16 hex characters of the SHA-256 hash of the
    canonicalized ``(args_type, return_type)`` pair."""
    canonical = {
        "args": _canonicalize(args_type),
        "return": _canonicalize(return_type),
    }
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _canonicalize(node: Any) -> Any:
    """Recursively sort all dict keys and union members to produce a
    deterministic representation."""
    if isinstance(node, dict):
        result: Dict[str, Any] = {}
        for key in sorted(node.keys()):
            value = node[key]
            result[key] = _canonicalize(value)
        # Sort union members for stability
        if result.get("kind") == "union" and "members" in result:
            result["members"] = sorted(
                result["members"],
                key=lambda m: json.dumps(m, sort_keys=True, separators=(",", ":")),
            )
        return result
    if isinstance(node, list):
        return [_canonicalize(item) for item in node]
    return node
