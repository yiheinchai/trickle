/**
 * trickle anomaly — detect performance anomalies by comparing against baselines.
 *
 * Saves normal latency profiles and alerts when current run deviates
 * significantly (>2x or >2 standard deviations from baseline mean).
 *
 * Usage:
 *   trickle anomaly --learn         # learn normal baseline from current data
 *   trickle anomaly                 # compare current data against baseline
 *   trickle anomaly --json          # structured output
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface BaselineEntry {
  name: string;
  samples: number[];
  mean: number;
  stddev: number;
  p95: number;
}

interface AnomalyResult {
  anomalies: Array<{
    name: string;
    type: 'function' | 'query';
    currentMs: number;
    baselineMean: number;
    baselineP95: number;
    deviation: number; // how many stddevs away
    severity: 'critical' | 'warning';
  }>;
  checked: number;
  baselineAge: string;
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function learnBaseline(dir?: string): void {
  const trickleDir = dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));

  const entries: Record<string, BaselineEntry> = {};

  // Functions
  for (const obs of observations) {
    if (!obs.durationMs || obs.durationMs <= 0) continue;
    const name = `fn:${obs.module}.${obs.functionName}`;
    if (!entries[name]) entries[name] = { name, samples: [], mean: 0, stddev: 0, p95: 0 };
    entries[name].samples.push(obs.durationMs);
  }

  // Queries (normalized)
  const queryDurations = new Map<string, number[]>();
  for (const q of queries) {
    if (!q.durationMs || q.durationMs <= 0) continue;
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?').substring(0, 80);
    const key = `query:${norm}`;
    if (!queryDurations.has(key)) queryDurations.set(key, []);
    queryDurations.get(key)!.push(q.durationMs);
  }
  for (const [key, samples] of queryDurations) {
    entries[key] = { name: key, samples, mean: 0, stddev: 0, p95: 0 };
  }

  // Compute stats
  for (const entry of Object.values(entries)) {
    entry.mean = entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length;
    entry.stddev = stddev(entry.samples);
    const sorted = [...entry.samples].sort((a, b) => a - b);
    entry.p95 = percentile(sorted, 95);
  }

  const baselinePath = path.join(trickleDir, 'anomaly-baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify({
    entries,
    timestamp: new Date().toISOString(),
    sampleCount: Object.values(entries).reduce((sum, e) => sum + e.samples.length, 0),
  }, null, 2));

  console.log(chalk.green(`\n  Baseline saved: ${Object.keys(entries).length} entries, ${baselinePath}\n`));
}

export function detectAnomalies(opts?: { dir?: string; json?: boolean }): AnomalyResult {
  const trickleDir = opts?.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const baselinePath = path.join(trickleDir, 'anomaly-baseline.json');

  if (!fs.existsSync(baselinePath)) {
    if (!opts?.json) console.log(chalk.yellow('\n  No baseline. Run: trickle anomaly --learn\n'));
    return { anomalies: [], checked: 0, baselineAge: 'none' };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const entries: Record<string, BaselineEntry> = baseline.entries;
  const ageMs = Date.now() - new Date(baseline.timestamp).getTime();
  const baselineAge = ageMs < 3600000 ? `${Math.round(ageMs / 60000)}m` : `${Math.round(ageMs / 3600000)}h`;

  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const anomalies: AnomalyResult['anomalies'] = [];

  // Check functions
  for (const obs of observations) {
    if (!obs.durationMs || obs.durationMs <= 0) continue;
    const key = `fn:${obs.module}.${obs.functionName}`;
    const entry = entries[key];
    if (!entry || entry.stddev === 0) continue;

    const deviation = (obs.durationMs - entry.mean) / (entry.stddev || 1);
    if (deviation > 2 && obs.durationMs > entry.p95 * 1.5) {
      anomalies.push({
        name: `${obs.module}.${obs.functionName}`,
        type: 'function',
        currentMs: Math.round(obs.durationMs * 100) / 100,
        baselineMean: Math.round(entry.mean * 100) / 100,
        baselineP95: Math.round(entry.p95 * 100) / 100,
        deviation: Math.round(deviation * 10) / 10,
        severity: deviation > 5 ? 'critical' : 'warning',
      });
    }
  }

  // Check queries
  const queryLatest = new Map<string, number>();
  for (const q of queries) {
    if (!q.durationMs) continue;
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?').substring(0, 80);
    const key = `query:${norm}`;
    queryLatest.set(key, Math.max(queryLatest.get(key) || 0, q.durationMs));
  }
  for (const [key, currentMs] of queryLatest) {
    const entry = entries[key];
    if (!entry || entry.stddev === 0) continue;
    const deviation = (currentMs - entry.mean) / (entry.stddev || 1);
    if (deviation > 2 && currentMs > entry.p95 * 1.5) {
      anomalies.push({
        name: key.replace('query:', ''),
        type: 'query',
        currentMs: Math.round(currentMs * 100) / 100,
        baselineMean: Math.round(entry.mean * 100) / 100,
        baselineP95: Math.round(entry.p95 * 100) / 100,
        deviation: Math.round(deviation * 10) / 10,
        severity: deviation > 5 ? 'critical' : 'warning',
      });
    }
  }

  anomalies.sort((a, b) => b.deviation - a.deviation);
  const result: AnomalyResult = { anomalies, checked: Object.keys(entries).length, baselineAge };

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log('');
  console.log(chalk.bold('  trickle anomaly'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray(`  Baseline: ${baselineAge} ago, ${result.checked} entries`));

  if (anomalies.length === 0) {
    console.log(chalk.green('  No anomalies detected. ✓'));
  } else {
    console.log(`  ${chalk.red(String(anomalies.length))} anomalies detected:`);
    console.log('');
    for (const a of anomalies.slice(0, 8)) {
      const icon = a.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`  ${icon} ${a.name} (${a.type})`);
      console.log(chalk.gray(`    ${a.currentMs}ms now vs ${a.baselineMean}ms baseline (${a.deviation}σ deviation, p95=${a.baselineP95}ms)`));
    }
  }
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');

  return result;
}
