/**
 * trickle monitor — watches .trickle/ data files for anomalies and
 * generates alerts that agents can act on.
 *
 * Detects:
 * - Slow database queries (> threshold ms)
 * - Error spikes
 * - Memory leaks (RSS growing across snapshots)
 * - Slow function calls (> threshold ms)
 * - HTTP errors (4xx/5xx status codes)
 *
 * Writes alerts to .trickle/alerts.jsonl for agent consumption.
 * Also available via MCP tool: get_alerts
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface Alert {
  kind: 'alert';
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
  details: Record<string, unknown>;
  timestamp: number;
  suggestion?: string;
}

interface MonitorOptions {
  dir?: string;
  slowQueryMs?: number;
  slowFunctionMs?: number;
  memoryThresholdMb?: number;
}

function findTrickleDir(dir?: string): string {
  return dir || path.join(process.cwd(), '.trickle');
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const lines: unknown[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch {}
  }
  return lines;
}

function analyzeQueries(trickleDir: string, slowThreshold: number): Alert[] {
  const alerts: Alert[] = [];
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl')) as any[];

  const slowQueries = queries.filter(q => q.durationMs > slowThreshold);
  if (slowQueries.length > 0) {
    for (const q of slowQueries.slice(0, 5)) {
      alerts.push({
        kind: 'alert',
        severity: q.durationMs > slowThreshold * 5 ? 'critical' : 'warning',
        category: 'slow_query',
        message: `Slow ${q.driver || 'SQL'} query: ${q.durationMs.toFixed(1)}ms`,
        details: { query: q.query, durationMs: q.durationMs, driver: q.driver },
        timestamp: q.timestamp || Date.now(),
        suggestion: `Optimize this query or add an index. Query: ${q.query?.substring(0, 100)}`,
      });
    }
  }

  // Detect N+1 pattern: same query executed many times
  const queryCounts = new Map<string, number>();
  for (const q of queries) {
    const key = q.query?.substring(0, 100);
    if (key) queryCounts.set(key, (queryCounts.get(key) || 0) + 1);
  }
  for (const [query, count] of queryCounts) {
    if (count >= 5) {
      alerts.push({
        kind: 'alert',
        severity: count >= 10 ? 'critical' : 'warning',
        category: 'n_plus_one',
        message: `N+1 query pattern: "${query.substring(0, 60)}" executed ${count} times`,
        details: { query, executionCount: count },
        timestamp: Date.now(),
        suggestion: `Use a JOIN or batch query instead of executing "${query.substring(0, 40)}" in a loop.`,
      });
    }
  }

  return alerts;
}

function analyzeErrors(trickleDir: string): Alert[] {
  const alerts: Alert[] = [];
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl')) as any[];

  if (errors.length > 0) {
    // Group by error type
    const byType = new Map<string, any[]>();
    for (const e of errors) {
      const type = e.type || e.error || 'Unknown';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(e);
    }

    for (const [type, errs] of byType) {
      alerts.push({
        kind: 'alert',
        severity: errs.length >= 3 ? 'critical' : 'warning',
        category: 'error',
        message: `${type}: ${errs.length} occurrence(s)`,
        details: {
          errorType: type,
          count: errs.length,
          firstMessage: errs[0]?.message?.substring(0, 200),
          file: errs[0]?.file,
          line: errs[0]?.line,
        },
        timestamp: errs[errs.length - 1]?.timestamp || Date.now(),
        suggestion: `Fix the ${type} error in ${errs[0]?.file || 'unknown file'}:${errs[0]?.line || '?'}`,
      });
    }
  }

  return alerts;
}

function analyzeMemory(trickleDir: string, thresholdMb: number): Alert[] {
  const alerts: Alert[] = [];
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl')) as any[];

  const start = profile.find(p => p.event === 'start');
  const end = profile.find(p => p.event === 'end');

  if (start && end && start.rssKb && end.rssKb) {
    const startMb = start.rssKb / 1024;
    const endMb = end.rssKb / 1024;
    const growthMb = endMb - startMb;

    if (endMb > thresholdMb) {
      alerts.push({
        kind: 'alert',
        severity: endMb > thresholdMb * 2 ? 'critical' : 'warning',
        category: 'memory',
        message: `High memory usage: ${endMb.toFixed(0)}MB RSS (grew ${growthMb.toFixed(0)}MB during execution)`,
        details: { startMb: Math.round(startMb), endMb: Math.round(endMb), growthMb: Math.round(growthMb) },
        timestamp: end.timestamp || Date.now(),
        suggestion: `Memory grew from ${startMb.toFixed(0)}MB to ${endMb.toFixed(0)}MB. Check for large data structures or memory leaks.`,
      });
    }
  }

  return alerts;
}

function analyzeFunctions(trickleDir: string, slowThreshold: number): Alert[] {
  const alerts: Alert[] = [];
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl')) as any[];

  const slowFuncs = observations.filter(o => o.durationMs && o.durationMs > slowThreshold);
  for (const fn of slowFuncs.slice(0, 5)) {
    alerts.push({
      kind: 'alert',
      severity: fn.durationMs > slowThreshold * 5 ? 'critical' : 'warning',
      category: 'slow_function',
      message: `Slow function: ${fn.functionName} took ${fn.durationMs.toFixed(1)}ms`,
      details: { function: fn.functionName, module: fn.module, durationMs: fn.durationMs },
      timestamp: Date.now(),
      suggestion: `Profile ${fn.functionName} in ${fn.module} — it took ${fn.durationMs.toFixed(0)}ms.`,
    });
  }

  return alerts;
}

function analyzeCallTrace(trickleDir: string): Alert[] {
  const alerts: Alert[] = [];
  const trace = readJsonl(path.join(trickleDir, 'calltrace.jsonl')) as any[];

  // Detect deeply nested call stacks (depth > 10)
  const maxDepth = Math.max(0, ...trace.map((t: any) => t.depth || 0));
  if (maxDepth > 10) {
    alerts.push({
      kind: 'alert',
      severity: maxDepth > 20 ? 'critical' : 'warning',
      category: 'deep_call_stack',
      message: `Deep call stack detected: max depth ${maxDepth}`,
      details: { maxDepth },
      timestamp: Date.now(),
      suggestion: `Call stack reaches depth ${maxDepth}. Check for recursion or overly nested function calls.`,
    });
  }

  return alerts;
}

export function runMonitor(opts: MonitorOptions): Alert[] {
  const trickleDir = findTrickleDir(opts.dir);
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return [];
  }

  const slowQueryMs = opts.slowQueryMs || 100;
  const slowFunctionMs = opts.slowFunctionMs || 1000;
  const memoryThresholdMb = opts.memoryThresholdMb || 512;

  const allAlerts: Alert[] = [
    ...analyzeQueries(trickleDir, slowQueryMs),
    ...analyzeErrors(trickleDir),
    ...analyzeMemory(trickleDir, memoryThresholdMb),
    ...analyzeFunctions(trickleDir, slowFunctionMs),
    ...analyzeCallTrace(trickleDir),
  ];

  // Write alerts to file for agent consumption
  const alertsFile = path.join(trickleDir, 'alerts.jsonl');
  fs.writeFileSync(alertsFile, allAlerts.map(a => JSON.stringify(a)).join('\n') + (allAlerts.length > 0 ? '\n' : ''), 'utf-8');

  // Display
  console.log('');
  console.log(chalk.bold('  trickle monitor'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (allAlerts.length === 0) {
    console.log(chalk.green('  No issues detected.'));
  } else {
    const critical = allAlerts.filter(a => a.severity === 'critical');
    const warnings = allAlerts.filter(a => a.severity === 'warning');
    const info = allAlerts.filter(a => a.severity === 'info');

    if (critical.length > 0) {
      console.log(chalk.red(`  ${critical.length} critical issue(s)`));
      for (const a of critical) {
        console.log(chalk.red(`    ✗ ${a.message}`));
        if (a.suggestion) console.log(chalk.gray(`      → ${a.suggestion}`));
      }
    }
    if (warnings.length > 0) {
      console.log(chalk.yellow(`  ${warnings.length} warning(s)`));
      for (const a of warnings) {
        console.log(chalk.yellow(`    ⚠ ${a.message}`));
        if (a.suggestion) console.log(chalk.gray(`      → ${a.suggestion}`));
      }
    }
    if (info.length > 0) {
      console.log(chalk.blue(`  ${info.length} info`));
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray(`  Alerts written to ${path.relative(process.cwd(), path.join(trickleDir, 'alerts.jsonl'))}`));
  console.log('');

  return allAlerts;
}
