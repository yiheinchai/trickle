/**
 * trickle verify — re-runs the app and compares before/after metrics
 * to verify that a fix actually improved things.
 *
 * Usage:
 *   trickle verify "node app.js"        # runs app, compares with previous data
 *   trickle verify --baseline           # saves current data as baseline
 *   trickle verify --compare            # compares current data with saved baseline
 *
 * This closes the auto-remediation loop:
 *   detect → heal → fix → verify → done
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface Metrics {
  alertCount: number;
  criticalCount: number;
  warningCount: number;
  errorCount: number;
  slowQueryCount: number;
  n1QueryCount: number;
  maxFunctionMs: number;
  memoryMb: number;
  timestamp: number;
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function collectMetrics(trickleDir: string): Metrics {
  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl')) as any[];
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl')) as any[];
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl')) as any[];
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl')) as any[];

  const critical = alerts.filter(a => a.severity === 'critical').length;
  const warnings = alerts.filter(a => a.severity === 'warning').length;
  const slowQueries = alerts.filter(a => a.category === 'slow_query').length;
  const n1Queries = alerts.filter(a => a.category === 'n_plus_one').length;
  const maxMs = Math.max(0, ...observations.map((o: any) => o.durationMs || 0));
  const endProfile = profile.find((p: any) => p.event === 'end');
  const memMb = endProfile ? (endProfile.rssKb || 0) / 1024 : 0;

  return {
    alertCount: alerts.length,
    criticalCount: critical,
    warningCount: warnings,
    errorCount: errors.length,
    slowQueryCount: slowQueries,
    n1QueryCount: n1Queries,
    maxFunctionMs: Math.round(maxMs * 100) / 100,
    memoryMb: Math.round(memMb),
    timestamp: Date.now(),
  };
}

export function saveBaseline(opts: { dir?: string }): void {
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found.'));
    return;
  }

  // Run monitor to generate alerts
  try {
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: trickleDir });
  } catch {}

  const metrics = collectMetrics(trickleDir);
  const baselinePath = path.join(trickleDir, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(metrics, null, 2), 'utf-8');

  console.log('');
  console.log(chalk.bold('  trickle verify --baseline'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Baseline saved: ${metrics.alertCount} alerts, ${metrics.errorCount} errors`);
  console.log(`  Max function time: ${metrics.maxFunctionMs}ms`);
  console.log(`  Memory: ${metrics.memoryMb}MB`);
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export function compareWithBaseline(opts: { dir?: string }): any {
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');
  const baselinePath = path.join(trickleDir, 'baseline.json');

  if (!fs.existsSync(baselinePath)) {
    console.log(chalk.yellow('  No baseline found. Run trickle verify --baseline first.'));
    return;
  }

  // Run monitor to generate alerts
  try {
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: trickleDir });
  } catch {}

  const baseline: Metrics = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const current = collectMetrics(trickleDir);

  console.log('');
  console.log(chalk.bold('  trickle verify'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  const comparisons = [
    { label: 'Alerts', before: baseline.alertCount, after: current.alertCount, lowerBetter: true },
    { label: 'Critical', before: baseline.criticalCount, after: current.criticalCount, lowerBetter: true },
    { label: 'Errors', before: baseline.errorCount, after: current.errorCount, lowerBetter: true },
    { label: 'N+1 Queries', before: baseline.n1QueryCount, after: current.n1QueryCount, lowerBetter: true },
    { label: 'Slow Queries', before: baseline.slowQueryCount, after: current.slowQueryCount, lowerBetter: true },
    { label: 'Max Function (ms)', before: baseline.maxFunctionMs, after: current.maxFunctionMs, lowerBetter: true },
    { label: 'Memory (MB)', before: baseline.memoryMb, after: current.memoryMb, lowerBetter: true },
  ];

  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const c of comparisons) {
    const diff = c.after - c.before;
    let status: string;
    if (diff === 0) {
      status = chalk.gray('  =');
      unchanged++;
    } else if ((diff < 0 && c.lowerBetter) || (diff > 0 && !c.lowerBetter)) {
      status = chalk.green(`  ↓ ${Math.abs(diff)}`);
      improved++;
    } else {
      status = chalk.red(`  ↑ ${Math.abs(diff)}`);
      regressed++;
    }
    console.log(`  ${c.label.padEnd(20)} ${String(c.before).padStart(6)} → ${String(c.after).padStart(6)} ${status}`);
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  if (regressed === 0 && improved > 0) {
    console.log(chalk.green(`  ✓ Fix verified — ${improved} metric(s) improved, ${regressed} regressed`));
  } else if (regressed > 0) {
    console.log(chalk.red(`  ✗ Regression detected — ${regressed} metric(s) worsened`));
  } else {
    console.log(chalk.gray(`  No change detected`));
  }
  console.log('');

  // Write verification result
  const verifyResult = {
    kind: 'verification',
    baseline,
    current,
    comparisons: comparisons.map(c => ({
      metric: c.label,
      before: c.before,
      after: c.after,
      delta: c.after - c.before,
      status: c.after === c.before ? 'unchanged' :
        ((c.after - c.before < 0 && c.lowerBetter) || (c.after - c.before > 0 && !c.lowerBetter)) ? 'improved' : 'regressed',
    })),
    improved,
    regressed,
    unchanged,
    passed: regressed === 0 && improved > 0,
    timestamp: Date.now(),
  };
  fs.writeFileSync(path.join(trickleDir, 'verify.json'), JSON.stringify(verifyResult, null, 2), 'utf-8');

  return verifyResult;
}

/**
 * Save baseline and return metrics (for MCP consumption).
 */
export function saveBaselineJson(opts: { dir?: string }): Metrics & { saved: boolean } {
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');
  if (!fs.existsSync(trickleDir)) {
    return { alertCount: 0, criticalCount: 0, warningCount: 0, errorCount: 0, slowQueryCount: 0, n1QueryCount: 0, maxFunctionMs: 0, memoryMb: 0, timestamp: Date.now(), saved: false };
  }

  // Run monitor silently
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

  const metrics = collectMetrics(trickleDir);
  const baselinePath = path.join(trickleDir, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(metrics, null, 2), 'utf-8');
  return { ...metrics, saved: true };
}

/**
 * Compare with baseline and return structured result (for MCP consumption).
 */
export function compareWithBaselineJson(opts: { dir?: string }): any {
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');
  const baselinePath = path.join(trickleDir, 'baseline.json');

  if (!fs.existsSync(baselinePath)) {
    return { error: 'No baseline found. Use save_baseline first.' };
  }

  // Run monitor silently
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

  const baseline: Metrics = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const current = collectMetrics(trickleDir);

  const comparisons = [
    { metric: 'Alerts', before: baseline.alertCount, after: current.alertCount, lowerBetter: true },
    { metric: 'Critical', before: baseline.criticalCount, after: current.criticalCount, lowerBetter: true },
    { metric: 'Errors', before: baseline.errorCount, after: current.errorCount, lowerBetter: true },
    { metric: 'N+1 Queries', before: baseline.n1QueryCount, after: current.n1QueryCount, lowerBetter: true },
    { metric: 'Slow Queries', before: baseline.slowQueryCount, after: current.slowQueryCount, lowerBetter: true },
    { metric: 'Max Function (ms)', before: baseline.maxFunctionMs, after: current.maxFunctionMs, lowerBetter: true },
    { metric: 'Memory (MB)', before: baseline.memoryMb, after: current.memoryMb, lowerBetter: true },
  ].map(c => ({
    ...c,
    delta: c.after - c.before,
    status: c.after === c.before ? 'unchanged' as const :
      ((c.after - c.before < 0 && c.lowerBetter) || (c.after - c.before > 0 && !c.lowerBetter)) ? 'improved' as const : 'regressed' as const,
  }));

  const improved = comparisons.filter(c => c.status === 'improved').length;
  const regressed = comparisons.filter(c => c.status === 'regressed').length;

  const result = {
    passed: regressed === 0 && improved > 0,
    verdict: regressed === 0 && improved > 0 ? 'Fix verified' :
      regressed > 0 ? 'Regression detected' : 'No change',
    improved,
    regressed,
    comparisons,
    baseline,
    current,
  };

  fs.writeFileSync(path.join(trickleDir, 'verify.json'), JSON.stringify(result, null, 2), 'utf-8');
  return result;
}
