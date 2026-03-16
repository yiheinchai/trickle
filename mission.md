Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle's strategic moat is zero-code, local-first runtime observability for both humans AND AI agents — at zero cost. Competition is accelerating: Honeycomb claims "first observability for AI agents," New Relic launched agentic monitoring, Arize Phoenix (8.8K stars) has agent graph visualization. But they're all cloud-first, enterprise-priced, or require code changes. Trickle wins on three axes: (1) Framework-agnostic agent tracing — CrewAI (44.6K stars, 12M+ PyPI downloads) has only proprietary observability; OpenAI Agents SDK tracing is locked to OpenAI; LangSmith is locked to LangChain. Trickle is the only zero-code tool that traces across all of them. (2) Causal debugging — the #1 developer pain is "why did the agent do X?" (66% spend more time fixing near-correct AI code than writing from scratch). Don't just show what happened — show why, with cost attribution and decision path tracing. (3) Zero friction, zero cost — free because it's local, instant because it's zero-code. Every feature must pass: "does this help a developer understand WHY their code (or agent) behaved this way, with zero setup?"
</higher directive>

<focus point>
CLI 0.1.183, client-js 0.2.121, client-python 0.2.31. 36 MCP tools. SHIPPED: LangChain agent tracing, agent trace visualization, MCP tool call tracing, MCP server tools for agent debugging, LLM auto-instrumentation (OpenAI + Anthropic + Gemini), live status display.

Priority areas ranked by market impact:

1. **CrewAI auto-tracing** — SHIPPED: Zero-code CrewAI tracing via event bus (CrewAIEventsBus). Captures crew kickoff/complete, agent start/end, task start/end, tool usage, and LLM calls. Registered via import hook on `crewai` module. Events include `framework: "crewai"` field for dashboard filtering. Works alongside LangChain tracing in the same agents.jsonl.

2. **OpenAI Agents SDK tracing** — OpenAI's SDK has built-in tracing but it's locked to their ecosystem. Developers using mixed providers (OpenAI + Anthropic + open-source models) need vendor-neutral tracing. Add zero-code interception of OpenAI's agent handoffs, guardrails, and tool calls.

3. **Cost attribution** — SHIPPED: `trickle cost-report` command with cost breakdown by provider/model, monthly projection, budget checking (--budget flag), and most expensive calls. Dashboard overview shows LLM cost card. MCP server has `get_cost_report` tool (37 tools total). Still TODO: per-agent cost roll-up and decision path highlighting.

4. **WebSocket dashboard streaming** — Real-time browser updates via WebSocket. The dashboard currently polls every 5 seconds via `/api/data`. Upgrade to push-based streaming for instant feedback during agent runs, server processes, and training loops.

5. **A2A protocol observability** — Google's Agent-to-Agent protocol has 100+ enterprise supporters and CrewAI already supports it natively, but it's still in reference-implementation stage. Monitor adoption; implement tracing when production usage materializes. Don't over-invest in a protocol that may not reach critical mass.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
