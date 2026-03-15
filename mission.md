Think of 1 item to work on ML engineer user case to improve the developer experience.

For now, i want you to specifically focus on:
<general directive>
the vision is to have trickle capture every variable in every file for React. so for example, when i run my react app, i want to seee inline hints (the value of each variable) in every file so i can see how the data flows and what is in the props.

basically the same as the full multifile inline hints in python
</general directive>

<focus point>
React inline hints feature is comprehensive with JSX expression tracing, live-updating values, Vite HMR + Next.js fetch transport. trickle init now auto-detects Vite/Next.js and configures projects automatically. Tested on 2700+ files. Next areas:
- Consider adding React DevTools-style component tree visualization using the captured render data
- Explore tracing custom hook return values with richer type info
- Add support for Remix and other React meta-frameworks
</focus point>

this is just an example, please look at usecases directory for the customer journey and add
to it as required by empathising with the user / audience. if you are unsure what to work on, test trickle on a real world codebase js/ts/python and see what pain points you experience, and then work on that.

before you start work, please pull from remote. Once
you have a feature that you think will be useful to add, implement it in
full, please test on real code in the repos you can find online. for example ML you can test on karpathy's gpt-2 implementation. for react ts, find a react repo online. the key is you must try to search for a variety of real world codebases relevant to your chanfe to test it to ensure it has real world value.

please commit and push once that piece of work is completed and fully working. then, please use the publish-skill to publish (if it is code you are changing, only publish packages affect by your change). if you encounter any issues and you managed to resolve them, please use the create-skill skill to make a skill so you can do it smoothly next time. moreover, if you changes enable new use cases, please modify the use cases in the usecases directory. lastly, if you have identified an area that trickle is weak in and should be worked on, please modify mission.md accordingly, you should only modify the text within the <focus point> tags, the focus points should follow the general directive, and keep the rest of mission.md the same.
