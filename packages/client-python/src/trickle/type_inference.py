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
        # Capture whether gradient computation is enabled in the current context
        try:
            import torch
            if not torch.is_grad_enabled():
                props["grad_enabled"] = {"kind": "primitive", "name": "False"}
        except Exception:
            pass
        if hasattr(value, "grad_fn") and value.grad_fn is not None:
            props["grad_fn"] = {"kind": "primitive", "name": type(value.grad_fn).__name__}
        # Memory footprint
        try:
            nbytes = value.nelement() * value.element_size()
            if nbytes >= 1_073_741_824:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1_073_741_824:.1f} GB"}
            elif nbytes >= 1_048_576:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1_048_576:.1f} MB"}
            elif nbytes >= 1024:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1024:.1f} KB"}
            else:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes} B"}
        except Exception:
            pass
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
                        # Min/max/mean/std for non-scalar tensors (only on finite values)
                        if numel > 1:
                            finite = v[torch.isfinite(v)] if (nan_count + inf_count) > 0 else v
                            if finite.numel() > 0:
                                props["min"] = {"kind": "primitive", "name": f"{finite.min().item():.4g}"}
                                props["max"] = {"kind": "primitive", "name": f"{finite.max().item():.4g}"}
                                props["mean"] = {"kind": "primitive", "name": f"{finite.mean().item():.4g}"}
                                props["std"] = {"kind": "primitive", "name": f"{finite.std().item():.4g}"}
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
        # Memory footprint
        try:
            nbytes = value.nbytes
            if nbytes >= 1_073_741_824:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1_073_741_824:.1f} GB"}
            elif nbytes >= 1_048_576:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1_048_576:.1f} MB"}
            elif nbytes >= 1024:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes / 1024:.1f} KB"}
            else:
                props["memory"] = {"kind": "primitive", "name": f"{nbytes} B"}
        except Exception:
            pass
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
                        props["std"] = {"kind": "primitive", "name": f"{finite.std():.4g}"}
            except Exception:
                pass
        return {"kind": "object", "properties": props, "class_name": "ndarray"}

    # --- PyTorch nn.Module (MUST come before callable — modules are callable) ---
    _module_type = _get_torch_module_type()
    if _module_type is not None and isinstance(value, _module_type):
        return _infer_nn_module(value)

    # --- PyTorch Optimizer ---
    _optim_type = _get_torch_optimizer_type()
    if _optim_type is not None and isinstance(value, _optim_type):
        return _infer_optimizer(value)

    # --- PyTorch LR Scheduler ---
    _sched_type = _get_torch_scheduler_type()
    if _sched_type is not None and isinstance(value, _sched_type):
        return _infer_scheduler(value)

    # --- PyTorch DataLoader ---
    _dl_type = _get_torch_dataloader_type()
    if _dl_type is not None and isinstance(value, _dl_type):
        return _infer_dataloader(value)

    # --- PyTorch Dataset ---
    _ds_type = _get_torch_dataset_type()
    if _ds_type is not None and isinstance(value, _ds_type):
        return _infer_dataset(value)

    # --- Pandas DataFrame ---
    _df_type = _get_pandas_dataframe_type()
    if _df_type is not None and isinstance(value, _df_type):
        return _infer_dataframe(value)

    # --- Pandas Series ---
    _series_type = _get_pandas_series_type()
    if _series_type is not None and isinstance(value, _series_type):
        return _infer_series(value)

    # --- Pandas GroupBy ---
    _groupby_type = _get_pandas_groupby_type()
    if _groupby_type is not None and isinstance(value, _groupby_type):
        return _infer_groupby(value)

    # --- Pandas Index ---
    _index_type = _get_pandas_index_type()
    if _index_type is not None and isinstance(value, _index_type):
        return _infer_index(value)

    # --- Scikit-learn estimators ---
    _estimator_type = _get_sklearn_estimator_type()
    if _estimator_type is not None and isinstance(value, _estimator_type):
        return _infer_sklearn_estimator(value)

    # --- HuggingFace PretrainedConfig ---
    # Detected by presence of to_dict() and model_type (not a nn.Module itself)
    if hasattr(value, "to_dict") and hasattr(value, "model_type") and not callable(value):
        return _infer_hf_pretrained_config(value)

    # --- HuggingFace datasets ---
    _hf_dataset_type = _get_hf_dataset_type()
    if _hf_dataset_type is not None and isinstance(value, _hf_dataset_type):
        return _infer_hf_dataset(value)
    _hf_dataset_dict_type = _get_hf_dataset_dict_type()
    if _hf_dataset_dict_type is not None and isinstance(value, _hf_dataset_dict_type):
        return _infer_hf_dataset_dict(value)

    # --- Callable (functions, methods, lambdas, built-ins) ---
    if callable(value) and not isinstance(value, type):
        name = getattr(value, "__name__", getattr(value, "__qualname__", "anonymous"))
        return {"kind": "function", "name": name}

    # -- From here on, structures may be recursive, so register id --
    _seen = _seen | {obj_id}  # copy so siblings don't interfere

    # --- list ---
    if isinstance(value, list):
        sample = value[:20]
        element_type = _unify_element_types(sample, max_depth - 1, _seen)
        # For small heterogeneous lists (like asyncio.gather() results), show per-element
        # types as a positional tuple rather than array[union(...)]. This converts
        # `array[union(int, str, list[int])]` → `list[int, str, list[int]]`.
        if element_type.get("kind") == "union" and len(sample) <= 12:
            elements = [infer_type(el, max_depth - 1, _seen) for el in sample]
            return {"kind": "tuple", "elements": elements, "class_name": "list"}
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
        result: Dict[str, Any] = {"kind": "object", "properties": props}
        # For small dicts with string keys, set class_name so the renderer
        # can display inline values as {key: value} instead of {key: type}
        if len(value) <= 20 and all(isinstance(k, str) for k in value):
            result["class_name"] = "dict"
        return result

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
    except Exception:
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
    except Exception:
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

    # If the module has a `config` attribute, surface its primitive fields first.
    # This is the ML convention (GPT, BERT, T5, HuggingFace, etc.)
    try:
        config = getattr(value, "config", None)
        if config is not None and not isinstance(config, (int, float, bool, str, type)):
            from trickle._auto_var_tracer import _extract_config_fields
            config_fields = _extract_config_fields(config)
            # Insert config fields at the top of props (they're the most informative)
            new_props: Dict[str, Any] = {}
            for fname, val in list(config_fields.items())[:8]:
                new_props[fname] = {"kind": "primitive", "name": str(val)}
            new_props.update(props)
            props = new_props
    except Exception:
        pass

    # Capture training/eval mode
    try:
        props["training"] = {"kind": "primitive", "name": str(value.training)}
    except Exception:
        pass

    # Count parameters and compute model memory
    try:
        params_list = list(value.parameters())
        n_params = sum(p.numel() for p in params_list)
        props["params"] = {"kind": "primitive", "name": str(n_params)}
        # Total model memory (parameters + buffers)
        param_bytes = sum(p.numel() * p.element_size() for p in params_list)
        buffer_bytes = sum(b.numel() * b.element_size() for b in value.buffers())
        total_bytes = param_bytes + buffer_bytes
        if total_bytes >= 1_073_741_824:
            props["memory"] = {"kind": "primitive", "name": f"{total_bytes / 1_073_741_824:.1f} GB"}
        elif total_bytes >= 1_048_576:
            props["memory"] = {"kind": "primitive", "name": f"{total_bytes / 1_048_576:.1f} MB"}
        elif total_bytes >= 1024:
            props["memory"] = {"kind": "primitive", "name": f"{total_bytes / 1024:.1f} KB"}
        else:
            props["memory"] = {"kind": "primitive", "name": f"{total_bytes} B"}
    except Exception:
        pass

    # Gradient norms — after loss.backward(), show gradient health at a glance
    try:
        import torch
        grads = [p.grad for p in value.parameters() if p.grad is not None]
        if grads:
            # Total gradient norm (L2 across all parameters)
            total_norm = torch.sqrt(sum(g.detach().pow(2).sum() for g in grads)).item()
            props["grad_norm"] = {"kind": "primitive", "name": f"{total_norm:.4g}"}
            # Check for NaN/Inf gradients
            nan_grads = sum(1 for g in grads if torch.isnan(g).any())
            inf_grads = sum(1 for g in grads if torch.isinf(g).any())
            if nan_grads > 0:
                props["grad_nan"] = {"kind": "primitive", "name": str(nan_grads)}
            if inf_grads > 0:
                props["grad_inf"] = {"kind": "primitive", "name": str(inf_grads)}
            # Per-layer max gradient norm (top 3 by norm, helps find exploding layers)
            if len(grads) >= 2:
                layer_norms = []
                for name, p in value.named_parameters():
                    if p.grad is not None:
                        layer_norms.append((name, p.grad.detach().norm().item()))
                layer_norms.sort(key=lambda x: -x[1])
                top = layer_norms[:3]
                # Show last 2 path segments for context (e.g. "h.0.attn.weight")
                def _short_name(n: str) -> str:
                    parts = n.split(".")
                    return ".".join(parts[-2:]) if len(parts) > 2 else n
                top_str = ", ".join(f"{_short_name(n)}={v:.3g}" for n, v in top)
                props["grad_top"] = {"kind": "primitive", "name": top_str}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": class_name}


# --- PyTorch Optimizer support ---

_torch_optimizer_type: Any = None
_torch_optimizer_checked = False


def _get_torch_optimizer_type() -> Any:
    """Lazily resolve torch.optim.Optimizer."""
    global _torch_optimizer_type, _torch_optimizer_checked
    if _torch_optimizer_checked:
        return _torch_optimizer_type
    _torch_optimizer_checked = True
    try:
        import torch.optim
        _torch_optimizer_type = torch.optim.Optimizer
    except Exception:
        pass
    return _torch_optimizer_type


def _infer_optimizer(value: Any) -> Dict[str, Any]:
    """Infer type for a torch.optim.Optimizer instance."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    try:
        param_groups = value.param_groups
        if param_groups:
            pg = param_groups[0]
            if "lr" in pg:
                props["lr"] = {"kind": "primitive", "name": f"{pg['lr']:.6g}"}
            if "weight_decay" in pg and pg["weight_decay"] != 0:
                props["weight_decay"] = {"kind": "primitive", "name": f"{pg['weight_decay']:.6g}"}
            if "betas" in pg:
                props["betas"] = {"kind": "primitive", "name": str(pg["betas"])}
            if "momentum" in pg and pg["momentum"] != 0:
                props["momentum"] = {"kind": "primitive", "name": str(pg["momentum"])}
            if "eps" in pg:
                props["eps"] = {"kind": "primitive", "name": f"{pg['eps']:.1e}"}
        props["param_groups"] = {"kind": "primitive", "name": str(len(param_groups))}
        total_params = sum(sum(p.numel() for p in g["params"]) for g in param_groups)
        props["params"] = {"kind": "primitive", "name": str(total_params)}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": class_name}


# --- PyTorch LR Scheduler support ---

_torch_scheduler_type: Any = None
_torch_scheduler_checked = False


def _get_torch_scheduler_type() -> Any:
    """Lazily resolve torch.optim.lr_scheduler.LRScheduler."""
    global _torch_scheduler_type, _torch_scheduler_checked
    if _torch_scheduler_checked:
        return _torch_scheduler_type
    _torch_scheduler_checked = True
    try:
        import torch.optim.lr_scheduler
        # _LRScheduler for older PyTorch, LRScheduler for newer
        _torch_scheduler_type = getattr(
            torch.optim.lr_scheduler, "LRScheduler",
            getattr(torch.optim.lr_scheduler, "_LRScheduler", None)
        )
    except Exception:
        pass
    return _torch_scheduler_type


def _infer_scheduler(value: Any) -> Dict[str, Any]:
    """Infer type for a torch.optim.lr_scheduler instance."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    try:
        # Current learning rate(s)
        lrs = value.get_last_lr() if hasattr(value, "get_last_lr") else None
        if lrs:
            if len(lrs) == 1:
                props["lr"] = {"kind": "primitive", "name": f"{lrs[0]:.6g}"}
            else:
                props["lrs"] = {"kind": "primitive", "name": str([f"{lr:.6g}" for lr in lrs])}
    except Exception:
        pass

    # Common scheduler attributes
    for attr in ["step_size", "gamma", "T_max", "eta_min", "last_epoch"]:
        try:
            val = getattr(value, attr, None)
            if val is not None:
                if isinstance(val, float):
                    props[attr] = {"kind": "primitive", "name": f"{val:.6g}"}
                else:
                    props[attr] = {"kind": "primitive", "name": str(val)}
        except Exception:
            continue

    return {"kind": "object", "properties": props, "class_name": class_name}


# --- PyTorch DataLoader support ---

_torch_dataloader_type: Any = None
_torch_dataloader_checked = False


def _get_torch_dataloader_type() -> Any:
    """Lazily resolve torch.utils.data.DataLoader."""
    global _torch_dataloader_type, _torch_dataloader_checked
    if _torch_dataloader_checked:
        return _torch_dataloader_type
    _torch_dataloader_checked = True
    try:
        import torch.utils.data
        _torch_dataloader_type = torch.utils.data.DataLoader
    except Exception:
        pass
    return _torch_dataloader_type


def _infer_dataloader(value: Any) -> Dict[str, Any]:
    """Infer type for a torch.utils.data.DataLoader instance."""
    props: Dict[str, Any] = {}

    try:
        if value.batch_size is not None:
            props["batch_size"] = {"kind": "primitive", "name": str(value.batch_size)}
    except Exception:
        pass

    try:
        ds = value.dataset
        if hasattr(ds, "__len__"):
            props["dataset_size"] = {"kind": "primitive", "name": str(len(ds))}
        props["dataset"] = {"kind": "primitive", "name": type(ds).__name__}
    except Exception:
        pass

    try:
        if value.num_workers > 0:
            props["num_workers"] = {"kind": "primitive", "name": str(value.num_workers)}
    except Exception:
        pass

    for attr in ["shuffle", "drop_last", "pin_memory"]:
        try:
            val = getattr(value, attr, None)
            if val:  # Only show when True (non-default)
                props[attr] = {"kind": "primitive", "name": str(val)}
        except Exception:
            continue

    try:
        if hasattr(value.dataset, "__len__") and value.batch_size:
            import math
            n_batches = math.ceil(len(value.dataset) / value.batch_size)
            if getattr(value, "drop_last", False):
                n_batches = len(value.dataset) // value.batch_size
            props["batches"] = {"kind": "primitive", "name": str(n_batches)}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": "DataLoader"}


# --- PyTorch Dataset support ---

_torch_dataset_type: Any = None
_torch_dataset_checked = False


def _get_torch_dataset_type() -> Any:
    """Lazily resolve torch.utils.data.Dataset."""
    global _torch_dataset_type, _torch_dataset_checked
    if _torch_dataset_checked:
        return _torch_dataset_type
    _torch_dataset_checked = True
    try:
        import torch.utils.data
        _torch_dataset_type = torch.utils.data.Dataset
    except Exception:
        pass
    return _torch_dataset_type


def _infer_dataset(value: Any) -> Dict[str, Any]:
    """Infer type for a torch.utils.data.Dataset instance."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    try:
        if hasattr(value, "__len__"):
            props["size"] = {"kind": "primitive", "name": str(len(value))}
    except Exception:
        pass

    # TensorDataset: show number of tensors and their shapes
    if class_name == "TensorDataset":
        try:
            tensors = value.tensors
            props["tensors"] = {"kind": "primitive", "name": str(len(tensors))}
            shapes = [str(list(t.shape)) for t in tensors[:3]]
            if len(tensors) > 3:
                shapes.append("...")
            props["shapes"] = {"kind": "primitive", "name": ", ".join(shapes)}
        except Exception:
            pass

    # Subset: show indices range
    if class_name == "Subset":
        try:
            props["from"] = {"kind": "primitive", "name": type(value.dataset).__name__}
        except Exception:
            pass

    return {"kind": "object", "properties": props, "class_name": class_name}


# --- Pandas DataFrame / Series support ---

_pandas_dataframe_type: Any = None
_pandas_dataframe_checked = False


def _get_pandas_dataframe_type() -> Any:
    """Lazily resolve pandas.DataFrame."""
    global _pandas_dataframe_type, _pandas_dataframe_checked
    if _pandas_dataframe_checked:
        return _pandas_dataframe_type
    _pandas_dataframe_checked = True
    try:
        import pandas
        _pandas_dataframe_type = pandas.DataFrame
    except Exception:
        pass
    return _pandas_dataframe_type


_pandas_series_type: Any = None
_pandas_series_checked = False


def _get_pandas_series_type() -> Any:
    """Lazily resolve pandas.Series."""
    global _pandas_series_type, _pandas_series_checked
    if _pandas_series_checked:
        return _pandas_series_type
    _pandas_series_checked = True
    try:
        import pandas
        _pandas_series_type = pandas.Series
    except Exception:
        pass
    return _pandas_series_type


def _infer_dataframe(value: Any) -> Dict[str, Any]:
    """Infer type for a pandas DataFrame."""
    props: Dict[str, Any] = {}
    try:
        rows, cols = value.shape
        props["rows"] = {"kind": "primitive", "name": str(rows)}
        props["cols"] = {"kind": "primitive", "name": str(cols)}
    except Exception:
        pass

    # Column dtypes summary
    try:
        dtypes = value.dtypes
        dtype_counts: Dict[str, int] = {}
        for dt in dtypes:
            name = str(dt)
            dtype_counts[name] = dtype_counts.get(name, 0) + 1
        dtype_parts = [f"{v}x {k}" for k, v in sorted(dtype_counts.items(), key=lambda x: -x[1])]
        props["dtypes"] = {"kind": "primitive", "name": ", ".join(dtype_parts[:4])}
    except Exception:
        pass

    # Column names (first few)
    try:
        col_names = list(value.columns[:8])
        if len(value.columns) > 8:
            col_names.append(f"... +{len(value.columns) - 8}")
        props["columns"] = {"kind": "primitive", "name": ", ".join(str(c) for c in col_names)}
    except Exception:
        pass

    # Memory usage
    try:
        mem_bytes = value.memory_usage(deep=True).sum()
        if mem_bytes >= 1_073_741_824:
            props["memory"] = {"kind": "primitive", "name": f"{mem_bytes / 1_073_741_824:.1f} GB"}
        elif mem_bytes >= 1_048_576:
            props["memory"] = {"kind": "primitive", "name": f"{mem_bytes / 1_048_576:.1f} MB"}
        elif mem_bytes >= 1024:
            props["memory"] = {"kind": "primitive", "name": f"{mem_bytes / 1024:.1f} KB"}
        else:
            props["memory"] = {"kind": "primitive", "name": f"{mem_bytes} B"}
    except Exception:
        pass

    # Null count
    try:
        null_count = int(value.isnull().sum().sum())
        if null_count > 0:
            props["nulls"] = {"kind": "primitive", "name": str(null_count)}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": "DataFrame"}


def _infer_series(value: Any) -> Dict[str, Any]:
    """Infer type for a pandas Series."""
    props: Dict[str, Any] = {}
    try:
        props["length"] = {"kind": "primitive", "name": str(len(value))}
    except Exception:
        pass

    try:
        props["dtype"] = {"kind": "primitive", "name": str(value.dtype)}
    except Exception:
        pass

    if value.name is not None:
        props["name"] = {"kind": "primitive", "name": str(value.name)}

    # Null count
    try:
        null_count = int(value.isnull().sum())
        if null_count > 0:
            props["nulls"] = {"kind": "primitive", "name": str(null_count)}
    except Exception:
        pass

    # Stats for numeric series
    try:
        if value.dtype.kind in ('i', 'u', 'f'):
            props["min"] = {"kind": "primitive", "name": f"{value.min():.4g}"}
            props["max"] = {"kind": "primitive", "name": f"{value.max():.4g}"}
            props["mean"] = {"kind": "primitive", "name": f"{value.mean():.4g}"}
    except Exception:
        pass

    # Unique count for categorical/object
    try:
        if value.dtype == 'object' or str(value.dtype) == 'category':
            props["unique"] = {"kind": "primitive", "name": str(value.nunique())}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": "Series"}


_sklearn_estimator_type: Any = None
_sklearn_estimator_checked = False


def _get_sklearn_estimator_type() -> Any:
    """Lazily resolve sklearn BaseEstimator."""
    global _sklearn_estimator_type, _sklearn_estimator_checked
    if _sklearn_estimator_checked:
        return _sklearn_estimator_type
    _sklearn_estimator_checked = True
    try:
        from sklearn.base import BaseEstimator
        _sklearn_estimator_type = BaseEstimator
    except Exception:
        pass
    return _sklearn_estimator_type


# Key hyperparameters for common sklearn estimators
_SKLEARN_KEY_PARAMS: Dict[str, list] = {
    "LogisticRegression": ["C", "penalty", "solver", "max_iter"],
    "LinearRegression": ["fit_intercept"],
    "Ridge": ["alpha", "fit_intercept"],
    "Lasso": ["alpha", "fit_intercept"],
    "ElasticNet": ["alpha", "l1_ratio"],
    "SGDClassifier": ["loss", "penalty", "alpha"],
    "SGDRegressor": ["loss", "penalty", "alpha"],
    "RandomForestClassifier": ["n_estimators", "max_depth", "criterion"],
    "RandomForestRegressor": ["n_estimators", "max_depth", "criterion"],
    "GradientBoostingClassifier": ["n_estimators", "max_depth", "learning_rate"],
    "GradientBoostingRegressor": ["n_estimators", "max_depth", "learning_rate"],
    "AdaBoostClassifier": ["n_estimators", "learning_rate"],
    "AdaBoostRegressor": ["n_estimators", "learning_rate"],
    "DecisionTreeClassifier": ["max_depth", "criterion"],
    "DecisionTreeRegressor": ["max_depth", "criterion"],
    "SVC": ["C", "kernel", "gamma"],
    "SVR": ["C", "kernel", "gamma"],
    "KNeighborsClassifier": ["n_neighbors", "weights"],
    "KNeighborsRegressor": ["n_neighbors", "weights"],
    "XGBClassifier": ["n_estimators", "max_depth", "learning_rate"],
    "XGBRegressor": ["n_estimators", "max_depth", "learning_rate"],
    "LGBMClassifier": ["n_estimators", "max_depth", "learning_rate"],
    "LGBMRegressor": ["n_estimators", "max_depth", "learning_rate"],
    "StandardScaler": ["with_mean", "with_std"],
    "MinMaxScaler": ["feature_range"],
    "RobustScaler": ["with_centering", "with_scaling"],
    "PCA": ["n_components"],
    "KMeans": ["n_clusters", "n_init"],
    "DBSCAN": ["eps", "min_samples"],
}


def _infer_sklearn_estimator(value: Any) -> Dict[str, Any]:
    """Infer type for a scikit-learn estimator."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    # Check if fitted (sklearn convention: fitted attrs end with _)
    is_fitted = any(
        attr.endswith("_") and not attr.startswith("_")
        for attr in vars(value)
    )
    # Fallback: try sklearn's check_is_fitted
    if not is_fitted:
        try:
            from sklearn.utils.validation import check_is_fitted
            check_is_fitted(value)
            is_fitted = True
        except Exception:
            pass
    if is_fitted:
        props["fitted"] = {"kind": "primitive", "name": "True"}

    # Key hyperparameters
    key_params = _SKLEARN_KEY_PARAMS.get(class_name, [])
    if key_params:
        for param in key_params:
            try:
                val = getattr(value, param, None)
                if val is not None:
                    if isinstance(val, float):
                        props[param] = {"kind": "primitive", "name": f"{val:.6g}"}
                    else:
                        props[param] = {"kind": "primitive", "name": str(val)}
            except Exception:
                continue
    else:
        # Unknown estimator: try get_params() for top params
        try:
            params = value.get_params(deep=False)
            for k, v in list(params.items())[:6]:
                if v is not None and not callable(v):
                    if isinstance(v, float):
                        props[k] = {"kind": "primitive", "name": f"{v:.6g}"}
                    elif isinstance(v, (int, str, bool)):
                        props[k] = {"kind": "primitive", "name": str(v)}
        except Exception:
            pass

    # Fitted model info
    if is_fitted:
        try:
            n_features = getattr(value, "n_features_in_", None)
            if n_features is not None:
                props["features"] = {"kind": "primitive", "name": str(n_features)}
        except Exception:
            pass

        try:
            classes = getattr(value, "classes_", None)
            if classes is not None:
                props["classes"] = {"kind": "primitive", "name": str(len(classes))}
        except Exception:
            pass

        # Number of estimators for ensemble methods
        try:
            estimators = getattr(value, "estimators_", None)
            if estimators is not None and hasattr(estimators, "__len__"):
                props["n_estimators_actual"] = {"kind": "primitive", "name": str(len(estimators))}
        except Exception:
            pass

    # Pipeline: show steps, remove noise params
    if class_name == "Pipeline":
        try:
            steps = value.steps
            step_names = [name for name, _ in steps]
            props["steps"] = {"kind": "primitive", "name": " → ".join(step_names)}
            props.pop("verbose", None)
        except Exception:
            pass

    return {"kind": "object", "properties": props, "class_name": class_name}


_pandas_groupby_type: Any = None
_pandas_groupby_checked = False


def _get_pandas_groupby_type() -> Any:
    """Lazily resolve pandas GroupBy base type."""
    global _pandas_groupby_type, _pandas_groupby_checked
    if _pandas_groupby_checked:
        return _pandas_groupby_type
    _pandas_groupby_checked = True
    try:
        from pandas.core.groupby import GroupBy
        _pandas_groupby_type = GroupBy
    except Exception:
        pass
    return _pandas_groupby_type


def _infer_groupby(value: Any) -> Dict[str, Any]:
    """Infer type for a pandas GroupBy object."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    try:
        props["ngroups"] = {"kind": "primitive", "name": str(value.ngroups)}
    except Exception:
        pass

    try:
        keys = value.keys
        if isinstance(keys, list):
            props["by"] = {"kind": "primitive", "name": ", ".join(str(k) for k in keys)}
        else:
            props["by"] = {"kind": "primitive", "name": str(keys)}
    except Exception:
        pass

    try:
        sizes = value.size()
        if hasattr(sizes, 'min') and hasattr(sizes, 'max'):
            mn, mx = int(sizes.min()), int(sizes.max())
            if mn == mx:
                props["group_size"] = {"kind": "primitive", "name": str(mn)}
            else:
                props["group_size"] = {"kind": "primitive", "name": f"{mn}-{mx}"}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": class_name}


_pandas_index_type: Any = None
_pandas_index_checked = False


def _get_pandas_index_type() -> Any:
    """Lazily resolve pandas Index base type."""
    global _pandas_index_type, _pandas_index_checked
    if _pandas_index_checked:
        return _pandas_index_type
    _pandas_index_checked = True
    try:
        import pandas
        _pandas_index_type = pandas.Index
    except Exception:
        pass
    return _pandas_index_type


def _infer_index(value: Any) -> Dict[str, Any]:
    """Infer type for a pandas Index or MultiIndex."""
    class_name = type(value).__name__
    props: Dict[str, Any] = {}

    try:
        props["length"] = {"kind": "primitive", "name": str(len(value))}
    except Exception:
        pass

    try:
        props["dtype"] = {"kind": "primitive", "name": str(value.dtype)}
    except Exception:
        pass

    # RangeIndex: show start/stop/step
    if class_name == "RangeIndex":
        try:
            props["range"] = {"kind": "primitive", "name": f"{value.start}:{value.stop}:{value.step}"}
        except Exception:
            pass

    # MultiIndex: show levels and names
    if class_name == "MultiIndex":
        try:
            names = [str(n) for n in value.names if n is not None]
            if names:
                props["names"] = {"kind": "primitive", "name": ", ".join(names)}
            props["levels"] = {"kind": "primitive", "name": str(value.nlevels)}
        except Exception:
            pass

    # DatetimeIndex: show range
    if class_name == "DatetimeIndex":
        try:
            props["start"] = {"kind": "primitive", "name": str(value[0].date())}
            props["end"] = {"kind": "primitive", "name": str(value[-1].date())}
            if value.freq is not None:
                props["freq"] = {"kind": "primitive", "name": str(value.freq)}
        except Exception:
            pass

    # Unique count for non-range indices
    if class_name != "RangeIndex":
        try:
            if not value.is_unique:
                props["unique"] = {"kind": "primitive", "name": str(value.nunique())}
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
    except Exception:
        pass
    return _numpy_ndarray_type


# --- HuggingFace datasets support ---

_hf_dataset_type: Any = None
_hf_dataset_checked = False


def _get_hf_dataset_type() -> Any:
    """Lazily resolve datasets.Dataset."""
    global _hf_dataset_type, _hf_dataset_checked
    if _hf_dataset_checked:
        return _hf_dataset_type
    _hf_dataset_checked = True
    try:
        from datasets import Dataset
        _hf_dataset_type = Dataset
    except Exception:
        pass
    return _hf_dataset_type


_hf_dataset_dict_type: Any = None
_hf_dataset_dict_checked = False


def _get_hf_dataset_dict_type() -> Any:
    """Lazily resolve datasets.DatasetDict."""
    global _hf_dataset_dict_type, _hf_dataset_dict_checked
    if _hf_dataset_dict_checked:
        return _hf_dataset_dict_type
    _hf_dataset_dict_checked = True
    try:
        from datasets import DatasetDict
        _hf_dataset_dict_type = DatasetDict
    except Exception:
        pass
    return _hf_dataset_dict_type


def _infer_hf_pretrained_config(value: Any) -> Dict[str, Any]:
    """Infer type for a HuggingFace PretrainedConfig.

    Surfaces priority fields (vocab_size, hidden_size, n_layer, etc.) first
    so inline hints show the most architecturally significant parameters.
    """
    class_name = type(value).__name__
    props: Dict[str, Any] = {}
    try:
        from trickle._auto_var_tracer import _extract_config_fields
        fields = _extract_config_fields(value)
        for fname, val in list(fields.items())[:10]:
            props[fname] = {"kind": "primitive", "name": str(val)}
    except Exception:
        pass
    return {"kind": "object", "properties": props, "class_name": class_name}


def _infer_hf_dataset(value: Any) -> Dict[str, Any]:
    """Infer type for a HuggingFace datasets.Dataset."""
    props: Dict[str, Any] = {}

    try:
        props["rows"] = {"kind": "primitive", "name": str(value.num_rows)}
    except Exception:
        pass

    # Column names
    try:
        cols = value.column_names
        if cols:
            col_str = ", ".join(cols[:8])
            if len(cols) > 8:
                col_str += f", ... +{len(cols) - 8}"
            props["columns"] = {"kind": "primitive", "name": col_str}
    except Exception:
        pass

    # Feature types (e.g., text: string, label: ClassLabel)
    try:
        features = value.features
        if features:
            feat_parts = []
            for name, feat in list(features.items())[:6]:
                feat_type = type(feat).__name__
                if feat_type == "Value":
                    feat_parts.append(f"{name}: {feat.dtype}")
                elif feat_type == "ClassLabel":
                    n_classes = feat.num_classes
                    feat_parts.append(f"{name}: {n_classes} classes")
                elif feat_type == "Sequence":
                    feat_parts.append(f"{name}: Sequence")
                else:
                    feat_parts.append(f"{name}: {feat_type}")
            if len(features) > 6:
                feat_parts.append(f"... +{len(features) - 6}")
            props["features"] = {"kind": "primitive", "name": ", ".join(feat_parts)}
    except Exception:
        pass

    # Split name
    try:
        split = value.split
        if split is not None:
            props["split"] = {"kind": "primitive", "name": str(split)}
    except Exception:
        pass

    # Format (torch, numpy, etc.)
    try:
        fmt = value.format
        if fmt:
            fmt_type = fmt.get("type") if isinstance(fmt, dict) else getattr(fmt, "type", None)
            if fmt_type is not None:
                props["format"] = {"kind": "primitive", "name": str(fmt_type)}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": "Dataset"}


def _infer_hf_dataset_dict(value: Any) -> Dict[str, Any]:
    """Infer type for a HuggingFace datasets.DatasetDict."""
    props: Dict[str, Any] = {}

    try:
        splits = list(value.keys())
        split_parts = []
        for split_name in splits[:5]:
            ds = value[split_name]
            n_rows = ds.num_rows if hasattr(ds, "num_rows") else "?"
            split_parts.append(f"{split_name}: {n_rows}")
        if len(splits) > 5:
            split_parts.append(f"... +{len(splits) - 5}")
        props["splits"] = {"kind": "primitive", "name": ", ".join(split_parts)}
    except Exception:
        pass

    # Show features from first split
    try:
        first_ds = next(iter(value.values()))
        cols = first_ds.column_names
        if cols:
            props["columns"] = {"kind": "primitive", "name": ", ".join(cols[:8])}
    except Exception:
        pass

    return {"kind": "object", "properties": props, "class_name": "DatasetDict"}


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
