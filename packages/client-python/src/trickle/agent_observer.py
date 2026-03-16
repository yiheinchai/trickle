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
            serialized = serialized or {}
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
        if hasattr(CallbackManager, "configure") and not getattr(CallbackManager, "_trickle_patched", False):
            # Get the underlying function from the classmethod
            orig_func = CallbackManager.configure.__func__ if hasattr(CallbackManager.configure, '__func__') else CallbackManager.configure

            def _patched_configure_func(cls: Any, *args: Any, **kwargs: Any) -> Any:
                manager = orig_func(cls, *args, **kwargs)
                if manager is not None:
                    try:
                        handler_names = {getattr(h, "name", None) for h in (getattr(manager, 'inheritable_handlers', None) or [])}
                        if "trickle_agent_observer" not in handler_names:
                            manager.add_handler(handler, inherit=True)
                    except Exception:
                        pass
                return manager

            CallbackManager.configure = classmethod(_patched_configure_func)  # type: ignore
            CallbackManager._trickle_patched = True  # type: ignore

            if _debug:
                print("[trickle/agent] Patched CallbackManager.configure — agent tracing enabled")
    except Exception as e:
        if _debug:
            print(f"[trickle/agent] Failed to patch CallbackManager: {e}")


# ────────────────────────────────────────────────────
# CrewAI auto-instrumentation via event bus
# ────────────────────────────────────────────────────


def patch_crewai(crewai_module: Any) -> None:
    """Auto-inject trickle event listener into CrewAI's event bus.

    CrewAI has a built-in event system (CrewAIEventsBus) that fires events
    for crew kickoff, agent execution, task start/end, tool usage, and LLM calls.
    We register listeners for all of these — zero code changes needed.
    """
    if getattr(crewai_module, "_trickle_agent_patched", False):
        return
    crewai_module._trickle_agent_patched = True

    try:
        from crewai.utilities.events.event_listener import crewai_event_bus
    except ImportError:
        try:
            from crewai.events.event_listener import crewai_event_bus
        except ImportError:
            if _debug:
                print("[trickle/agent] CrewAI event bus not found — skipping")
            return

    # Import event types — wrapped in try/except for version compatibility
    event_handlers: list[tuple[Any, str]] = []

    def _try_import_event(path: str) -> Any:
        try:
            parts = path.rsplit(".", 1)
            mod = __import__(parts[0], fromlist=[parts[1]])
            return getattr(mod, parts[1])
        except Exception:
            return None

    # Crew events
    CrewKickoffStarted = _try_import_event("crewai.utilities.events.crew_events.CrewKickoffStartedEvent")
    CrewKickoffCompleted = _try_import_event("crewai.utilities.events.crew_events.CrewKickoffCompletedEvent")
    CrewKickoffFailed = _try_import_event("crewai.utilities.events.crew_events.CrewKickoffFailedEvent")

    # Agent events
    AgentStarted = _try_import_event("crewai.utilities.events.agent_events.AgentExecutionStartedEvent")
    AgentCompleted = _try_import_event("crewai.utilities.events.agent_events.AgentExecutionCompletedEvent")
    AgentError = _try_import_event("crewai.utilities.events.agent_events.AgentExecutionErrorEvent")

    # Task events
    TaskStarted = _try_import_event("crewai.utilities.events.task_events.TaskStartedEvent")
    TaskCompleted = _try_import_event("crewai.utilities.events.task_events.TaskCompletedEvent")
    TaskFailed = _try_import_event("crewai.utilities.events.task_events.TaskFailedEvent")

    # Tool events
    ToolStarted = _try_import_event("crewai.utilities.events.tool_events.ToolUsageStartedEvent")
    ToolFinished = _try_import_event("crewai.utilities.events.tool_events.ToolUsageFinishedEvent")
    ToolError = _try_import_event("crewai.utilities.events.tool_events.ToolUsageErrorEvent")

    # LLM events
    LLMStarted = _try_import_event("crewai.utilities.events.llm_events.LLMCallStartedEvent")
    LLMCompleted = _try_import_event("crewai.utilities.events.llm_events.LLMCallCompletedEvent")
    LLMFailed = _try_import_event("crewai.utilities.events.llm_events.LLMCallFailedEvent")

    _start_times: dict[str, float] = {}

    def _safe_str(obj: Any) -> str:
        try:
            return str(obj)[:_TRUNCATE_LEN]
        except Exception:
            return "?"

    # Register event handlers
    if CrewKickoffStarted:
        @crewai_event_bus.on(CrewKickoffStarted)
        def _on_crew_start(ev: Any) -> None:
            _start_times["crew"] = time.perf_counter()
            _write_event({
                "kind": "agent_action", "event": "crew_start",
                "chain": "CrewAI", "framework": "crewai",
                "input": _truncate(_safe_str(getattr(ev, "inputs", ""))),
                "timestamp": int(time.time() * 1000),
            })
            if _debug:
                print("[trickle/agent] CrewAI: crew started")

    if CrewKickoffCompleted:
        @crewai_event_bus.on(CrewKickoffCompleted)
        def _on_crew_end(ev: Any) -> None:
            dur = round((time.perf_counter() - _start_times.pop("crew", time.perf_counter())) * 1000, 2)
            output = getattr(ev, "output", None)
            token_usage = getattr(output, "token_usage", None) if output else None
            _write_event({
                "kind": "agent_action", "event": "crew_end",
                "chain": "CrewAI", "framework": "crewai",
                "output": _truncate(_safe_str(getattr(output, "raw", output))),
                "durationMs": dur,
                "tokens": _safe_str(token_usage) if token_usage else None,
                "timestamp": int(time.time() * 1000),
            })

    if CrewKickoffFailed:
        @crewai_event_bus.on(CrewKickoffFailed)
        def _on_crew_fail(ev: Any) -> None:
            dur = round((time.perf_counter() - _start_times.pop("crew", time.perf_counter())) * 1000, 2)
            _write_event({
                "kind": "agent_action", "event": "crew_error",
                "chain": "CrewAI", "framework": "crewai",
                "error": _truncate(_safe_str(getattr(ev, "error", ""))),
                "durationMs": dur,
                "timestamp": int(time.time() * 1000),
            })

    if AgentStarted:
        @crewai_event_bus.on(AgentStarted)
        def _on_agent_start(ev: Any) -> None:
            agent = getattr(ev, "agent", None)
            name = getattr(agent, "role", "unknown") if agent else "unknown"
            _start_times[f"agent:{name}"] = time.perf_counter()
            _write_event({
                "kind": "agent_action", "event": "agent_start",
                "chain": name, "framework": "crewai",
                "timestamp": int(time.time() * 1000),
            })

    if AgentCompleted:
        @crewai_event_bus.on(AgentCompleted)
        def _on_agent_end(ev: Any) -> None:
            agent = getattr(ev, "agent", None)
            name = getattr(agent, "role", "unknown") if agent else "unknown"
            dur = round((time.perf_counter() - _start_times.pop(f"agent:{name}", time.perf_counter())) * 1000, 2)
            _write_event({
                "kind": "agent_action", "event": "agent_end",
                "chain": name, "framework": "crewai",
                "output": _truncate(_safe_str(getattr(ev, "output", ""))),
                "durationMs": dur,
                "timestamp": int(time.time() * 1000),
            })

    if TaskStarted:
        @crewai_event_bus.on(TaskStarted)
        def _on_task_start(ev: Any) -> None:
            task = getattr(ev, "task", None)
            desc = getattr(task, "description", "unknown") if task else "unknown"
            _start_times[f"task:{desc[:30]}"] = time.perf_counter()
            _write_event({
                "kind": "agent_action", "event": "task_start",
                "chain": _truncate(desc, 100), "framework": "crewai",
                "timestamp": int(time.time() * 1000),
            })

    if TaskCompleted:
        @crewai_event_bus.on(TaskCompleted)
        def _on_task_end(ev: Any) -> None:
            task = getattr(ev, "task", None)
            desc = getattr(task, "description", "unknown") if task else "unknown"
            dur = round((time.perf_counter() - _start_times.pop(f"task:{desc[:30]}", time.perf_counter())) * 1000, 2)
            output = getattr(ev, "output", None)
            _write_event({
                "kind": "agent_action", "event": "task_end",
                "chain": _truncate(desc, 100), "framework": "crewai",
                "output": _truncate(_safe_str(output)),
                "durationMs": dur,
                "timestamp": int(time.time() * 1000),
            })

    if ToolStarted:
        @crewai_event_bus.on(ToolStarted)
        def _on_tool_start(ev: Any) -> None:
            name = _safe_str(getattr(ev, "tool_name", "unknown"))
            _start_times[f"tool:{name}"] = time.perf_counter()
            _write_event({
                "kind": "agent_action", "event": "tool_start",
                "tool": name, "framework": "crewai",
                "toolInput": _truncate(_safe_str(getattr(ev, "tool_input", ""))),
                "timestamp": int(time.time() * 1000),
            })

    if ToolFinished:
        @crewai_event_bus.on(ToolFinished)
        def _on_tool_end(ev: Any) -> None:
            name = _safe_str(getattr(ev, "tool_name", "unknown"))
            dur = round((time.perf_counter() - _start_times.pop(f"tool:{name}", time.perf_counter())) * 1000, 2)
            _write_event({
                "kind": "agent_action", "event": "tool_end",
                "tool": name, "framework": "crewai",
                "output": _truncate(_safe_str(getattr(ev, "tool_result", ""))),
                "durationMs": dur,
                "timestamp": int(time.time() * 1000),
            })

    if ToolError:
        @crewai_event_bus.on(ToolError)
        def _on_tool_error(ev: Any) -> None:
            name = _safe_str(getattr(ev, "tool_name", "unknown"))
            dur = round((time.perf_counter() - _start_times.pop(f"tool:{name}", time.perf_counter())) * 1000, 2)
            _write_event({
                "kind": "agent_action", "event": "tool_error",
                "tool": name, "framework": "crewai",
                "error": _truncate(_safe_str(getattr(ev, "error", ""))),
                "durationMs": dur,
                "timestamp": int(time.time() * 1000),
            })

    if LLMCompleted:
        @crewai_event_bus.on(LLMCompleted)
        def _on_llm_end(ev: Any) -> None:
            _write_event({
                "kind": "agent_action", "event": "llm_end",
                "framework": "crewai",
                "output": _truncate(_safe_str(getattr(ev, "response", ""))),
                "timestamp": int(time.time() * 1000),
            })

    if _debug:
        print("[trickle/agent] CrewAI event listeners registered")


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

    # Deferred patching: langchain_core has circular imports, so we can't
    # patch CallbackManager during the initial import. Use a timer to patch
    # after the module is fully loaded.
    import threading

    def _deferred_patch_langchain():
        try:
            if "langchain_core" in sys.modules:
                patch_langchain(sys.modules["langchain_core"])
        except Exception:
            pass

    def _deferred_patch_crewai():
        try:
            if "crewai" in sys.modules:
                patch_crewai(sys.modules["crewai"])
        except Exception:
            pass

    # Patch already-imported modules (deferred to avoid circular imports)
    if "langchain_core" in sys.modules:
        threading.Timer(0.1, _deferred_patch_langchain).start()
    if "crewai" in sys.modules:
        threading.Timer(0.1, _deferred_patch_crewai).start()

    # Register deferred patches with the import hook
    def _langchain_hook(mod: Any) -> None:
        threading.Timer(0.1, _deferred_patch_langchain).start()

    def _crewai_hook(mod: Any) -> None:
        threading.Timer(0.1, _deferred_patch_crewai).start()

    try:
        from trickle.db_observer import register_import_patches
        register_import_patches({
            "langchain_core": _langchain_hook,
            "langchain": _langchain_hook,
            "crewai": _crewai_hook,
        })
    except Exception:
        pass
