Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle now traces ALL major agent frameworks (LangChain, CrewAI, Claude Agent SDK, OpenAI Agents SDK) with zero code changes, detects silent failures, and has causal debugging (`trickle why`). No other tool matches this breadth. The "see everything" chapter is complete. The next chapter: "catch every mistake." Developers are screaming "less capability, more reliability" — 89% have observability but only 52% have evals (LangChain State of Agents 2026). The winning pattern is trace-based evaluation: score agent runs using traces already captured. Microsoft Research launched AgentRx to find "critical failure steps," LangWatch open-sourced OTLP-native evals, and agent-replay tools are emerging for run diffing. Trickle's strategic pivot: from observability platform to reliability platform. Three pillars: (1) Trace-based evals — score agent runs on the traces trickle already captures, closing the 37% gap between teams with observability and teams with evals. (2) Agent reliability — replay runs, diff between runs, detect variance across identical tasks, regression-test agent behavior as models update. (3) Zero friction, zero cost — free, local, zero-code. Every feature must pass: "does this help a developer catch agent mistakes and improve reliability, with zero setup?"
</higher directive>

<focus point>
CLI 0.1.186, client-js 0.2.121, client-python 0.2.34. 38 MCP tools. SHIPPED: All 4 agent framework tracers (LangChain + CrewAI + Claude Agent SDK + OpenAI Agents SDK), silent failure detection, `trickle why` causal debugging, agent trace visualization, MCP tool call tracing, LLM auto-instrumentation (OpenAI + Anthropic + Gemini), cost-report with budgets, live status display.

The "see everything" layer is complete. Priority now shifts to "catch every mistake" — reliability and evaluation:

1. **Trace-based agent evaluation** — 89% of teams have observability but only 52% have evals (LangChain State of Agents). Build `trickle eval` that scores agent runs using traces already captured: tool selection accuracy (did the agent pick the right tool?), output relevance (did the response address the query?), cost efficiency (tokens spent vs value delivered). Use LLM-as-judge on captured traces — no separate eval pipeline needed. LangWatch just open-sourced this pattern; trickle should have it natively and locally.

2. **Agent run replay and diff** — `agent-replay` (local SQLite CLI) is gaining traction. Trickle already captures full agent traces. Add `trickle diff` to compare two runs side-by-side: show exactly where agent behavior diverged (different tool selected, different LLM response, different cost). Critical for regression testing when models update. Harvard research shows reliability requires multi-run testing on identical tasks.

3. **Per-agent cost roll-up** — SHIPPED: `trickle cost-report` now includes "By Agent/Workflow" section that attributes LLM costs to active agents by correlating LLM call timestamps with agent activity windows from agents.jsonl. Shows cost, call count, and token usage per agent/crew. JSON output includes `byAgent` for CI integration.

4. **Cache hit/miss observability** — Prompt caching delivers 30-50% cost reduction but nobody surfaces cache hit rates alongside cost data. Add detection of cached vs uncached LLM responses (bimodal latency distributions: cached = milliseconds, uncached = seconds). Show cache efficiency in cost-report and dashboard.

5. **Interactive agent trace exploration** — Click-to-expand nodes in agent trace view with: full prompt/completion text, token counts, latency breakdown, cost per step, and eval score per decision. Transform the trace tree from a read-only view into a debugging workbench.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
