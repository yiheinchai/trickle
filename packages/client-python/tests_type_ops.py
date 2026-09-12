"""Tests for Python TypeNode inference and algebraic type_ops.

Run:
    python3 packages/client-python/tests_type_ops.py
    python3 -m pytest packages/client-python/tests_type_ops.py
"""

from __future__ import annotations

import enum
import sys
import unittest
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from trickle.type_inference import infer_type, _unify_element_types  # noqa: E402
from trickle.type_ops import (  # noqa: E402
    Awaited,
    Exclude,
    Extract,
    NonNullable,
    Omit,
    Partial,
    Pick,
    Required,
    ReturnType,
    indexed_access,
    is_assignable,
    keyof,
    literal,
    primitive,
    types_equal,
    unify,
    unify_all,
)


def _opt_inner(node):
    if node.get("kind") == "optional":
        return node.get("type")
    return node


class InferTypeSmoke(unittest.TestCase):
    def test_none(self):
        t = infer_type(None)
        self.assertEqual(t.get("kind"), "primitive")
        self.assertEqual(t.get("name"), "null")

    def test_bool_literal(self):
        t = infer_type(True)
        self.assertEqual(t, {"kind": "literal", "value": True})
        self.assertEqual(infer_type(False), {"kind": "literal", "value": False})

    def test_small_int_literal(self):
        t = infer_type(1)
        self.assertEqual(t, {"kind": "literal", "value": 1})
        self.assertEqual(infer_type(-9999)["kind"], "literal")

    def test_large_int_primitive(self):
        t = infer_type(10_000)
        self.assertEqual(t, {"kind": "primitive", "name": "integer"})
        self.assertEqual(infer_type(-10_000)["kind"], "primitive")

    def test_short_string_literal(self):
        t = infer_type("x")
        self.assertEqual(t, {"kind": "literal", "value": "x"})

    def test_long_string_primitive(self):
        t = infer_type("a" * 65)
        self.assertEqual(t, {"kind": "primitive", "name": "string"})

    def test_homogeneous_int_list_is_array(self):
        t = infer_type([1, 2])
        self.assertEqual(t["kind"], "array")
        elem = t["element"]
        # Distinct int literals unify to a union of literals (not a tuple).
        if elem.get("kind") == "union":
            values = {m.get("value") for m in elem["members"]}
            self.assertEqual(values, {1, 2})
        else:
            self.assertEqual(elem.get("kind"), "literal")

    def test_heterogeneous_list_is_tuple(self):
        t = infer_type([1, "a"])
        self.assertEqual(t["kind"], "tuple")
        self.assertEqual(len(t["elements"]), 2)
        self.assertEqual(t["elements"][0], {"kind": "literal", "value": 1})
        self.assertEqual(t["elements"][1], {"kind": "literal", "value": "a"})

    def test_single_dict_keys_required(self):
        t = infer_type({"a": 1})
        self.assertEqual(t["kind"], "object")
        self.assertEqual(t["properties"]["a"], {"kind": "literal", "value": 1})
        self.assertNotEqual(t["properties"]["a"].get("kind"), "optional")

    def test_dict_mixed_values(self):
        t = infer_type({"a": 1, "b": "s"})
        self.assertEqual(t["kind"], "object")
        self.assertEqual(t["properties"]["a"]["value"], 1)
        self.assertEqual(t["properties"]["b"]["value"], "s")
        self.assertNotEqual(t["properties"]["a"].get("kind"), "optional")
        self.assertNotEqual(t["properties"]["b"].get("kind"), "optional")

    def test_python_tuple(self):
        t = infer_type((1, "x"))
        self.assertEqual(t["kind"], "tuple")
        self.assertEqual(t["elements"][0]["value"], 1)
        self.assertEqual(t["elements"][1]["value"], "x")

    def test_class_instance(self):
        class Point:
            def __init__(self):
                self.x = 1
                self.y = 2

        t = infer_type(Point())
        self.assertEqual(t["kind"], "object")
        self.assertEqual(t.get("class_name"), "Point")
        self.assertEqual(t["properties"]["x"]["value"], 1)
        self.assertEqual(t["properties"]["y"]["value"], 2)

    def test_set(self):
        t = infer_type({1, 2})
        self.assertEqual(t["kind"], "set")
        self.assertIn(t["element"]["kind"], ("literal", "union"))

    def test_non_str_keys_are_map(self):
        t = infer_type({1: "a", 2: "b"})
        self.assertEqual(t["kind"], "map")
        self.assertEqual(t["key"]["kind"] in ("literal", "union", "primitive"), True)

    def test_wide_str_keys_are_map(self):
        d = {f"k{i}": i for i in range(31)}
        t = infer_type(d)
        self.assertEqual(t["kind"], "map")

    def test_function_signature(self):
        def greet(name, times):
            return name * times

        t = infer_type(greet)
        self.assertEqual(t["kind"], "function")
        self.assertEqual(len(t["params"]), 2)
        self.assertEqual(t["params"][0]["name"], "unknown")
        self.assertEqual(t["returnType"]["name"], "unknown")
        self.assertEqual(t.get("name"), "greet")

    def test_enum(self):
        class Color(enum.Enum):
            RED = "red"
            BLUE = "blue"

        t = infer_type(Color.RED)
        self.assertEqual(t["kind"], "enum")
        self.assertEqual(t["name"], "Color")
        self.assertIn("RED", t["members"])
        self.assertEqual(t["members"]["RED"]["value"], "red")

    def test_bytes_datetime(self):
        import datetime as dt

        self.assertEqual(infer_type(b"hi"), {"kind": "primitive", "name": "bytes"})
        self.assertEqual(infer_type(dt.datetime(2020, 1, 1)).get("name"), "datetime")

    def test_compatible_dict_list_unifies_optional(self):
        t = infer_type([{"a": 1}, {"a": 1, "b": 2}])
        self.assertEqual(t["kind"], "array")
        elem = t["element"]
        self.assertEqual(elem["kind"], "object")
        self.assertNotEqual(elem["properties"]["a"].get("kind"), "optional")
        self.assertEqual(elem["properties"]["b"].get("kind"), "optional")


class UnifyTests(unittest.TestCase):
    def test_unify_compatible_objects_optional_missing_keys(self):
        a = infer_type({"a": 1})
        b = infer_type({"a": 1, "b": 2})
        u = unify(a, b)
        self.assertEqual(u["kind"], "object", u)
        self.assertNotEqual(u["kind"], "union")
        self.assertEqual(_opt_inner(u["properties"]["a"]).get("value"), 1)
        self.assertEqual(u["properties"]["b"]["kind"], "optional")
        self.assertEqual(u["properties"]["b"]["type"]["value"], 2)

    def test_unify_literals_same_value(self):
        self.assertTrue(types_equal(unify(literal(1), literal(1)), literal(1)))

    def test_literal_widens_to_primitive(self):
        u = unify(literal(1), primitive("integer"))
        self.assertEqual(u, primitive("integer"))
        u2 = unify(literal("hi"), primitive("string"))
        self.assertEqual(u2, primitive("string"))
        u3 = unify(literal(True), primitive("boolean"))
        self.assertEqual(u3, primitive("boolean"))

    def test_unify_all_via_element_helper(self):
        u = _unify_element_types([{"a": 1}, {"a": 1, "b": 2}], max_depth=4, _seen=set())
        self.assertEqual(u["kind"], "object")
        self.assertEqual(u["properties"]["b"]["kind"], "optional")

    def test_unify_tuples_same_length(self):
        u = unify(infer_type((1, "x")), infer_type((2, "y")))
        self.assertEqual(u["kind"], "tuple")
        self.assertEqual(u["elements"][0]["kind"], "union")

    def test_display_tensors_equal_regardless_of_props(self):
        a = {"kind": "object", "class_name": "Tensor", "properties": {"shape": primitive(" [1]")}}
        b = {"kind": "object", "class_name": "Tensor", "properties": {"shape": primitive(" [2, 2]")}}
        self.assertTrue(types_equal(a, b))
        self.assertEqual(unify(a, b)["class_name"], "Tensor")


class AssignabilityTests(unittest.TestCase):
    def test_literal_to_base(self):
        self.assertTrue(is_assignable(literal(1), primitive("integer")))
        self.assertTrue(is_assignable(literal(1), primitive("number")))
        self.assertTrue(is_assignable(literal(True), primitive("boolean")))
        self.assertTrue(is_assignable(literal("x"), primitive("string")))
        self.assertFalse(is_assignable(primitive("integer"), literal(1)))

    def test_extra_props_ok_missing_required_not(self):
        src = infer_type({"a": 1, "b": 2})
        tgt = infer_type({"a": 1})
        self.assertTrue(is_assignable(src, tgt))
        self.assertFalse(is_assignable(tgt, src))

    def test_optional_property(self):
        merged = unify(infer_type({"a": 1}), infer_type({"a": 1, "b": 2}))
        src_without_b = infer_type({"a": 1})
        self.assertTrue(is_assignable(src_without_b, merged))

    def test_tuple_to_array(self):
        tup = infer_type((1, 2))
        arr = {"kind": "array", "element": primitive("integer")}
        self.assertTrue(is_assignable(tup, arr))

    def test_unknown_is_top(self):
        self.assertTrue(is_assignable(literal(1), primitive("unknown")))


class UtilityTests(unittest.TestCase):
    def test_keyof_and_indexed_access(self):
        obj = infer_type({"a": 1, "b": "s"})
        keys = keyof(obj)
        self.assertEqual(keys["kind"], "union")
        names = {m["value"] for m in keys["members"]}
        self.assertEqual(names, {"a", "b"})
        self.assertEqual(indexed_access(obj, "a")["value"], 1)
        self.assertEqual(indexed_access(obj, literal("b"))["value"], "s")

    def test_partial_required_pick_omit(self):
        obj = infer_type({"a": 1, "b": "s"})
        p = Partial(obj)
        self.assertEqual(p["properties"]["a"]["kind"], "optional")
        self.assertEqual(p["properties"]["b"]["kind"], "optional")
        r = Required(p)
        self.assertEqual(r["properties"]["a"].get("kind"), "literal")
        picked = Pick(obj, ["a"])
        self.assertEqual(set(picked["properties"]), {"a"})
        omitted = Omit(obj, ["a"])
        self.assertEqual(set(omitted["properties"]), {"b"})

    def test_exclude_extract_nonnullable(self):
        u = unify_all([literal(1), literal("x"), primitive("null")])
        self.assertEqual(u["kind"], "union")
        extracted = Extract(u, primitive("string"))
        self.assertEqual(extracted.get("value"), "x")
        excluded = Exclude(u, primitive("string"))
        members = excluded["members"] if excluded.get("kind") == "union" else [excluded]
        kinds_or_values = {(m.get("kind"), m.get("value"), m.get("name")) for m in members}
        self.assertTrue(any(m.get("value") == 1 for m in members))
        self.assertFalse(any(m.get("value") == "x" for m in members))
        nn = NonNullable(u)
        nn_members = nn["members"] if nn.get("kind") == "union" else [nn]
        self.assertFalse(any(m.get("name") == "null" for m in nn_members))
        self.assertIsNotNone(kinds_or_values)

    def test_return_type_and_awaited(self):
        fn = {
            "kind": "function",
            "params": [primitive("unknown")],
            "returnType": {"kind": "promise", "resolved": primitive("string")},
        }
        self.assertEqual(ReturnType(fn)["kind"], "promise")
        self.assertEqual(Awaited(ReturnType(fn)), primitive("string"))
        self.assertEqual(Awaited(primitive("integer")), primitive("integer"))


class SpecialCases(unittest.TestCase):
    def test_ndarray_if_numpy_present(self):
        try:
            import numpy as np  # noqa: F401
        except Exception:
            self.skipTest("numpy not installed")
        import numpy as np

        t = infer_type(np.zeros((2, 3)))
        self.assertEqual(t["kind"], "object")
        self.assertEqual(t.get("class_name"), "ndarray")
        self.assertIn("shape", t["properties"])
        self.assertIn("dtype", t["properties"])

    def test_float_simple_literal(self):
        t = infer_type(1.5)
        self.assertEqual(t["kind"], "literal")
        self.assertEqual(t["value"], 1.5)


if __name__ == "__main__":
    unittest.main()
