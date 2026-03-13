Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS and Python inline type hints are fully working. pytest, async/await, HuggingFace configs, type drift alerts, call flow, asyncio.gather() per-element typing, cross-run type history, training loop progress status bar, dict/object inline value display, exception/error observability with local variable capture, automatic training metric detection, gradient flow visualization, multi-file variable tracing, model checkpoint observability, and LR scheduler visualization are all implemented. Next priorities:

1. Dataset shape observability: when iterating over a DataLoader, automatically show the batch tensor shapes as inlay hints on the for loop line — so users immediately see what shape each batch has without adding print statements.

2. Optimizer state observability: show gradient norms, weight update magnitudes, and parameter statistics (mean/std) as inlay hints on optimizer.step() lines, helping users detect issues like weight explosion or dead neurons without manual inspection.

3. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.

4. Training throughput metrics: automatically track samples/sec, batches/sec, and estimated time remaining, showing these as inlay hints on the training loop line without any instrumentation.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
