Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<general directive>
test trickle on more real world codebases, key is to have diversity of codebases, find painpoints and fix them, maximise value to user

my vision to have every single variable to be able to have inline type hints for any repo / codebase. the current usecases for js/ts does not follow this vision. you must realise this vision for python/ts/js
</general directive>

<focus point>

Tested and fixed:
- Async JS functions now correctly return Promise<T> in .d.ts stubs
- detectSingleFile works for "node app.js", "npx ts-node app.ts" etc — enables .d.ts generation
- CJS multifile variable tracing works (both entry file and imported modules get inline hints)

Current status of "every variable gets inline hints":
- **Python**: Full coverage — entry file + imported modules, all variable assignments traced
- **JS CJS**: Good coverage — entry file + imported modules, const/let/var traced in function bodies
- **JS ESM**: Broken — hooks load too late, no observations for top-level calls
- **JS class methods**: Not observed — CJS observer only wraps top-level function declarations

Priority gaps for the vision:
1. **JS ESM variable tracing** — ESM loader hooks install after the entry module executes. Need AST transform approach (like Python) or use `--import` flag
2. **JS class method observation** — class constructors and methods are invisible to the CJS observer
3. **TypeScript with ts-node/tsx** — works via NODE_OPTIONS but needs testing with real TS projects

</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.
