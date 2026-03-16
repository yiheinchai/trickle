Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle has completed three chapters: "see everything" (all 4 agent frameworks, LLM/MCP tracing, causal debugging), "catch every mistake" (evals, run diffing, silent failure detection, per-agent cost), and "prove it's safe" (security scanning, compliance audit export, CI/CD eval gating). The next chapter: "meet developers where they are." 57% of companies have agents in production, but a single AI agent generates 10-100x more observability data than traditional apps — teams are hitting $150K/month on cloud monitoring. Trickle's local-first approach eliminates this cost entirely. Meanwhile, IDE-native observability is the clear trend: Honeycomb built MCP for Cursor, Datadog shipped Code Insights for VS Code, and developers want runtime insights without leaving their editor. Trickle already has a VSCode extension + 37 MCP tools — the infrastructure exists. Three pillars: (1) IDE-native runtime insights — surface eval scores, security alerts, cost data, and agent traces inside VS Code and Cursor via trickle's existing MCP server and VSCode extension. (2) Smart data management — agents produce massive telemetry; add intelligent sampling, retention policies, and summarization so trickle stays fast even on heavy workloads. (3) Model tier observability — as enterprises use tiered inference (80% cheap model, 20% frontier for 75% cost savings), they need to see which tier handled what and whether quality held. Every feature must pass: "does this surface the right insight, in the right place, at the right time, with zero cost and zero setup?"
</higher directive>

<focus point>
CLI 0.1.192, client-js 0.2.121, client-python 0.2.34. 37 MCP tools, 74 CLI commands. SHIPPED: All 4 agent framework tracers, silent failure detection, `trickle why`, `trickle eval` (A-F + --fail-under for CI), `trickle diff-runs`, per-agent cost roll-up, `trickle security` (Lethal Trifecta scanning), `trickle audit --compliance` (EU AI Act / Colorado AI Act reports), GitHub Action example workflow.

Three chapters complete (see everything → catch every mistake → prove it's safe). Priority shifts to "meet developers where they are":

1. **IDE-native runtime insights** — PARTIAL: VSCode extension now surfaces security alerts (prompt injection, privilege escalation, cost spikes, tool errors, agent failures) as VS Code diagnostics (yellow/red squiggles). Watches alerts.jsonl for real-time updates. TODO: inline eval scores, per-function cost CodeLens, agent trace sidebar panel.

2. **Model tier / routing observability** — SHIPPED: cost-report now includes "Model Tier Analysis" classifying models into Frontier/Standard/Mini tiers. Shows per-tier cost%, call%, avg latency, error rate. Detects over-use of frontier models with optimization suggestion. Covers OpenAI (gpt-4/o1/o3), Anthropic (opus/sonnet/haiku), Gemini (pro/flash/lite). JSON output includes `byTier` for CI.

3. **Smart data management** — SHIPPED: `trickle cleanup` with configurable retention. `--retain-days 7` prunes by timestamp, `--retain-lines 100` keeps last N lines per file. `--dry-run` shows impact without modifying. Cleans all JSONL files + snapshot/CSV dirs. TODO: auto-cleanup on run, TRICKLE_SAMPLE_RATE for JS client, trace summarization.

4. **Cache hit/miss observability** — SHIPPED: cost-report now includes "Cache Analysis" detecting cached vs uncached LLM responses from latency bimodality (5x+ speed difference between fast and slow calls to same model). Shows per-model hit rate, fast/slow call counts, speedup factor, and avg latencies. Works on existing data without provider-specific API changes.

5. **GitHub Action for trickle eval** — SHIPPED: Reusable workflow at `.github/workflows/trickle-eval.yml` + example at `example-agent-ci.yml`. Features: run agent with trickle, evaluate with --fail-under, security scan, compliance report as artifact, post eval score as PR comment. Updated devops-ci.md use case with agent CI examples. TODO: publish to GitHub Marketplace as standalone action.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
