Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
Focus on the typescript/javascript developer experience, thinking through the React developer customer journey and usecases, for both React frontend, Next.js, Vite, and React Native. Python ML observability (type hints, training loop, gradients, activations, loss probing, attention stats, etc.) is already well-covered. Next priorities:

1. React component observability: show prop types, state shapes, and re-render counts as inline hints on component definitions — zero instrumentation required.

2. Next.js API route observability: capture request/response shapes, latency, and error rates for API routes, showing them as inlay hints on route handler lines.

3. React Native performance: track component render times, JS thread FPS, and bridge call counts as inlay hints during development.

4. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the ML repos you can find online. for example test on karpathy's gpt-2 implementation.
please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
