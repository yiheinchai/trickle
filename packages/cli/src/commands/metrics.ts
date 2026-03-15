/**
 * trickle metrics — APM-style metrics computed from .trickle/ data.
 *
 * Computes:
 *   - Latency percentiles (p50, p95, p99) for functions and queries
 *   - Throughput (requests/sec, queries/sec)
 *   - Error rate (errors / total calls)
 *   - Slowest endpoints/functions
 *   - Query performance breakdown
 *
 * Output modes:
 *   - Terminal (default): formatted table
 *   - JSON (--json): structured for agent consumption
 *   - HTML (--html): self-contained APM dashboard
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface MetricsOptions {
  dir?: string;
  json?: boolean;
  html?: boolean;
  port?: number;
}

function findTrickleDir(dir?: string): string {
  return dir || path.join(process.cwd(), '.trickle');
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

interface FunctionMetrics {
  name: string;
  module: string;
  calls: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  totalMs: number;
  errorCount: number;
  errorRate: number;
}

interface QueryMetrics {
  query: string;
  driver: string;
  calls: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  totalMs: number;
}

interface OverallMetrics {
  functions: FunctionMetrics[];
  queries: QueryMetrics[];
  summary: {
    totalFunctions: number;
    totalCalls: number;
    totalQueries: number;
    totalErrors: number;
    errorRate: number;
    durationMs: number;
    memoryStartMb: number;
    memoryEndMb: number;
    memoryGrowthMb: number;
    logCount: number;
    traceCount: number;
  };
}

function computeMetrics(trickleDir: string): OverallMetrics {
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));

  // Function metrics — group by name
  const funcGroups = new Map<string, { durations: number[]; module: string; errors: number }>();
  for (const obs of observations) {
    const key = obs.functionName || '?';
    if (!funcGroups.has(key)) {
      funcGroups.set(key, { durations: [], module: obs.module || '', errors: 0 });
    }
    const g = funcGroups.get(key)!;
    if (obs.durationMs !== undefined && obs.durationMs !== null) {
      g.durations.push(obs.durationMs);
    }
  }

  // Count errors per function
  for (const err of errors) {
    const key = err.function || err.functionName || '?';
    if (funcGroups.has(key)) {
      funcGroups.get(key)!.errors++;
    }
  }

  const functionMetrics: FunctionMetrics[] = [];
  for (const [name, group] of funcGroups) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    const totalMs = sorted.reduce((s, d) => s + d, 0);
    const calls = sorted.length || 1;
    functionMetrics.push({
      name,
      module: group.module,
      calls,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      avg: totalMs / calls,
      totalMs,
      errorCount: group.errors,
      errorRate: group.errors / calls,
    });
  }

  // Sort by p95 descending
  functionMetrics.sort((a, b) => b.p95 - a.p95);

  // Query metrics — group by normalized query
  const queryGroups = new Map<string, { durations: number[]; driver: string }>();
  for (const q of queries) {
    // Normalize: truncate to first 80 chars for grouping
    const key = (q.query || '').substring(0, 80);
    if (!queryGroups.has(key)) {
      queryGroups.set(key, { durations: [], driver: q.driver || 'sql' });
    }
    queryGroups.get(key)!.durations.push(q.durationMs || 0);
  }

  const queryMetrics: QueryMetrics[] = [];
  for (const [query, group] of queryGroups) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    const totalMs = sorted.reduce((s, d) => s + d, 0);
    const calls = sorted.length;
    queryMetrics.push({
      query,
      driver: group.driver,
      calls,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      avg: totalMs / calls,
      totalMs,
    });
  }

  queryMetrics.sort((a, b) => b.p95 - a.p95);

  // Memory
  const startProfile = profile.find(p => p.event === 'start');
  const endProfile = profile.find(p => p.event === 'end');
  const memStartMb = startProfile ? (startProfile.rssKb || 0) / 1024 : 0;
  const memEndMb = endProfile ? (endProfile.rssKb || 0) / 1024 : 0;

  // Duration
  const timestamps = [
    ...observations.map(o => o.timestamp).filter(Boolean),
    ...queries.map(q => q.timestamp).filter(Boolean),
  ];
  const minTs = Math.min(...timestamps, Date.now());
  const maxTs = Math.max(...timestamps, Date.now());
  const durationMs = maxTs - minTs;

  const totalCalls = observations.length;
  const totalErrors = errors.length;

  return {
    functions: functionMetrics,
    queries: queryMetrics,
    summary: {
      totalFunctions: funcGroups.size,
      totalCalls,
      totalQueries: queries.length,
      totalErrors,
      errorRate: totalCalls > 0 ? totalErrors / totalCalls : 0,
      durationMs,
      memoryStartMb: Math.round(memStartMb),
      memoryEndMb: Math.round(memEndMb),
      memoryGrowthMb: Math.round(memEndMb - memStartMb),
      logCount: logs.length,
      traceCount: calltrace.length,
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printMetrics(metrics: OverallMetrics): void {
  const { summary, functions, queries } = metrics;

  console.log('');
  console.log(chalk.bold('  trickle metrics'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Summary cards
  console.log('');
  console.log(chalk.gray('  Summary'));
  const errColor = summary.errorRate > 0.05 ? chalk.red : summary.errorRate > 0 ? chalk.yellow : chalk.green;
  console.log(`    Functions: ${chalk.bold(String(summary.totalFunctions))}  |  Calls: ${chalk.bold(String(summary.totalCalls))}  |  Queries: ${chalk.bold(String(summary.totalQueries))}`);
  console.log(`    Errors: ${errColor(String(summary.totalErrors))} (${errColor((summary.errorRate * 100).toFixed(1) + '%')})  |  Logs: ${summary.logCount}  |  Traces: ${summary.traceCount}`);
  if (summary.memoryEndMb > 0) {
    console.log(`    Memory: ${summary.memoryStartMb}MB → ${summary.memoryEndMb}MB (${summary.memoryGrowthMb > 0 ? '+' : ''}${summary.memoryGrowthMb}MB)`);
  }

  // Function latency table
  if (functions.length > 0) {
    console.log('');
    console.log(chalk.gray('  Function Latency'));
    console.log(chalk.gray('    ' + 'Function'.padEnd(35) + 'Calls'.padStart(6) + '   p50'.padStart(8) + '   p95'.padStart(8) + '   p99'.padStart(8) + '   Errors'));

    for (const fn of functions.slice(0, 15)) {
      const name = fn.name.length > 33 ? fn.name.substring(0, 30) + '...' : fn.name;
      const errStr = fn.errorCount > 0 ? chalk.red(String(fn.errorCount)) : chalk.gray('0');
      const p95Color = fn.p95 > 1000 ? chalk.red : fn.p95 > 100 ? chalk.yellow : chalk.green;
      console.log(`    ${chalk.white(name.padEnd(35))}${String(fn.calls).padStart(6)}   ${formatDuration(fn.p50).padStart(8)}   ${p95Color(formatDuration(fn.p95).padStart(8))}   ${formatDuration(fn.p99).padStart(8)}   ${errStr}`);
    }
    if (functions.length > 15) {
      console.log(chalk.gray(`    ... and ${functions.length - 15} more functions`));
    }
  }

  // Query latency table
  if (queries.length > 0) {
    console.log('');
    console.log(chalk.gray('  Query Latency'));
    console.log(chalk.gray('    ' + 'Query'.padEnd(45) + 'Calls'.padStart(6) + '   p50'.padStart(8) + '   p95'.padStart(8) + '   Total'));

    for (const q of queries.slice(0, 10)) {
      const queryStr = q.query.length > 43 ? q.query.substring(0, 40) + '...' : q.query;
      const p95Color = q.p95 > 100 ? chalk.red : q.p95 > 10 ? chalk.yellow : chalk.green;
      console.log(`    ${chalk.white(queryStr.padEnd(45))}${String(q.calls).padStart(6)}   ${formatDuration(q.p50).padStart(8)}   ${p95Color(formatDuration(q.p95).padStart(8))}   ${formatDuration(q.totalMs).padStart(8)}`);
    }
    if (queries.length > 10) {
      console.log(chalk.gray(`    ... and ${queries.length - 10} more query patterns`));
    }
  }

  console.log('');
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log('');
}

function generateMetricsHtml(metrics: OverallMetrics): string {
  const { summary, functions, queries } = metrics;

  const fnRows = functions.slice(0, 20).map(fn => {
    const p95Color = fn.p95 > 1000 ? '#f85149' : fn.p95 > 100 ? '#d29922' : '#3fb950';
    const errColor = fn.errorCount > 0 ? '#f85149' : '#484f58';
    const barWidth = functions[0]?.p95 > 0 ? Math.round((fn.p95 / functions[0].p95) * 100) : 0;
    return `<tr>
      <td class="mono">${escHtml(fn.name)}</td>
      <td>${fn.calls}</td>
      <td>${formatDuration(fn.p50)}</td>
      <td style="color:${p95Color};font-weight:600">${formatDuration(fn.p95)}</td>
      <td>${formatDuration(fn.p99)}</td>
      <td style="color:${errColor}">${fn.errorCount}</td>
      <td><div class="bar"><div class="bar-fill" style="width:${barWidth}%;background:${p95Color}"></div></div></td>
    </tr>`;
  }).join('');

  const qRows = queries.slice(0, 15).map(q => {
    const p95Color = q.p95 > 100 ? '#f85149' : q.p95 > 10 ? '#d29922' : '#3fb950';
    return `<tr>
      <td class="mono" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(q.query)}</td>
      <td>${q.driver}</td>
      <td>${q.calls}</td>
      <td>${formatDuration(q.p50)}</td>
      <td style="color:${p95Color};font-weight:600">${formatDuration(q.p95)}</td>
      <td>${formatDuration(q.totalMs)}</td>
    </tr>`;
  }).join('');

  const errPct = (summary.errorRate * 100).toFixed(1);
  const errColor = summary.errorRate > 0.05 ? '#f85149' : summary.errorRate > 0 ? '#d29922' : '#3fb950';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trickle APM</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0d1117; color:#c9d1d9; }
  .container { max-width:1200px; margin:0 auto; padding:24px; }
  h1 { color:#58a6ff; font-size:22px; margin-bottom:4px; }
  .subtitle { color:#484f58; font-size:13px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:14px; }
  .card .label { color:#8b949e; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
  .card .value { font-size:26px; font-weight:700; margin-top:2px; }
  .section { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:16px; margin-bottom:16px; }
  .section h3 { color:#8b949e; font-size:13px; text-transform:uppercase; margin-bottom:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#484f58; padding:6px 8px; border-bottom:1px solid #21262d; font-weight:500; font-size:11px; text-transform:uppercase; }
  td { padding:6px 8px; border-bottom:1px solid #161b22; }
  .mono { font-family:'SF Mono',Monaco,Consolas,monospace; font-size:12px; }
  .bar { height:6px; background:#21262d; border-radius:3px; overflow:hidden; min-width:60px; }
  .bar-fill { height:100%; border-radius:3px; }
  footer { text-align:center; padding:24px; color:#484f58; font-size:12px; }
  a { color:#58a6ff; text-decoration:none; }
</style>
</head>
<body>
<div class="container">
  <h1>trickle APM</h1>
  <div class="subtitle">Latency percentiles, throughput, and error rates</div>

  <div class="grid">
    <div class="card"><div class="label">Functions</div><div class="value">${summary.totalFunctions}</div></div>
    <div class="card"><div class="label">Total Calls</div><div class="value">${summary.totalCalls}</div></div>
    <div class="card"><div class="label">DB Queries</div><div class="value">${summary.totalQueries}</div></div>
    <div class="card"><div class="label">Errors</div><div class="value" style="color:${errColor}">${summary.totalErrors}</div></div>
    <div class="card"><div class="label">Error Rate</div><div class="value" style="color:${errColor}">${errPct}%</div></div>
    <div class="card"><div class="label">Logs</div><div class="value">${summary.logCount}</div></div>
    ${summary.memoryEndMb > 0 ? `<div class="card"><div class="label">Memory</div><div class="value">${summary.memoryEndMb}MB</div></div>` : ''}
  </div>

  ${functions.length > 0 ? `
  <div class="section">
    <h3>Function Latency</h3>
    <table>
      <thead><tr><th>Function</th><th>Calls</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th><th>Distribution</th></tr></thead>
      <tbody>${fnRows}</tbody>
    </table>
  </div>` : ''}

  ${queries.length > 0 ? `
  <div class="section">
    <h3>Query Performance</h3>
    <table>
      <thead><tr><th>Query</th><th>Driver</th><th>Calls</th><th>p50</th><th>p95</th><th>Total</th></tr></thead>
      <tbody>${qRows}</tbody>
    </table>
  </div>` : ''}
</div>
<footer>Powered by <a href="https://github.com/yiheinchai/trickle">trickle</a> — runtime observability</footer>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function runMetrics(opts: MetricsOptions): void {
  const trickleDir = findTrickleDir(opts.dir);
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return;
  }

  const metrics = computeMetrics(trickleDir);

  // Write metrics.json for agent consumption
  const metricsFile = path.join(trickleDir, 'metrics.json');
  fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2), 'utf-8');

  if (opts.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  if (opts.html) {
    const html = generateMetricsHtml(metrics);
    const port = opts.port || 4322;
    const server = require('http').createServer((_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(port, () => {
      console.log(chalk.green(`  ✓ APM dashboard: http://localhost:${port}`));
      console.log(chalk.gray('  Press Ctrl+C to stop'));
    });
    return;
  }

  printMetrics(metrics);
}
