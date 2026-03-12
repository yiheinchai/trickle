---
name: create-skill
description: Create a new Claude Code skill. Use when the user wants to create, scaffold, build, or set up a new skill, custom slash command, or reusable instruction for Claude Code. Also use when someone says "make a skill", "I keep repeating myself to Claude", or "teach Claude how to do X".
---

# Create a New Claude Code Skill

You are creating a new Claude Code skill. A skill is a markdown file that teaches Claude how to do something once, and Claude applies that knowledge automatically whenever it's relevant — no slash command needed.

## 1. Gather Requirements

Ask the user:

- **What does the skill do?** What task or knowledge should Claude learn? (e.g. "review PRs my way", "follow our commit message format", "use our brand colors")
- **Skill name**: lowercase, letters/numbers/hyphens only, max 64 chars
- **Scope**: personal (global — follows you across all projects) or project (lives in the repo, shared with the team)?

Then determine the right configuration by asking:

- **Auto or manual?** Should Claude activate this automatically when it recognizes the situation (default), or only when you type `/skill-name`? Use auto (`disable-model-invocation: false`) for everything. In fact, do not specify that configuration in the first place.
- **Arguments?** Does the skill need input when invoked? (e.g. a PR number, filename, component name)
- **Isolated context?** Should it run in a subagent (`context: fork`) to avoid filling up the main conversation?
- **Tool restrictions?** Should Claude be limited to certain tools? (e.g. read-only with `allowed-tools: Read, Grep, Glob`)

## 2. Determine the Skill Location

- **Personal/global** (your preferences, follows you everywhere): `~/.claude/skills/<skill-name>/SKILL.md`
- **Project** (team standards, shared via git): `.claude/skills/<skill-name>/SKILL.md`

Create the directory if it doesn't exist.

## 3. Write the SKILL.md File

Every SKILL.md has two parts:

### YAML Frontmatter (between `---` markers)

Available fields (all optional):

| Field                      | Type    | Description                                                                                                                                                                                                                      |
| :------------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | string  | Display name. If omitted, uses directory name.                                                                                                                                                                                   |
| `description`              | string  | **Critical field.** What the skill does + WHEN to use it. Claude matches user requests against this to decide whether to auto-activate. Write it like a trigger: include the situations and keywords a user would naturally say. |
| `argument-hint`            | string  | Hint for autocomplete, e.g. `[issue-number]` or `[filename]`                                                                                                                                                                     |
| `disable-model-invocation` | boolean | `true` = manual-only, Claude won't auto-trigger. Use for destructive/side-effect workflows. Default: `false`                                                                                                                     |
| `user-invocable`           | boolean | `false` = hidden from `/` menu, background knowledge only. Default: `true`                                                                                                                                                       |
| `allowed-tools`            | string  | Comma-separated tool list to restrict what Claude can use, e.g. `Read, Grep, Bash`                                                                                                                                               |
| `model`                    | string  | Force a specific model, e.g. `opus` or `sonnet`                                                                                                                                                                                  |
| `context`                  | string  | Set to `fork` to run in an isolated subagent                                                                                                                                                                                     |
| `agent`                    | string  | Subagent type when `context: fork`. Options: `Explore`, `Plan`, `general-purpose`                                                                                                                                                |

### Markdown Body

The instructions Claude follows when the skill is activated. Can include:

- Step-by-step instructions for the task
- Templates and examples
- References to supporting files in the skill directory
- Variable substitutions: `$ARGUMENTS`, `$0`, `$1`, `$N`, `${CLAUDE_SESSION_ID}`
- Dynamic context via `!command` syntax (runs a shell command before Claude sees the prompt, output replaces the placeholder)

### Writing a Great Description

The description is how Claude decides whether to use your skill. Tips:

- Describe WHEN to use it, not just what it does
- Include natural phrases a user would say: "review this PR", "write a commit message", "explain this code"
- Be specific enough that Claude won't false-positive on unrelated requests

**Good**: `"Review pull requests following our team's checklist. Use when the user asks to review a PR, check code changes, or give feedback on a pull request."`

**Bad**: `"Code review skill"`

## 4. Create Supporting Files (if needed)

Skills can include additional files in their directory:

```
my-skill/
├── SKILL.md           # Required - main instructions
├── template.md        # Optional - templates for Claude to use
├── examples/          # Optional - example outputs
└── scripts/           # Optional - utility scripts
```

Claude loads supporting files only when the skill is activated, keeping context efficient.

## 5. Verify the Skill

After creating the skill:

- Read the file back to confirm it was written correctly
- Explain to the user how it will work:
  - If auto-invocation is enabled (default): Claude will automatically activate this skill whenever your request matches the description — no `/` command needed
  - It can also always be manually invoked with `/<skill-name>`
  - Only the name and description are loaded into context at startup (~100 tokens), the full instructions load on-demand when activated

## Guidelines

- **Description is the trigger**: Spend time writing a clear description — it determines when Claude activates the skill
- **Skills vs CLAUDE.md**: If you want something in EVERY conversation (e.g. "always use TypeScript strict mode"), put it in CLAUDE.md. Skills are for task-specific knowledge that loads on-demand.
- **One skill = one job**: Keep skills focused. Multiple small skills beat one mega-skill.
- **Use `disable-model-invocation: true`** only for destructive actions (deploy, commit, delete)
- **Use `context: fork`** for research-heavy tasks to keep the main context clean
- **Use `allowed-tools`** to restrict scope when the skill shouldn't modify files
