Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Make a big push of increasing the feature set of trickle to expand the target audience and the TAM. Make sure to update the readme and usecases accordingly.

Particularly, build a complete observability platform, it will replace datadog, with the ability for agents to automatically fix issues in production. this will be critical for the business as we will sell cloud computing and agent credits, esp now that we have the runtime cache infrastructure in place.

the goal is to make it production ready, where real companies can start deploying trickle to production
</higher directive>

<focus point>
Cloud backend v3 shipped: full auto-push + fly.io deployment config.

Features:
- Auto-push: all data types (variables, calltrace, queries, errors, alerts)
  automatically pushed to cloud after every `trickle run` — zero manual steps
- Real-time streaming: observations stream during app execution every 5s
- Dockerfile + fly.toml: ready for `fly deploy` to production
- Shared dashboards: dark-themed HTML with alerts, errors, performance, queries

Flow: trickle cloud login → trickle run <app> → all data auto-pushed → dashboard ready

Next priorities:
1. Deploy cloud.trickle.dev to fly.io (run `fly deploy`)
2. Team management (invite members, RBAC, org-level projects)
3. Production hardening (rate limiting, data retention, PostgreSQL)
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

if you think everything has already be accomplished, please compact conversation, and work on improving trickle by your discretions
