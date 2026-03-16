"""LLM call observer — auto-instruments OpenAI, Anthropic, and other LLM SDKs.

Captures prompts, completions, token counts, latency, cost, and model metadata
with zero code changes. Writes to .trickle/llm.jsonl.

Follows the same monkey-patching pattern as db_observer.py:
1. Patch already-imported modules eagerly
2. Hook builtins.__import__ for future imports
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

_debug = False
_llm_file: str | None = None
_event_count = 0
_MAX_EVENTS = 500
_TRUNCATE_LEN = 500

# Token budget enforcement
_cumulative_tokens = 0
_cumulative_cost = 0.0
_budget_warned = False
_TOKEN_BUDGET = int(os.environ.get("TRICKLE_TOKEN_BUDGET", "0"))
_COST_BUDGET = float(os.environ.get("TRICKLE_COST_BUDGET", "0"))

# Approximate pricing per 1M tokens (USD)
_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.5, "output": 10},
    "gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "gpt-4-turbo": {"input": 10, "output": 30},
    "gpt-4": {"input": 30, "output": 60},
    "gpt-3.5-turbo": {"input": 0.5, "output": 1.5},
    "claude-opus-4-20250514": {"input": 15, "output": 75},
    "claude-sonnet-4-20250514": {"input": 3, "output": 15},
    "claude-3-5-sonnet-20241022": {"input": 3, "output": 15},
    "claude-3-5-haiku-20241022": {"input": 0.8, "output": 4},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    "gemini-2.5-flash-lite": {"input": 0.1, "output": 0.4},
    "gemini-2.5-flash": {"input": 0.3, "output": 2.5},
    "gemini-2.5-pro": {"input": 1.25, "output": 10},
    "gemini-2.0-flash": {"input": 0.1, "output": 0.4},
    "gemini-1.5-flash": {"input": 0.075, "output": 0.3},
    "gemini-1.5-pro": {"input": 1.25, "output": 5},
}


def _get_llm_file() -> str:
    global _llm_file
    if _llm_file:
        return _llm_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _llm_file = os.path.join(local_dir, "llm.jsonl")
    return _llm_file


def _write_event(event: dict[str, Any]) -> None:
    global _event_count, _cumulative_tokens, _cumulative_cost, _budget_warned
    if _event_count >= _MAX_EVENTS:
        return
    _event_count += 1

    # Track cumulative usage for budget enforcement
    _cumulative_tokens += event.get("totalTokens", 0) or 0
    _cumulative_cost += event.get("estimatedCostUsd", 0) or 0

    if not _budget_warned:
        if _TOKEN_BUDGET > 0 and _cumulative_tokens > _TOKEN_BUDGET:
            import sys
            print(f"[trickle] \u26a0 Token budget exceeded: {_cumulative_tokens} tokens used (budget: {_TOKEN_BUDGET})", file=sys.stderr)
            _budget_warned = True
        if _COST_BUDGET > 0 and _cumulative_cost > _COST_BUDGET:
            import sys
            print(f"[trickle] \u26a0 Cost budget exceeded: ${_cumulative_cost:.4f} spent (budget: ${_COST_BUDGET:.4f})", file=sys.stderr)
            _budget_warned = True

    try:
        with open(_get_llm_file(), "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass


def _truncate(s: str, length: int = _TRUNCATE_LEN) -> str:
    if not s:
        return ""
    return s[:length] + "..." if len(s) > length else s


def _estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    for key, pricing in _PRICING.items():
        if key in model:
            cost = (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000
            return round(cost, 6)
    return 0.0


def _extract_input_preview(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return ""
    last = messages[-1]
    content = last.get("content", "")
    if isinstance(content, str):
        return _truncate(content)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                return _truncate(part.get("text", ""))
    return ""


def _extract_system_prompt(messages: list[dict[str, Any]] | None, system: Any = None) -> str | None:
    # Anthropic uses a top-level 'system' parameter
    if system and isinstance(system, str):
        return _truncate(system, 200)
    # OpenAI uses a system message
    if messages:
        for m in messages:
            if m.get("role") == "system":
                c = m.get("content", "")
                if isinstance(c, str):
                    return _truncate(c, 200)
    return None


def _has_tool_use(params: dict[str, Any]) -> bool:
    tools = params.get("tools")
    return bool(tools and isinstance(tools, list) and len(tools) > 0)


# ────────────────────────────────────────────────────
# OpenAI SDK patching
# ────────────────────────────────────────────────────


def patch_openai(openai_module: Any) -> None:
    """Patch the OpenAI SDK to capture LLM calls."""
    if getattr(openai_module, "_trickle_llm_patched", False):
        return
    openai_module._trickle_llm_patched = True

    # OpenAI SDK v1+ has OpenAI class with client.chat.completions.create
    OpenAI = getattr(openai_module, "OpenAI", None)
    if OpenAI is None:
        return

    _orig_init = OpenAI.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        _orig_init(self, *args, **kwargs)
        _patch_openai_client(self)

    OpenAI.__init__ = _patched_init

    # Also patch AsyncOpenAI if available
    AsyncOpenAI = getattr(openai_module, "AsyncOpenAI", None)
    if AsyncOpenAI:
        _orig_async_init = AsyncOpenAI.__init__

        def _patched_async_init(self: Any, *args: Any, **kwargs: Any) -> None:
            _orig_async_init(self, *args, **kwargs)
            _patch_openai_client(self)

        AsyncOpenAI.__init__ = _patched_async_init

    if _debug:
        print("[trickle/llm] Patched OpenAI SDK")


def _patch_openai_client(client: Any) -> None:
    """Patch chat.completions.create on a client instance."""
    chat_completions = getattr(getattr(client, "chat", None), "completions", None)
    if not chat_completions or getattr(chat_completions.create, "_trickle_patched", False):
        return

    _orig_create = chat_completions.create

    def _patched_create(*args: Any, **kwargs: Any) -> Any:
        params = kwargs if kwargs else (args[0] if args else {})
        start = time.perf_counter()
        error_msg = None
        result = None
        try:
            result = _orig_create(*args, **kwargs)
            return result
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 2)
            _capture_openai_result(params, result, duration_ms, error_msg)

    _patched_create._trickle_patched = True  # type: ignore
    chat_completions.create = _patched_create


def _capture_openai_result(
    params: dict[str, Any], result: Any, duration_ms: float, error_msg: str | None
) -> None:
    try:
        model = params.get("model", "unknown")
        messages = params.get("messages", [])
        stream = params.get("stream", False)

        if error_msg:
            _write_event({
                "kind": "llm_call", "provider": "openai", "model": model,
                "durationMs": duration_ms, "inputTokens": 0, "outputTokens": 0,
                "totalTokens": 0, "estimatedCostUsd": 0, "stream": stream,
                "finishReason": "error", "temperature": params.get("temperature"),
                "maxTokens": params.get("max_tokens"),
                "systemPrompt": _extract_system_prompt(messages),
                "inputPreview": _extract_input_preview(messages),
                "outputPreview": "", "messageCount": len(messages),
                "toolUse": _has_tool_use(params),
                "timestamp": int(time.time() * 1000), "error": error_msg,
            })
            return

        if result is None or stream:
            # Streaming responses are iterable — we can't easily capture them
            # without consuming the stream. Record what we know.
            _write_event({
                "kind": "llm_call", "provider": "openai", "model": model,
                "durationMs": duration_ms, "inputTokens": 0, "outputTokens": 0,
                "totalTokens": 0, "estimatedCostUsd": 0, "stream": True,
                "finishReason": "stream",
                "temperature": params.get("temperature"),
                "maxTokens": params.get("max_tokens"),
                "systemPrompt": _extract_system_prompt(messages),
                "inputPreview": _extract_input_preview(messages),
                "outputPreview": "(streaming)", "messageCount": len(messages),
                "toolUse": _has_tool_use(params),
                "timestamp": int(time.time() * 1000),
            })
            return

        # Non-streaming response
        usage = getattr(result, "usage", None) or {}
        if hasattr(usage, "prompt_tokens"):
            input_tokens = usage.prompt_tokens or 0
            output_tokens = usage.completion_tokens or 0
            total_tokens = usage.total_tokens or 0
        else:
            input_tokens = getattr(usage, "get", lambda k, d: d)("prompt_tokens", 0)
            output_tokens = getattr(usage, "get", lambda k, d: d)("completion_tokens", 0)
            total_tokens = getattr(usage, "get", lambda k, d: d)("total_tokens", 0)

        choices = getattr(result, "choices", []) or []
        output_text = ""
        finish_reason = "unknown"
        if choices:
            msg = getattr(choices[0], "message", None)
            if msg:
                output_text = getattr(msg, "content", "") or ""
            finish_reason = getattr(choices[0], "finish_reason", "unknown") or "unknown"

        _write_event({
            "kind": "llm_call", "provider": "openai", "model": model,
            "durationMs": duration_ms, "inputTokens": input_tokens,
            "outputTokens": output_tokens, "totalTokens": total_tokens,
            "estimatedCostUsd": _estimate_cost(model, input_tokens, output_tokens),
            "stream": False, "finishReason": finish_reason,
            "temperature": params.get("temperature"),
            "maxTokens": params.get("max_tokens"),
            "systemPrompt": _extract_system_prompt(messages),
            "inputPreview": _extract_input_preview(messages),
            "outputPreview": _truncate(output_text),
            "messageCount": len(messages), "toolUse": _has_tool_use(params),
            "timestamp": int(time.time() * 1000),
        })

        if _debug:
            print(f"[trickle/llm] OpenAI: {model} ({total_tokens} tokens, {duration_ms}ms)")
    except Exception:
        pass  # Never crash user's app


# ────────────────────────────────────────────────────
# Anthropic SDK patching
# ────────────────────────────────────────────────────


def patch_anthropic(anthropic_module: Any) -> None:
    """Patch the Anthropic SDK to capture LLM calls."""
    if getattr(anthropic_module, "_trickle_llm_patched", False):
        return
    anthropic_module._trickle_llm_patched = True

    Anthropic = getattr(anthropic_module, "Anthropic", None)
    if Anthropic is None:
        return

    _orig_init = Anthropic.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        _orig_init(self, *args, **kwargs)
        _patch_anthropic_client(self)

    Anthropic.__init__ = _patched_init

    # Also patch AsyncAnthropic
    AsyncAnthropic = getattr(anthropic_module, "AsyncAnthropic", None)
    if AsyncAnthropic:
        _orig_async_init = AsyncAnthropic.__init__

        def _patched_async_init(self: Any, *args: Any, **kwargs: Any) -> None:
            _orig_async_init(self, *args, **kwargs)
            _patch_anthropic_client(self)

        AsyncAnthropic.__init__ = _patched_async_init

    if _debug:
        print("[trickle/llm] Patched Anthropic SDK")


def _patch_anthropic_client(client: Any) -> None:
    """Patch messages.create on an Anthropic client instance."""
    messages = getattr(client, "messages", None)
    if not messages or getattr(getattr(messages, "create", None), "_trickle_patched", False):
        return

    _orig_create = messages.create

    def _patched_create(*args: Any, **kwargs: Any) -> Any:
        params = kwargs if kwargs else (args[0] if args else {})
        start = time.perf_counter()
        error_msg = None
        result = None
        try:
            result = _orig_create(*args, **kwargs)
            return result
        except Exception as e:
            error_msg = str(e)[:200]
            raise
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 2)
            _capture_anthropic_result(params, result, duration_ms, error_msg)

    _patched_create._trickle_patched = True  # type: ignore
    messages.create = _patched_create


def _capture_anthropic_result(
    params: dict[str, Any], result: Any, duration_ms: float, error_msg: str | None
) -> None:
    try:
        model = params.get("model", "unknown")
        msgs = params.get("messages", [])
        system = params.get("system")
        stream = params.get("stream", False)

        if error_msg:
            _write_event({
                "kind": "llm_call", "provider": "anthropic", "model": model,
                "durationMs": duration_ms, "inputTokens": 0, "outputTokens": 0,
                "totalTokens": 0, "estimatedCostUsd": 0, "stream": stream,
                "finishReason": "error", "temperature": params.get("temperature"),
                "maxTokens": params.get("max_tokens"),
                "systemPrompt": _extract_system_prompt(msgs, system),
                "inputPreview": _extract_input_preview(msgs),
                "outputPreview": "", "messageCount": len(msgs),
                "toolUse": _has_tool_use(params),
                "timestamp": int(time.time() * 1000), "error": error_msg,
            })
            return

        if result is None or stream:
            _write_event({
                "kind": "llm_call", "provider": "anthropic", "model": model,
                "durationMs": duration_ms, "inputTokens": 0, "outputTokens": 0,
                "totalTokens": 0, "estimatedCostUsd": 0, "stream": True,
                "finishReason": "stream",
                "temperature": params.get("temperature"),
                "maxTokens": params.get("max_tokens"),
                "systemPrompt": _extract_system_prompt(msgs, system),
                "inputPreview": _extract_input_preview(msgs),
                "outputPreview": "(streaming)", "messageCount": len(msgs),
                "toolUse": _has_tool_use(params),
                "timestamp": int(time.time() * 1000),
            })
            return

        # Non-streaming response
        usage = getattr(result, "usage", None)
        input_tokens = getattr(usage, "input_tokens", 0) or 0
        output_tokens = getattr(usage, "output_tokens", 0) or 0
        total_tokens = input_tokens + output_tokens

        content = getattr(result, "content", []) or []
        output_text = ""
        has_tool = False
        for block in content:
            if getattr(block, "type", "") == "text":
                output_text += getattr(block, "text", "")
            elif getattr(block, "type", "") == "tool_use":
                has_tool = True

        result_model = getattr(result, "model", model) or model
        stop_reason = getattr(result, "stop_reason", "unknown") or "unknown"

        _write_event({
            "kind": "llm_call", "provider": "anthropic", "model": result_model,
            "durationMs": duration_ms, "inputTokens": input_tokens,
            "outputTokens": output_tokens, "totalTokens": total_tokens,
            "estimatedCostUsd": _estimate_cost(result_model, input_tokens, output_tokens),
            "stream": False, "finishReason": stop_reason,
            "temperature": params.get("temperature"),
            "maxTokens": params.get("max_tokens"),
            "systemPrompt": _extract_system_prompt(msgs, system),
            "inputPreview": _extract_input_preview(msgs),
            "outputPreview": _truncate(output_text),
            "messageCount": len(msgs),
            "toolUse": _has_tool_use(params) or has_tool,
            "timestamp": int(time.time() * 1000),
        })

        if _debug:
            print(f"[trickle/llm] Anthropic: {result_model} ({total_tokens} tokens, {duration_ms}ms)")
    except Exception:
        pass  # Never crash user's app


# ────────────────────────────────────────────────────
# Google Gemini SDK patching (google-genai)
# ────────────────────────────────────────────────────


def patch_gemini(genai_module: Any) -> None:
    """Patch the Google Gemini SDK to capture LLM calls."""
    if getattr(genai_module, "_trickle_llm_patched", False):
        return
    genai_module._trickle_llm_patched = True

    # google-genai uses: client = genai.Client(api_key=...)
    # then client.models.generate_content(model=..., contents=...)
    ClientClass = getattr(genai_module, "Client", None)
    if ClientClass is None:
        return

    _orig_init = ClientClass.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        _orig_init(self, *args, **kwargs)
        _patch_gemini_client(self)

    ClientClass.__init__ = _patched_init

    if _debug:
        print("[trickle/llm] Patched Google Gemini SDK")


def _patch_gemini_client(client: Any) -> None:
    """Patch models.generate_content on a Gemini client instance."""
    models = getattr(client, "models", None)
    if not models:
        return

    gen = getattr(models, "generate_content", None)
    if gen and not getattr(gen, "_trickle_patched", False):
        _orig_generate = gen

        def _patched_generate(*args: Any, **kwargs: Any) -> Any:
            params = kwargs if kwargs else (args[0] if args and isinstance(args[0], dict) else {})
            # Handle positional args: generate_content(model=..., contents=...)
            if not isinstance(params, dict):
                params = {}
            if "model" not in params and len(args) >= 1:
                params = dict(kwargs)
                # Try to extract model from kwargs or the method call
            start = time.perf_counter()
            error_msg = None
            result = None
            try:
                result = _orig_generate(*args, **kwargs)
                return result
            except Exception as e:
                error_msg = str(e)[:200]
                raise
            finally:
                duration_ms = round((time.perf_counter() - start) * 1000, 2)
                _capture_gemini_result(params, kwargs, result, duration_ms, error_msg)

        _patched_generate._trickle_patched = True  # type: ignore
        models.generate_content = _patched_generate


def _capture_gemini_result(
    params: dict[str, Any],
    kwargs: dict[str, Any],
    result: Any,
    duration_ms: float,
    error_msg: str | None,
) -> None:
    try:
        model = kwargs.get("model", params.get("model", "gemini-unknown"))
        contents = kwargs.get("contents", params.get("contents", ""))

        # Extract input preview
        if isinstance(contents, str):
            input_preview = _truncate(contents)
        elif isinstance(contents, list) and contents:
            last = contents[-1]
            if isinstance(last, str):
                input_preview = _truncate(last)
            else:
                input_preview = _truncate(str(last)[:200])
        else:
            input_preview = ""

        if error_msg:
            _write_event({
                "kind": "llm_call", "provider": "gemini", "model": model,
                "durationMs": duration_ms, "inputTokens": 0, "outputTokens": 0,
                "totalTokens": 0, "estimatedCostUsd": 0, "stream": False,
                "finishReason": "error",
                "inputPreview": input_preview,
                "outputPreview": "", "messageCount": 0,
                "toolUse": False,
                "timestamp": int(time.time() * 1000), "error": error_msg,
            })
            return

        if result is None:
            return

        # Extract response data
        usage = getattr(result, "usage_metadata", None)
        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
        output_tokens = getattr(usage, "candidates_token_count", 0) or 0
        total_tokens = getattr(usage, "total_token_count", 0) or (input_tokens + output_tokens)

        output_text = ""
        finish_reason = "unknown"
        try:
            output_text = result.text or ""
        except Exception:
            candidates = getattr(result, "candidates", []) or []
            if candidates:
                parts = getattr(getattr(candidates[0], "content", None), "parts", []) or []
                if parts:
                    output_text = getattr(parts[0], "text", "") or ""

        candidates = getattr(result, "candidates", []) or []
        if candidates:
            finish_reason = getattr(candidates[0], "finish_reason", "unknown") or "unknown"
            if hasattr(finish_reason, "name"):
                finish_reason = finish_reason.name

        config = kwargs.get("config", params.get("config", {}))
        if not isinstance(config, dict):
            config = {}

        _write_event({
            "kind": "llm_call", "provider": "gemini", "model": model,
            "durationMs": duration_ms, "inputTokens": input_tokens,
            "outputTokens": output_tokens, "totalTokens": total_tokens,
            "estimatedCostUsd": _estimate_cost(model, input_tokens, output_tokens),
            "stream": False, "finishReason": str(finish_reason),
            "temperature": config.get("temperature"),
            "maxTokens": config.get("max_output_tokens"),
            "inputPreview": input_preview,
            "outputPreview": _truncate(output_text),
            "messageCount": len(contents) if isinstance(contents, list) else (1 if contents else 0),
            "toolUse": bool(config.get("tools")),
            "timestamp": int(time.time() * 1000),
        })

        if _debug:
            print(f"[trickle/llm] Gemini: {model} ({total_tokens} tokens, {duration_ms}ms)")
    except Exception:
        pass  # Never crash user's app


# ────────────────────────────────────────────────────
# Installation
# ────────────────────────────────────────────────────


def patch_llms(debug: bool = False) -> None:
    """Install LLM observer hooks.

    Patches already-imported LLM SDKs and hooks builtins.__import__
    to catch future imports.
    """
    global _debug
    _debug = debug

    import sys

    # Clear previous LLM data
    try:
        f = _get_llm_file()
        with open(f, "w") as fp:
            fp.truncate(0)
    except Exception:
        pass

    _LLM_PATCHES: dict[str, Any] = {
        "openai": patch_openai,
        "anthropic": patch_anthropic,
        "google.genai": patch_gemini,
    }

    # Patch already-imported modules
    for mod_name, patcher in _LLM_PATCHES.items():
        if mod_name in sys.modules:
            try:
                patcher(sys.modules[mod_name])
            except Exception:
                pass

    # Register patches with db_observer's __import__ hook instead of
    # creating a separate one (avoids double-hooking stack trace noise)
    try:
        from trickle.db_observer import register_import_patches
        register_import_patches(_LLM_PATCHES)
    except Exception:
        pass
