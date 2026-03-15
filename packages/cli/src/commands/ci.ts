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

  // Step 5: Exit code
  if (opts.failOnCritical !== false && critical.length > 0) {
    process.exitCode = 1;
  }
  if (opts.failOnWarning && warnings.length > 0) {
    process.exitCode = 1;
  }
}
