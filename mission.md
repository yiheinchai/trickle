Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle's strategic moat is zero-code, local-first runtime observability that works for both humans AND AI agents. The market is splitting into expensive enterprise APM (Datadog, New Relic) and LLM-specific observability (Langfuse, LangSmith, Helicone). Trickle sits in the underserved middle: general-purpose runtime understanding for individual developers and small teams, with first-class AI agent integration. Double down on this position by: (1) making trickle the default "eyes" for AI coding agents — if an agent uses trickle, it writes better code faster, (2) extending auto-instrumentation to capture LLM/AI calls (OpenAI, Anthropic, etc.) with zero code changes, competing with Langfuse/LangSmith on DX, and (3) ensuring rock-solid reliability on real-world codebases so developers trust it in production. Every feature should pass the test: "does this help a developer (or their AI agent) understand their running code faster?"
</higher directive>

<focus point>
CLI 0.1.176. Priority areas ranked by impact on TAM capture:

1. **LLM/AI call auto-instrumentation** — Add zero-code capture of OpenAI, Anthropic, and other LLM API calls in both JS and Python. Record prompts, completions, token counts, latency, cost, and model metadata into .trickle/llm.jsonl. This lets trickle compete with Langfuse/LangSmith/Helicone on the fastest-growing observability segment while keeping trickle's zero-code DX advantage.

2. **Agent workflow tracing** — Extend tracing to capture multi-step AI agent workflows (tool calls, reasoning chains, delegation between agents). Trickle's MCP integration already makes it agent-native; adding agent-aware tracing makes it indispensable.

3. **Real-world reliability hardening** — Test trickle against 10+ popular open-source repos (Express apps, FastAPI services, Next.js apps, PyTorch training scripts, LangChain agents). Fix every instrumentation failure found.

4. **Export and interoperability** — SHIPPED: CSV export from dashboard (per-tab Export CSV button, /api/csv/:type endpoint, `trickle export --csv` CLI), paginated tables (25/50/100/250 per page). Fixed dashboard table rendering bug. Still TODO: OpenTelemetry GenAI semantic conventions for LLM span export.

5. **Live streaming mode** — Real-time tail of observations in the dashboard (WebSocket-based). Critical for debugging long-running processes and agent workflows.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
