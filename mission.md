Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS and Python inline type hints are fully working. pytest plugin auto-activates. Model instances with a `config` attribute now show constructor-call hints inline: `model: GPT(n_layer=12, n_head=12, n_embd=768, +2)` — config fields also appear in the hover type. Next priorities:

1. Python async support: `async def` functions and `asyncio.gather()` return values are not yet traced. Improve to trace coroutine results after `await`. Important for ML engineers using async data pipelines or FastAPI inference servers.

2. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.

3. Type drift alerts: when a variable's type changes between two runs (e.g., a tensor shape changes from `[32, 768]` to `[32, 512]`), surface a warning inline in VSCode — useful for catching shape regressions between training iterations.

4. HuggingFace integration: when using `transformers` models (e.g., `AutoModelForCausalLM.from_pretrained()`), surface the model config (vocab_size, hidden_size, num_layers, etc.) inline, including the model card name. Currently, HuggingFace models have `model.config` as a `PretrainedConfig` which may not be a dataclass — ensure the config extraction handles it.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
