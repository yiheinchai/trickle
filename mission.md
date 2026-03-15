Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Do market research, see what features are needed and pain points, and build those features to capture more TAM.
</higher directive>

<focus point>
CLI 0.1.152. Shipped trickle fix + get_fix_suggestions MCP tool (#27) — generates actual
code patches for N+1 queries (batch SQL), null refs (guard checks), slow functions (caching).

27 MCP tools. All major integrations done (OTLP, Prometheus, Slack, Discord, GitHub PR).

Next TAM opportunities to research:
1. Session replay / request tracing (follow a single HTTP request through the full stack)
2. Cost attribution (show which functions/queries cost the most in cloud spend)
3. AI-powered anomaly detection (baseline normal behavior, alert on deviations)
4. Team dashboards with real-time streaming (replace Datadog dashboards)
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

DO NOT ever believe that trickle is done, it is not. If focus point says all done, delete all text within focus point and come up with ideas that follows the directive.
