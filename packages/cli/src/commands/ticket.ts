/**
 * trickle ticket — create tickets in Jira/Linear/GitHub Issues from alerts.
 *
 * When trickle detects critical issues, auto-create tickets with full context:
 * root cause, affected functions, fix suggestions, and relevant data.
 *
 * Usage:
 *   trickle ticket --github              # create GitHub issue
 *   trickle ticket --linear              # create Linear issue
 *   trickle ticket --jira                # create Jira issue
 *   trickle ticket --json                # output ticket body as JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

interface TicketData {
  title: string;
  body: string;
  labels: string[];
  priority: 'urgent' | 'high' | 'medium' | 'low';
}

function buildTicketFromAlerts(trickleDir: string): TicketData[] {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};

  let summary: any;
  try {
    const { generateRunSummary } = require('./summary');
    summary = generateRunSummary({ dir: trickleDir });
  } catch {} finally {
    console.log = origLog;
    console.error = origErr;
  }
  if (!summary) return [];

  const tickets: TicketData[] = [];

  for (const rc of summary.rootCauses) {
    const title = `[trickle] ${rc.category}: ${rc.description.substring(0, 80)}`;
    let body = `## Issue Detected by trickle\n\n`;
    body += `**Severity**: ${rc.severity}\n`;
    body += `**Category**: ${rc.category}\n\n`;
    body += `### Description\n\n${rc.description}\n\n`;
    body += `### Suggested Fix\n\n${rc.suggestedFix}\n\n`;

    // Add context
    if (summary.counts.queries > 0) {
      body += `### Context\n\n`;
      body += `- Functions observed: ${summary.counts.functions}\n`;
      body += `- Database queries: ${summary.counts.queries}\n`;
      body += `- Errors: ${summary.counts.errors}\n`;
    }

    if (summary.queries.nPlusOnePatterns.length > 0 && rc.category === 'n_plus_one') {
      body += `\n### N+1 Query Details\n\n`;
      for (const p of summary.queries.nPlusOnePatterns.slice(0, 3)) {
        body += `- \`${p.query}\` repeated **${p.count}** times\n`;
      }
    }

    body += `\n---\n*Auto-created by [trickle](https://github.com/yiheinchai/trickle)*`;

    tickets.push({
      title,
      body,
      labels: ['trickle', rc.severity, rc.category],
      priority: rc.severity === 'critical' ? 'urgent' : 'medium',
    });
  }

  return tickets;
}

export interface TicketOptions {
  github?: boolean;
  linear?: boolean;
  jira?: boolean;
  json?: boolean;
}

export async function createTickets(opts: TicketOptions): Promise<void> {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const tickets = buildTicketFromAlerts(trickleDir);

  if (tickets.length === 0) {
    console.log(chalk.green('\n  No issues to create tickets for. ✓\n'));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(tickets, null, 2));
    return;
  }

  // GitHub Issues
  if (opts.github) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
      console.log(chalk.yellow('\n  Set GITHUB_TOKEN and GITHUB_REPOSITORY env vars.\n'));
      return;
    }

    for (const ticket of tickets) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: ticket.title, body: ticket.body, labels: ticket.labels }),
        });
        if (res.ok) {
          const data = await res.json() as any;
          console.log(chalk.green(`  ✓ Created issue #${data.number}: ${ticket.title}`));
        } else {
          console.log(chalk.red(`  ✗ Failed to create issue: ${res.status}`));
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ ${err.message}`));
      }
    }
    return;
  }

  // Linear
  if (opts.linear) {
    const apiKey = process.env.LINEAR_API_KEY;
    const teamId = process.env.LINEAR_TEAM_ID;
    if (!apiKey || !teamId) {
      console.log(chalk.yellow('\n  Set LINEAR_API_KEY and LINEAR_TEAM_ID env vars.\n'));
      return;
    }

    for (const ticket of tickets) {
      try {
        const priorityMap: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
        const res = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `mutation { issueCreate(input: { title: "${ticket.title.replace(/"/g, '\\"')}", description: "${ticket.body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}", teamId: "${teamId}", priority: ${priorityMap[ticket.priority] || 3} }) { success issue { identifier url } } }`,
          }),
        });
        const data = await res.json() as any;
        if (data.data?.issueCreate?.success) {
          console.log(chalk.green(`  ✓ Created ${data.data.issueCreate.issue.identifier}: ${ticket.title}`));
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ ${err.message}`));
      }
    }
    return;
  }

  // Jira
  if (opts.jira) {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    const project = process.env.JIRA_PROJECT_KEY;
    if (!baseUrl || !email || !token || !project) {
      console.log(chalk.yellow('\n  Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY env vars.\n'));
      return;
    }

    for (const ticket of tickets) {
      try {
        const auth = Buffer.from(`${email}:${token}`).toString('base64');
        const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              project: { key: project },
              summary: ticket.title,
              description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: ticket.body }] }] },
              issuetype: { name: 'Bug' },
            },
          }),
        });
        const data = await res.json() as any;
        if (data.key) {
          console.log(chalk.green(`  ✓ Created ${data.key}: ${ticket.title}`));
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ ${err.message}`));
      }
    }
    return;
  }

  // Default: print tickets
  console.log('');
  console.log(chalk.bold('  trickle ticket'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  ${tickets.length} ticket(s) to create:\n`);
  for (const t of tickets) {
    const icon = t.priority === 'urgent' ? chalk.red('!') : chalk.yellow('~');
    console.log(`  ${icon} ${t.title}`);
    console.log(chalk.gray(`    Labels: ${t.labels.join(', ')}`));
  }
  console.log('');
  console.log(chalk.gray('  Use --github, --linear, or --jira to create tickets'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}
