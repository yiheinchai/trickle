Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle has completed two chapters: "see everything" (all 4 agent frameworks, LLM/MCP tracing, causal debugging) and "catch every mistake" (trace-based evals, run diffing, silent failure detection, per-agent cost). The next chapter: "prove it's safe." A regulatory cliff is arriving — EU AI Act (Aug 2, 2026), Colorado AI Act (June 30, 2026), California already active — and agent security is a live threat (OpenClaw vulnerabilities March 14, OWASP AI Agent Security Cheat Sheet published, "Lethal Trifecta" of prompt injection + tool abuse + data exfiltration). 65% of enterprise AI tools operate without IT oversight (shadow AI), and compliance teams need audit trails, tool-call authorization logs, and data lineage. Trickle's strategic advantage: it already captures everything locally in JSONL files — that IS an audit trail, it just needs to be formatted for compliance. Three pillars: (1) Agent security observability — detect prompt injection, unauthorized tool calls, and data exfiltration patterns in traces trickle already captures. (2) Compliance-ready audit export — format trickle's local data for EU AI Act / Colorado AI Act requirements before the deadlines hit. (3) CI/CD agent reliability — `trickle eval` already outputs JSON; integrate into CI pipelines with fail-on-grade thresholds. Every feature must pass: "does this help a developer prove their agent is safe, reliable, and compliant, with zero setup?"
</higher directive>

<focus point>
CLI 0.1.189, client-js 0.2.121, client-python 0.2.34. 38 MCP tools, 75 CLI commands. SHIPPED: All 4 agent framework tracers, silent failure detection, `trickle why`, `trickle eval` (A-F grading), `trickle diff-runs`, per-agent cost roll-up, agent trace visualization, MCP/LLM auto-instrumentation, cost-report with budgets.

Both "see everything" and "catch every mistake" layers complete. Priority shifts to "prove it's safe" — security, compliance, and CI/CD:

1. **Agent security observability** — SHIPPED: `trickle security` now scans LLM calls, agent events, and MCP tool calls for the "Lethal Trifecta": (a) prompt injection (6 patterns: instruction override, role hijacking, jailbreak, etc.), (b) privilege escalation (dangerous shell commands via agent tools), (c) data exfiltration (secrets in LLM outputs/MCP responses), (d) secret leaks to LLMs (API keys/tokens passed in prompts). Scans all data sources: variables, queries, logs, functions, LLM calls, agent events, MCP calls.

2. **Compliance audit export** — SHIPPED: `trickle audit --compliance` generates structured compliance reports with: risk classification (HIGH/MEDIUM/LOW with factors), decision lineage (chronological trace of all LLM/agent/tool/MCP events), data processing summary (providers, models, tokens, cost, tools), security findings, eval score, and human oversight assessment. Export as JSON (`--json` or `-o file.json`). Local-first: audit data never leaves the machine.

3. **CI/CD eval integration** — SHIPPED: `trickle eval --fail-under 70` exits with code 1 if score drops below threshold. JSON output includes `threshold` and `passed` fields for CI parsing. Works in any CI pipeline: `trickle eval --fail-under 70 --json`. TODO: reusable GitHub Action, PR comment posting.

4. **Cache hit/miss observability** — Prompt caching delivers 30-50% cost savings but nobody surfaces cache efficiency alongside cost data. Detect cached vs uncached LLM responses via latency bimodality (cached = <100ms, uncached = seconds) and provider-reported cache tokens (OpenAI/Anthropic both expose this). Show cache hit rate in cost-report and dashboard. Developers burning $5-25K/month on tokens need to know if caching is actually working.

5. **Interactive agent trace exploration** — Click-to-expand nodes in the agent trace view with: full prompt/completion text, token counts, latency breakdown, cost per step, eval score, and security flags per decision. This transforms the trace tree from read-only into a debugging + compliance workbench.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
