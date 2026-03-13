Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<general directive>
First do some comms, work clarify the difference between trickle generating pyi files vs the jsonl and generate inline hints via extension, and resolve the inconsistencies between these two across different usecases. the same for javascript/typescript (.d.ts vs jsonl + extension). probably the best approach is give user option for both?

First pick a usecase, get a real world repo from online for that use case. Test trickle on that repo. 
Find the pain points. Implement features to fix the pain point.
</general directive>

<focus point>

Next priorities:

1. **Generator yield types not captured** — `Iterator[Any]` instead of `Iterator[int]`. Need to trace generator yields to infer the element type.

2. **Infinite recursion with complex class hierarchies** — Classes with many self-referential methods (e.g. boltons' OrderedMultiDict) can cause hangs or RecursionError from cascading TrackedObject wrapping and inspect.signature calls.

3. **Decorated functions lose parameter names** — `@log_calls def add(a: int, b: int)` shows as `def add(arg0: int, arg1: int)` because the decorator's `(*args, **kwargs)` signature is inspected instead of the original function's.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.


please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.
