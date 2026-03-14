Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<general directive>
multifile inline type hints for python, currently, it seems that running train.py will have inline type hints. but model.py will not show inline type hints, even though model.py vars are captured in the jsonl

next, focus on performance, no one will use trickle if running it hurts performance by too much
</general directive>

<focus point>

Completed:
- Fixed multifile hints: resolved symlinks (realpath) in Python tracers and extension so paths match VSCode's document.uri.fsPath. This was the likely cause of model.py not showing hints (macOS /tmp → /private/tmp mismatch).
- Fixed loop value stacking: extension now deduplicates by (varName, line) using "last wins"

Next for performance:
1. **Measure current overhead** — benchmark trickle's AST transform + variable tracing vs bare Python execution to quantify the cost
2. **Reduce I/O from variable tracing** — currently each variable write opens/appends/closes the file. Batch writes with a buffer (write every N entries or every Xms)
3. **Skip tracing for hot loops** — detect variables inside tight loops and rate-limit observations (e.g. max 1 write per variable per 50ms)
4. **Lazy type inference** — `infer_type()` walks the full object graph (max_depth=3) for every observation. For repeated types, cache the inference result

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.
