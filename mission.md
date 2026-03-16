Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle has completed three chapters: "see everything" (all 4 agent frameworks, LLM/MCP tracing, causal debugging), "catch every mistake" (evals, run diffing, silent failure detection, per-agent cost), and "prove it's safe" (security scanning, compliance audit export, CI/CD eval gating). The next chapter: "meet developers where they are." 57% of companies have agents in production, but a single AI agent generates 10-100x more observability data than traditional apps — teams are hitting $150K/month on cloud monitoring. Trickle's local-first approach eliminates this cost entirely. Meanwhile, IDE-native observability is the clear trend: Honeycomb built MCP for Cursor, Datadog shipped Code Insights for VS Code, and developers want runtime insights without leaving their editor. Trickle already has a VSCode extension + 37 MCP tools — the infrastructure exists. Three pillars: (1) IDE-native runtime insights — surface eval scores, security alerts, cost data, and agent traces inside VS Code and Cursor via trickle's existing MCP server and VSCode extension. (2) Smart data management — agents produce massive telemetry; add intelligent sampling, retention policies, and summarization so trickle stays fast even on heavy workloads. (3) Model tier observability — as enterprises use tiered inference (80% cheap model, 20% frontier for 75% cost savings), they need to see which tier handled what and whether quality held. Every feature must pass: "does this surface the right insight, in the right place, at the right time, with zero cost and zero setup?"
</higher directive>

<focus point>
CLI 0.1.192, client-js 0.2.121, client-python 0.2.34. 37 MCP tools, 74 CLI commands. SHIPPED: All 4 agent framework tracers, silent failure detection, `trickle why`, `trickle eval` (A-F + --fail-under for CI), `trickle diff-runs`, per-agent cost roll-up, `trickle security` (Lethal Trifecta scanning), `trickle audit --compliance` (EU AI Act / Colorado AI Act reports), GitHub Action example workflow.

Three chapters complete (see everything → catch every mistake → prove it's safe). Priority shifts to "meet developers where they are":

1. **IDE-native runtime insights** — Honeycomb and Datadog are shipping IDE observability integrations. Trickle has a VSCode extension and 37 MCP tools but they're not deeply connected. Upgrade the VSCode extension to: (a) show inline eval scores next to functions, (b) surface security alerts as VS Code diagnostics (yellow/red squiggles), (c) display per-function cost in CodeLens, (d) show agent trace tree in a sidebar panel. Also ensure trickle's MCP server works seamlessly in Cursor (it already supports MCP natively). The developer shouldn't have to leave their editor to understand runtime behavior.

2. **Model tier / routing observability** — Enterprises now use tiered inference fabric (80% to cheap distilled models, 20% to frontier = 75% cost reduction). Add detection of model routing patterns in LLM traces: which model tier handled which request, quality comparison across tiers, cost savings attribution. Surface in cost-report as "Model Tier Analysis" showing per-tier cost, latency, and error rate. This is a new observability dimension nobody else tracks.

3. **Smart data management** — SHIPPED: `trickle cleanup` with configurable retention. `--retain-days 7` prunes by timestamp, `--retain-lines 100` keeps last N lines per file. `--dry-run` shows impact without modifying. Cleans all JSONL files + snapshot/CSV dirs. TODO: auto-cleanup on run, TRICKLE_SAMPLE_RATE for JS client, trace summarization.

4. **Cache hit/miss observability** — Prompt caching delivers 30-50% cost savings but nobody surfaces cache efficiency. Detect cached vs uncached LLM responses via latency bimodality and provider-reported cache tokens (OpenAI/Anthropic expose these). Show cache hit rate, cost saved, and bimodal latency distribution in cost-report and dashboard. Developers burning $5-25K/month need to know if caching works.

5. **GitHub Action for trickle eval** — SHIPPED: Reusable workflow at `.github/workflows/trickle-eval.yml` + example at `example-agent-ci.yml`. Features: run agent with trickle, evaluate with --fail-under, security scan, compliance report as artifact, post eval score as PR comment. Updated devops-ci.md use case with agent CI examples. TODO: publish to GitHub Marketplace as standalone action.
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
