Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:

<focus point>
Focus on the typescript/javascript developer experience, thinking through the React developer customer journey and usecases, for AWS lambdas (first), React Native. Python ML observability (type hints, training loop, gradients, activations, loss probing, attention stats, etc.) is already well-covered.

Testing requirements (MUST follow for every feature):
- Write unit tests in the relevant test file (eg. packages/client-js/src/vite-plugin.test.ts) before publishing
- Test on a real-world codebase (find React repos online DO NOT find locally) to verify real-world value
- Run `npm test` and ensure all tests pass before committing

Next priorities:

1. ~~AWS Lambda support~~ ✅ DONE — `wrapLambda()`, `printObservations()`, `trickle lambda setup/layer/pull`, Lambda Layer zip, auto-detection of `/tmp/.trickle`, real-time streaming via ngrok.

2. ~~React Native observability~~ ✅ DONE — Metro transformer (`trickle-observe/metro-transformer`) instruments RN components at build time. Fixed `export default function` tracking (common RN screen pattern). Tested on real Expo and Ory RN codebases.

3. ~~Arrow function / typed component tracking~~ ✅ DONE — Now tracks `React.FC`, `React.FC<Props>`, `React.memo()`, `memo()`, `React.forwardRef()`, `export default function`, and plain arrows. Fixed type-annotated destructured props.

4. ~~trickle rn CLI~~ ✅ DONE — `trickle rn setup` prints metro.config.js config, Expo/bare RN variants, simulator/real-device/Android emulator setup. `trickle rn ip` auto-detects LAN IP for real-device config. 12 tests passing.

5. ~~Next.js observability~~ ✅ DONE — `withTrickle(nextConfig)` HOC wraps `next.config.js`, adds webpack loader for Client and Server Components. Tested on real vercel/commerce codebase. Known gap: concise arrow bodies `=> (...)` without `{}` are not tracked (affects simple presentational components — workaround: add `{}` block body).

6. Next: **Concise arrow body support** `=> (...)` — common in Next.js/React for simple presentational components like `const Layout = (props) => (<div>...</div>)`. Convert these to block bodies to enable render tracking. Also consider: **`trickle next` CLI command** (similar to `trickle rn setup`) for Next.js setup instructions.

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.


please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, and keep the rest of mission.md the same.
