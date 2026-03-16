from .decorator import trickle
from .transport import configure, flush
from .instrument import (
    instrument,
    instrument_fastapi,
    instrument_flask,
    instrument_django,
    instrument_litestar,
)
from .observe import observe, observe_fn
from .progress import progress

# Observer patch functions — call these to enable tracing for specific libraries.
# Each patch function is idempotent and safe to call multiple times.
from .llm_observer import patch_openai, patch_anthropic, patch_gemini, patch_mistral, patch_cohere, patch_llms
from .db_observer import patch_sqlite3, patch_psycopg2, patch_sqlalchemy, patch_redis, patch_pymongo
from .agent_observer import patch_langchain, patch_crewai
from .openai_agents_observer import patch_openai_agents
from .mcp_observer import patch_mcp_client, patch_mcp_server, patch_mcp
from .memory_observer import patch_mem0, patch_langgraph_checkpointer, patch_memory
from .http_observer import patch_http

__all__ = [
    # Core
    "trickle",
    "configure",
    "flush",
    # Framework instrumentation
    "instrument",
    "instrument_fastapi",
    "instrument_flask",
    "instrument_django",
    "instrument_litestar",
    # Universal observation
    "observe",
    "observe_fn",
    "progress",
    # LLM observers
    "patch_openai",
    "patch_anthropic",
    "patch_gemini",
    "patch_mistral",
    "patch_cohere",
    "patch_llms",
    # Database observers
    "patch_sqlite3",
    "patch_psycopg2",
    "patch_sqlalchemy",
    "patch_redis",
    "patch_pymongo",
    # Agent observers
    "patch_langchain",
    "patch_crewai",
    "patch_openai_agents",
    # MCP observers
    "patch_mcp_client",
    "patch_mcp_server",
    "patch_mcp",
    # Memory observers
    "patch_mem0",
    "patch_langgraph_checkpointer",
    "patch_memory",
    # HTTP observer
    "patch_http",
]


# IPython extension entry point: %load_ext trickle
def load_ipython_extension(ipython):  # type: ignore
    """Called by IPython when ``%load_ext trickle`` is executed."""
    from .notebook import load_ipython_extension as _load
    _load(ipython)


def unload_ipython_extension(ipython):  # type: ignore
    """Called by IPython when ``%unload_ext trickle`` is executed."""
    from .notebook import unload_ipython_extension as _unload
    _unload(ipython)
