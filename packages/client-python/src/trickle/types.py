"""Type definitions for Trickle's internal type representation.

TypeNode is a dict with a "kind" key and type-specific fields.
Examples:
  {"kind": "primitive", "name": "string"}
  {"kind": "object", "properties": {"name": {"kind": "primitive", "name": "string"}}}
  {"kind": "array", "element": {"kind": "primitive", "name": "number"}}
  {"kind": "union", "members": [...]}
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

try:
    from typing import TypedDict
except ImportError:
    from typing_extensions import TypedDict


class PrimitiveType(TypedDict):
    kind: str  # "primitive"
    name: str  # "string", "number", "boolean", "null", "bytes", "datetime", "date", "time"


class ArrayType(TypedDict):
    kind: str  # "array"
    element: TypeNode


class TupleType(TypedDict):
    kind: str  # "tuple"
    elements: List[TypeNode]


class SetType(TypedDict):
    kind: str  # "set"
    element: TypeNode


class ObjectType(TypedDict, total=False):
    kind: str  # "object"
    properties: Dict[str, TypeNode]
    class_name: str


class UnionType(TypedDict):
    kind: str  # "union"
    members: List[TypeNode]


class FunctionType(TypedDict, total=False):
    kind: str  # "function"
    name: str


# TypeNode is the union of all type representations.
TypeNode = Union[PrimitiveType, ArrayType, TupleType, SetType, ObjectType, UnionType, FunctionType, Dict[str, Any]]


class IngestPayload(TypedDict, total=False):
    function_name: str
    module: str
    args_type: TypeNode
    return_type: TypeNode
    variables_type: Optional[Dict[str, TypeNode]]
    type_hash: str
    environment: str
    timestamp: str
    error: Optional[str]
    error_type: Optional[str]
