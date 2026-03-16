Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle's strategic moat is zero-code, local-first runtime observability for both humans AND AI agents — at zero cost. The race is on: Arize Phoenix just added Claude Agent SDK instrumentation, Datadog has native OpenAI Agents integration, and no single zero-code cross-framework product has broken out yet — trickle's window is open but closing. Developer trust in AI is falling (only 3% "highly trust" AI output, down from 70%+ favorability in 2023-24), and silent agent failures (wrong tool selected, wrong doc retrieved, but HTTP 200 returned) are the core unsolved problem. Trickle wins on three axes: (1) Framework-agnostic agent tracing — trickle already traces LangChain + CrewAI; adding Claude Agent SDK + OpenAI Agents SDK completes the "traces everything" story that no competitor can match. (2) Silent failure detection — don't just show what happened, detect when agents silently made wrong decisions. The "why" debugger for AI agents. (3) Zero friction, zero cost — free because it's local, instant because it's zero-code. Every feature must pass: "does this help a developer catch silent agent failures and understand WHY their code behaved this way, with zero setup?"
</higher directive>

<focus point>
CLI 0.1.184, client-js 0.2.121, client-python 0.2.31. 38 MCP tools. SHIPPED: LangChain agent tracing, CrewAI agent tracing, agent trace visualization, MCP tool call tracing, LLM auto-instrumentation (OpenAI + Anthropic + Gemini), cost-report command with budget tracking, live status display, SSE dashboard updates.

Priority areas ranked by competitive urgency:

1. **Claude Agent SDK tracing** — SHIPPED: Zero-code tracing via SDK hooks (PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop). Auto-injects hooks into ClaudeAgentOptions. Captures tool calls with input/output/duration, subagent lifecycle, and full agent run. Events use `framework: "claude-agent-sdk"`. Parity with Arize Phoenix achieved.

2. **OpenAI Agents SDK tracing** — SHIPPED: Zero-code tracing via TracingProcessor interface + add_trace_processor(). Captures AgentSpanData, FunctionSpanData, GenerationSpanData, HandoffSpanData, GuardrailSpanData with timing/tokens. Events use `framework: "openai-agents"`. Trickle now traces ALL major agent frameworks: LangChain + CrewAI + Claude Agent SDK + OpenAI Agents SDK.

3. **Silent failure detection** — SHIPPED: `trickle monitor` now detects LLM and agent anomalies: (a) high LLM error rate, (b) cost spikes (single call >50% of total), (c) excessive token usage (>10K/call), (d) tool retry loops (same tool 3+ times), (e) tool execution errors, (f) agent workflow failures, (g) slow agent runs (>30s). All with actionable suggestions. Alerts written to alerts.jsonl for dashboard and agent consumption.

4. **Per-agent cost roll-up** — Cost-report exists but doesn't break down by agent/workflow. Production agents burn 5-10M tokens/month at 1K users/day. Add per-agent, per-task cost attribution in agent trace view. Show which agent decisions drove cost — enabling developers to optimize the expensive paths.

5. **Interactive agent trace exploration** — The agent trace tab shows a tree view but clicking nodes doesn't expand to full inputs/outputs/timing. Add click-to-expand with: full prompt/completion text, token counts per node, latency breakdown, and cost attribution per decision step.

Just shipped: **`trickle why`** — causal debugging command. Given an error, function, or query, traces back through ALL data sources (errors, call trace, variables, LLM calls, agent events, MCP tools) to build a unified "why" view. Auto-detects the most recent error when no query given. Also available as MCP tool `why` (38 tools total).
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
