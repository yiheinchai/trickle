Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
JS/TS inline type hints are now working for plain JS (trickle run node app.js) and TypeScript via ts-node. The next priorities for JS/TS developer experience are:

1. React component support: inline type hints for state, props, and hooks (useState, useEffect return values). Currently works for plain logic files but JSX isn't transformed.
2. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup.
3. ESM module support: tsx and modern ESM JavaScript don't go through the Module._compile hook, so variables aren't traced in those files. Add variable tracing to the ESM hooks (observe-esm-hooks.mjs).

2. ESM module support: tsx and modern ESM JavaScript don't go through the Module._compile hook, so variables aren't traced in those files. Add variable tracing to the ESM hooks (observe-esm-hooks.mjs).

3. Better object type display: for large objects with many keys, the inline hint is verbose. Consider showing {key1, key2, ...N more} for compact inline display, with full type in hover.

4. Test with a real-world JS/TS project (e.g. a Next.js or Express app) to verify the end-to-end experience works smoothly for actual developer workflows.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
