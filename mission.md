Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<general directive>
Improve on the python developer experience, any arbituary python code (even without framework) can be run and instantly generate inline type hints
</general directive>

<focus point>

Next priorities for Python DX:

1. **Reduce observation JSONL bloat** — Functions called 100+ times (e.g. `load_recording` called per file) generate 100+ near-identical observation entries. Add deduplication or sampling to cap observations per function, reducing disk I/O and codegen time.

2. **Improve type hint quality** — Better `List[dataclass]` types instead of `List[Dict[str, Any]]` in .pyi stubs. Use proper import types (e.g. `numpy.ndarray` instead of `Any`) for ndarray/Tensor/DataFrame return types in .pyi stubs.

3. **Test async code and more edge cases** — Test on async frameworks (asyncio/aiohttp), Django views, SQLAlchemy models. Verify generators-as-iterators (consuming yield values), properties, decorated class methods, and nested unpacking.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.


please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.
