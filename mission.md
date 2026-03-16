Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Trickle's strategic moat is zero-code, local-first runtime observability that works for both humans AND AI agents — at zero cost. The market is in a cost revolt against Datadog/New Relic ($50K-$1M/year) and drowning in "too much telemetry, not enough insight." Trickle's winning position: free because it's on your machine, intelligent because it surfaces signal not noise, and AI-native because it feeds runtime context to coding agents via MCP. Three strategic pillars: (1) Be the default "eyes" for AI coding agents — 95% of developers use AI tools weekly and Claude Code is the #1 most-loved; if trickle + MCP makes agents write better code, adoption follows the agent ecosystem. (2) Shift-left observability — give developers production-grade runtime understanding during localhost development, filling the massive gap between printf debugging and enterprise APM. (3) Intelligent signal extraction — don't just capture everything, automatically surface anomalies, performance regressions, and breaking changes so developers act on insights not raw data. Every feature must pass: "does this help a developer (or their AI agent) understand their running code faster, with less noise?"
</higher directive>

<focus point>
CLI 0.1.177, client-js 0.2.119, client-python 0.2.27. Recent ships: LLM auto-instrumentation, CSV export, pagination, kwargs fix, route parameterization, docstring preservation, consolidated import hooks.

Just fixed:
- AST transform now preserves docstrings as first statement (fixes LangChain @tool compatibility)
- Consolidated Python import hooks: llm_observer registers patches with db_observer's hook instead of creating separate one (cleaner stack traces)

Known remaining issues: (a) Python .pyi stubs have invalid types for tensor params, (b) error stack traces point to temp file not source

Priority areas:
1. **AI agent runtime tracing** — first-class LangChain/CrewAI agent workflow tracing
2. **OpenTelemetry export** — OTel-compatible span export with GenAI semantic conventions
3. **Live streaming mode** — WebSocket real-time dashboard for long-running processes
4. **More LLM providers** — Cohere, Mistral, Google Gemini, Python streaming tokens
5. **Python .pyi stub quality** — fix tensor param types, missing imports, meaningless Union[Any, ...]
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
