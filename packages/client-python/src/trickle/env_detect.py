"""Detect the runtime environment for tagging payloads."""

from __future__ import annotations

import os


def detect_environment() -> str:
    """Return a short string describing the runtime environment."""

    # --- Cloud / serverless ---
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return "lambda"
    if os.environ.get("FUNCTION_TARGET") or os.environ.get("GOOGLE_CLOUD_PROJECT"):
        return "gcp-functions"
    if os.environ.get("AZURE_FUNCTIONS_ENVIRONMENT"):
        return "azure-functions"

    # --- Frameworks (try imports) ---
    try:
        import fastapi  # noqa: F401
        return "fastapi"
    except ImportError:
        pass

    try:
        import django  # noqa: F401
        return "django"
    except ImportError:
        pass

    try:
        import flask  # noqa: F401
        return "flask"
    except ImportError:
        pass

    return "python"
