Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<focus point>
Focus on the typescript/javascript developer experience, thinking through the React developer customer journey and usecases, for both React frontend, Next.js, Vite, and React Native. Python ML observability (type hints, training loop, gradients, activations, loss probing, attention stats, etc.) is already well-covered.

Already completed:
- React component render counts: 🔄 ×N renders inlay hint on component definition lines (Vite plugin, zero instrumentation)

Next priorities:

1. React component prop/state observability: show the actual prop types and state shapes as inline hints on component definition lines. The render count is shown — now show WHAT changed (which props/state triggered the re-render). Zero instrumentation required.

2. Next.js API route observability: capture request/response shapes, latency, and error rates for API routes, showing them as inlay hints on route handler lines. Hook into Next.js middleware or page router.

3. React hook observability: track useEffect dependency arrays, useCallback/useMemo memoization hits/misses, and custom hook return shapes — show as inlay hints on the hook call lines.

4. AWS Lambda support: JS/TS code running in Lambda functions should be observable with minimal setup — possibly via a Lambda layer that injects the ESM hooks or CJS register hook automatically.


</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.


please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
