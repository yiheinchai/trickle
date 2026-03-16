"""OpenAI Agents SDK observer — auto-instruments openai-agents.

Captures agent execution, LLM generations, tool/function calls, handoffs,
and guardrails via the SDK's TracingProcessor interface.

Writes to .trickle/agents.jsonl alongside LangChain/CrewAI/Claude events.
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


def _create_trickle_processor() -> Any:
    """Create a TracingProcessor that writes agent events to agents.jsonl."""
    try:
        from agents.tracing import TracingProcessor
    except ImportError:
        return None

    class TrickleAgentProcessor(TracingProcessor):
        """Captures OpenAI Agents SDK trace events for trickle."""

        async def on_trace_start(self, trace: Any) -> None:
            _write_event({
                "kind": "agent_action",
                "event": "crew_start",
                "chain": "OpenAIAgent",
                "framework": "openai-agents",
                "runId": _safe_str(getattr(trace, "trace_id", "")),
                "timestamp": int(time.time() * 1000),
            })
            if _debug:
                print(f"[trickle/agent] OpenAI Agents: trace started")

        async def on_trace_end(self, trace: Any) -> None:
            _write_event({
                "kind": "agent_action",
                "event": "crew_end",
                "chain": "OpenAIAgent",
                "framework": "openai-agents",
                "runId": _safe_str(getattr(trace, "trace_id", "")),
                "timestamp": int(time.time() * 1000),
            })

        async def on_span_start(self, span: Any) -> None:
            data = getattr(span, "span_data", None)
            if data is None:
                return

            data_type = type(data).__name__
            span_id = _safe_str(getattr(span, "span_id", ""))

            if data_type == "AgentSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "agent_start",
                    "chain": _safe_str(getattr(data, "name", "agent")),
                    "framework": "openai-agents",
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "FunctionSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "tool_start",
                    "tool": _safe_str(getattr(data, "name", "unknown")),
                    "toolInput": _truncate(_safe_str(getattr(data, "input", ""))),
                    "framework": "openai-agents",
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "GenerationSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "llm_start",
                    "chain": _safe_str(getattr(data, "model", "unknown")),
                    "framework": "openai-agents",
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "HandoffSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "action",
                    "tool": "handoff",
                    "toolInput": f"{_safe_str(getattr(data, 'from_agent', '?'))} → {_safe_str(getattr(data, 'to_agent', '?'))}",
                    "framework": "openai-agents",
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "GuardrailSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "action",
                    "tool": f"guardrail:{_safe_str(getattr(data, 'name', 'unknown'))}",
                    "framework": "openai-agents",
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

        async def on_span_end(self, span: Any) -> None:
            data = getattr(span, "span_data", None)
            if data is None:
                return

            data_type = type(data).__name__
            span_id = _safe_str(getattr(span, "span_id", ""))

            # Calculate duration from span start/end times if available
            start_t = getattr(span, "started_at", None)
            end_t = getattr(span, "ended_at", None)
            dur = None
            if start_t and end_t:
                try:
                    dur = round((end_t - start_t) * 1000, 2)
                except Exception:
                    pass

            if data_type == "AgentSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "agent_end",
                    "chain": _safe_str(getattr(data, "name", "agent")),
                    "output": _truncate(_safe_str(getattr(data, "output_type", ""))),
                    "framework": "openai-agents",
                    "durationMs": dur,
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "FunctionSpanData":
                _write_event({
                    "kind": "agent_action",
                    "event": "tool_end",
                    "tool": _safe_str(getattr(data, "name", "unknown")),
                    "output": _truncate(_safe_str(getattr(data, "output", ""))),
                    "framework": "openai-agents",
                    "durationMs": dur,
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "GenerationSpanData":
                usage = getattr(data, "usage", None)
                tokens = 0
                if usage:
                    tokens = getattr(usage, "total_tokens", 0) or 0
                _write_event({
                    "kind": "agent_action",
                    "event": "llm_end",
                    "chain": _safe_str(getattr(data, "model", "unknown")),
                    "output": _truncate(_safe_str(getattr(data, "output", ""))),
                    "tokens": tokens,
                    "framework": "openai-agents",
                    "durationMs": dur,
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

            elif data_type == "GuardrailSpanData":
                triggered = getattr(data, "triggered", False)
                _write_event({
                    "kind": "agent_action",
                    "event": "action",
                    "tool": f"guardrail:{_safe_str(getattr(data, 'name', 'unknown'))}",
                    "output": f"triggered={triggered}",
                    "framework": "openai-agents",
                    "durationMs": dur,
                    "runId": span_id,
                    "timestamp": int(time.time() * 1000),
                })

        async def shutdown(self) -> None:
            pass

        async def force_flush(self) -> None:
            pass

    return TrickleAgentProcessor()


# ────────────────────────────────────────────────────
# Auto-registration
# ────────────────────────────────────────────────────


def patch_openai_agents(agents_module: Any) -> None:
    """Auto-register trickle trace processor with OpenAI Agents SDK."""
    if getattr(agents_module, "_trickle_agent_patched", False):
        return
    agents_module._trickle_agent_patched = True

    processor = _create_trickle_processor()
    if processor is None:
        return

    try:
        add_trace_processor = getattr(agents_module, "add_trace_processor", None)
        if add_trace_processor is None:
            from agents import add_trace_processor
        add_trace_processor(processor)
        if _debug:
            print("[trickle/agent] OpenAI Agents SDK: trace processor registered")
    except Exception as e:
        if _debug:
            print(f"[trickle/agent] Failed to register OpenAI Agents processor: {e}")


def patch_openai_agents_sdk(debug: bool = False) -> None:
    """Install OpenAI Agents SDK observer hooks."""
    global _debug
    _debug = debug

    import sys

    if "agents" in sys.modules:
        try:
            patch_openai_agents(sys.modules["agents"])
        except Exception:
            pass

    try:
        from trickle.db_observer import register_import_patches
        register_import_patches({
            "agents": patch_openai_agents,
        })
    except Exception:
        pass
