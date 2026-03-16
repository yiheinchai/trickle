Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle's strategic moat is zero-code, local-first runtime observability for both humans AND AI agents — at zero cost. The market has three openings: (1) a cost revolt against Datadog/New Relic ($50K-$1M/year), (2) 10,390+ MCP servers with no observability standard, and (3) LangSmith locked to LangChain while CrewAI, OpenAI Agents SDK, and Microsoft Agent Framework all need framework-agnostic observability. Trickle's positioning: the Switzerland of agent observability — works with every framework, every LLM provider, every IDE agent. Three strategic pillars: (1) MCP-native observability — be the default way AI coding agents understand runtime behavior; 10K+ MCP servers generate traces that need capturing, and trickle's MCP server already feeds context back to agents. (2) Framework-agnostic agent tracing — trace LangChain, CrewAI, OpenAI Agents SDK, and custom agents with zero code changes, owning the space LangSmith can't reach. (3) Vibe-coder DX — zero-config, single-line setup, instant results; 45% of AI-generated code has security vulnerabilities, and developers building with AI need observability that's as fast as their workflow. Every feature must pass: "does this make a developer (or their AI agent) understand running code faster, with zero setup friction?"
</higher directive>

<focus point>
CLI 0.1.178, client-js 0.2.120, client-python 0.2.29. SHIPPED: live status display, Gemini auto-instrumentation, OTel export (`trickle export --otlp`), CSV export, pagination, LLM auto-instrumentation (OpenAI + Anthropic + Gemini), WebSocket observer, dashboard charts/sorting. LLM coverage spans top 3 providers.

Priority areas ranked by strategic opportunity:

1. **Framework-agnostic agent tracing** — LangSmith is locked to LangChain. CrewAI, OpenAI Agents SDK, Microsoft Agent Framework (AutoGen+Semantic Kernel merger), and LangGraph all need third-party observability. Build zero-code auto-detection and tracing of agent workflows: tool calls, reasoning steps, delegation between agents, state changes. Trace the agent execution graph automatically when running `trickle run` on any agent framework. This is the single biggest market gap — Arize Phoenix has agent graph visualization but requires manual instrumentation.

2. **MCP tool call tracing** — 10,390+ MCP servers exist and growing. Nobody traces MCP tool invocations as first-class observability events. Add automatic capture of MCP tool calls (tool name, arguments, response, latency, errors) into `.trickle/mcp.jsonl`. This makes trickle indispensable for anyone building or consuming MCP servers — and positions trickle at the center of the AI tool ecosystem.

3. **Agent execution graph visualization** — Add a visual node-based graph view to the dashboard showing agent decision flow: LLM calls → tool invocations → sub-agent delegation → results. Arize Phoenix has this and it's becoming table stakes. Combine with trickle's existing call trace data to show the full picture without extra instrumentation.

4. **WebSocket dashboard streaming** — Upgrade live status from CLI-only to browser dashboard via WebSocket. Real-time updates for long-running servers, training loops, and agent workflows. The shift-left observability trend demands instant feedback during development.

5. **Python .pyi stub quality** — FIXED: class_name preserved during merge (Tensor/SimpleCNN no longer become TypedDict), Union[Any,Any,Any] deduplicated, conditional imports added. **More LLM providers** — Add Cohere and Mistral AI auto-instrumentation for broader LLM coverage.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
