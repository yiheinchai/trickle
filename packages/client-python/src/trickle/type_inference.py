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

    # --- int ---
    if isinstance(value, int):
        return {"kind": "primitive", "name": "integer"}

    # --- float ---
    if isinstance(value, float):
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

    # --- PyTorch Tensor ---
    _tensor_type = _get_torch_tensor_type()
    if _tensor_type is not None and isinstance(value, _tensor_type):
        props: Dict[str, Any] = {
            "shape": {"kind": "primitive", "name": str(list(value.shape))},
            "dtype": {"kind": "primitive", "name": str(value.dtype)},
        }
        if hasattr(value, "device"):
            props["device"] = {"kind": "primitive", "name": str(value.device)}
        if hasattr(value, "requires_grad"):
            props["requires_grad"] = {"kind": "primitive", "name": str(value.requires_grad)}
        if hasattr(value, "grad_fn") and value.grad_fn is not None:
            props["grad_fn"] = {"kind": "primitive", "name": type(value.grad_fn).__name__}
        # Scalar tensors: capture actual value
        if value.numel() <= 1:
            try:
                props["value"] = {"kind": "primitive", "name": f"{value.detach().item():.6g}"}
            except Exception:
                pass
        # Stats and NaN/Inf detection for floating-point tensors
        # Use detach + no_grad to avoid polluting the autograd graph
        # Skip stats on very large tensors (>10M elements) for performance
        _MAX_STAT_NUMEL = 10_000_000
        if value.is_floating_point() and value.numel() > 0:
            try:
                import torch
                v = value.detach()
                with torch.no_grad():
                    numel = v.numel()
                    if numel <= _MAX_STAT_NUMEL:
                        nan_count = int(torch.isnan(v).sum().item())
                        inf_count = int(torch.isinf(v).sum().item())
                        if nan_count > 0:
                            props["nan_count"] = {"kind": "primitive", "name": str(nan_count)}
                        if inf_count > 0:
                            props["inf_count"] = {"kind": "primitive", "name": str(inf_count)}
                        # Min/max/mean for non-scalar tensors (only on finite values)
                        if numel > 1:
                            finite = v[torch.isfinite(v)] if (nan_count + inf_count) > 0 else v
                            if finite.numel() > 0:
                                props["min"] = {"kind": "primitive", "name": f"{finite.min().item():.4g}"}
                                props["max"] = {"kind": "primitive", "name": f"{finite.max().item():.4g}"}
                                props["mean"] = {"kind": "primitive", "name": f"{finite.mean().item():.4g}"}
                    else:
                        # For very large tensors, only check NaN on a sample
                        sample_idx = torch.randint(0, numel, (min(100_000, numel),))
                        flat = v.reshape(-1)[sample_idx]
                        nan_count = int(torch.isnan(flat).sum().item())
                        if nan_count > 0:
                            props["nan_count"] = {"kind": "primitive", "name": f"~{nan_count * (numel // len(sample_idx))}"}
                        props["numel"] = {"kind": "primitive", "name": f"{numel:,}"}
            except Exception:
                pass
        return {"kind": "object", "properties": props, "class_name": "Tensor"}

    # --- NumPy ndarray ---
    _ndarray_type = _get_numpy_ndarray_type()
    if _ndarray_type is not None and isinstance(value, _ndarray_type):
        props = {
            "shape": {"kind": "primitive", "name": str(list(value.shape))},
            "dtype": {"kind": "primitive", "name": str(value.dtype)},
        }
        if value.size <= 1:
            try:
                props["value"] = {"kind": "primitive", "name": f"{value.item():.6g}"}
            except Exception:
                pass
        # Stats and NaN/Inf detection for floating-point arrays
        if value.dtype.kind == 'f' and value.size > 0:
            try:
                import numpy as np
                nan_count = int(np.isnan(value).sum())
                inf_count = int(np.isinf(value).sum())
                if nan_count > 0:
                    props["nan_count"] = {"kind": "primitive", "name": str(nan_count)}
                if inf_count > 0:
                    props["inf_count"] = {"kind": "primitive", "name": str(inf_count)}
                if value.size > 1:
                    finite = value[np.isfinite(value)] if (nan_count + inf_count) > 0 else value
                    if finite.size > 0:
                        props["min"] = {"kind": "primitive", "name": f"{finite.min():.4g}"}
                        props["max"] = {"kind": "primitive", "name": f"{finite.max():.4g}"}
                        props["mean"] = {"kind": "primitive", "name": f"{finite.mean():.4g}"}
            except Exception:
                pass
        return {"kind": "object", "properties": props, "class_name": "ndarray"}

    # --- PyTorch nn.Module (MUST come before callable — modules are callable) ---
    _module_type = _get_torch_module_type()
    if _module_type is not None and isinstance(value, _module_type):
        return _infer_nn_module(value)

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


_torch_tensor_type: Any = None
_torch_checked = False


def _get_torch_tensor_type() -> Any:
    """Lazily resolve torch.Tensor to avoid import overhead when torch isn't used."""
    global _torch_tensor_type, _torch_checked
    if _torch_checked:
        return _torch_tensor_type
    _torch_checked = True
    try:
        import torch
        _torch_tensor_type = torch.Tensor
    except ImportError:
        pass
    return _torch_tensor_type


_torch_module_type: Any = None
_torch_module_checked = False


def _get_torch_module_type() -> Any:
    """Lazily resolve torch.nn.Module."""
    global _torch_module_type, _torch_module_checked
    if _torch_module_checked:
        return _torch_module_type
    _torch_module_checked = True
    try:
        import torch.nn
        _torch_module_type = torch.nn.Module
    except ImportError:
        pass
    return _torch_module_type


# Map of nn.Module subclass names to their key attributes to extract
_MODULE_KEY_ATTRS: Dict[str, list] = {
    "Linear": ["in_features", "out_features", "bias"],
    "Conv1d": ["in_channels", "out_channels", "kernel_size", "stride", "padding"],
    "Conv2d": ["in_channels", "out_channels", "kernel_size", "stride", "padding"],
    "Conv3d": ["in_channels", "out_channels", "kernel_size", "stride", "padding"],
    "BatchNorm1d": ["num_features", "eps", "momentum"],
    "BatchNorm2d": ["num_features", "eps", "momentum"],
    "LayerNorm": ["normalized_shape", "eps"],
    "RMSNorm": ["normalized_shape", "eps"],
    "Embedding": ["num_embeddings", "embedding_dim"],
    "Dropout": ["p"],
    "LSTM": ["input_size", "hidden_size", "num_layers", "bidirectional"],
    "GRU": ["input_size", "hidden_size", "num_layers", "bidirectional"],
    "RNN": ["input_size", "hidden_size", "num_layers", "bidirectional"],
    "MultiheadAttention": ["embed_dim", "num_heads", "dropout"],
    "TransformerEncoderLayer": ["d_model", "nhead", "dim_feedforward"],
    "TransformerDecoderLayer": ["d_model", "nhead", "dim_feedforward"],
}


def _infer_nn_module(value: Any) -> Dict[str, Any]:
    """Infer type for a torch.nn.Module instance.

    Returns a TypeNode with class_name and key properties like
    in_features, out_features for Linear layers.
    """
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    # Try to extract known key attributes for common module types
    key_attrs = _MODULE_KEY_ATTRS.get(class_name, [])
    for attr in key_attrs:
        try:
            val = getattr(value, attr, None)
            if val is not None:
                # Convert to a simple representation
                if isinstance(val, bool):
                    props[attr] = {"kind": "primitive", "name": str(val)}
                elif isinstance(val, (int, float)):
                    props[attr] = {"kind": "primitive", "name": str(val)}
                elif isinstance(val, (list, tuple)):
                    props[attr] = {"kind": "primitive", "name": str(val)}
                else:
                    props[attr] = {"kind": "primitive", "name": str(val)}
        except Exception:
            continue

    # For unknown module types, try to extract any simple numeric/bool attributes
    # Skip internal PyTorch module attrs that add noise
    _SKIP_MODULE_ATTRS = frozenset({
        "call_super_init", "dump_patches", "training",
        "T_destination", "FSDP_WRAPPED_MODULE",
    })
    if not key_attrs:
        try:
            for attr_name in dir(value):
                if attr_name.startswith("_") or attr_name in _SKIP_MODULE_ATTRS:
                    continue
                try:
                    val = getattr(value, attr_name)
                except Exception:
                    continue
                if isinstance(val, (int, float, bool)) and not callable(val):
                    props[attr_name] = {"kind": "primitive", "name": str(val)}
                if len(props) >= 6:
                    break
        except Exception:
            pass

    # Count parameters
    try:
        n_params = sum(p.numel() for p in value.parameters())
        props["params"] = {"kind": "primitive", "name": str(n_params)}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": class_name}


_numpy_ndarray_type: Any = None
_numpy_checked = False


def _get_numpy_ndarray_type() -> Any:
    """Lazily resolve numpy.ndarray to avoid import overhead when numpy isn't used."""
    global _numpy_ndarray_type, _numpy_checked
    if _numpy_checked:
        return _numpy_ndarray_type
    _numpy_checked = True
    try:
        import numpy
        _numpy_ndarray_type = numpy.ndarray
    except ImportError:
        pass
    return _numpy_ndarray_type


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
