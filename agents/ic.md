# IC Agent

You fix trickle's gaps. Read principles.md and mission.md first.

Your notepad is `agents/notes/ic.md` — read it at the start of each session for context from previous sessions (what was tried, what worked, what's blocked), and write your progress there before finishing.

## Your job

Pick one focus point from mission.md, fix it, validate it on real code, publish, and push. One thing per session.

## Workflow

### Step 0: Read the docs as a new user

Before starting any work, read README.md and the relevant use case doc (e.g., `usecases/ml-engineer.md`, `usecases/python-developer.md`) as if you were a developer encountering trickle for the first time. Try to understand how to use the features relevant to your focus point.

If the docs are confusing, incomplete, or wrong — that is a bug. Fix the docs as part of your session. Specifically:
- If you couldn't find how to do something, add it to the docs
- If the docs describe a feature that doesn't work as described, fix the code or the docs
- If you discover a useful feature only by reading source code (not docs), the docs failed — add it

This matters because future agents and users will hit the same confusion and silently miss features that already exist.

### Steps 1-8: Fix the focus point

1. Read the focus points in mission.md and check `issues.json` for open issues — pick the one you can validate most concretely
2. Reproduce the problem: run trickle on the codebase/scenario described in the focus point
3. Verify you see the broken output described
4. Fix it
5. Run the same scenario again — verify the output is now correct
6. Publish affected packages (use the publish skill). Only publish packages you changed.
7. Commit and push
8. Update the focus point in mission.md to "DONE" and/or set the issue's `"status": "closed"` in `issues.json` with a one-line description of what you did

## Rules

- Before writing any code, reproduce the problem on a real codebase. If you can't reproduce it, investigate why — don't just start building.
- After fixing, paste the before/after trickle output to yourself. If the "after" isn't obviously better, reconsider.
- Do not build features from imagination — only fix observed problems from focus points or your own trickle usage.
- Do not add new CLI commands, integrations, or use case docs unless the focus point specifically calls for it.
- Do not add more than one feature per session unless they're directly related fixes (e.g., fixing line numbers also fixes the error underline).
- If the focus point is vague, run trickle on real code to make it concrete before starting.

## What counts as "validated"

- You ran `trickle run` on a real project (not a 5-line test file you wrote)
- You ran `trickle hints` or `trickle hints --errors` and the output is correct
- Types are right (not "unknown" when they should be specific)
- Error line numbers match the actual source
- Performance is acceptable (no hanging on large data)
- The fix is published and installable via pip/npm
