/**
 * trickle summary — auto-generated post-run summary.
 *
 * After every `trickle run`, generates .trickle/summary.json with a
 * comprehensive snapshot of everything captured. Designed for AI agent
 * consumption — one call to get_last_run_summary replaces 5-10 MCP calls.
 *
 * Combines: function types, errors, queries, alerts, logs, HTTP, memory,
 * performance metrics, and fix recommendations into a single JSON document.
 */

import * as fs from 'fs';
import * as path from 'path';

function readJsonl(fp: string): any[] {
  if (!fp || !fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export interface RunSummary {
  timestamp: string;
  status: 'healthy' | 'warning' | 'critical' | 'error';
  exitCode: number;
  command: string;

  counts: {
    functions: number;
    variables: number;
    queries: number;
    errors: number;
    logs: number;
    httpRequests: number;
    consoleLines: number;
    callTraceEvents: number;
  };

  errors: Array<{
    message: string;
    type?: string;
    file?: string;
    line?: number;
    stack?: string;
  }>;

  alerts: Array<{
    severity: string;
    category: string;
    message: string;
    suggestion?: string;
  }>;

  queries: {
    total: number;
    uniqueQueries: number;
    totalDurationMs: number;
    slowQueries: Array<{ query: string; durationMs: number; driver?: string }>;
    nPlusOnePatterns: Array<{ query: string; count: number }>;
  };

  functions: {
    total: number;
    slowest: Array<{ name: string; module: string; durationMs: number }>;
    signatures: Array<{ name: string; signature: string }>;
  };

  logs: {
    total: number;
    byLevel: Record<string, number>;
    errors: Array<{ message: string; logger?: string; timestamp?: string }>;
  };

  httpRequests: Array<{
    endpoint: string;
    host: string;
    durationMs?: number;
    status?: number;
  }>;

  memory: {
    startMb?: number;
    endMb?: number;
    heapStartMb?: number;
    heapEndMb?: number;
    delta?: number;
  };

  environment: {
    runtime?: string;
    platform?: string;
    frameworks?: string[];
  };

  healPlans: Array<{
    category: string;
    message: string;
    recommendation: string;
    confidence: string;
  }>;

  rootCauses: Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    description: string;
    evidence: string;
    suggestedFix: string;
  }>;
}

/**
 * Derive likely root causes from runtime data.
 */
function deriveRootCauses(
  errors: RunSummary['errors'],
  alerts: any[],
  nPlusOnePatterns: RunSummary['queries']['nPlusOnePatterns'],
  slowQueries: RunSummary['queries']['slowQueries'],
  funcs: any[],
  memory: RunSummary['memory'],
  logs: any[],
): RunSummary['rootCauses'] {
  const causes: RunSummary['rootCauses'] = [];

  // Analyze errors (deduplicate by message)
  const seenErrors = new Set<string>();
  for (const err of errors.slice(0, 5)) {
    if (seenErrors.has(err.message || '')) continue;
    seenErrors.add(err.message || '');
    const msg = err.message || '';
    const type = err.type || 'Error';

    if (msg.includes('not defined') || msg.includes('is not a function')) {
      causes.push({
        severity: 'critical',
        category: 'reference_error',
        description: `${type}: ${msg.substring(0, 100)}`,
        evidence: err.stack ? `at ${err.file || 'unknown'}:${err.line || '?'}` : msg,
        suggestedFix: 'Check for typos in variable/function names, missing imports, or undefined references.',
      });
    } else if (msg.includes('NoneType') || msg.includes('undefined') || msg.includes('null')) {
      causes.push({
        severity: 'critical',
        category: 'null_reference',
        description: `Null/undefined access: ${msg.substring(0, 100)}`,
        evidence: err.stack ? `at ${err.file || 'unknown'}:${err.line || '?'}` : msg,
        suggestedFix: 'Add null check before accessing the value. Check if the database query/API call returned data.',
      });
    } else if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
      causes.push({
        severity: 'critical',
        category: 'connection_error',
        description: `Connection issue: ${msg.substring(0, 100)}`,
        evidence: msg,
        suggestedFix: 'Check if the target service is running, network connectivity, and timeout settings.',
      });
    } else if (type !== 'Error' || msg.length > 0) {
      causes.push({
        severity: 'critical',
        category: 'runtime_error',
        description: `${type}: ${msg.substring(0, 100)}`,
        evidence: err.stack ? `at ${err.file || 'unknown'}:${err.line || '?'}` : msg,
        suggestedFix: `Fix the ${type} in the code at the indicated location.`,
      });
    }
  }

  // Analyze N+1 patterns
  for (const pattern of nPlusOnePatterns.slice(0, 2)) {
    causes.push({
      severity: 'warning',
      category: 'n_plus_one',
      description: `N+1 query: "${pattern.query.substring(0, 60)}" repeated ${pattern.count} times`,
      evidence: `${pattern.count} identical queries detected — likely executed in a loop`,
      suggestedFix: `Replace with a batch query using IN clause or JOIN. Example: SELECT * FROM table WHERE id IN (${Array(Math.min(pattern.count, 3)).fill('?').join(', ')})`,
    });
  }

  // Analyze slow functions
  const verySlowFuncs = funcs.filter(f => f.durationMs > 1000);
  for (const f of verySlowFuncs.slice(0, 2)) {
    causes.push({
      severity: 'warning',
      category: 'slow_function',
      description: `${f.module}.${f.functionName} took ${f.durationMs.toFixed(0)}ms`,
      evidence: `Function duration exceeds 1000ms threshold`,
      suggestedFix: 'Profile this function. Check for blocking I/O, unnecessary computation, or missing caching.',
    });
  }

  // Analyze memory
  if (memory.delta && memory.delta > 100) {
    causes.push({
      severity: 'warning',
      category: 'memory_growth',
      description: `Memory grew by ${memory.delta}MB during execution (${memory.startMb}MB → ${memory.endMb}MB)`,
      evidence: `RSS delta: +${memory.delta}MB`,
      suggestedFix: 'Check for memory leaks — objects accumulating in arrays/maps, unclosed connections, or event listener accumulation.',
    });
  }

  // Analyze error logs
  const errorLogCount = logs.filter((l: any) => {
    const lvl = (l.level || l.levelname || '').toLowerCase();
    return lvl === 'error' || lvl === 'critical' || lvl === 'fatal';
  }).length;
  if (errorLogCount > 0 && errors.length === 0) {
    causes.push({
      severity: 'warning',
      category: 'logged_errors',
      description: `${errorLogCount} error-level log entries detected (errors caught but logged)`,
      evidence: `Error logs without unhandled exceptions — errors are being swallowed`,
      suggestedFix: 'Review error log messages for issues that may need fixing even though they are caught.',
    });
  }

  return causes;
}

/**
 * Generate a comprehensive post-run summary from .trickle/ data files.
 */
export function generateRunSummary(opts: {
  dir?: string;
  exitCode?: number;
  command?: string;
}): RunSummary {
  const trickleDir = opts.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  // Run monitor for fresh alerts (suppress console output)
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

  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const console_out = readJsonl(path.join(trickleDir, 'console.jsonl'));
  const logsRaw = readJsonl(path.join(trickleDir, 'logs.jsonl'));
  const alertsRaw = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
  const traces = readJsonl(path.join(trickleDir, 'traces.jsonl'));

  let env: any = {};
  try {
    const envFile = path.join(trickleDir, 'environment.json');
    if (fs.existsSync(envFile)) env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  } catch {}

  // ── Alerts ──
  const critical = alertsRaw.filter((a: any) => a.severity === 'critical');
  const warnings = alertsRaw.filter((a: any) => a.severity === 'warning');

  const status: RunSummary['status'] =
    critical.length > 0 ? 'critical' :
    warnings.length > 0 ? 'warning' :
    errors.length > 0 ? 'error' :
    'healthy';

  // ── Errors ──
  const errorSummaries = errors.slice(0, 10).map((e: any) => ({
    message: e.message || e.error || String(e),
    type: e.type || e.name,
    file: e.file,
    line: e.line,
    stack: e.stack?.substring(0, 300),
  }));

  // ── Queries ──
  const queryCounts = new Map<string, number>();
  let totalQueryDuration = 0;
  for (const q of queries) {
    const text = (q.query || '').replace(/\s+/g, ' ').trim();
    // Normalize parameterized values for grouping
    const normalized = text.replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?');
    queryCounts.set(normalized, (queryCounts.get(normalized) || 0) + 1);
    totalQueryDuration += q.durationMs || 0;
  }

  const nPlusOnePatterns: RunSummary['queries']['nPlusOnePatterns'] = [];
  for (const [query, count] of queryCounts) {
    if (count >= 3) {
      nPlusOnePatterns.push({ query: query.substring(0, 120), count });
    }
  }
  nPlusOnePatterns.sort((a, b) => b.count - a.count);

  const slowQueries = queries
    .filter((q: any) => q.durationMs > 10)
    .sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, 5)
    .map((q: any) => ({
      query: (q.query || '').substring(0, 120),
      durationMs: Math.round((q.durationMs || 0) * 100) / 100,
      driver: q.driver,
    }));

  // ── Functions ──
  // Deduplicate by module.functionName
  const funcMap = new Map<string, any>();
  for (const f of observations) {
    if (f.functionName) funcMap.set(`${f.module}.${f.functionName}`, f);
  }
  const uniqueFuncs = Array.from(funcMap.values());

  const slowest = uniqueFuncs
    .filter(f => f.durationMs > 0)
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, 5)
    .map(f => ({
      name: f.functionName,
      module: f.module,
      durationMs: Math.round((f.durationMs || 0) * 100) / 100,
    }));

  const signatures = uniqueFuncs.slice(0, 20).map(f => {
    const params = (f.argsType?.elements || [])
      .map((e: any, i: number) => `${f.paramNames?.[i] || `arg${i}`}: ${compactType(e)}`)
      .join(', ');
    return {
      name: `${f.module}.${f.functionName}`,
      signature: `${f.functionName}(${params}) -> ${compactType(f.returnType)}`,
    };
  });

  // ── Logs ──
  const byLevel: Record<string, number> = {};
  for (const log of logsRaw) {
    const level = (log.level || log.levelname || 'unknown').toLowerCase();
    byLevel[level] = (byLevel[level] || 0) + 1;
  }
  const errorLogs = logsRaw
    .filter((l: any) => {
      const lvl = (l.level || l.levelname || '').toLowerCase();
      return lvl === 'error' || lvl === 'critical' || lvl === 'fatal';
    })
    .slice(0, 5)
    .map((l: any) => ({
      message: (l.message || l.msg || '').substring(0, 200),
      logger: l.logger || l.name,
      timestamp: l.timestamp || l.ts,
    }));

  // ── HTTP requests ──
  const httpObs = uniqueFuncs.filter(f =>
    f.functionName.startsWith('GET ') || f.functionName.startsWith('POST ') ||
    f.functionName.startsWith('PUT ') || f.functionName.startsWith('DELETE ') ||
    f.functionName.startsWith('PATCH ')
  );
  const httpRequests = httpObs.slice(0, 10).map(f => ({
    endpoint: f.functionName,
    host: f.module,
    durationMs: f.durationMs,
  }));

  // ── Memory ──
  const startProfile = profile.find((p: any) => p.event === 'start');
  const endProfile = profile.find((p: any) => p.event === 'end');
  const memory: RunSummary['memory'] = {};
  if (startProfile) {
    memory.startMb = Math.round((startProfile.rssKb || 0) / 1024);
    memory.heapStartMb = Math.round((startProfile.heapUsedKb || 0) / 1024);
  }
  if (endProfile) {
    memory.endMb = Math.round((endProfile.rssKb || 0) / 1024);
    memory.heapEndMb = Math.round((endProfile.heapUsedKb || 0) / 1024);
  }
  if (memory.startMb && memory.endMb) {
    memory.delta = memory.endMb - memory.startMb;
  }

  // ── Environment ──
  const environment: RunSummary['environment'] = {
    runtime: env.python ? `Python ${(env.python.version || '').split(' ')[0]}` :
             env.node ? `Node ${env.node.version}` : undefined,
    platform: env.python?.platform || (env.node ? `${env.node.platform}/${env.node.arch}` : undefined),
    frameworks: env.frameworks || [],
  };

  // ── Heal plans ── (suppress console output)
  let healPlans: RunSummary['healPlans'] = [];
  const origLog2 = console.log;
  const origErr2 = console.error;
  try {
    console.log = () => {};
    console.error = () => {};
    const { runHeal } = require('./heal');
    const plans = runHeal({ json: true, dir: trickleDir });
    if (Array.isArray(plans)) {
      healPlans = plans.slice(0, 5).map((p: any) => ({
        category: p.alert?.category || 'unknown',
        message: p.alert?.message || '',
        recommendation: p.recommendation || '',
        confidence: p.confidence || 'low',
      }));
    }
  } catch {} finally {
    console.log = origLog2;
    console.error = origErr2;
  }

  const summary: RunSummary = {
    timestamp: new Date().toISOString(),
    status,
    exitCode: opts.exitCode ?? 0,
    command: opts.command || 'unknown',

    counts: {
      functions: uniqueFuncs.length,
      variables: variables.length,
      queries: queries.length,
      errors: errors.length,
      logs: logsRaw.length,
      httpRequests: httpObs.length,
      consoleLines: console_out.length,
      callTraceEvents: calltrace.length,
    },

    errors: errorSummaries,
    alerts: alertsRaw.slice(0, 10).map((a: any) => ({
      severity: a.severity,
      category: a.category,
      message: a.message,
      suggestion: a.suggestion,
    })),

    queries: {
      total: queries.length,
      uniqueQueries: queryCounts.size,
      totalDurationMs: Math.round(totalQueryDuration * 100) / 100,
      slowQueries,
      nPlusOnePatterns: nPlusOnePatterns.slice(0, 5),
    },

    functions: {
      total: uniqueFuncs.length,
      slowest,
      signatures,
    },

    logs: {
      total: logsRaw.length,
      byLevel,
      errors: errorLogs,
    },

    httpRequests,
    memory,
    environment,
    healPlans,
    rootCauses: deriveRootCauses(errorSummaries, alertsRaw, nPlusOnePatterns, slowQueries, uniqueFuncs, memory, logsRaw),
  };

  return summary;
}

/**
 * Generate summary and write to .trickle/summary.json.
 */
export function writeRunSummary(opts: {
  dir?: string;
  exitCode?: number;
  command?: string;
}): RunSummary {
  const trickleDir = opts.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const summary = generateRunSummary(opts);

  try {
    if (!fs.existsSync(trickleDir)) fs.mkdirSync(trickleDir, { recursive: true });
    fs.writeFileSync(
      path.join(trickleDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
  } catch {}

  return summary;
}

// Compact type printer (simplified version of MCP server's typeNodeToCompact)
function compactType(node: any): string {
  if (!node) return 'unknown';
  switch (node.kind) {
    case 'primitive': return node.name || 'unknown';
    case 'object': {
      if (node.class_name) return node.class_name;
      if (!node.properties) return '{}';
      const props = Object.entries(node.properties).slice(0, 4)
        .map(([k, v]) => `${k}: ${compactType(v)}`);
      const extra = Object.keys(node.properties).length > 4 ? ', ...' : '';
      return `{ ${props.join(', ')}${extra} }`;
    }
    case 'array': return `${compactType(node.element || { kind: 'primitive', name: 'unknown' })}[]`;
    case 'tuple': return `[${(node.elements || []).map(compactType).join(', ')}]`;
    case 'union': return (node.elements || []).map(compactType).join(' | ');
    default: return node.kind;
  }
}
