"""The ``@trickle`` decorator — the main public API of the library."""

from __future__ import annotations

import datetime
import functools
import inspect
import logging
import threading
import time
from typing import Any, Callable, Dict, Optional, Set, overload

from .attr_tracker import create_tracker
from .cache import TypeCache
from .env_detect import detect_environment
from .transport import enqueue
from .type_hash import hash_type
from .type_inference import infer_type

logger = logging.getLogger("trickle")

# Re-entrancy guard: skip tracking/wrapping when already inside an observed call.
# Prevents infinite recursion with complex class hierarchies where wrapped methods
# call other wrapped methods (e.g. OrderedMultiDict with ~100 self-referential methods).
_call_depth = threading.local()

# Shared singleton cache
_cache = TypeCache()
_environment: Optional[str] = None

# Sample rate for production mode (0.0 = no sampling, 1.0 = trace everything)
import os as _os
import random as _random
_sample_rate: float = float(_os.environ.get("TRICKLE_SAMPLE_RATE", "1.0"))
_production_mode: bool = _os.environ.get("TRICKLE_PRODUCTION", "").lower() in ("1", "true", "yes")


def _get_environment() -> str:
    global _environment
    if _environment is None:
        _environment = detect_environment()
    return _environment


# ---------------------------------------------------------------------------
# Decorator overloads
# ---------------------------------------------------------------------------

@overload
def trickle(fn: Callable) -> Callable: ...


@overload
def trickle(*, name: Optional[str] = None, module: Optional[str] = None) -> Callable: ...


def trickle(fn: Optional[Callable] = None, *, name: Optional[str] = None, module: Optional[str] = None) -> Callable:
    """Decorator that captures runtime type information for a function.

    Usage::

        @trickle
        def my_func(x, y):
            ...

        @trickle(name="custom", module="my.module")
        def my_func(x, y):
            ...
    """
    if fn is not None:
        # Called as @trickle (no parentheses)
        return _wrap(fn, name=None, module=None)
    # Called as @trickle(...) — return the actual decorator
    def decorator(f: Callable) -> Callable:
        return _wrap(f, name=name, module=module)
    return decorator


# ---------------------------------------------------------------------------
# Core wrapper logic
# ---------------------------------------------------------------------------

def _wrap(fn: Callable, *, name: Optional[str], module: Optional[str]) -> Callable:
    func_name = name or fn.__name__
    func_module = module or fn.__module__

    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            return await _invoke_async(fn, func_name, func_module, args, kwargs)
        return async_wrapper
    elif inspect.isgeneratorfunction(fn):
        @functools.wraps(fn)
        def gen_wrapper(*args: Any, **kwargs: Any) -> Any:
            return _invoke_generator(fn, func_name, func_module, args, kwargs)
        return gen_wrapper
    elif inspect.isasyncgenfunction(fn):
        @functools.wraps(fn)
        async def async_gen_wrapper(*args: Any, **kwargs: Any) -> Any:
            async for item in _invoke_async_generator(fn, func_name, func_module, args, kwargs):
                yield item
        return async_gen_wrapper
    else:
        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            return _invoke_sync(fn, func_name, func_module, args, kwargs)
        return sync_wrapper


def _invoke_sync(fn: Callable, func_name: str, func_module: str, args: tuple, kwargs: dict) -> Any:
    from .call_trace import trace_call, trace_return

    # Production sampling: skip type observation for most calls (errors always captured)
    if _sample_rate < 1.0 and _random.random() > _sample_rate:
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            # Always capture errors even when sampling
            duration_ms = (time.perf_counter() - start) * 1000
            _emit(fn, func_name, func_module, args, kwargs, None, [], exc, is_async=False, duration_ms=duration_ms)
            raise

    # Re-entrancy guard: if already inside an observed call, skip type observation
    # but still record call trace for execution flow
    depth = getattr(_call_depth, "value", 0)
    if depth > 0:
        call_id = trace_call(func_name, func_module)
        start = time.perf_counter()
        try:
            result = fn(*args, **kwargs)
            trace_return(call_id, func_name, func_module, (time.perf_counter() - start) * 1000)
            return result
        except Exception as exc:
            trace_return(call_id, func_name, func_module, (time.perf_counter() - start) * 1000, str(exc)[:200])
            raise
    _call_depth.value = depth + 1
    call_id = trace_call(func_name, func_module)
    try:
        tracked_args, tracked_kwargs, all_paths_fns = _prepare_tracked(args, kwargs, fn)

        error_exc: Optional[Exception] = None
        result = None
        start = time.perf_counter()
        try:
            result = fn(*tracked_args, **tracked_kwargs)
        except Exception as exc:
            duration_ms = (time.perf_counter() - start) * 1000
            error_exc = exc
            _emit(fn, func_name, func_module, args, kwargs, result, all_paths_fns, error_exc, is_async=False, duration_ms=duration_ms)
            trace_return(call_id, func_name, func_module, duration_ms, str(exc)[:200])
            raise
        else:
            duration_ms = (time.perf_counter() - start) * 1000
            _emit(fn, func_name, func_module, args, kwargs, result, all_paths_fns, None, is_async=False, duration_ms=duration_ms)
            trace_return(call_id, func_name, func_module, duration_ms)
        return result
    finally:
        _call_depth.value = depth


async def _invoke_async(fn: Callable, func_name: str, func_module: str, args: tuple, kwargs: dict) -> Any:
    depth = getattr(_call_depth, "value", 0)
    if depth > 0:
        return await fn(*args, **kwargs)
    _call_depth.value = depth + 1
    try:
        tracked_args, tracked_kwargs, all_paths_fns = _prepare_tracked(args, kwargs, fn)

        error_exc: Optional[Exception] = None
        result = None
        start = time.perf_counter()
        try:
            result = await fn(*tracked_args, **tracked_kwargs)
        except Exception as exc:
            duration_ms = (time.perf_counter() - start) * 1000
            error_exc = exc
            _emit(fn, func_name, func_module, args, kwargs, result, all_paths_fns, error_exc, is_async=True, duration_ms=duration_ms)
            raise
        else:
            duration_ms = (time.perf_counter() - start) * 1000
            _emit(fn, func_name, func_module, args, kwargs, result, all_paths_fns, None, is_async=True, duration_ms=duration_ms)
        return result
    finally:
        _call_depth.value = depth


def _invoke_generator(fn: Callable, func_name: str, func_module: str, args: tuple, kwargs: dict) -> Any:
    """Wrap a generator function to capture yielded value types."""
    depth = getattr(_call_depth, "value", 0)
    if depth > 0:
        yield from fn(*args, **kwargs)
        return
    _call_depth.value = depth + 1
    try:
        tracked_args, tracked_kwargs, all_paths_fns = _prepare_tracked(args, kwargs, fn)
        gen = fn(*tracked_args, **tracked_kwargs)
    finally:
        _call_depth.value = depth

    # Yield from the generator, capturing the first yielded value's type
    yield_type_emitted = False
    yield_types: list = []
    try:
        for value in gen:
            if not yield_type_emitted and len(yield_types) < 5:
                yield_types.append(value)
                if len(yield_types) >= 3 or True:
                    # Emit after first yield for responsiveness
                    _emit_generator(fn, func_name, func_module, args, kwargs,
                                    yield_types, all_paths_fns)
                    yield_type_emitted = True
            yield value
    except Exception as exc:
        if not yield_type_emitted:
            _emit_generator(fn, func_name, func_module, args, kwargs,
                            yield_types, all_paths_fns, error_exc=exc)
        raise
    else:
        if not yield_type_emitted:
            _emit_generator(fn, func_name, func_module, args, kwargs,
                            yield_types, all_paths_fns)


async def _invoke_async_generator(fn: Callable, func_name: str, func_module: str, args: tuple, kwargs: dict) -> Any:
    """Wrap an async generator function to capture yielded value types."""
    depth = getattr(_call_depth, "value", 0)
    if depth > 0:
        async for item in fn(*args, **kwargs):
            yield item
        return
    _call_depth.value = depth + 1
    try:
        tracked_args, tracked_kwargs, all_paths_fns = _prepare_tracked(args, kwargs, fn)
        gen = fn(*tracked_args, **tracked_kwargs)
    finally:
        _call_depth.value = depth

    yield_type_emitted = False
    yield_types: list = []
    try:
        async for value in gen:
            if not yield_type_emitted and len(yield_types) < 5:
                yield_types.append(value)
                if len(yield_types) >= 1:
                    _emit_generator(fn, func_name, func_module, args, kwargs,
                                    yield_types, all_paths_fns, is_async=True)
                    yield_type_emitted = True
            yield value
    except Exception as exc:
        if not yield_type_emitted:
            _emit_generator(fn, func_name, func_module, args, kwargs,
                            yield_types, all_paths_fns, error_exc=exc, is_async=True)
        raise
    else:
        if not yield_type_emitted:
            _emit_generator(fn, func_name, func_module, args, kwargs,
                            yield_types, all_paths_fns, is_async=True)


def _emit_generator(
    fn: Callable,
    func_name: str,
    func_module: str,
    original_args: tuple,
    original_kwargs: dict,
    yield_values: list,
    all_paths_fns: list,
    error_exc: Optional[Exception] = None,
    is_async: bool = False,
) -> None:
    """Emit an observation for a generator function with Iterator[T] return type."""
    try:
        # Build the yield element type from observed values
        if yield_values:
            # Merge types of all yielded values
            element_type = infer_type(yield_values[0])
            for v in yield_values[1:]:
                vt = infer_type(v)
                if vt != element_type:
                    # Create a union
                    if element_type.get("kind") == "union":
                        members = element_type.get("members", [])
                        if vt not in members:
                            element_type = {"kind": "union", "members": members + [vt]}
                    else:
                        element_type = {"kind": "union", "members": [element_type, vt]}
        else:
            element_type = {"kind": "unknown"}

        # Build Iterator[element_type] return type
        gen_kind = "AsyncIterator" if is_async else "Iterator"
        return_type = {"kind": "iterator", "element": element_type, "name": gen_kind}

        # Use a synthetic result for _emit — we pass the constructed return type directly
        _emit_with_return_type(fn, func_name, func_module, original_args, original_kwargs,
                               return_type, all_paths_fns, error_exc, is_async)
    except Exception:
        logger.debug("trickle: failed to emit generator payload", exc_info=True)


def _emit_with_return_type(
    fn: Callable,
    func_name: str,
    func_module: str,
    original_args: tuple,
    original_kwargs: dict,
    return_type: Dict[str, Any],
    all_paths_fns: list,
    error_exc: Optional[Exception],
    is_async: bool = False,
) -> None:
    """Like _emit but with a pre-computed return type (for generators)."""
    try:
        import traceback

        param_names: list[str] = []
        try:
            sig = inspect.signature(fn)
            param_names = [
                p.name for p in sig.parameters.values()
                if p.kind in (
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.KEYWORD_ONLY,
                )
            ]
        except (ValueError, TypeError):
            pass

        if param_names and original_kwargs:
            elements: list[Dict[str, Any]] = []
            provided_names: list[str] = []
            for i, pname in enumerate(param_names):
                if i < len(original_args):
                    elements.append(infer_type(original_args[i]))
                    provided_names.append(pname)
                elif pname in original_kwargs:
                    elements.append(infer_type(original_kwargs[pname]))
                    provided_names.append(pname)
            for arg in original_args[len(param_names):]:
                elements.append(infer_type(arg))
            param_names = provided_names
        else:
            elements = [infer_type(arg) for arg in original_args]
            if original_kwargs:
                kwargs_props: Dict[str, Any] = {}
                for key, val in original_kwargs.items():
                    kwargs_props[key] = infer_type(val)
                elements.append({"kind": "object", "properties": kwargs_props})

        args_type: Dict[str, Any] = {"kind": "tuple", "elements": elements}

        type_hash_val = hash_type(args_type, return_type)
        function_key = f"{func_module}.{func_name}"

        if error_exc is None and not _cache.should_send(function_key, type_hash_val):
            return

        sample_args = [_sanitize_sample(a) for a in original_args]
        if original_kwargs:
            sample_args.append(_sanitize_sample(original_kwargs))

        payload: Dict[str, Any] = {
            "functionName": func_name,
            "module": func_module,
            "language": "python",
            "environment": _get_environment(),
            "typeHash": type_hash_val,
            "argsType": args_type,
            "returnType": return_type,
            "sampleInput": sample_args,
            "sampleOutput": None,
        }

        if is_async:
            payload["isAsync"] = True

        if param_names:
            payload["paramNames"] = param_names

        if error_exc is not None:
            payload["error"] = {
                "type": type(error_exc).__name__,
                "message": str(error_exc),
                "stackTrace": "".join(traceback.format_exception(type(error_exc), error_exc, error_exc.__traceback__)),
                "argsSnapshot": sample_args,
            }

        _cache.mark_sent(function_key, type_hash_val)
        enqueue(payload)

    except Exception:
        logger.debug("trickle: failed to emit payload", exc_info=True)


# ---------------------------------------------------------------------------
# Tracking helpers
# ---------------------------------------------------------------------------

def _prepare_tracked(args: tuple, kwargs: dict, fn: Callable):
    """Wrap mutable arguments in attribute trackers.

    Returns (tracked_args, tracked_kwargs, all_paths_fns) where
    *all_paths_fns* is a list of ``(param_name, get_paths_fn)`` tuples.
    """
    sig = None
    try:
        # Use inspect.unwrap to see through decorators to the original function,
        # so we get the real param names (not (*args, **kwargs) from wrappers)
        unwrapped = inspect.unwrap(fn, stop=lambda f: hasattr(f, "__signature__"))
        sig = inspect.signature(unwrapped)
    except (ValueError, TypeError, StopIteration):
        try:
            sig = inspect.signature(fn)
        except (ValueError, TypeError):
            pass

    param_names: list[str] = []
    if sig is not None:
        param_names = list(sig.parameters.keys())

    all_paths_fns: list[tuple[str, Callable[[], Set[str]]]] = []

    tracked_args = []
    for i, arg in enumerate(args):
        pname = param_names[i] if i < len(param_names) else f"arg{i}"
        # Skip wrapping self/cls — they're not data arguments, and wrapping
        # them breaks methods that mutate their own state (e.g. __dict__.update)
        if i == 0 and pname in ("self", "cls"):
            all_paths_fns.append((pname, lambda: set()))
            tracked_args.append(arg)
            continue
        tracked, get_paths = create_tracker(arg)
        all_paths_fns.append((pname, get_paths))
        tracked_args.append(tracked)

    tracked_kwargs: dict[str, Any] = {}
    for key, val in kwargs.items():
        tracked, get_paths = create_tracker(val)
        all_paths_fns.append((key, get_paths))
        tracked_kwargs[key] = tracked

    return tuple(tracked_args), tracked_kwargs, all_paths_fns


# ---------------------------------------------------------------------------
# Payload emission
# ---------------------------------------------------------------------------

def _sanitize_sample(value: Any, depth: int = 3) -> Any:
    """Truncate large values for safe serialization as sample data."""
    if depth <= 0:
        return "[truncated]"
    if value is None:
        return None
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:200] + "..." if len(value) > 200 else value
    if isinstance(value, (list, tuple)):
        return [_sanitize_sample(v, depth - 1) for v in value[:5]]
    if isinstance(value, dict):
        return {k: _sanitize_sample(v, depth - 1) for k, v in list(value.items())[:20]}
    return str(value)


def _emit(
    fn: Callable,
    func_name: str,
    func_module: str,
    original_args: tuple,
    original_kwargs: dict,
    result: Any,
    all_paths_fns: list,
    error_exc: Optional[Exception],
    is_async: bool = False,
    duration_ms: Optional[float] = None,
) -> None:
    """Build and enqueue an ingest payload.  Never raises."""
    try:
        import traceback

        # Build argument types matching the function signature order.
        # Merge positional args and kwargs so each parameter gets its own
        # element in the tuple — avoids collapsing kwargs into one object.
        param_names: list[str] = []
        try:
            sig = inspect.signature(fn)
            param_names = [
                p.name for p in sig.parameters.values()
                if p.kind in (
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.KEYWORD_ONLY,
                )
            ]
        except (ValueError, TypeError):
            pass

        if param_names and original_kwargs:
            # Merge positional and keyword args in signature order,
            # keeping only params that were actually provided.
            elements: list[Dict[str, Any]] = []
            provided_names: list[str] = []
            for i, pname in enumerate(param_names):
                if i < len(original_args):
                    elements.append(infer_type(original_args[i]))
                    provided_names.append(pname)
                elif pname in original_kwargs:
                    elements.append(infer_type(original_kwargs[pname]))
                    provided_names.append(pname)
                # else: parameter not provided (has a default) — skip
            for arg in original_args[len(param_names):]:
                elements.append(infer_type(arg))
            param_names = provided_names
        else:
            elements = [infer_type(arg) for arg in original_args]
            if original_kwargs:
                kwargs_props: Dict[str, Any] = {}
                for key, val in original_kwargs.items():
                    kwargs_props[key] = infer_type(val)
                elements.append({"kind": "object", "properties": kwargs_props})

        args_type: Dict[str, Any] = {"kind": "tuple", "elements": elements}
        return_type = infer_type(result)

        type_hash_val = hash_type(args_type, return_type)
        function_key = f"{func_module}.{func_name}"

        # For errors, always send. For happy path, check cache.
        if error_exc is None and not _cache.should_send(function_key, type_hash_val):
            return

        # Build sample input matching the argsType element order
        if param_names and original_kwargs:
            sample_args = []
            for i, pname in enumerate(param_names):
                if i < len(original_args):
                    sample_args.append(_sanitize_sample(original_args[i]))
                elif pname in original_kwargs:
                    sample_args.append(_sanitize_sample(original_kwargs[pname]))
            for arg in original_args[len(param_names):]:
                sample_args.append(_sanitize_sample(arg))
        else:
            sample_args = [_sanitize_sample(a) for a in original_args]
            if original_kwargs:
                sample_args.append(_sanitize_sample(original_kwargs))

        # camelCase payload to match backend's IngestPayload interface
        payload: Dict[str, Any] = {
            "functionName": func_name,
            "module": func_module,
            "language": "python",
            "environment": _get_environment(),
            "typeHash": type_hash_val,
            "argsType": args_type,
            "returnType": return_type,
            "sampleInput": sample_args,
            "sampleOutput": _sanitize_sample(result),
        }

        if duration_ms is not None:
            payload["durationMs"] = round(duration_ms, 2)

        if is_async:
            payload["isAsync"] = True

        if param_names:
            payload["paramNames"] = param_names

        if error_exc is not None:
            payload["error"] = {
                "type": type(error_exc).__name__,
                "message": str(error_exc),
                "stackTrace": "".join(traceback.format_exception(type(error_exc), error_exc, error_exc.__traceback__)),
                "argsSnapshot": sample_args,
            }

        _cache.mark_sent(function_key, type_hash_val)
        enqueue(payload)

    except Exception:
        # NEVER crash the user's application
        logger.debug("trickle: failed to emit payload", exc_info=True)
