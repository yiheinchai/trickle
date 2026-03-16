"""Agent workflow observer — auto-instruments LangChain agents.

Captures agent steps (thought→action→observation), tool calls, LLM calls,
chain execution, and the full agent workflow with parent-child relationships.

Writes to .trickle/agents.jsonl. Zero code changes needed — patches
langchain_core's CallbackManager to auto-inject a trickle handler.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional
from uuid import UUID

_debug = False
_agents_file: str | None = None
_event_count = 0
_MAX_EVENTS = 2000
_TRUNCATE_LEN = 500


def _get_agents_file() -> str:
    global _agents_file
    if _agents_file:
        return _agents_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _agents_file = os.path.join(local_dir, "agents.jsonl")
    return _agents_file


def _write_event(event: dict[str, Any]) -> None:
    global _event_count
    if _event_count >= _MAX_EVENTS:
        return
    _event_count += 1
    try:
        with open(_get_agents_file(), "a") as f:
            f.write(json.dumps(event, default=str) + "\n")
    except Exception:
        pass


def _truncate(s: str, length: int = _TRUNCATE_LEN) -> str:
    if not s:
        return ""
    return s[:length] + "..." if len(s) > length else s


def _create_trickle_handler() -> Any:
    """Create a LangChain callback handler that writes agent events."""
    try:
        from langchain_core.callbacks.base import BaseCallbackHandler
    except ImportError:
        return None

    class TrickleAgentHandler(BaseCallbackHandler):
        """Captures agent workflow events for trickle observability."""

        name = "trickle_agent_observer"

        def __init__(self) -> None:
            super().__init__()
            self._start_times: dict[str, float] = {}

        def _record_start(self, run_id: UUID) -> None:
            self._start_times[str(run_id)] = time.perf_counter()

        def _get_duration(self, run_id: UUID) -> float:
            start = self._start_times.pop(str(run_id), None)
            if start is None:
                return 0.0
            return round((time.perf_counter() - start) * 1000, 2)

        # ── Agent events ──

        def on_agent_action(
            self, action: Any, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            tool = getattr(action, "tool", "unknown")
            tool_input = getattr(action, "tool_input", "")
            log = getattr(action, "log", "")
            _write_event({
                "kind": "agent_action", "event": "action",
                "tool": str(tool),
                "toolInput": _truncate(str(tool_input)),
                "thought": _truncate(str(log)),
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })
            if _debug:
                print(f"[trickle/agent] Action: {tool}({_truncate(str(tool_input), 50)})")

        def on_agent_finish(
            self, finish: Any, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            output = getattr(finish, "return_values", {})
            log = getattr(finish, "log", "")
            _write_event({
                "kind": "agent_action", "event": "finish",
                "output": _truncate(str(output)),
                "thought": _truncate(str(log)),
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })
            if _debug:
                print(f"[trickle/agent] Finish: {_truncate(str(output), 80)}")

        # ── Tool events ──

        def on_tool_start(
            self, serialized: dict[str, Any], input_str: str, *,
            run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            self._record_start(run_id)
            name = serialized.get("name", "unknown")
            _write_event({
                "kind": "agent_action", "event": "tool_start",
                "tool": name,
                "toolInput": _truncate(str(input_str)),
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        def on_tool_end(
            self, output: Any, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            _write_event({
                "kind": "agent_action", "event": "tool_end",
                "output": _truncate(str(output)),
                "durationMs": duration,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        def on_tool_error(
            self, error: BaseException, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            _write_event({
                "kind": "agent_action", "event": "tool_error",
                "error": _truncate(str(error), 200),
                "durationMs": duration,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        # ── Chain events ──

        def on_chain_start(
            self, serialized: dict[str, Any], inputs: dict[str, Any], *,
            run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            self._record_start(run_id)
            name = serialized.get("name", serialized.get("id", ["unknown"])[-1] if isinstance(serialized.get("id"), list) else "unknown")
            _write_event({
                "kind": "agent_action", "event": "chain_start",
                "chain": str(name),
                "input": _truncate(str(inputs)),
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        def on_chain_end(
            self, outputs: dict[str, Any], *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            _write_event({
                "kind": "agent_action", "event": "chain_end",
                "output": _truncate(str(outputs)),
                "durationMs": duration,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        def on_chain_error(
            self, error: BaseException, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            _write_event({
                "kind": "agent_action", "event": "chain_error",
                "error": _truncate(str(error), 200),
                "durationMs": duration,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        # ── LLM events (within agent context) ──

        def on_llm_start(
            self, serialized: dict[str, Any], prompts: list[str], *,
            run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            self._record_start(run_id)

        def on_chat_model_start(
            self, serialized: dict[str, Any], messages: list[list[Any]], *,
            run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            self._record_start(run_id)

        def on_llm_end(
            self, response: Any, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            # Extract token usage from response
            llm_output = getattr(response, "llm_output", {}) or {}
            usage = llm_output.get("token_usage", {})
            _write_event({
                "kind": "agent_action", "event": "llm_end",
                "durationMs": duration,
                "tokens": usage.get("total_tokens", 0) if isinstance(usage, dict) else 0,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

        def on_llm_error(
            self, error: BaseException, *, run_id: UUID,
            parent_run_id: Optional[UUID] = None, **kwargs: Any
        ) -> None:
            duration = self._get_duration(run_id)
            _write_event({
                "kind": "agent_action", "event": "llm_error",
                "error": _truncate(str(error), 200),
                "durationMs": duration,
                "runId": str(run_id),
                "parentRunId": str(parent_run_id) if parent_run_id else None,
                "timestamp": int(time.time() * 1000),
            })

    return TrickleAgentHandler()


# ────────────────────────────────────────────────────
# Auto-injection into LangChain's callback system
# ────────────────────────────────────────────────────


def patch_langchain(langchain_module: Any) -> None:
    """Auto-inject trickle's callback handler into LangChain.

    Patches CallbackManager.configure() to always include the trickle
    handler as an inheritable handler — giving zero-code agent tracing.
    """
    if getattr(langchain_module, "_trickle_agent_patched", False):
        return
    langchain_module._trickle_agent_patched = True

    handler = _create_trickle_handler()
    if handler is None:
        return

    # Patch CallbackManager.configure to auto-inject our handler
    try:
        from langchain_core.callbacks.manager import CallbackManager
        if hasattr(CallbackManager, "configure") and not getattr(CallbackManager.configure, "_trickle_patched", False):
            _orig_configure = CallbackManager.configure

            @classmethod  # type: ignore
            def _patched_configure(
                cls: Any,
                inheritable_callbacks: Any = None,
                local_callbacks: Any = None,
                verbose: bool = False,
                inheritable_tags: Any = None,
                local_tags: Any = None,
                inheritable_metadata: Any = None,
                local_metadata: Any = None,
            ) -> Any:
                # Call original configure
                manager = _orig_configure.__func__(
                    cls,
                    inheritable_callbacks=inheritable_callbacks,
                    local_callbacks=local_callbacks,
                    verbose=verbose,
                    inheritable_tags=inheritable_tags,
                    local_tags=local_tags,
                    inheritable_metadata=inheritable_metadata,
                    local_metadata=local_metadata,
                )
                # Auto-inject trickle handler if not already present
                if manager is not None:
                    handler_names = {getattr(h, "name", None) for h in (manager.inheritable_handlers or [])}
                    if "trickle_agent_observer" not in handler_names:
                        manager.add_handler(handler, inherit=True)
                return manager

            _patched_configure._trickle_patched = True  # type: ignore
            CallbackManager.configure = _patched_configure  # type: ignore

            if _debug:
                print("[trickle/agent] Patched CallbackManager.configure — agent tracing enabled")
    except Exception as e:
        if _debug:
            print(f"[trickle/agent] Failed to patch CallbackManager: {e}")


# ────────────────────────────────────────────────────
# Installation
# ────────────────────────────────────────────────────


def patch_agents(debug: bool = False) -> None:
    """Install agent observer hooks."""
    global _debug
    _debug = debug

    import sys

    # Clear previous data
    try:
        f = _get_agents_file()
        with open(f, "w") as fp:
            fp.truncate(0)
    except Exception:
        pass

    # Patch already-imported modules
    if "langchain_core" in sys.modules:
        try:
            patch_langchain(sys.modules["langchain_core"])
        except Exception:
            pass

    # Register with the consolidated import hook
    try:
        from trickle.db_observer import register_import_patches
        register_import_patches({
            "langchain_core": patch_langchain,
            "langchain": patch_langchain,
        })
    except Exception:
        pass
