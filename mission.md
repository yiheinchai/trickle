Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Go through every part of the trickle platform and make it agent first, meaning that it is designed primary to be used by AI agents, the goal is 10-100x improvement in agent capability with trickle compared to without trickle.

The vision is to have AI agents eg claude code run autonomously as a on-call engineer responding the incidences and debugging and fixing autonomously in prod. Trickle is the important part to give the AI agent all the information required to fix the issue.

As a key point for the agent first approach, i want you to use trickle when developing trickle (since you are an agent), and you will be able to identify any pain points in the process.
</higher directive>

<focus point>
26 MCP tools. Automatic root cause analysis now in summary — derives null_reference,
n_plus_one, slow_function, memory_growth, and logged_errors with evidence + suggested fixes.
Errors enriched with variable context. Guided agent workflows. Flamegraph. Python decorator fix.

Next priorities:
1. Test on a real open-source Django project from GitHub
2. Distributed tracing improvements (cross-service flamegraphs)
3. Add CLAUDE.md auto-generation to trickle init with MCP server config instructions
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

if you think everything has already be accomplished, please compact conversation, and work on improving trickle by your discretions
