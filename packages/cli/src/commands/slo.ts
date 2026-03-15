/**
 * trickle slo — Service Level Objective monitoring.
 *
 * Define SLOs in .trickle/slos.json and track budget burn rate.
 * Example SLOs:
 *   - "99.9% of requests complete in < 200ms" (latency SLO)
 *   - "Error rate < 1%" (availability SLO)
 *   - "p95 query latency < 50ms" (query SLO)
 *
 * Commands:
 *   trickle slo init       — Create default SLOs
 *   trickle slo check      — Check SLO compliance against current data
 *   trickle slo report     — Detailed SLO status report
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface SloDefinition {
  name: string;
  type: 'latency' | 'error_rate' | 'query_latency' | 'availability';
  target: number; // e.g., 99.9 for 99.9%
  threshold?: number; // e.g., 200 for 200ms latency
  scope?: string; // optional: function pattern or query pattern
  enabled: boolean;
}

interface SloConfig {
  slos: SloDefinition[];
  window?: string; // "30d", "7d", etc. — informational
}

interface SloResult {
  name: string;
  type: string;
  target: number;
  actual: number;
  passing: boolean;
  budgetRemaining: number; // percentage of error budget left
  details: Record<string, unknown>;
}

const DEFAULT_SLOS: SloConfig = {
  slos: [
    {
      name: "Request Latency",
      type: "latency",
      target: 99.0,
      threshold: 500,
      enabled: true,
    },
    {
      name: "Error Rate",
      type: "error_rate",
      target: 99.0,
      enabled: true,
    },
    {
      name: "Query Latency",
      type: "query_latency",
      target: 95.0,
      threshold: 100,
      enabled: true,
    },
    {
      name: "P95 Function Latency",
      type: "latency",
      target: 95.0,
      threshold: 1000,
      scope: "*",
      enabled: true,
    },
  ],
  window: "30d",
};

function findTrickleDir(dir?: string): string {
  return dir || path.join(process.cwd(), '.trickle');
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function loadSlos(trickleDir: string): SloConfig {
  const filePath = path.join(trickleDir, 'slos.json');
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return DEFAULT_SLOS;
}

function checkSlos(trickleDir: string, sloConfig: SloConfig): SloResult[] {
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));

  const results: SloResult[] = [];

  for (const slo of sloConfig.slos) {
    if (!slo.enabled) continue;

    switch (slo.type) {
      case 'latency': {
        const threshold = slo.threshold || 500;
        let funcs = observations.filter((o: any) => o.durationMs !== undefined);
        if (slo.scope && slo.scope !== '*') {
          const pattern = new RegExp(slo.scope, 'i');
          funcs = funcs.filter((o: any) => pattern.test(o.functionName || ''));
        }
        const total = funcs.length;
        const passing = funcs.filter((o: any) => o.durationMs <= threshold).length;
        const actual = total > 0 ? (passing / total) * 100 : 100;
        const budgetTotal = 100 - slo.target; // e.g., 1% for 99% SLO
        const budgetUsed = 100 - actual;
        const budgetRemaining = budgetTotal > 0 ? Math.max(0, ((budgetTotal - budgetUsed) / budgetTotal) * 100) : (actual >= slo.target ? 100 : 0);

        results.push({
          name: slo.name,
          type: slo.type,
          target: slo.target,
          actual: Math.round(actual * 100) / 100,
          passing: actual >= slo.target,
          budgetRemaining: Math.round(budgetRemaining * 10) / 10,
          details: {
            threshold: `${threshold}ms`,
            totalCalls: total,
            passingCalls: passing,
            failingCalls: total - passing,
          },
        });
        break;
      }

      case 'error_rate': {
        const totalCalls = observations.length;
        const totalErrors = errors.length;
        const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;
        const availability = 100 - errorRate;
        const budgetTotal = 100 - slo.target;
        const budgetUsed = errorRate;
        const budgetRemaining = budgetTotal > 0 ? Math.max(0, ((budgetTotal - budgetUsed) / budgetTotal) * 100) : (availability >= slo.target ? 100 : 0);

        results.push({
          name: slo.name,
          type: slo.type,
          target: slo.target,
          actual: Math.round(availability * 100) / 100,
          passing: availability >= slo.target,
          budgetRemaining: Math.round(budgetRemaining * 10) / 10,
          details: {
            totalCalls,
            totalErrors,
            errorRate: `${errorRate.toFixed(2)}%`,
          },
        });
        break;
      }

      case 'query_latency': {
        const threshold = slo.threshold || 100;
        let qs = queries.filter((q: any) => q.durationMs !== undefined);
        if (slo.scope) {
          const pattern = new RegExp(slo.scope, 'i');
          qs = qs.filter((q: any) => pattern.test(q.query || ''));
        }
        const total = qs.length;
        const passing = qs.filter((q: any) => q.durationMs <= threshold).length;
        const actual = total > 0 ? (passing / total) * 100 : 100;
        const budgetTotal = 100 - slo.target;
        const budgetUsed = 100 - actual;
        const budgetRemaining = budgetTotal > 0 ? Math.max(0, ((budgetTotal - budgetUsed) / budgetTotal) * 100) : (actual >= slo.target ? 100 : 0);

        results.push({
          name: slo.name,
          type: slo.type,
          target: slo.target,
          actual: Math.round(actual * 100) / 100,
          passing: actual >= slo.target,
          budgetRemaining: Math.round(budgetRemaining * 10) / 10,
          details: {
            threshold: `${threshold}ms`,
            totalQueries: total,
            passingQueries: passing,
            failingQueries: total - passing,
          },
        });
        break;
      }

      case 'availability': {
        const totalCalls = observations.length;
        const totalErrors = errors.length;
        const availability = totalCalls > 0 ? ((totalCalls - totalErrors) / totalCalls) * 100 : 100;
        const budgetTotal = 100 - slo.target;
        const budgetUsed = 100 - availability;
        const budgetRemaining = budgetTotal > 0 ? Math.max(0, ((budgetTotal - budgetUsed) / budgetTotal) * 100) : (availability >= slo.target ? 100 : 0);

        results.push({
          name: slo.name,
          type: slo.type,
          target: slo.target,
          actual: Math.round(availability * 100) / 100,
          passing: availability >= slo.target,
          budgetRemaining: Math.round(budgetRemaining * 10) / 10,
          details: { totalCalls, totalErrors },
        });
        break;
      }
    }
  }

  return results;
}

export function initSlos(dir?: string): void {
  const trickleDir = findTrickleDir(dir);
  fs.mkdirSync(trickleDir, { recursive: true });
  const filePath = path.join(trickleDir, 'slos.json');

  if (fs.existsSync(filePath)) {
    console.log(chalk.yellow(`  SLO config already exists: ${filePath}`));
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SLOS, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(chalk.green(`  ✓ Created ${path.relative(process.cwd(), filePath)}`));
  console.log('');
  console.log(chalk.gray('  Default SLOs:'));
  console.log(chalk.gray('    - 99% of functions complete in < 500ms'));
  console.log(chalk.gray('    - 99% availability (error rate < 1%)'));
  console.log(chalk.gray('    - 95% of queries complete in < 100ms'));
  console.log(chalk.gray('    - 95% of functions p95 < 1000ms'));
  console.log('');
  console.log(chalk.gray('  Edit .trickle/slos.json to customize, then run:'));
  console.log(chalk.gray('    trickle slo check'));
  console.log('');
}

export function checkSloCommand(opts: { dir?: string; json?: boolean }): void {
  const trickleDir = findTrickleDir(opts.dir);
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found.'));
    return;
  }

  const sloConfig = loadSlos(trickleDir);
  const results = checkSlos(trickleDir, sloConfig);

  // Write results
  fs.writeFileSync(path.join(trickleDir, 'slo-results.json'), JSON.stringify(results, null, 2), 'utf-8');

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle slo'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const allPassing = results.every(r => r.passing);
  const failing = results.filter(r => !r.passing);

  if (allPassing) {
    console.log(chalk.green('  ✓ All SLOs passing'));
  } else {
    console.log(chalk.red(`  ✗ ${failing.length} SLO(s) breached`));
  }
  console.log('');

  for (const r of results) {
    const icon = r.passing ? chalk.green('✓') : chalk.red('✗');
    const actualColor = r.passing ? chalk.green : chalk.red;
    const budgetColor = r.budgetRemaining > 50 ? chalk.green :
      r.budgetRemaining > 20 ? chalk.yellow : chalk.red;

    console.log(`  ${icon} ${chalk.bold(r.name)}`);
    console.log(`    Target: ${r.target}%  |  Actual: ${actualColor(r.actual + '%')}  |  Budget: ${budgetColor(r.budgetRemaining + '% remaining')}`);

    // Show details
    const details = Object.entries(r.details).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(chalk.gray(`    ${details}`));
    console.log('');
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Exit non-zero if any SLO is breached (for CI)
  if (!allPassing) {
    process.exitCode = 1;
  }
}
