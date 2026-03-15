Think of 1 item to work to improve the developer experience with trickle.

For now, i want you to specifically focus on:
<higher directive>
Go through every part of the trickle platform and make it agent first, meaning that it is designed primary to be used by AI agents, the goal is 10-100x improvement in agent capability with trickle compared to without trickle.

The vision is to have AI agents eg claude code run autonomously as a on-call engineer responding the incidences and debugging and fixing autonomously in prod. Trickle is the important part to give the AI agent all the information required to fix the issue.

As a key point for the agent first approach, i want you to use trickle when developing trickle (since you are an agent), and you will be able to identify any pain points in the process.
</higher directive>

<focus point>
24 MCP tools. Express crash fix shipped. jest-setup.js created.

Known limitation: Jest's module sandbox (jest-runtime) bypasses Node's Module._load hooks
completely — no way to auto-patch DB drivers inside test files. Test pass/fail is captured,
but DB queries/function observation is not. Workaround: run the app with `trickle run` for
observability, then run tests separately.

Next priorities:
1. Performance profiling: flamegraph generation from call traces
2. Test on more real-world open-source projects (try a Django/Flask project with pytest)
3. Improve Python pytest integration (pytest runs in same process, so patching works)
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.

if you think everything has already be accomplished, please compact conversation, and work on improving trickle by your discretions
