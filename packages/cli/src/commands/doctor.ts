/**
 * trickle doctor — comprehensive health check that gives agents a complete
 * picture of an application's state in a single command.
 *
 * Combines: data freshness, alert summary, performance overview, error
 * summary, and environment info into one output.
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

export function runDoctor(opts: { json?: boolean }): void {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(trickleDir)) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'no_data', message: 'No .trickle/ directory. Run trickle run <command> first.' }));
    } else {
      console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    }
    return;
  }

  // Run monitor silently for fresh alerts
  const origLog = console.log;
  const origErr = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: trickleDir });
  } catch {} finally {
    console.log = origLog;
    console.error = origErr;
  }

  // Collect all data
  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
  const console_out = readJsonl(path.join(trickleDir, 'console.jsonl'));
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));

  let env: any = {};
  try {
    const envFile = path.join(trickleDir, 'environment.json');
    if (fs.existsSync(envFile)) env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  } catch {}

  // Data freshness
  let dataAge = 'unknown';
  try {
    const stat = fs.statSync(path.join(trickleDir, 'variables.jsonl'));
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 60000) dataAge = `${Math.round(ageMs / 1000)}s ago`;
    else if (ageMs < 3600000) dataAge = `${Math.round(ageMs / 60000)}m ago`;
    else dataAge = `${Math.round(ageMs / 3600000)}h ago`;
  } catch {}

  // Performance summary
  const startProfile = profile.find((p: any) => p.event === 'start');
  const endProfile = profile.find((p: any) => p.event === 'end');
  const maxFunctionMs = Math.max(0, ...observations.map((o: any) => o.durationMs || 0));
  const slowFunctions = observations.filter((o: any) => o.durationMs > 100).sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0));
  const slowQueries = queries.filter((q: any) => q.durationMs > 10).sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0));

  const critical = alerts.filter((a: any) => a.severity === 'critical');
  const warnings = alerts.filter((a: any) => a.severity === 'warning');

  const report = {
    status: critical.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : errors.length > 0 ? 'error' : 'healthy',
    dataFreshness: dataAge,
    summary: {
      variables: variables.length,
      functions: observations.length,
      queries: queries.length,
      errors: errors.length,
      callTraceEvents: calltrace.length,
      consoleLines: console_out.length,
      alerts: { critical: critical.length, warning: warnings.length, total: alerts.length },
    },
    performance: {
      maxFunctionMs: Math.round(maxFunctionMs * 100) / 100,
      slowFunctions: slowFunctions.slice(0, 5).map((f: any) => ({ name: f.functionName, module: f.module, ms: f.durationMs })),
      slowQueries: slowQueries.slice(0, 5).map((q: any) => ({ query: q.query?.substring(0, 80), ms: q.durationMs, driver: q.driver })),
      memoryMb: endProfile ? Math.round((endProfile.rssKb || 0) / 1024) : null,
    },
    environment: {
      runtime: env.python ? `Python ${env.python.version?.split(' ')[0]}` : env.node ? `Node ${env.node.version}` : 'unknown',
      platform: env.python?.platform || (env.node ? `${env.node.platform}/${env.node.arch}` : 'unknown'),
      frameworks: env.frameworks || [],
    },
    alerts: alerts.slice(0, 10).map((a: any) => ({
      severity: a.severity,
      category: a.category,
      message: a.message,
      suggestion: a.suggestion,
    })),
    logs: {
      total: logs.length,
      errors: logs.filter((l: any) => ['error','critical','fatal'].includes((l.level||l.levelname||'').toLowerCase())).length,
    },
    rootCauses: [] as Array<{ severity: string; category: string; description: string; suggestedFix: string }>,
    recommendedActions: [] as Array<{ priority: number; action: string; tool: string }>,
  };

  // Derive root causes
  const seenMsgs = new Set<string>();
  for (const err of errors.slice(0, 5)) {
    const msg = (err.message || '').substring(0, 100);
    if (seenMsgs.has(msg)) continue;
    seenMsgs.add(msg);
    const isNull = msg.includes('NoneType') || msg.includes('undefined') || msg.includes('null');
    report.rootCauses.push({
      severity: 'critical',
      category: isNull ? 'null_reference' : 'runtime_error',
      description: `${err.type || 'Error'}: ${msg}`,
      suggestedFix: isNull ? 'Add null check before accessing the value.' : `Fix the ${err.type || 'error'} at ${err.file || 'unknown'}:${err.line || '?'}.`,
    });
  }
  // N+1 patterns
  const queryCounts = new Map<string, number>();
  for (const q of queries) {
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?');
    queryCounts.set(norm, (queryCounts.get(norm) || 0) + 1);
  }
  for (const [q, count] of queryCounts) {
    if (count >= 3) {
      report.rootCauses.push({
        severity: 'warning',
        category: 'n_plus_one',
        description: `N+1: "${q.substring(0, 60)}" repeated ${count} times`,
        suggestedFix: 'Replace with a batch query using IN clause or JOIN.',
      });
    }
  }
  // Memory
  if (endProfile && startProfile) {
    const delta = Math.round(((endProfile.rssKb || 0) - (startProfile.rssKb || 0)) / 1024);
    if (delta > 100) {
      report.rootCauses.push({
        severity: 'warning', category: 'memory_growth',
        description: `Memory grew by ${delta}MB`,
        suggestedFix: 'Check for memory leaks — objects accumulating in arrays/maps.',
      });
    }
  }

  // Recommended actions
  if (errors.length > 0) report.recommendedActions.push({ priority: 1, action: `Debug ${errors.length} error(s)`, tool: 'get_errors' });
  if (critical.length > 0) report.recommendedActions.push({ priority: 1, action: `Fix ${critical.length} critical alert(s)`, tool: 'get_alerts' });
  report.recommendedActions.push({ priority: 2, action: 'Get full summary', tool: 'get_last_run_summary' });
  if (calltrace.length > 5) report.recommendedActions.push({ priority: 3, action: 'Analyze performance', tool: 'get_flamegraph' });
  if (!fs.existsSync(path.join(trickleDir, 'baseline.json')) && alerts.length > 0) {
    report.recommendedActions.push({ priority: 3, action: 'Save baseline before fixing', tool: 'save_baseline' });
  }
  report.recommendedActions.sort((a, b) => a.priority - b.priority);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle doctor'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  // Status
  const statusIcon = report.status === 'healthy' ? chalk.green('✓ HEALTHY') :
    report.status === 'critical' ? chalk.red('✗ CRITICAL') :
    report.status === 'warning' ? chalk.yellow('⚠ WARNING') :
    chalk.red('✗ ERRORS');
  console.log(`  Status: ${statusIcon}  (data: ${dataAge})`);
  console.log(`  Runtime: ${report.environment.runtime} on ${report.environment.platform}`);
  if (report.environment.frameworks.length > 0) {
    console.log(`  Frameworks: ${report.environment.frameworks.join(', ')}`);
  }
  console.log('');

  // Counts
  console.log(`  ${chalk.bold('Data')}:  ${variables.length} vars | ${observations.length} functions | ${queries.length} queries | ${errors.length} errors`);
  console.log(`  ${chalk.bold('Alerts')}: ${critical.length} critical | ${warnings.length} warnings`);
  if (report.performance.memoryMb) {
    console.log(`  ${chalk.bold('Memory')}: ${report.performance.memoryMb}MB RSS`);
  }
  console.log('');

  // Top issues
  if (alerts.length > 0) {
    console.log(`  ${chalk.bold('Issues')}:`);
    for (const a of alerts.slice(0, 5)) {
      const icon = a.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`    ${icon} ${a.message}`);
    }
    console.log('');
  }

  // Slow functions
  if (slowFunctions.length > 0) {
    console.log(`  ${chalk.bold('Slow Functions')}:`);
    for (const f of slowFunctions.slice(0, 3)) {
      console.log(`    ${f.functionName} (${f.module}) — ${f.durationMs?.toFixed(0)}ms`);
    }
    console.log('');
  }

  // Root causes
  if (report.rootCauses.length > 0) {
    console.log(`  ${chalk.bold('Root Causes')}:`);
    for (const rc of report.rootCauses.slice(0, 5)) {
      const icon = rc.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`    ${icon} ${rc.description}`);
      console.log(chalk.gray(`      Fix: ${rc.suggestedFix}`));
    }
    console.log('');
  }

  // Recommended actions
  if (report.recommendedActions.length > 0) {
    console.log(`  ${chalk.bold('Recommended')}:`);
    for (const a of report.recommendedActions.slice(0, 4)) {
      console.log(chalk.cyan(`    → ${a.action}`));
    }
    console.log('');
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray('  Use trickle doctor --json for structured output'));
  console.log('');
}
