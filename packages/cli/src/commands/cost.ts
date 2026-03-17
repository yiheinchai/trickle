/**
 * trickle cost — estimate cloud cost per function and query.
 *
 * Calculates cost based on execution time using configurable pricing:
 * - Lambda: $0.0000166667 per GB-second (default 128MB)
 * - Compute: $0.048/hour per vCPU (general estimate)
 * - DB queries: estimated I/O cost
 *
 * Usage:
 *   trickle cost                    # show cost breakdown
 *   trickle cost --json             # structured output
 *   trickle cost --memory 256       # Lambda memory in MB
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

interface CostEntry {
  name: string;
  type: 'function' | 'query';
  totalMs: number;
  calls: number;
  avgMs: number;
  costPerCall: number;
  totalCost: number;
  costPer1000: number;
}

export interface CostResult {
  entries: CostEntry[];
  totalCost: number;
  costPer1000Requests: number;
  estimatedMonthlyCost: number;
  pricing: { model: string; ratePerMs: number };
}

export function estimateCost(opts?: {
  dir?: string;
  memoryMb?: number;
  requestsPerDay?: number;
  json?: boolean;
}): CostResult {
  const trickleDir = opts?.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const memoryMb = opts?.memoryMb || 128;
  const requestsPerDay = opts?.requestsPerDay || 1000;

  // Lambda pricing: $0.0000166667 per GB-second
  const lambdaRatePerGbSecond = 0.0000166667;
  const gbFraction = memoryMb / 1024;
  const ratePerMs = (lambdaRatePerGbSecond * gbFraction) / 1000;

  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));

  const entries: CostEntry[] = [];

  // Functions
  const funcStats = new Map<string, { totalMs: number; calls: number }>();
  for (const obs of observations) {
    if (!obs.durationMs) continue;
    const key = `${obs.module}.${obs.functionName}`;
    const existing = funcStats.get(key) || { totalMs: 0, calls: 0 };
    existing.totalMs += obs.durationMs;
    existing.calls++;
    funcStats.set(key, existing);
  }

  for (const [name, stats] of funcStats) {
    const avgMs = stats.totalMs / stats.calls;
    const costPerCall = avgMs * ratePerMs;
    entries.push({
      name,
      type: 'function',
      totalMs: Math.round(stats.totalMs * 100) / 100,
      calls: stats.calls,
      avgMs: Math.round(avgMs * 100) / 100,
      costPerCall,
      totalCost: costPerCall * stats.calls,
      costPer1000: costPerCall * 1000,
    });
  }

  // Queries (grouped by normalized pattern)
  const queryStats = new Map<string, { totalMs: number; calls: number }>();
  for (const q of queries) {
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?').substring(0, 60);
    const existing = queryStats.get(norm) || { totalMs: 0, calls: 0 };
    existing.totalMs += q.durationMs || 0;
    existing.calls++;
    queryStats.set(norm, existing);
  }

  for (const [name, stats] of queryStats) {
    const avgMs = stats.totalMs / stats.calls;
    const costPerCall = avgMs * ratePerMs;
    entries.push({
      name,
      type: 'query',
      totalMs: Math.round(stats.totalMs * 100) / 100,
      calls: stats.calls,
      avgMs: Math.round(avgMs * 100) / 100,
      costPerCall,
      totalCost: costPerCall * stats.calls,
      costPer1000: costPerCall * 1000,
    });
  }

  entries.sort((a, b) => b.totalCost - a.totalCost);

  const totalCost = entries.reduce((sum, e) => sum + e.totalCost, 0);
  const costPer1000 = entries.reduce((sum, e) => sum + e.costPer1000, 0);
  const estimatedMonthlyCost = (costPer1000 / 1000) * requestsPerDay * 30;

  const result: CostResult = {
    entries,
    totalCost,
    costPer1000Requests: costPer1000,
    estimatedMonthlyCost,
    pricing: { model: `Lambda ${memoryMb}MB`, ratePerMs },
  };

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle cost'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(chalk.gray(`  Pricing: Lambda ${memoryMb}MB ($${lambdaRatePerGbSecond}/GB-s)`));
  console.log('');

  console.log(chalk.bold('  Top costs (per 1000 requests):'));
  for (const e of entries.slice(0, 10)) {
    const icon = e.type === 'function' ? chalk.blue('fn') : chalk.green('db');
    const cost = e.costPer1000 < 0.01 ? `$${(e.costPer1000 * 100).toFixed(2)}¢` : `$${e.costPer1000.toFixed(4)}`;
    const bar = '█'.repeat(Math.min(20, Math.ceil((e.totalMs / (entries[0]?.totalMs || 1)) * 20)));
    console.log(`  ${icon} ${bar.padEnd(20)} ${cost.padStart(10)}  ${e.avgMs.toFixed(1)}ms  ${e.name.substring(0, 40)}`);
  }

  console.log('');
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(`  This run cost: $${totalCost.toFixed(6)}`);
  console.log(`  Per 1000 requests: $${costPer1000.toFixed(4)}`);
  console.log(`  Estimated monthly (${requestsPerDay}/day): ${chalk.bold('$' + estimatedMonthlyCost.toFixed(2))}`);
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log('');

  return result;
}
