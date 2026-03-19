"""Auto-observation import hook — wraps all user module functions on import.

Unlike ``_auto.py`` which only patches Flask/FastAPI, this hook wraps
every exported function in user modules so that *all* function calls
are observed — not just web framework routes.

Usage::

    python -m trickle.observe_runner script.py

Environment variables:
    TRICKLE_BACKEND_URL       — Backend URL (default: http://localhost:4888)
    TRICKLE_ENABLED           — "0" or "false" to disable
    TRICKLE_DEBUG             — "1" or "true" for debug logging
    TRICKLE_OBSERVE_INCLUDE   — Comma-separated substrings to include
    TRICKLE_OBSERVE_EXCLUDE   — Comma-separated substrings to exclude
"""

from __future__ import annotations

import builtins
import inspect
import logging
import os
import sys
import types
from typing import Any

logger = logging.getLogger("trickle.observe")

_installed = False
_include_patterns: list[str] = []
_exclude_patterns: list[str] = []
_wrapped_modules: set[str] = set()
_original_import: Any = None


def _should_observe(fullname: str) -> bool:
    """Determine if a module should be observed."""
    if fullname in _wrapped_modules:
        return False

    # Skip stdlib (Python 3.10+)
    top_level = fullname.split(".")[0]
    if hasattr(sys, "stdlib_module_names") and top_level in sys.stdlib_module_names:
        return False

    # Skip well-known third-party and internal packages
    skip_prefixes = (
        "trickle", "_trickle",
        # Web frameworks
        "flask", "fastapi", "django", "starlette", "uvicorn", "gunicorn",
        "werkzeug", "jinja2", "markupsafe", "click", "itsdangerous",
        # HTTP / networking
        "requests", "urllib3", "httpx", "aiohttp", "certifi", "charset_normalizer",
        "idna", "urllib", "http", "socket", "ssl", "email",
        # Testing
        "pytest", "unittest", "_pytest", "pluggy",
        # Build / packaging
        "setuptools", "pip", "pkg_resources", "wheel", "distutils",
        # Data science / ML
        "numpy", "pandas", "scipy", "sklearn", "matplotlib",
        "torch", "torchvision", "torchaudio", "transformers",
        "tensorflow", "tf", "keras", "jax", "flax",
        "mlx", "sentencepiece",
        # Typing
        "typing", "typing_extensions",
        # Stdlib categories
        "importlib", "collections", "functools", "itertools", "operator",
        "os", "sys", "io", "re", "json", "logging", "pathlib",
        "asyncio", "concurrent", "threading", "multiprocessing",
        "dataclasses", "enum", "abc", "copy", "pprint", "textwrap",
        "builtins", "copyreg", "encodings", "codecs", "locale",
        "runpy", "pkgutil", "zipimport", "zipfile", "zoneinfo",
        "datetime", "time", "calendar", "math", "random", "hashlib",
        "hmac", "secrets", "struct", "ctypes", "inspect", "traceback",
        "warnings", "contextlib", "string", "fnmatch", "glob", "shutil",
        "tempfile", "csv", "configparser", "argparse", "gettext",
        "subprocess", "signal", "select", "selectors", "mmap",
        "base64", "binascii", "quopri", "uu",
        "xml", "html", "plistlib",
        "_",
    )
    if top_level in skip_prefixes:
        return False

    # Apply include filter
    if _include_patterns:
        if not any(p in fullname for p in _include_patterns):
            return False

    # Apply exclude filter
    if _exclude_patterns:
        if any(p in fullname for p in _exclude_patterns):
            return False

    return True


def _wrap_module_functions(module: types.ModuleType, fullname: str) -> None:
    """Wrap all public callable attributes on a module."""
    from .decorator import _wrap

    module_name = fullname
    count = 0

    for name in dir(module):
        if name.startswith("_"):
            continue

        try:
            val = getattr(module, name)
        except AttributeError:
            continue

        # Handle classes: wrap their public methods
        if isinstance(val, type):
            cls = val
            for method_name in list(vars(cls)):
                # Allow __init__ and public methods, skip other dunders/private
                if method_name.startswith("_") and method_name != "__init__":
                    continue
                method_val = getattr(cls, method_name, None)
                if method_val is None:
                    continue
                # Handle staticmethod and classmethod descriptors
                raw_val = vars(cls).get(method_name)
                if isinstance(raw_val, staticmethod):
                    inner = raw_val.__func__
                    if callable(inner):
                        try:
                            wrapped_method = _wrap(inner, name=f"{name}.{method_name}", module=module_name)
                            setattr(cls, method_name, staticmethod(wrapped_method))
                            count += 1
                        except Exception:
                            logger.debug("trickle: failed to wrap %s.%s.%s", fullname, name, method_name, exc_info=True)
                    continue
                if isinstance(raw_val, classmethod):
                    inner = raw_val.__func__
                    if callable(inner):
                        try:
                            wrapped_method = _wrap(inner, name=f"{name}.{method_name}", module=module_name)
                            setattr(cls, method_name, classmethod(wrapped_method))
                            count += 1
                        except Exception:
                            logger.debug("trickle: failed to wrap %s.%s.%s", fullname, name, method_name, exc_info=True)
                    continue
                if not (inspect.isfunction(method_val) or inspect.iscoroutinefunction(method_val)):
                    continue
                try:
                    wrapped_method = _wrap(method_val, name=f"{name}.{method_name}", module=module_name)
                    setattr(cls, method_name, wrapped_method)
                    count += 1
                except Exception:
                    logger.debug("trickle: failed to wrap %s.%s.%s", fullname, name, method_name, exc_info=True)
            continue

        # Only wrap plain functions and coroutine functions
        if not callable(val):
            continue

        if not (inspect.isfunction(val) or inspect.iscoroutinefunction(val)):
            continue

        try:
            wrapped = _wrap(val, name=name, module=module_name)
            setattr(module, name, wrapped)
            count += 1
        except Exception:
            logger.debug("trickle: failed to wrap %s.%s", fullname, name, exc_info=True)

    if count > 0:
        logger.debug("trickle: wrapped %d functions from %s", count, fullname)


def _hooked_import(name: str, *args: Any, **kwargs: Any) -> Any:
    """Replacement for builtins.__import__ that wraps user module functions."""
    module = _original_import(name, *args, **kwargs)

    # Use the actual resolved module name (handles relative imports)
    actual_name = getattr(module, "__name__", name) or name

    if _should_observe(actual_name):
        # Skip trickle's own modules (resolved via __package__ or __file__)
        pkg = getattr(module, "__package__", "") or ""
        if pkg == "trickle" or pkg.startswith("trickle."):
            _wrapped_modules.add(actual_name)
            return module

        # Skip site-packages / dist-packages
        mod_file = getattr(module, "__file__", None)
        if mod_file and ("site-packages" in mod_file or "dist-packages" in mod_file):
            _wrapped_modules.add(actual_name)
            return module

        _wrapped_modules.add(actual_name)
        try:
            _wrap_module_functions(module, actual_name)
        except Exception:
            logger.debug("trickle: failed to observe module %s", actual_name, exc_info=True)

        # Also register the module file for variable tracing (multi-file tracing).
        # This makes assignment lines in imported user modules visible to the
        # sys.settrace-based var tracer, so inline hints appear in those files too.
        if mod_file and mod_file.endswith(".py"):
            try:
                from trickle._auto_var_tracer import install_files as _install_files
                _install_files([mod_file])
            except Exception:
                pass

    return module


def install() -> None:
    """Install the auto-observe import hook.

    Patches ``builtins.__import__`` to wrap all user module functions
    after import. This works across all Python versions (3.8+).
    """
    global _installed, _include_patterns, _exclude_patterns, _original_import
    if _installed:
        return
    _installed = True

    enabled = os.environ.get("TRICKLE_ENABLED", "1").lower() not in ("0", "false")
    if not enabled:
        return

    backend_url = os.environ.get("TRICKLE_BACKEND_URL", "http://localhost:4888")
    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")

    include_raw = os.environ.get("TRICKLE_OBSERVE_INCLUDE", "")
    exclude_raw = os.environ.get("TRICKLE_OBSERVE_EXCLUDE", "")

    if include_raw:
        _include_patterns = [s.strip() for s in include_raw.split(",") if s.strip()]
    if exclude_raw:
        _exclude_patterns = [s.strip() for s in exclude_raw.split(",") if s.strip()]

    from trickle import configure
    configure(backend_url=backend_url)

    if debug:
        logging.basicConfig(level=logging.DEBUG)
        logger.debug("trickle: auto-observation enabled (backend: %s)", backend_url)
        if _include_patterns:
            logger.debug("trickle: include patterns: %s", _include_patterns)
        if _exclude_patterns:
            logger.debug("trickle: exclude patterns: %s", _exclude_patterns)

    # Patch builtins.__import__ — works on all Python versions
    _original_import = builtins.__import__
    builtins.__import__ = _hooked_import
