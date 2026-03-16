"""Auto-instrumentation for Python web frameworks.

One-liner setup:

    from trickle import instrument
    instrument(app)

Supports FastAPI, Flask, and Django. Auto-detects the framework from the
app object. Falls back to a no-op if the framework is unrecognized.
"""

from __future__ import annotations

import functools
import inspect
import json
import logging
from typing import Any, Callable, Dict, Optional

from .cache import TypeCache
from .env_detect import detect_environment
from .transport import enqueue
from .type_hash import hash_type
from .type_inference import infer_type

logger = logging.getLogger("trickle.instrument")

_cache = TypeCache()
_environment: Optional[str] = None


def _get_env() -> str:
    global _environment
    if _environment is None:
        _environment = detect_environment()
    return _environment


def _sanitize_sample(value: Any, depth: int = 3) -> Any:
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


def _emit_route(
    route_name: str,
    module: str,
    input_data: Dict[str, Any],
    output_data: Any,
    error_exc: Optional[Exception],
) -> None:
    """Emit type observation for a route handler. Never raises."""
    try:
        import traceback as tb_module

        args_type = infer_type(input_data)
        return_type = infer_type(output_data)
        type_hash_val = hash_type(args_type, return_type)
        function_key = f"{module}.{route_name}"

        if error_exc is None and not _cache.should_send(function_key, type_hash_val):
            return

        payload: Dict[str, Any] = {
            "functionName": route_name,
            "module": module,
            "language": "python",
            "environment": _get_env(),
            "typeHash": type_hash_val,
            "argsType": args_type,
            "returnType": return_type,
            "sampleInput": _sanitize_sample(input_data),
            "sampleOutput": _sanitize_sample(output_data),
        }

        if error_exc is not None:
            payload["error"] = {
                "type": type(error_exc).__name__,
                "message": str(error_exc),
                "stackTrace": "".join(
                    tb_module.format_exception(
                        type(error_exc), error_exc, error_exc.__traceback__
                    )
                ),
                "argsSnapshot": _sanitize_sample(input_data),
            }

        _cache.mark_sent(function_key, type_hash_val)
        enqueue(payload)
    except Exception:
        logger.debug("trickle: instrument emit failed", exc_info=True)


# ---------------------------------------------------------------------------
# FastAPI auto-instrumentation
# ---------------------------------------------------------------------------


def _get_fastapi_route_name(request: Any, fallback: str) -> str:
    """Extract parameterized route template from FastAPI/Starlette request scope.

    After routing, request.scope['route'].path contains the template
    (e.g. '/users/{user_id}') instead of the literal path ('/users/abc123').
    """
    try:
        route = request.scope.get("route")
        if route and hasattr(route, "path"):
            return f"{request.method} {route.path}"
    except Exception:
        pass
    return fallback


def instrument_fastapi(app: Any) -> None:
    """Instrument a FastAPI app.

    Adds middleware that captures request/response types for every endpoint.
    """
    try:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.requests import Request
        from starlette.responses import Response
    except ImportError:
        logger.warning("trickle: starlette not installed, cannot instrument FastAPI")
        return

    class TrickleMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next: Callable) -> Response:
            route_name = f"{request.method} {request.url.path}"

            # Capture input
            input_data: Dict[str, Any] = {
                "path": str(request.url.path),
                "method": request.method,
                "query": dict(request.query_params),
            }

            # Try to read body (only for methods that typically have one)
            if request.method in ("POST", "PUT", "PATCH", "DELETE"):
                try:
                    body_bytes = await request.body()
                    if body_bytes:
                        try:
                            input_data["body"] = json.loads(body_bytes)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            input_data["body"] = body_bytes.decode("utf-8", errors="replace")[:200]
                except Exception:
                    pass

            # Try to get path params from the route
            if hasattr(request, "path_params") and request.path_params:
                input_data["params"] = dict(request.path_params)

            # Call the actual handler
            error_exc = None
            response = None
            response_body = None
            try:
                response = await call_next(request)
            except Exception as exc:
                error_exc = exc
                # Try to get parameterized route template even on error
                route_name = _get_fastapi_route_name(request, route_name)
                _emit_route(route_name, "fastapi", input_data, None, error_exc)
                raise

            # Use parameterized route template (e.g. /users/{user_id}) instead of
            # literal path (/users/abc123) to avoid cardinality explosion
            route_name = _get_fastapi_route_name(request, route_name)

            # Capture response body if JSON
            if response is not None:
                try:
                    # Read the response body
                    body_chunks = []
                    async for chunk in response.body_iterator:
                        if isinstance(chunk, bytes):
                            body_chunks.append(chunk)
                        else:
                            body_chunks.append(chunk.encode("utf-8"))

                    body_bytes = b"".join(body_chunks)

                    try:
                        response_body = json.loads(body_bytes)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        response_body = {"_raw": body_bytes.decode("utf-8", errors="replace")[:200]}

                    # Reconstruct the response since we consumed the iterator
                    from starlette.responses import Response as StarletteResponse

                    response = StarletteResponse(
                        content=body_bytes,
                        status_code=response.status_code,
                        headers=dict(response.headers),
                        media_type=response.media_type,
                    )
                except Exception:
                    pass

            _emit_route(route_name, "fastapi", input_data, response_body, error_exc)
            return response

    app.add_middleware(TrickleMiddleware)


# ---------------------------------------------------------------------------
# Flask auto-instrumentation
# ---------------------------------------------------------------------------


def instrument_flask(app: Any) -> None:
    """Instrument a Flask app.

    Wraps `app.route` and `app.add_url_rule` to auto-instrument all endpoints.
    """

    original_add_url_rule = app.add_url_rule

    @functools.wraps(original_add_url_rule)
    def patched_add_url_rule(rule: str, endpoint: Optional[str] = None, view_func: Any = None, **kwargs: Any) -> Any:
        if view_func is not None and callable(view_func):
            methods = kwargs.get("methods", ["GET"])
            method_str = "/".join(sorted(methods)) if isinstance(methods, (list, tuple)) else str(methods)
            route_name = f"{method_str} {rule}"

            original_view = view_func

            if inspect.iscoroutinefunction(original_view):
                @functools.wraps(original_view)
                async def async_wrapper(*args: Any, **kw: Any) -> Any:
                    return await _flask_handle_request(route_name, original_view, app, args, kw)
                view_func = async_wrapper
            else:
                @functools.wraps(original_view)
                def sync_wrapper(*args: Any, **kw: Any) -> Any:
                    return _flask_handle_request_sync(route_name, original_view, app, args, kw)
                view_func = sync_wrapper

        return original_add_url_rule(rule, endpoint, view_func, **kwargs)

    app.add_url_rule = patched_add_url_rule


def _flask_handle_request_sync(
    route_name: str, view_func: Callable, app: Any, args: tuple, kwargs: dict
) -> Any:
    try:
        from flask import request as flask_request
    except ImportError:
        return view_func(*args, **kwargs)

    input_data: Dict[str, Any] = {
        "method": flask_request.method,
        "path": flask_request.path,
        "query": dict(flask_request.args),
    }
    try:
        body = flask_request.get_json(silent=True)
        if body is not None:
            input_data["body"] = body
    except Exception:
        pass
    if kwargs:
        input_data["params"] = kwargs

    error_exc = None
    result = None
    try:
        result = view_func(*args, **kwargs)
    except Exception as exc:
        error_exc = exc
        _emit_route(route_name, "flask", input_data, None, error_exc)
        raise

    # Try to extract response data
    output_data = None
    try:
        if isinstance(result, tuple):
            output_data = result[0]
        elif isinstance(result, dict):
            output_data = result
        elif hasattr(result, "get_json"):
            output_data = result.get_json(silent=True)
        elif isinstance(result, str):
            try:
                output_data = json.loads(result)
            except (json.JSONDecodeError, ValueError):
                output_data = result
        else:
            output_data = result
    except Exception:
        output_data = result

    _emit_route(route_name, "flask", input_data, output_data, error_exc)
    return result


async def _flask_handle_request(
    route_name: str, view_func: Callable, app: Any, args: tuple, kwargs: dict
) -> Any:
    # Same as sync but awaits
    return _flask_handle_request_sync(route_name, view_func, app, args, kwargs)


# ---------------------------------------------------------------------------
# Django auto-instrumentation
# ---------------------------------------------------------------------------


def instrument_django(urlpatterns: Any = None) -> None:
    """Instrument Django views.

    Call with your URL patterns to wrap all view functions:
        from trickle import instrument_django
        instrument_django(urlpatterns)

    Or call with no args to install as middleware (add 'trickle.django' to MIDDLEWARE).
    """
    if urlpatterns is not None:
        _instrument_django_urls(urlpatterns)


def _instrument_django_urls(urlpatterns: Any) -> None:
    """Walk Django URL patterns and wrap view functions."""
    for pattern in urlpatterns:
        if hasattr(pattern, "callback") and callable(pattern.callback):
            original = pattern.callback
            route_name = getattr(pattern, "name", None) or getattr(original, "__name__", "unknown")

            @functools.wraps(original)
            def make_wrapper(orig: Callable, name: str) -> Callable:
                def wrapper(request: Any, *args: Any, **kwargs: Any) -> Any:
                    input_data: Dict[str, Any] = {
                        "method": request.method,
                        "path": request.path,
                        "query": dict(request.GET) if hasattr(request, "GET") else {},
                    }
                    try:
                        if hasattr(request, "body") and request.body:
                            input_data["body"] = json.loads(request.body)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        pass
                    if kwargs:
                        input_data["params"] = kwargs

                    error_exc = None
                    result = None
                    try:
                        result = orig(request, *args, **kwargs)
                    except Exception as exc:
                        error_exc = exc
                        _emit_route(name, "django", input_data, None, error_exc)
                        raise

                    output_data = None
                    try:
                        if hasattr(result, "content"):
                            output_data = json.loads(result.content)
                        elif isinstance(result, dict):
                            output_data = result
                    except Exception:
                        pass

                    _emit_route(name, "django", input_data, output_data, error_exc)
                    return result
                return wrapper

            pattern.callback = make_wrapper(original, route_name)

        # Recurse into included patterns
        if hasattr(pattern, "url_patterns"):
            _instrument_django_urls(pattern.url_patterns)


# ---------------------------------------------------------------------------
# Litestar auto-instrumentation
# ---------------------------------------------------------------------------


def instrument_litestar(app: Any) -> None:
    """Instrument a Litestar app using lifecycle hooks.

    Uses before_request (input capture) and before_send (response capture)
    to observe all HTTP endpoints.

    Usage:
        from litestar import Litestar
        from trickle import instrument_litestar

        app = Litestar(...)
        instrument_litestar(app)
    """
    # Store request data keyed by scope id for correlation
    _request_store: Dict[int, Dict[str, Any]] = {}

    original_before_request = app.before_request

    async def trickle_before_request(request: Any) -> None:
        """Capture input before the handler runs."""
        try:
            scope = request.scope if hasattr(request, "scope") else {}
            req_id = id(scope)

            input_data: Dict[str, Any] = {
                "path": str(request.url.path) if hasattr(request, "url") else "/",
                "method": request.method if hasattr(request, "method") else "GET",
                "query": dict(request.query_params) if hasattr(request, "query_params") else {},
            }

            if scope.get("path_params"):
                input_data["params"] = dict(scope["path_params"])

            if hasattr(request, "method") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
                try:
                    body_bytes = await request.body()
                    if body_bytes:
                        try:
                            input_data["body"] = json.loads(body_bytes)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            pass
                except Exception:
                    pass

            route_name = f"{input_data['method']} {input_data['path']}"
            try:
                route = scope.get("route")
                if route and hasattr(route, "path"):
                    route_name = f"{input_data['method']} {route.path}"
            except Exception:
                pass

            _request_store[req_id] = {"input": input_data, "route": route_name}
        except Exception:
            pass

        if original_before_request is not None:
            result = original_before_request(request)
            if inspect.isawaitable(result):
                await result

    async def trickle_before_send(message: Any, scope: Any) -> None:
        """Capture response body from the ASGI send messages."""
        try:
            if scope.get("type") != "http":
                return
            req_id = id(scope)
            store = _request_store.get(req_id)
            if not store:
                return

            if message["type"] == "http.response.body":
                body = message.get("body", b"")
                if body:
                    try:
                        output_data = json.loads(body)
                        _emit_route(store["route"], "litestar", store["input"], output_data, None)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        _emit_route(store["route"], "litestar", store["input"], None, None)
                    _request_store.pop(req_id, None)
        except Exception:
            pass

    app.before_request = trickle_before_request
    app.before_send.append(trickle_before_send)


# ---------------------------------------------------------------------------
# Auto-detect and instrument
# ---------------------------------------------------------------------------


def instrument(app: Any) -> None:
    """Auto-detect the framework and instrument the app.

    Usage:
        from trickle import instrument
        instrument(app)

    Supports: FastAPI, Flask, Django (pass urlpatterns), Litestar.
    """
    app_type = type(app).__name__
    module_name = type(app).__module__ or ""

    # FastAPI / Starlette
    if "fastapi" in module_name.lower() or app_type in ("FastAPI", "Starlette"):
        instrument_fastapi(app)
        return

    # Litestar
    if "litestar" in module_name.lower() or app_type == "Litestar":
        instrument_litestar(app)
        return

    # Flask
    if "flask" in module_name.lower() or app_type == "Flask":
        instrument_flask(app)
        return

    # Django URL patterns (list of URLPattern/URLResolver)
    if isinstance(app, (list, tuple)):
        if len(app) > 0 and hasattr(app[0], "callback"):
            _instrument_django_urls(app)
            return

    logger.warning(
        f"trickle: could not auto-detect framework for {app_type} "
        f"(module: {module_name}). Use instrument_fastapi(), "
        f"instrument_flask(), instrument_django(), or instrument_litestar() directly."
    )
