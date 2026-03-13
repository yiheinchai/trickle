Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS and Python inline type hints are fully working. Pydantic v1/v2, dataclasses, and NamedTuples all show actual field values inline: `AppConfig(host="localhost", port=9000, debug=False, workers=8)`. Next priorities:

1. React component support: inline type hints for state, props, and hooks (useState, useEffect return values). JSX/TSX files aren't yet transformed by the ESM hooks. Approach: detect JSX syntax and strip it before regex-based variable finding, or integrate with a TSX/Babel transform.

2. Vitest/Jest integration: test files should get variable tracing so developers see types while writing tests. The NODE_OPTIONS path already adds ESM hooks — verify it works with a real Vitest project.

3. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer.

4. Python: for nested structured types (e.g., `ExperimentConfig` with a `ModelConfig` sub-field), nested model fields currently show as `null` in the inline hint. Improve to show one level of nested compact values, e.g., `ExperimentConfig(model=ModelConfig(...), training=TrainingConfig(...), name="exp1", seed=42)`.

5. Nested type compaction: when a compact type like `{id, name, +N}[]` is shown, hovering should show the full expanded object shape. Currently the hover tooltip shows the full TypeNode string but may be hard to read for deeply nested types — consider a structured hover card with collapsible sections.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
