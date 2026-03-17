# AI Agent Builder: Debug Agent Workflows with Zero-Code Tracing

You're building AI agents with LangChain, CrewAI, or custom frameworks. Your agent makes LLM calls, invokes tools, and chains reasoning steps — but when something goes wrong, you have no visibility into what happened. Trickle auto-traces every LLM call, tool invocation, and agent step with zero code changes.

## Install

```bash
npm install -g trickle-cli
pip install trickle-observe   # for Python agents
```

---

## Use Case 1: Trace LangChain Agent Execution

Run your LangChain agent through trickle — every chain, tool call, and LLM invocation is captured automatically:

```bash
trickle run python my_agent.py
```

**What you see during execution (live status):**
```
[07:38:30] trickle: 3 fn | 12 var | 5 agent | 2 llm
[07:38:33] trickle: 3 fn | 12 var | 8 agent | 4 llm
```

**After execution — view the agent trace:**
```bash
trickle dashboard-local
```

The **Agent Trace** tab shows a nested tree of every step:
```
⛓ AgentExecutor (1200ms)
  → "What is the weather in Paris?"
  ✨ LLM: gpt-4o (320ms, 150 tokens)
  ⚒ get_weather
    I should check the weather in Paris
  ⚙ get_weather (45ms)
    → {"city": "Paris"}
    ← "Sunny, 22°C"
  ✨ LLM: gpt-4o (250ms, 80 tokens)
  ✔ finish
    I now know the answer
    ← "The weather in Paris is sunny at 22°C"
```

**How it works:** Trickle patches LangChain's `CallbackManager.configure()` to auto-inject a callback handler as an inheritable handler. No `callbacks=[...]` parameter needed.

---

## Use Case 2: Track LLM Costs Across Providers

Every OpenAI, Anthropic, and Google Gemini API call is captured with token counts and estimated costs:

```bash
trickle run python my_app.py
trickle llm
```

**Output:**
```
  trickle llm
  ────────────────────────────────────────────────────────────
  12 LLM calls  $0.0234 est. cost  4.2K tokens  8.3s total
  ────────────────────────────────────────────────────────────
  openai/gpt-4o — 8 calls, 3.1K tokens, $0.0189, avg 650ms
  anthropic/claude-3-5-sonnet — 3 calls, 900 tokens, $0.0039, avg 420ms
  gemini/gemini-2.5-flash — 1 call, 200 tokens, $0.0006, avg 180ms
```

**Supports:** OpenAI (GPT-4o, GPT-4, GPT-3.5), Anthropic (Claude 4, 3.5), Google Gemini (2.5, 2.0, 1.5) — all auto-detected, zero code changes.

---

## Use Case 3: Debug MCP Tool Calls

If your agent uses MCP tools, every tool invocation is captured:

```bash
trickle run node my_mcp_client.js
trickle mcp-calls
```

**Output:**
```
  trickle mcp-calls
  ────────────────────────────────────────────────────────────
  8 tool calls  5 outgoing  3 incoming  1.2s total
  ────────────────────────────────────────────────────────────
  → fetch_url — 3 calls, avg 340ms
  → search_docs — 2 calls, avg 120ms
  ← get_context — 3 calls, avg 5ms
```

Both client-side (outgoing `callTool`) and server-side (incoming tool handlers) are traced.

---

## Use Case 4: Export Agent Traces

Export all agent data for analysis or sharing:

```bash
# CSV files for spreadsheet analysis
trickle export --csv

# OpenTelemetry for Grafana/Jaeger
trickle export --otlp

# JSON for custom tooling
trickle llm --json > llm_calls.json
trickle mcp-calls --json > mcp_calls.json
```

---

## Use Case 5: AI Agent Debugging AI Agents

If you're using Claude Code or another AI coding agent to debug your AI agent, trickle's MCP server feeds runtime context directly:

```bash
trickle init   # Sets up MCP server in .claude/settings.json
```

Now Claude Code can use tools like:
- `get_last_run_summary` — see all agent steps, LLM calls, errors
- `get_llm_calls` — inspect token usage and costs
- `get_mcp_tool_calls` — see MCP tool invocations
- `explain_file` — understand how your agent code works at runtime

The AI agent debugging your AI agent can see exactly what happened — no more guessing.

---

## Zero-Code Setup — How It Works

Trickle uses import hooks to auto-instrument SDKs:

| SDK | What's Captured | Data File |
|-----|----------------|-----------|
| OpenAI / Anthropic / Gemini | Model, tokens, cost, latency, prompts, responses | `.trickle/llm.jsonl` |
| @modelcontextprotocol/sdk | Tool name, args, response, latency, direction | `.trickle/mcp.jsonl` |
| LangChain | Chains, tools, agent actions, LLM calls, parent-child | `.trickle/agents.jsonl` |
| Express / FastAPI / Flask | Routes, request/response types, errors | `.trickle/observations.jsonl` |
| sqlite3 / pg / mysql | SQL queries, duration, row counts | `.trickle/queries.jsonl` |

All captured with `trickle run` — no decorators, no config files, no API keys needed.
