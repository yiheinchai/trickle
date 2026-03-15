/**
 * trickle ci — CI/CD integration for automated observability checks.
 *
 * Runs in CI pipelines to:
 * 1. Execute the app/tests with trickle
 * 2. Run monitor to detect issues
 * 3. Compare with baseline (if exists)
 * 4. Output results in CI-friendly format (GitHub Actions annotations, etc.)
 * 5. Exit with non-zero code if critical issues found
 *
 * Usage in GitHub Actions:
 *   - run: npx trickle ci "python -m pytest tests/"
 *
 * Environment detection:
 *   - GITHUB_ACTIONS → GitHub annotations format
 *   - GITLAB_CI → GitLab format
 *   - CI → generic format
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { runMonitor } from './monitor';

interface CiOptions {
  command?: string;
  failOnCritical?: boolean;
  failOnWarning?: boolean;
  format?: 'github' | 'gitlab' | 'json' | 'text';
}

function detectCiFormat(): 'github' | 'gitlab' | 'json' | 'text' {
  if (process.env.GITHUB_ACTIONS) return 'github';
  if (process.env.GITLAB_CI) return 'gitlab';
  if (process.env.CI) return 'json';
  return 'text';
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export async function runCi(opts: CiOptions): Promise<void> {
  const format = opts.format || detectCiFormat();
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  // Step 1: Run the command with trickle (if provided)
  if (opts.command) {
    const { execSync } = require('child_process');
    console.log(chalk.gray(`  Running: ${opts.command}`));
    try {
      execSync(`npx trickle run ${opts.command}`, {
        stdio: 'inherit',
        env: { ...process.env, TRICKLE_LOCAL: '1' },
      });
    } catch (err: any) {
      // App may exit with non-zero — that's ok, we still analyze
      if (format === 'github') {
        console.log(`::warning::Application exited with error`);
      }
    }
  }

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ data found.'));
    return;
  }

  // Step 2: Run monitor
  const alerts = runMonitor({ dir: trickleDir });

  // Step 3: Compare with baseline if exists
  const baselinePath = path.join(trickleDir, 'baseline.json');
  let baselineComparison: any = null;
  if (fs.existsSync(baselinePath)) {
    try {
      const { compareWithBaseline } = require('./verify');
      compareWithBaseline({ dir: trickleDir });
    } catch {}
  }

  // Step 4: Output in CI format
  const critical = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));

  if (format === 'github') {
    // GitHub Actions annotations
    for (const a of critical) {
      const file = a.details?.file || '';
      const line = a.details?.line || '';
      const loc = file && line ? ` file=${file},line=${line}` : '';
      console.log(`::error${loc}::${a.message}`);
    }
    for (const a of warnings) {
      console.log(`::warning::${a.message}`);
    }
    // Summary as step output
    console.log(`::notice::trickle: ${observations.length} functions, ${queries.length} queries, ${critical.length} critical, ${warnings.length} warnings`);
  } else if (format === 'gitlab') {
    // GitLab CI annotations (uses codequality report format in terminal)
    for (const a of critical) {
      console.log(`ERROR: [trickle] ${a.message}`);
    }
    for (const a of warnings) {
      console.log(`WARNING: [trickle] ${a.message}`);
    }
    console.log(`[trickle] ${observations.length} functions, ${queries.length} queries, ${critical.length} critical, ${warnings.length} warnings`);
  } else if (format === 'json') {
    const report = {
      status: critical.length > 0 ? 'fail' : 'pass',
      alerts: { critical: critical.length, warnings: warnings.length },
      functions: observations.length,
      queries: queries.length,
      errors: errors.length,
      issues: alerts.map(a => ({
        severity: a.severity,
        category: a.category,
        message: a.message,
        suggestion: a.suggestion,
      })),
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Text format (already printed by runMonitor)
    console.log('');
    console.log(chalk.bold('  CI Summary'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  Functions: ${observations.length} | Queries: ${queries.length} | Errors: ${errors.length}`);
    console.log(`  Alerts: ${chalk.red(String(critical.length) + ' critical')} | ${chalk.yellow(String(warnings.length) + ' warnings')}`);
    console.log(chalk.gray('  ' + '─'.repeat(50)));
  }

  // Step 5: Post PR/MR comment
  if (format === 'github' && process.env.GITHUB_TOKEN && process.env.GITHUB_EVENT_PATH) {
    await postPrComment(alerts, observations, queries, errors, trickleDir);
  }
  if (format === 'gitlab' && process.env.GITLAB_TOKEN && process.env.CI_MERGE_REQUEST_IID) {
    await postGitlabMrComment(alerts, observations, queries, errors, trickleDir);
  }

  // Step 6: Exit code
  if (opts.failOnCritical !== false && critical.length > 0) {
    process.exitCode = 1;
  }
  if (opts.failOnWarning && warnings.length > 0) {
    process.exitCode = 1;
  }
}

async function postPrComment(
  alerts: any[], observations: any[], queries: any[], errors: any[], trickleDir: string,
): Promise<void> {
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf-8'));
    const prNumber = event.pull_request?.number || event.number;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!prNumber || !repo) return;

    // Build summary
    const { generateRunSummary } = require('./summary');
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    let summary: any;
    try { summary = generateRunSummary({ dir: trickleDir }); } catch {} finally {
      console.log = origLog;
      console.error = origErr;
    }
    if (!summary) return;

    const critical = alerts.filter(a => a.severity === 'critical');
    const warnings = alerts.filter(a => a.severity === 'warning');
    const statusIcon = critical.length > 0 ? '🔴' : warnings.length > 0 ? '🟡' : '🟢';
    const statusText = critical.length > 0 ? 'Issues Found' : warnings.length > 0 ? 'Warnings' : 'Healthy';

    let body = `## ${statusIcon} trickle: ${statusText}\n\n`;
    body += `| Metric | Count |\n|---|---|\n`;
    body += `| Functions | ${summary.counts.functions} |\n`;
    body += `| Queries | ${summary.counts.queries} |\n`;
    body += `| Errors | ${summary.counts.errors} |\n`;
    body += `| Logs | ${summary.counts.logs} |\n`;
    body += `| Alerts | ${alerts.length} (${critical.length} critical, ${warnings.length} warnings) |\n\n`;

    if (summary.rootCauses.length > 0) {
      body += `### Root Causes\n\n`;
      for (const rc of summary.rootCauses.slice(0, 5)) {
        const icon = rc.severity === 'critical' ? '🔴' : '🟡';
        body += `${icon} **${rc.category}**: ${rc.description}\n`;
        body += `> ${rc.suggestedFix}\n\n`;
      }
    }

    if (summary.queries.nPlusOnePatterns.length > 0) {
      body += `### N+1 Query Patterns\n\n`;
      for (const p of summary.queries.nPlusOnePatterns.slice(0, 3)) {
        body += `- \`${p.query}\` repeated **${p.count}** times\n`;
      }
      body += `\n`;
    }

    if (summary.functions.signatures.length > 0) {
      body += `<details><summary>Function Signatures (${summary.functions.total})</summary>\n\n`;
      body += `\`\`\`\n`;
      for (const sig of summary.functions.signatures.slice(0, 15)) {
        body += `${sig.signature}\n`;
      }
      body += `\`\`\`\n</details>\n\n`;
    }

    // API changelog (if snapshot exists)
    try {
      const { generateChangelog, toMarkdown } = require('./changelog');
      const snapshotDir = path.join(trickleDir, 'snapshot');
      if (fs.existsSync(snapshotDir)) {
        const changelog = generateChangelog({ dir: trickleDir });
        if (changelog.changes.length > 0) {
          body += toMarkdown(changelog) + '\n\n';
        }
      }
    } catch {}

    // Security scan
    try {
      const { runSecurityScan } = require('./security');
      const origLog2 = console.log;
      console.log = () => {};
      const secResult = runSecurityScan({ dir: trickleDir });
      console.log = origLog2;
      if (secResult.findings.length > 0) {
        body += `### 🔒 Security\n\n`;
        body += `**${secResult.summary.critical}** critical, **${secResult.summary.warning}** warnings\n\n`;
        for (const f of secResult.findings.slice(0, 3)) {
          const icon = f.severity === 'critical' ? '🔴' : '🟡';
          body += `${icon} **${f.category}**: ${f.message}\n`;
        }
        body += '\n';
      }
    } catch {}

    body += `---\n*Generated by [trickle](https://github.com/yiheinchai/trickle) — runtime observability with 30 MCP tools*`;

    // Post comment via GitHub API
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({ body }),
    });

    if (res.ok) {
      console.log(`::notice::trickle: Posted analysis to PR #${prNumber}`);
    }
  } catch (err: any) {
    // Never fail CI because of comment posting
    console.log(`::warning::trickle: Failed to post PR comment: ${err.message}`);
  }
}

async function postGitlabMrComment(
  alerts: any[], observations: any[], queries: any[], errors: any[], trickleDir: string,
): Promise<void> {
  try {
    const projectId = process.env.CI_PROJECT_ID;
    const mrIid = process.env.CI_MERGE_REQUEST_IID;
    const gitlabUrl = process.env.CI_SERVER_URL || 'https://gitlab.com';
    const token = process.env.GITLAB_TOKEN;
    if (!projectId || !mrIid || !token) return;

    // Build comment body (same as GitHub but without GitHub-specific features)
    const { generateRunSummary } = require('./summary');
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    let summary: any;
    try { summary = generateRunSummary({ dir: trickleDir }); } catch {} finally {
      console.log = origLog;
      console.error = origErr;
    }
    if (!summary) return;

    const critical = alerts.filter(a => a.severity === 'critical');
    const warnings = alerts.filter(a => a.severity === 'warning');
    const statusIcon = critical.length > 0 ? '🔴' : warnings.length > 0 ? '🟡' : '🟢';
    const statusText = critical.length > 0 ? 'Issues Found' : warnings.length > 0 ? 'Warnings' : 'Healthy';

    let body = `## ${statusIcon} trickle: ${statusText}\n\n`;
    body += `| Metric | Count |\n|---|---|\n`;
    body += `| Functions | ${summary.counts.functions} |\n`;
    body += `| Queries | ${summary.counts.queries} |\n`;
    body += `| Errors | ${summary.counts.errors} |\n`;
    body += `| Alerts | ${alerts.length} |\n\n`;

    if (summary.rootCauses.length > 0) {
      body += `### Root Causes\n\n`;
      for (const rc of summary.rootCauses.slice(0, 5)) {
        body += `${rc.severity === 'critical' ? '🔴' : '🟡'} **${rc.category}**: ${rc.description}\n> ${rc.suggestedFix}\n\n`;
      }
    }

    body += `---\n*Generated by [trickle](https://github.com/yiheinchai/trickle)*`;

    const res = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
      {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    if (res.ok) console.log(`[trickle] Posted analysis to MR !${mrIid}`);
  } catch (err: any) {
    console.log(`WARNING: [trickle] Failed to post MR comment: ${err.message}`);
  }
}
