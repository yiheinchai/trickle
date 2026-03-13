"""Property access tracking wrappers for Python objects.

``create_tracker(value)`` returns ``(tracked_value, get_accessed_paths_fn)``
where *tracked_value* is a mostly-transparent wrapper that records every
property / key / index access as a dot-path string (e.g.
``"user.address.city"`` or ``"items[0].name"``).
"""

from __future__ import annotations

from typing import Any, Callable, List, Set, Tuple


def create_tracker(value: Any) -> Tuple[Any, Callable[[], Set[str]]]:
    """Wrap *value* in a tracking proxy.

    Returns ``(tracked, get_paths)`` where ``get_paths()`` yields the set of
    dot-path strings that were accessed on the tracked object.

    For types that cannot be transparently wrapped the original value is
    returned and ``get_paths`` will return an empty set.
    """
    paths: Set[str] = set()

    try:
        tracked = _wrap(value, "", paths)
    except Exception:
        # Fallback: return unwrapped
        return value, lambda: set()

    return tracked, lambda: set(paths)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _record(paths: Set[str], path: str) -> None:
    if path:
        paths.add(path)


def _child_path(parent: str, child: str) -> str:
    if not parent:
        return child
    return f"{parent}.{child}"


def _index_path(parent: str, index: int) -> str:
    return f"{parent}[{index}]"


def _wrap(value: Any, path: str, paths: Set[str]) -> Any:
    """Wrap *value* in the appropriate tracked container."""
    if isinstance(value, dict):
        return TrackedDict(value, path, paths)
    if isinstance(value, list):
        return TrackedList(value, path, paths)
    if isinstance(value, (str, int, float, bool, bytes, type(None))):
        return value
    # Skip types that break when wrapped (C extensions, numpy, pandas, sklearn, torch, etc.)
    # Only wrap simple Python objects that are dict-like or dataclass-like.
    if _should_skip_wrapping(value):
        return value
    # Generic object wrapper (for dataclasses, pydantic, namedtuples, etc.)
    try:
        return TrackedObject(value, path, paths)
    except Exception:
        return value


# Modules whose objects should never be wrapped in TrackedObject
_SKIP_MODULES = frozenset({
    "numpy", "np", "pandas", "pd", "sklearn", "torch", "tensorflow", "tf",
    "scipy", "matplotlib", "PIL", "cv2", "jax", "xgboost", "lightgbm",
    "catboost", "statsmodels", "networkx", "sympy", "dask",
})


def _should_skip_wrapping(value: Any) -> bool:
    """Return True if value should NOT be wrapped in TrackedObject."""
    cls = type(value)
    mod = getattr(cls, "__module__", "") or ""
    top_mod = mod.split(".")[0]
    if top_mod in _SKIP_MODULES:
        return True
    # Skip C extension types (no __dict__ on the class, or defined in builtins)
    if mod.startswith("_") or mod == "builtins":
        return True
    # Skip tuple subclasses (namedtuples are fine to read but break when wrapped)
    if isinstance(value, tuple):
        return True
    return False


class TrackedDict(dict):
    """A dict subclass that records key accesses."""

    def __init__(self, data: dict, path: str, paths: Set[str]):
        super().__init__(data)
        # Use object.__setattr__ to bypass any potential __setattr__ override
        object.__setattr__(self, "_path", path)
        object.__setattr__(self, "_paths", paths)

    def __getitem__(self, key: str) -> Any:
        _record(self._paths, _child_path(self._path, str(key)))
        value = super().__getitem__(key)
        return _wrap(value, _child_path(self._path, str(key)), self._paths)

    def get(self, key: str, default: Any = None) -> Any:
        _record(self._paths, _child_path(self._path, str(key)))
        if key in self:
            value = super().__getitem__(key)
            return _wrap(value, _child_path(self._path, str(key)), self._paths)
        return default

    def __repr__(self) -> str:
        return dict.__repr__(self)


class TrackedList(list):
    """A list subclass that records index accesses and iteration."""

    def __init__(self, data: list, path: str, paths: Set[str]):
        super().__init__(data)
        object.__setattr__(self, "_path", path)
        object.__setattr__(self, "_paths", paths)

    def __getitem__(self, index: Any) -> Any:
        if isinstance(index, int):
            _record(self._paths, _index_path(self._path, index))
            value = super().__getitem__(index)
            return _wrap(value, _index_path(self._path, index), self._paths)
        # Slice
        return super().__getitem__(index)

    def __iter__(self):
        for i, item in enumerate(list.__iter__(self)):
            _record(self._paths, _index_path(self._path, i))
            yield _wrap(item, _index_path(self._path, i), self._paths)

    def __repr__(self) -> str:
        return list.__repr__(self)


class TrackedObject:
    """Wraps an arbitrary object, recording attribute accesses."""

    __slots__ = ("_inner", "_path", "_paths")

    def __init__(self, obj: Any, path: str, paths: Set[str]):
        object.__setattr__(self, "_inner", obj)
        object.__setattr__(self, "_path", path)
        object.__setattr__(self, "_paths", paths)

    def __getattr__(self, name: str) -> Any:
        inner = object.__getattribute__(self, "_inner")
        path = object.__getattribute__(self, "_path")
        paths = object.__getattribute__(self, "_paths")

        value = getattr(inner, name)
        child = _child_path(path, name)
        _record(paths, child)
        return _wrap(value, child, paths)

    def __repr__(self) -> str:
        inner = object.__getattribute__(self, "_inner")
        return repr(inner)

    def __str__(self) -> str:
        inner = object.__getattribute__(self, "_inner")
        return str(inner)

    def __eq__(self, other: Any) -> bool:
        inner = object.__getattribute__(self, "_inner")
        if isinstance(other, TrackedObject):
            other = object.__getattribute__(other, "_inner")
        return inner == other

    def __hash__(self) -> int:
        inner = object.__getattribute__(self, "_inner")
        return hash(inner)

    def __len__(self) -> int:
        inner = object.__getattribute__(self, "_inner")
        return len(inner)

    def __bool__(self) -> bool:
        inner = object.__getattribute__(self, "_inner")
        return bool(inner)

    def __iter__(self):
        inner = object.__getattribute__(self, "_inner")
        return iter(inner)

    def __contains__(self, item: Any) -> bool:
        inner = object.__getattribute__(self, "_inner")
        return item in inner

    def __setattr__(self, name: str, value: Any) -> None:
        # Don't intercept our own slots
        if name in ("_inner", "_path", "_paths"):
            object.__setattr__(self, name, value)
            return
        inner = object.__getattribute__(self, "_inner")
        setattr(inner, name, value)

    def __delattr__(self, name: str) -> None:
        inner = object.__getattribute__(self, "_inner")
        delattr(inner, name)

    def __getitem__(self, key: Any) -> Any:
        inner = object.__getattribute__(self, "_inner")
        path = object.__getattribute__(self, "_path")
        paths = object.__getattribute__(self, "_paths")
        value = inner[key]
        child = _index_path(path, key) if isinstance(key, int) else _child_path(path, str(key))
        _record(paths, child)
        return _wrap(value, child, paths)

    def __setitem__(self, key: Any, value: Any) -> None:
        inner = object.__getattribute__(self, "_inner")
        inner[key] = value

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        inner = object.__getattribute__(self, "_inner")
        return inner(*args, **kwargs)

    def __int__(self) -> int:
        inner = object.__getattribute__(self, "_inner")
        return int(inner)

    def __float__(self) -> float:
        inner = object.__getattribute__(self, "_inner")
        return float(inner)

    @property
    def __class__(self):
        """Make isinstance() checks pass against the wrapped type."""
        inner = object.__getattribute__(self, "_inner")
        return type(inner)
