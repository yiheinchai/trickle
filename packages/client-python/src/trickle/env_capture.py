"""Environment capture — snapshots environment variables and config at startup.

Writes to .trickle/environment.json with sanitized env vars (secrets redacted).
Agents can use this to debug configuration issues without asking the user.
"""

from __future__ import annotations

import json
import os
import platform
import sys
from typing import Any, Dict

# Patterns that indicate sensitive values (redacted in output)
_SENSITIVE_PATTERNS = {
    "KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL",
    "AUTH", "PRIVATE", "API_KEY", "APIKEY", "ACCESS_KEY",
    "DATABASE_URL", "DB_PASSWORD", "DB_PASS",
}


def _is_sensitive(name: str) -> bool:
    upper = name.upper()
    return any(p in upper for p in _SENSITIVE_PATTERNS)


def _redact(name: str, value: str) -> str:
    if _is_sensitive(name):
        if len(value) <= 4:
            return "****"
        return value[:2] + "*" * (len(value) - 4) + value[-2:]
    return value


def capture_environment() -> None:
    """Capture environment snapshot to .trickle/environment.json."""
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    env_file = os.path.join(local_dir, "environment.json")

    # Collect trickle-specific env vars
    trickle_vars: Dict[str, str] = {}
    app_vars: Dict[str, str] = {}

    for key, value in sorted(os.environ.items()):
        if key.startswith("TRICKLE_"):
            trickle_vars[key] = value
        elif not key.startswith("_") and key not in (
            "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LOGNAME",
            "PWD", "OLDPWD", "SHLVL", "TMPDIR", "COLORTERM", "TERM_PROGRAM",
        ):
            app_vars[key] = _redact(key, value)

    snapshot: Dict[str, Any] = {
        "kind": "environment",
        "timestamp": int(__import__("time").time() * 1000),
        "python": {
            "version": sys.version,
            "executable": sys.executable,
            "platform": platform.platform(),
        },
        "cwd": os.getcwd(),
        "argv": sys.argv[:10],
        "trickle": trickle_vars,
        "env": app_vars,
    }

    # Detect common frameworks
    frameworks = []
    try:
        if "django" in sys.modules:
            frameworks.append("django")
        if "flask" in sys.modules:
            frameworks.append("flask")
        if "fastapi" in sys.modules:
            frameworks.append("fastapi")
        if "torch" in sys.modules:
            frameworks.append("pytorch")
        if "tensorflow" in sys.modules:
            frameworks.append("tensorflow")
        if "numpy" in sys.modules:
            frameworks.append("numpy")
        if "pandas" in sys.modules:
            frameworks.append("pandas")
    except Exception:
        pass

    if frameworks:
        snapshot["frameworks"] = frameworks

    try:
        with open(env_file, "w") as f:
            json.dump(snapshot, f, indent=2)
    except Exception:
        pass
