/**
 * trickle metrics --prometheus — expose trickle data as Prometheus metrics.
 *
 * Starts an HTTP endpoint at /metrics that returns Prometheus text format.
 * Scrape with Prometheus, visualize in Grafana.
 *
 * Usage:
 *   trickle metrics --prometheus              # start on port 9464
 *   trickle metrics --prometheus --port 9090  # custom port
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function generatePrometheusMetrics(): string {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  if (!fs.existsSync(dir)) return '# No trickle data found\n';

  const observations = readJsonl(path.join(dir, 'observations.jsonl'));
  const queries = readJsonl(path.join(dir, 'queries.jsonl'));
  const errors = readJsonl(path.join(dir, 'errors.jsonl'));
  const logs = readJsonl(path.join(dir, 'logs.jsonl'));
  const alerts = readJsonl(path.join(dir, 'alerts.jsonl'));
  const profile = readJsonl(path.join(dir, 'profile.jsonl'));
  const calltrace = readJsonl(path.join(dir, 'calltrace.jsonl'));

  const lines: string[] = [];

  // Function metrics
  const funcMap = new Map<string, { count: number; maxMs: number; totalMs: number }>();
  for (const o of observations) {
    const key = `${o.module}.${o.functionName}`;
    const existing = funcMap.get(key) || { count: 0, maxMs: 0, totalMs: 0 };
    existing.count++;
    existing.maxMs = Math.max(existing.maxMs, o.durationMs || 0);
    existing.totalMs += o.durationMs || 0;
    funcMap.set(key, existing);
  }

  lines.push('# HELP trickle_functions_total Total number of observed function calls');
  lines.push('# TYPE trickle_functions_total counter');
  for (const [name, data] of funcMap) {
    const [mod, fn] = name.includes('.') ? [name.split('.')[0], name.split('.').slice(1).join('.')] : ['', name];
    lines.push(`trickle_functions_total{function="${fn}",module="${mod}"} ${data.count}`);
  }

  lines.push('# HELP trickle_function_duration_max_ms Maximum function duration in milliseconds');
  lines.push('# TYPE trickle_function_duration_max_ms gauge');
  for (const [name, data] of funcMap) {
    if (data.maxMs > 0) {
      const [mod, fn] = name.includes('.') ? [name.split('.')[0], name.split('.').slice(1).join('.')] : ['', name];
      lines.push(`trickle_function_duration_max_ms{function="${fn}",module="${mod}"} ${data.maxMs.toFixed(2)}`);
    }
  }

  // Query metrics
  lines.push('# HELP trickle_queries_total Total number of database queries');
  lines.push('# TYPE trickle_queries_total counter');
  lines.push(`trickle_queries_total ${queries.length}`);

  const queryDurations = queries.map(q => q.durationMs || 0);
  if (queryDurations.length > 0) {
    lines.push('# HELP trickle_query_duration_max_ms Maximum query duration');
    lines.push('# TYPE trickle_query_duration_max_ms gauge');
    lines.push(`trickle_query_duration_max_ms ${Math.max(...queryDurations).toFixed(2)}`);

    lines.push('# HELP trickle_query_duration_avg_ms Average query duration');
    lines.push('# TYPE trickle_query_duration_avg_ms gauge');
    lines.push(`trickle_query_duration_avg_ms ${(queryDurations.reduce((a, b) => a + b, 0) / queryDurations.length).toFixed(2)}`);
  }

  // N+1 detection
  const queryCounts = new Map<string, number>();
  for (const q of queries) {
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?');
    queryCounts.set(norm, (queryCounts.get(norm) || 0) + 1);
  }
  const nPlusOne = Array.from(queryCounts.entries()).filter(([, c]) => c >= 3);
  lines.push('# HELP trickle_n_plus_one_patterns Number of N+1 query patterns detected');
  lines.push('# TYPE trickle_n_plus_one_patterns gauge');
  lines.push(`trickle_n_plus_one_patterns ${nPlusOne.length}`);

  // Errors
  lines.push('# HELP trickle_errors_total Total number of errors');
  lines.push('# TYPE trickle_errors_total counter');
  lines.push(`trickle_errors_total ${errors.length}`);

  // Logs by level
  const logLevels = new Map<string, number>();
  for (const l of logs) {
    const level = (l.level || l.levelname || 'info').toLowerCase();
    logLevels.set(level, (logLevels.get(level) || 0) + 1);
  }
  lines.push('# HELP trickle_logs_total Total log entries by level');
  lines.push('# TYPE trickle_logs_total counter');
  for (const [level, count] of logLevels) {
    lines.push(`trickle_logs_total{level="${level}"} ${count}`);
  }

  // Alerts
  const alertsBySev = new Map<string, number>();
  for (const a of alerts) {
    alertsBySev.set(a.severity, (alertsBySev.get(a.severity) || 0) + 1);
  }
  lines.push('# HELP trickle_alerts_total Total alerts by severity');
  lines.push('# TYPE trickle_alerts_total gauge');
  for (const [sev, count] of alertsBySev) {
    lines.push(`trickle_alerts_total{severity="${sev}"} ${count}`);
  }

  // Memory
  const endProfile = profile.find(p => p.event === 'end');
  if (endProfile) {
    lines.push('# HELP trickle_memory_rss_mb RSS memory in megabytes');
    lines.push('# TYPE trickle_memory_rss_mb gauge');
    lines.push(`trickle_memory_rss_mb ${Math.round((endProfile.rssKb || 0) / 1024)}`);
  }

  // Call trace depth
  if (calltrace.length > 0) {
    const maxDepth = Math.max(...calltrace.map((c: any) => c.depth || 0));
    lines.push('# HELP trickle_call_depth_max Maximum call stack depth');
    lines.push('# TYPE trickle_call_depth_max gauge');
    lines.push(`trickle_call_depth_max ${maxDepth}`);
  }

  return lines.join('\n') + '\n';
}

export function startPrometheusServer(port: number = 9464): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics' || req.url === '/') {
      const metrics = generatePrometheusMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics);
    } else {
      res.writeHead(404);
      res.end('Not found. Use /metrics');
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log(chalk.bold('  trickle metrics --prometheus'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  Prometheus endpoint: ${chalk.cyan(`http://localhost:${port}/metrics`)}`);
    console.log(chalk.gray('  Add to prometheus.yml:'));
    console.log(chalk.gray(`    - job_name: trickle`));
    console.log(chalk.gray(`      static_configs:`));
    console.log(chalk.gray(`        - targets: ['localhost:${port}']`));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log('');
  });
}

export { generatePrometheusMetrics };
