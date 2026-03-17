/**
 * trickle agent — autonomous debugging agent that detects and explains issues.
 *
 * Runs the full observability pipeline and generates a human-readable
 * debugging report that an AI agent would produce. This demonstrates
 * the value of agent-powered debugging.
 *
 * Usage:
 *   trickle agent "python app.py"      # run app + full analysis
 *   trickle agent                       # analyze existing .trickle/ data
 *   trickle agent --fix                 # generate fix suggestions
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

export async function runAgent(opts: { command?: string; fix?: boolean }): Promise<void> {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  // Step 1: Run the app if command provided
  if (opts.command) {
    console.log('');
    console.log(chalk.bold.cyan('  🤖 trickle agent'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(chalk.gray(`  Running: ${opts.command}`));
    console.log('');

    const { execSync } = require('child_process');
    try {
      execSync(`npx trickle run ${opts.command}`, {
        stdio: 'inherit',
        env: { ...process.env, TRICKLE_LOCAL: '1' },
      });
    } catch {}
  }

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ data found. Run trickle agent "your command" first.'));
    return;
  }

  // Step 2: Run monitor
  try {
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: trickleDir });
  } catch {}

  // Step 3: Collect all data
  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));

  const critical = alerts.filter((a: any) => a.severity === 'critical');
  const warnings = alerts.filter((a: any) => a.severity === 'warning');
  const endProfile = profile.find((p: any) => p.event === 'end');

  // Step 4: Generate agent report
  console.log('');
  console.log(chalk.bold.cyan('  🤖 Agent Analysis Report'));
  console.log(chalk.gray('  ' + '═'.repeat(50)));
  console.log('');

  // Overview
  const status = critical.length > 0 ? chalk.red('CRITICAL ISSUES FOUND') :
    warnings.length > 0 ? chalk.yellow('WARNINGS DETECTED') :
    errors.length > 0 ? chalk.red('RUNTIME ERRORS') :
    chalk.green('APPLICATION HEALTHY');
  console.log(`  ${chalk.bold('Status')}: ${status}`);
  console.log(`  ${chalk.bold('Coverage')}: ${variables.length} variables | ${observations.length} functions | ${queries.length} DB queries`);
  if (endProfile) {
    console.log(`  ${chalk.bold('Memory')}: ${Math.round((endProfile.rssKb || 0) / 1024)}MB RSS`);
  }
  console.log('');

  // Issues
  if (alerts.length > 0) {
    console.log(chalk.bold('  📋 Issues Found:'));
    console.log('');
    for (let i = 0; i < Math.min(alerts.length, 5); i++) {
      const a = alerts[i];
      const icon = a.severity === 'critical' ? chalk.red('●') : chalk.yellow('●');
      const sev = a.severity === 'critical' ? chalk.red('[CRITICAL]') : chalk.yellow('[WARNING]');
      console.log(`  ${icon} ${sev} ${a.message}`);
      if (a.suggestion) {
        console.log(chalk.gray(`     Fix: ${a.suggestion}`));
      }
      console.log('');
    }
  }

  // Error summary
  if (errors.length > 0) {
    console.log(chalk.bold('  💥 Runtime Errors:'));
    console.log('');
    for (const e of errors.slice(0, 3)) {
      console.log(chalk.red(`  ${e.type || 'Error'}: ${(e.message || e.error || '').substring(0, 100)}`));
      if (e.file) console.log(chalk.gray(`     at ${e.file}:${e.line || '?'}`));
      console.log('');
    }
  }

  // Performance hotspots
  const slowFuncs = observations
    .filter((o: any) => o.durationMs && o.durationMs > 10)
    .sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0));

  if (slowFuncs.length > 0) {
    console.log(chalk.bold('  ⏱  Performance Hotspots:'));
    console.log('');
    for (const f of slowFuncs.slice(0, 3)) {
      const bar = '█'.repeat(Math.min(20, Math.round(f.durationMs / (slowFuncs[0].durationMs / 20))));
      console.log(`  ${chalk.cyan(bar)} ${f.functionName} (${f.module}) — ${f.durationMs?.toFixed(0)}ms`);
    }
    console.log('');
  }

  // Error logs
  const errorLogs = logs.filter((l: any) => l.level === 'ERROR' || l.level === 'CRITICAL');
  if (errorLogs.length > 0) {
    console.log(chalk.bold('  📝 Error Logs:'));
    for (const l of errorLogs.slice(0, 3)) {
      console.log(chalk.red(`  [${l.level}] ${l.logger}: ${l.message?.substring(0, 80)}`));
    }
    console.log('');
  }

  // Recommendations
  if (opts.fix && alerts.length > 0) {
    console.log(chalk.bold('  🔧 Recommended Fixes:'));
    console.log('');
    for (let i = 0; i < Math.min(alerts.length, 3); i++) {
      const a = alerts[i];
      console.log(`  ${i + 1}. ${chalk.bold(a.category)}: ${a.suggestion || a.message}`);
    }
    console.log('');
    console.log(chalk.gray('  Run `trickle heal --json` for detailed fix plans with context.'));
    console.log('');
  }

  // Summary
  console.log(chalk.gray('  ' + '═'.repeat(50)));
  if (critical.length > 0) {
    console.log(chalk.red(`  ${critical.length} critical issue(s) require immediate attention.`));
  } else if (warnings.length > 0) {
    console.log(chalk.yellow(`  ${warnings.length} warning(s) should be addressed.`));
  } else {
    console.log(chalk.green('  No issues detected. Application is healthy.'));
  }
  console.log(chalk.gray('  Run `trickle heal` for fix plans or `trickle doctor --json` for structured data.'));
  console.log('');
}
