"""Runtime type tracing for Jupyter notebooks and VSCode.

Load in a notebook with ``%load_ext trickle``. For scripts, use
``trickle run`` (or ``python -m trickle script.py``).
"""

from __future__ import annotations


def load_ipython_extension(ipython):  # type: ignore
    """Called by IPython when ``%load_ext trickle`` is executed."""
    from .notebook import load_ipython_extension as _load
    _load(ipython)


def unload_ipython_extension(ipython):  # type: ignore
    """Called by IPython when ``%unload_ext trickle`` is executed."""
    from .notebook import unload_ipython_extension as _unload
    _unload(ipython)


__all__ = [
    "load_ipython_extension",
    "unload_ipython_extension",
]
