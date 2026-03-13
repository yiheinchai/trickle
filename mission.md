Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS and Python inline type hints are fully working. pytest, async/await, HuggingFace `PretrainedConfig` all supported. HuggingFace configs now show priority fields (vocab_size, hidden_size, n_layer, etc.) inline for any PretrainedConfig subclass (GPT-2, BERT, T5, LLaMA, etc.). Next priorities:

1. Type drift alerts: when a variable's type changes between two runs (e.g., a tensor shape changes from `[32, 768]` to `[32, 512]`), surface a warning inline in VSCode — useful for catching shape regressions between training iterations. Implement by comparing typeHash across runs in the VSCode extension and marking changed hints with a visual indicator.

2. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.

3. Variable flow across function calls: when a function is called and returns a value, the inline hint for the call site shows the return type but not the intermediate transformations. Consider showing a hover card with the input → output shape transformation (e.g. `Linear(784→10): Tensor[32,784] → Tensor[32,10]`).

4. Improve `asyncio.gather()` result typing: currently shown as `array[][]` (list of lists). When gather args are heterogeneous, show more specific per-element types.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
