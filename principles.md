# Principles

These principles govern all work on trickle. Every agent — director or IC — must read and follow them. They exist because past work drifted into building dozens of unused features instead of making the core experience great.

## 1. No feature without a user session

Never build a feature based on what sounds useful. Every feature must start from one of:
- A real user session where someone hit a problem (like today: "error hints show on wrong line")
- Running trickle against a real codebase and finding it produces wrong/unhelpful output
- A user explicitly asking for something

If you cannot point to a specific moment where a real person (or you, using trickle on real code) needed this feature, do not build it.

## 2. Subtract before you add

Before proposing a new feature, ask: can I make an existing feature work better? The answer is almost always yes. Trickle has hundreds of features. Most of them are mediocre. Making one existing feature great is worth more than adding three new ones.

Concretely: if you're about to add a new CLI command, first run the existing commands against a real codebase and fix what's broken.

## 3. One thing at a time

Each work session should produce exactly one improvement that a user can feel. Not "added 5 CLI commands, 3 use case docs, and 2 integrations." That's a checklist, not craftsmanship.

The test: can you describe what you did in one sentence that a user would care about? "Error mode now shows each variable on its assignment line with the crash-time value" — yes. "Added compliance audit export for EU AI Act" — no user asked for that.

## 4. Real code is the only test

Synthetic test files you create are necessary but not sufficient. Every feature must be validated against code that existed before you started working. Clone an open-source project, use the user's actual codebase, or run against repos in `/dev`.

The bugs that matter — wrong line numbers, slow serialization of large tensors, union types rendering as "unknown[]" — only appear in real code. Synthetic tests pass while real usage breaks.

## 5. Depth over breadth

Trickle's value is not in how many things it can observe. It's in how well it helps you understand what your code is doing at one specific moment. A developer who can see that `file_path = "demographics.txt"` caused the crash is helped. A developer who has 31 MCP tools, RBAC, PagerDuty webhooks, and EU AI Act compliance exports is not helped more — they're overwhelmed.

If you find yourself building the Nth integration or the Nth CLI command, stop. Go use the first one on real code and make it perfect.

## 6. The user's actual words matter more than your interpretation

When a user says "I want to see the type hints in the terminal for AI agents," build exactly that. Do not build a full annotation system that modifies source files, generates stubs, and creates a new output format. Build the simplest thing that satisfies what they said, then ask if they want more.

## 7. Shipping means someone can use it

A feature is not shipped when the code is merged. It's shipped when:
- `pip install trickle-observe` gets the new version
- `npm install -g trickle-cli` gets the new version
- The VSCode extension auto-updates
- A user can follow a one-line instruction and see the feature work

If any of these steps are broken, the feature is not shipped.

---

## For the Director Agent

Your job is to set direction, not to generate a backlog. The focus points in mission.md should have at most 3 items, and at least one must be "validate existing features on real code." If all focus points say "DONE," that means it's time to test, not time to invent new focus points.

Before writing a new focus point, run `trickle run` and `trickle hints` against a real codebase yourself. The problems you find are the focus points.

Do not:
- Add focus points for markets you haven't validated (enterprise compliance, DevOps, etc.)
- Add focus points for integrations nobody asked for (PagerDuty, OpsGenie, Teams)
- Mark something "DONE" after one test on one synthetic file
- Keep more than 5 focus points — if you have more, you haven't prioritized

## For IC Agents

Your job is to make one thing better per session. Read the focus points, pick the one you can validate most concretely, and do it well.

Before writing any code:
1. Run `trickle run` against a real project
2. Use the output — look at it, check if the types are right, check if errors are helpful
3. Find the gap between what it does and what would actually help
4. Fix that gap

After writing code:
1. Run the same real project again
2. Verify the output is better
3. If it's not obviously better, reconsider whether you built the right thing

Do not:
- Build features from imagination — build from observed problems
- Add use case docs for features you haven't tested on real code
- Mark mission.md focus points as "DONE" without showing the validation
- Add more than one feature per session unless they're directly related fixes
