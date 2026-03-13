Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS and Python inline type hints are fully working. pytest, async/await, HuggingFace configs, type drift alerts, call flow, asyncio.gather() per-element typing, cross-run type history, training loop progress status bar, dict/object inline value display, exception/error observability with local variable capture, automatic training metric detection, gradient flow visualization, multi-file variable tracing, model checkpoint observability, LR scheduler visualization, memory profiling inlay hints, dataset shape observability, optimizer state observability, training throughput metrics, activation statistics observability, and loss landscape probing (plateau/divergence/oscillation pattern detection) are all implemented. Next priorities:

1. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.

2. Distributed training observability: when using torch.distributed or HuggingFace Accelerate, show per-rank tensor shapes and gradient sync status as inlay hints, helping debug synchronization issues across GPUs.

3. Attention pattern visualization: for transformer models, capture attention weight statistics (entropy, max-attended position, dead heads) and show them as inlay hints on attention computation lines.

4. Batch norm statistics: track running mean/var drift in BatchNorm layers across training, flagging when they deviate significantly from initialization — a common source of silent bugs when freezing/unfreezing layers.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
