# Agentic DevOps: Observability for AI Agents in Your SDLC

AI agents are now part of the software development lifecycle — GitLab ships 7 AI agents, Azure has "Agentic DevOps Solutions" as a product category, and FinOps agents optimize cloud spend autonomously. These agents make decisions that affect production systems, but nobody observes what they actually do at runtime.

Trickle's general-purpose runtime tracing captures function calls, database queries, HTTP requests, LLM calls, and tool invocations — making it the natural observability layer for DevOps agents.

## Install

```bash
npm install -g trickle-cli
```

---

## Use Case 1: Observe a CI/CD Agent

Run your CI agent through trickle to see every decision it makes:

```bash
trickle run python deploy_agent.py
trickle playback     # step-by-step replay of what the agent did
trickle summarize    # concise narrative: "3 LLM calls, 5 tool calls, deployed to staging"
```

## Use Case 2: Evaluate Agent Reliability Before Production

Before letting an agent run autonomously in CI:

```bash
# Run the same task 10 times — measure consistency
trickle benchmark "python deploy_agent.py --dry-run" --runs 10

# Grade: A (95%) or F (40%)?
trickle eval --fail-under 80
```

If your agent makes the right decision 85% of the time, that's only 20% success on a 10-step workflow. `trickle benchmark` measures whether it's production-ready.

## Use Case 3: Security Scan Agent Actions

DevOps agents often have elevated privileges. Scan for dangerous behavior:

```bash
trickle run python infra_agent.py
trickle security
```

Detects:
- Privilege escalation (`rm -rf`, `sudo`, `chmod 777`)
- Secrets passed to LLMs (API keys in prompts)
- Prompt injection in agent inputs
- Data exfiltration (secrets in LLM outputs)

## Use Case 4: Cost Control for FinOps Agents

FinOps agents that analyze cloud spend make LLM calls that cost money:

```bash
TRICKLE_COST_BUDGET=1.00 trickle run python finops_agent.py
trickle cost-report
```

Shows:
- Cost by provider/model with tier analysis (Frontier vs Mini)
- Budget enforcement: warns at 50%, 80%, 100%
- Cache hit rate: are your prompts being cached effectively?

## Use Case 5: Compliance Audit Trail

For regulated environments where agent decisions need audit trails:

```bash
trickle run python approval_agent.py
trickle audit --compliance -o audit-report.json
```

Generates structured report with:
- Decision lineage (every LLM call → tool call → output)
- Risk classification (HIGH/MEDIUM/LOW)
- Human oversight assessment
- Security findings

## Use Case 6: CI Gate for Agent Quality

Add trickle to your CI pipeline:

```yaml
# .github/workflows/agent-ci.yml
- uses: yiheinchai/trickle@main
  with:
    command: "python deploy_agent.py --dry-run"
    fail-under: 80
    security-scan: true
    compliance-report: true
```

Fails the build if the agent's reliability score drops below threshold.

---

## Why Trickle for DevOps Agents?

| Need | Trickle Command |
|------|----------------|
| What did the agent do? | `trickle playback` |
| Is it consistent? | `trickle benchmark --runs 10` |
| Is it safe? | `trickle security` |
| What does it cost? | `trickle cost-report` |
| Is it compliant? | `trickle audit --compliance` |
| Why did it fail? | `trickle why` |

**Zero code changes. Free. Local-first. Works offline.**
