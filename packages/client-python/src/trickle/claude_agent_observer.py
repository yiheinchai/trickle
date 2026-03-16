"""Claude Agent SDK observer — auto-instruments claude-agent-sdk.

Captures tool calls (PreToolUse/PostToolUse), subagent lifecycle,
and agent run completion with zero code changes.

Writes to .trickle/agents.jsonl alongside LangChain/CrewAI events.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

_debug = False
_TRUNCATE_LEN = 500


def _get_agents_file() -> str:
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    return os.path.join(local_dir, "agents.jsonl")


def _write_event(event: dict[str, Any]) -> None:
    try:
        with open(_get_agents_file(), "a") as f:
            f.write(json.dumps(event, default=str) + "\n")
    except Exception:
        pass


def _truncate(s: str, length: int = _TRUNCATE_LEN) -> str:
    if not s:
        return ""
    return s[:length] + "..." if len(s) > length else s


def _safe_str(obj: Any) -> str:
    try:
        return str(obj)[:_TRUNCATE_LEN]
    except Exception:
        return "?"


# ────────────────────────────────────────────────────
# Hook functions for Claude Agent SDK
# ────────────────────────────────────────────────────

_tool_start_times: dict[str, float] = {}
_subagent_start_times: dict[str, float] = {}


async def _pre_tool_use_hook(hook_input: Any, tool_use_id: str | None, context: Any) -> dict[str, Any]:
    """Called before every tool execution in Claude Agent SDK."""
    tool_name = getattr(hook_input, "tool_name", "unknown")
    tool_input = getattr(hook_input, "tool_input", "")
    agent_id = getattr(hook_input, "agent_id", None)

    if tool_use_id:
        _tool_start_times[tool_use_id] = time.perf_counter()

    _write_event({
        "kind": "agent_action",
        "event": "tool_start",
        "tool": _safe_str(tool_name),
        "toolInput": _truncate(_safe_str(tool_input)),
        "framework": "claude-agent-sdk",
        "agentId": _safe_str(agent_id) if agent_id else None,
        "toolUseId": tool_use_id,
        "timestamp": int(time.time() * 1000),
    })

    if _debug:
        print(f"[trickle/agent] Claude SDK PreToolUse: {tool_name}")

    return {}  # Don't modify behavior


async def _post_tool_use_hook(hook_input: Any, tool_use_id: str | None, context: Any) -> dict[str, Any]:
    """Called after every tool execution in Claude Agent SDK."""
    tool_name = getattr(hook_input, "tool_name", "unknown")
    tool_response = getattr(hook_input, "tool_response", "")

    dur = 0.0
    if tool_use_id and tool_use_id in _tool_start_times:
        dur = round((time.perf_counter() - _tool_start_times.pop(tool_use_id)) * 1000, 2)

    _write_event({
        "kind": "agent_action",
        "event": "tool_end",
        "tool": _safe_str(tool_name),
        "output": _truncate(_safe_str(tool_response)),
        "durationMs": dur,
        "framework": "claude-agent-sdk",
        "toolUseId": tool_use_id,
        "timestamp": int(time.time() * 1000),
    })

    return {}


async def _post_tool_use_failure_hook(hook_input: Any, tool_use_id: str | None, context: Any) -> dict[str, Any]:
    """Called when a tool execution fails."""
    tool_name = getattr(hook_input, "tool_name", "unknown")
    error = getattr(hook_input, "error", "")

    dur = 0.0
    if tool_use_id and tool_use_id in _tool_start_times:
        dur = round((time.perf_counter() - _tool_start_times.pop(tool_use_id)) * 1000, 2)

    _write_event({
        "kind": "agent_action",
        "event": "tool_error",
        "tool": _safe_str(tool_name),
        "error": _truncate(_safe_str(error)),
        "durationMs": dur,
        "framework": "claude-agent-sdk",
        "toolUseId": tool_use_id,
        "timestamp": int(time.time() * 1000),
    })

    return {}


async def _subagent_start_hook(hook_input: Any, tool_use_id: str | None, context: Any) -> dict[str, Any]:
    """Called when a subagent starts."""
    agent_id = getattr(hook_input, "agent_id", "unknown")
    agent_type = getattr(hook_input, "agent_type", "")

    _subagent_start_times[str(agent_id)] = time.perf_counter()

    _write_event({
        "kind": "agent_action",
        "event": "agent_start",
        "chain": f"subagent:{_safe_str(agent_id)}",
        "framework": "claude-agent-sdk",
        "agentId": _safe_str(agent_id),
        "timestamp": int(time.time() * 1000),
    })

    return {}


async def _subagent_stop_hook(hook_input: Any, tool_use_id: str | None, context: Any) -> dict[str, Any]:
    """Called when a subagent stops."""
    agent_id = getattr(hook_input, "agent_id", "unknown")

    dur = 0.0
    if str(agent_id) in _subagent_start_times:
        dur = round((time.perf_counter() - _subagent_start_times.pop(str(agent_id))) * 1000, 2)

    _write_event({
        "kind": "agent_action",
        "event": "agent_end",
        "chain": f"subagent:{_safe_str(agent_id)}",
        "framework": "claude-agent-sdk",
        "agentId": _safe_str(agent_id),
        "durationMs": dur,
        "timestamp": int(time.time() * 1000),
    })

    return {}


# ────────────────────────────────────────────────────
# Auto-injection into Claude Agent SDK
# ────────────────────────────────────────────────────


def patch_claude_agent_sdk(sdk_module: Any) -> None:
    """Auto-inject trickle hooks into Claude Agent SDK.

    Patches the query() function and ClaudeSDKClient to auto-add
    trickle hooks to ClaudeAgentOptions.
    """
    if getattr(sdk_module, "_trickle_agent_patched", False):
        return
    sdk_module._trickle_agent_patched = True

    _trickle_hooks = _build_hooks_config(sdk_module)
    if _trickle_hooks is None:
        if _debug:
            print("[trickle/agent] Claude Agent SDK: could not build hooks config")
        return

    # Patch the query() function
    orig_query = getattr(sdk_module, "query", None)
    if orig_query and not getattr(orig_query, "_trickle_patched", False):
        async def _patched_query(*, prompt: Any = None, options: Any = None, **kwargs: Any) -> Any:
            options = _inject_hooks(options, _trickle_hooks, sdk_module)

            _write_event({
                "kind": "agent_action",
                "event": "crew_start",
                "chain": "ClaudeAgent",
                "framework": "claude-agent-sdk",
                "input": _truncate(_safe_str(prompt)),
                "timestamp": int(time.time() * 1000),
            })

            start = time.perf_counter()
            try:
                result = orig_query(prompt=prompt, options=options, **kwargs)
                # query() returns AsyncIterator — wrap it to capture completion
                return _wrap_message_iterator(result, start)
            except Exception as e:
                dur = round((time.perf_counter() - start) * 1000, 2)
                _write_event({
                    "kind": "agent_action",
                    "event": "crew_error",
                    "chain": "ClaudeAgent",
                    "framework": "claude-agent-sdk",
                    "error": _truncate(str(e)),
                    "durationMs": dur,
                    "timestamp": int(time.time() * 1000),
                })
                raise

        _patched_query._trickle_patched = True  # type: ignore
        sdk_module.query = _patched_query

    # Patch ClaudeSDKClient.__init__ to auto-inject hooks
    ClientClass = getattr(sdk_module, "ClaudeSDKClient", None)
    if ClientClass and not getattr(ClientClass.__init__, "_trickle_patched", False):
        _orig_init = ClientClass.__init__

        def _patched_init(self: Any, options: Any = None, **kwargs: Any) -> None:
            options = _inject_hooks(options, _trickle_hooks, sdk_module)
            _orig_init(self, options=options, **kwargs)

        _patched_init._trickle_patched = True  # type: ignore
        ClientClass.__init__ = _patched_init

    if _debug:
        print("[trickle/agent] Patched Claude Agent SDK")


def _build_hooks_config(sdk_module: Any) -> Any:
    """Build the hooks configuration for trickle."""
    try:
        HookMatcher = None
        # Try different import paths
        for path in [
            "claude_agent_sdk.types",
            "claude_agent_sdk",
        ]:
            try:
                mod = __import__(path, fromlist=["HookMatcher"])
                HookMatcher = getattr(mod, "HookMatcher", None)
                if HookMatcher:
                    break
            except ImportError:
                continue

        if HookMatcher is None:
            return None

        return {
            "PreToolUse": [HookMatcher(hooks=[_pre_tool_use_hook])],
            "PostToolUse": [HookMatcher(hooks=[_post_tool_use_hook])],
            "PostToolUseFailure": [HookMatcher(hooks=[_post_tool_use_failure_hook])],
            "SubagentStart": [HookMatcher(hooks=[_subagent_start_hook])],
            "SubagentStop": [HookMatcher(hooks=[_subagent_stop_hook])],
        }
    except Exception:
        return None


def _inject_hooks(options: Any, trickle_hooks: dict, sdk_module: Any) -> Any:
    """Inject trickle hooks into ClaudeAgentOptions."""
    try:
        ClaudeAgentOptions = getattr(sdk_module, "ClaudeAgentOptions", None)
        if options is None and ClaudeAgentOptions:
            options = ClaudeAgentOptions(hooks=trickle_hooks)
        elif options is not None:
            existing_hooks = getattr(options, "hooks", None) or {}
            merged = {**trickle_hooks}
            # Merge with existing hooks (append trickle hooks)
            for key, matchers in existing_hooks.items():
                if key in merged:
                    merged[key] = list(matchers) + merged[key]
                else:
                    merged[key] = list(matchers)
            if hasattr(options, "hooks"):
                options.hooks = merged
            elif isinstance(options, dict):
                options["hooks"] = merged
    except Exception:
        pass
    return options


async def _wrap_message_iterator(iterator: Any, start_time: float) -> Any:
    """Wrap the async message iterator to capture completion."""
    try:
        async for message in iterator:
            # Check for ResultMessage (final result)
            msg_type = type(message).__name__
            if msg_type == "ResultMessage":
                dur = round((time.perf_counter() - start_time) * 1000, 2)
                _write_event({
                    "kind": "agent_action",
                    "event": "crew_end",
                    "chain": "ClaudeAgent",
                    "framework": "claude-agent-sdk",
                    "output": _truncate(_safe_str(getattr(message, "result", ""))),
                    "durationMs": dur,
                    "tokens": getattr(message, "total_cost_usd", None),
                    "timestamp": int(time.time() * 1000),
                })
            yield message
    except Exception as e:
        dur = round((time.perf_counter() - start_time) * 1000, 2)
        _write_event({
            "kind": "agent_action",
            "event": "crew_error",
            "chain": "ClaudeAgent",
            "framework": "claude-agent-sdk",
            "error": _truncate(str(e)),
            "durationMs": dur,
            "timestamp": int(time.time() * 1000),
        })
        raise


# ────────────────────────────────────────────────────
# Installation
# ────────────────────────────────────────────────────


def patch_claude_agents(debug: bool = False) -> None:
    """Install Claude Agent SDK observer hooks."""
    global _debug
    _debug = debug

    import sys

    if "claude_agent_sdk" in sys.modules:
        try:
            patch_claude_agent_sdk(sys.modules["claude_agent_sdk"])
        except Exception:
            pass

    try:
        from trickle.db_observer import register_import_patches
        register_import_patches({
            "claude_agent_sdk": patch_claude_agent_sdk,
        })
    except Exception:
        pass
