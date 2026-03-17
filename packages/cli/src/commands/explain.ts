/**
 * trickle explain <file> — runtime-powered codebase understanding.
 *
 * Shows everything an AI agent needs to understand a file:
 * - Functions with runtime signatures and sample I/O
 * - Call graph: who calls this file's functions, what they call
 * - Database queries triggered by this file's code
 * - Variables with runtime values
 * - Errors that occurred in this file
 * - Relevant logs and alerts
 *
 * Designed for AI agents that need to understand unfamiliar code quickly.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export interface ExplainResult {
  file: string;
  exists: boolean;
  sourceLines?: number;

  functions: Array<{
    name: string;
    module: string;
    signature: string;
    durationMs?: number;
    callCount: number;
    sampleInput?: unknown;
    sampleOutput?: unknown;
  }>;

  callGraph: {
    callers: Array<{ caller: string; callee: string; callCount: number }>;
    callees: Array<{ caller: string; callee: string; callCount: number }>;
  };

  dataFlow: Array<{
    function: string;
    inputs: string;
    output: string;
    sampleInput?: unknown;
    sampleOutput?: unknown;
  }>;

  variables: Array<{
    name: string;
    line: number;
    type: string;
    value: unknown;
  }>;

  queries: Array<{
    query: string;
    durationMs: number;
    driver?: string;
    triggeredBy?: string;
  }>;

  errors: Array<{
    message: string;
    type?: string;
    line?: number;
    stack?: string;
  }>;

  logs: Array<{
    level: string;
    message: string;
    logger?: string;
  }>;

  alerts: Array<{
    severity: string;
    category: string;
    message: string;
    suggestion?: string;
  }>;

  summary: string;
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

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
    default: return node.kind || 'unknown';
  }
}

function moduleMatchesFile(module: string, targetFile: string): boolean {
  const baseName = path.basename(targetFile).replace(/\.[^.]+$/, '');
  // Match module name against file basename (e.g., "app" matches "app.js")
  return module === baseName ||
    module === targetFile ||
    module.endsWith('/' + baseName) ||
    module.endsWith('.' + baseName);
}

function filePathMatches(filePath: string, targetFile: string): boolean {
  if (!filePath) return false;
  const norm = targetFile.replace(/^\.\//, '');
  const rel = path.relative(process.cwd(), filePath);
  return rel === norm || rel.includes(norm) || filePath.includes(norm);
}

export function explain(targetFile: string, opts?: { dir?: string }): ExplainResult {
  const trickleDir = opts?.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const absPath = path.resolve(targetFile);
  const relPath = path.relative(process.cwd(), absPath);

  const result: ExplainResult = {
    file: relPath,
    exists: fs.existsSync(absPath),
    functions: [],
    callGraph: { callers: [], callees: [] },
    dataFlow: [],
    variables: [],
    queries: [],
    errors: [],
    logs: [],
    alerts: [],
    summary: '',
  };

  if (result.exists) {
    result.sourceLines = fs.readFileSync(absPath, 'utf-8').split('\n').length;
  }

  // ── Functions ──
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const fileFuncs = new Map<string, { obs: any; count: number }>();

  // Check if the source file defines Express routes (app.get, router.post, etc.)
  let hasExpressRoutes = false;
  if (result.exists) {
    const src = fs.readFileSync(absPath, 'utf-8');
    // Detect Express routes (app.get("/path")) or FastAPI routes (@app.get("/path"))
    hasExpressRoutes = /\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`\/]/.test(src) ||
      /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"`\/]/.test(src);
  }

  for (const obs of observations) {
    if (!obs.functionName) continue;
    // Match by module name, OR include HTTP route handlers if file defines them
    // Express uses module "express", FastAPI/uvicorn uses IP address or hostname
    const isHttpRoute = /^(GET|POST|PUT|DELETE|PATCH)\s/.test(obs.functionName);
    const isMatch = moduleMatchesFile(obs.module, targetFile) ||
      (hasExpressRoutes && isHttpRoute);
    if (isMatch) {
      const key = `${obs.module}.${obs.functionName}`;
      const existing = fileFuncs.get(key);
      if (existing) {
        existing.count++;
        if (obs.durationMs && (!existing.obs.durationMs || obs.durationMs > existing.obs.durationMs)) {
          existing.obs = obs;
        }
      } else {
        fileFuncs.set(key, { obs, count: 1 });
      }
    }
  }

  for (const [key, { obs, count }] of fileFuncs) {
    const params = (obs.argsType?.elements || [])
      .map((e: any, i: number) => `${obs.paramNames?.[i] || `arg${i}`}: ${compactType(e)}`)
      .join(', ');
    result.functions.push({
      name: obs.functionName,
      module: obs.module,
      signature: `${obs.functionName}(${params}) -> ${compactType(obs.returnType)}`,
      durationMs: obs.durationMs ? Math.round(obs.durationMs * 100) / 100 : undefined,
      callCount: count,
      sampleInput: obs.sampleInput,
      sampleOutput: obs.sampleOutput,
    });

    // Data flow: what types flow in and out
    const inputTypes = params || 'none';
    const outputType = compactType(obs.returnType);
    if (inputTypes !== 'none' || outputType !== 'unknown') {
      result.dataFlow.push({
        function: obs.functionName,
        inputs: inputTypes || 'none',
        output: outputType,
        sampleInput: obs.sampleInput,
        sampleOutput: obs.sampleOutput,
      });
    }
  }

  // ── Call Graph ──
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const callEvents = calltrace.filter((e: any) => e.kind === 'call');

  // Build callId -> event map
  const byCallId = new Map<number, any>();
  for (const ev of callEvents) {
    byCallId.set(ev.callId, ev);
  }

  // Find callers (who calls functions in this file)
  const callerCounts = new Map<string, number>();
  const calleeCounts = new Map<string, number>();

  for (const ev of callEvents) {
    const isInFile = moduleMatchesFile(ev.module, targetFile);
    const parent = byCallId.get(ev.parentId);

    if (isInFile && parent) {
      // Someone calls a function in this file
      const key = `${parent.module}.${parent.function} -> ${ev.module}.${ev.function}`;
      callerCounts.set(key, (callerCounts.get(key) || 0) + 1);
    }

    if (parent && moduleMatchesFile(parent.module, targetFile) && !isInFile) {
      // This file's function calls something outside
      const key = `${parent.module}.${parent.function} -> ${ev.module}.${ev.function}`;
      calleeCounts.set(key, (calleeCounts.get(key) || 0) + 1);
    }
  }

  for (const [key, count] of callerCounts) {
    const [caller, callee] = key.split(' -> ');
    result.callGraph.callers.push({ caller, callee, callCount: count });
  }
  for (const [key, count] of calleeCounts) {
    const [caller, callee] = key.split(' -> ');
    result.callGraph.callees.push({ caller, callee, callCount: count });
  }

  // Also find intra-file calls
  for (const ev of callEvents) {
    const isInFile = moduleMatchesFile(ev.module, targetFile);
    const parent = byCallId.get(ev.parentId);
    if (isInFile && parent && moduleMatchesFile(parent.module, targetFile)) {
      const key = `${parent.module}.${parent.function} -> ${ev.module}.${ev.function}`;
      if (!callerCounts.has(key)) {
        result.callGraph.callers.push({ caller: `${parent.module}.${parent.function}`, callee: `${ev.module}.${ev.function}`, callCount: 1 });
      }
    }
  }

  // ── Variables ──
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
  const seen = new Set<string>();
  for (const v of variables) {
    if (!v.file || !filePathMatches(v.file, targetFile)) continue;
    const key = `${v.varName}:${v.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.variables.push({
      name: v.varName,
      line: v.line,
      type: compactType(v.type),
      value: v.sample,
    });
  }
  result.variables.sort((a, b) => a.line - b.line);

  // ── Queries ──
  // All queries are captured globally; try to associate with this file's functions
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const fileFuncNames = new Set(result.functions.map(f => f.name));

  // If this file has functions, show all queries (they likely relate)
  // In the future, we could trace query -> caller relationship more precisely
  if (fileFuncNames.size > 0 && queries.length > 0) {
    const queryCounts = new Map<string, { q: any; count: number }>();
    for (const q of queries) {
      const text = (q.query || '').replace(/\s+/g, ' ').trim();
      const normalized = text.replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?');
      const existing = queryCounts.get(normalized);
      if (existing) {
        existing.count++;
      } else {
        queryCounts.set(normalized, { q, count: 1 });
      }
    }
    for (const [normalized, { q, count }] of queryCounts) {
      result.queries.push({
        query: normalized.substring(0, 200),
        durationMs: Math.round((q.durationMs || 0) * 100) / 100,
        driver: q.driver,
      });
    }
  }

  // ── Errors ──
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  for (const e of errors) {
    // Match errors by file or by module
    if (filePathMatches(e.file || '', targetFile) ||
        moduleMatchesFile(e.module || '', targetFile)) {
      result.errors.push({
        message: (e.message || e.error || String(e)).substring(0, 300),
        type: e.type || e.name,
        line: e.line,
        stack: e.stack?.substring(0, 500),
      });
    }
  }

  // Also check calltrace for errors from this file's functions
  for (const ev of callEvents) {
    if (ev.error && moduleMatchesFile(ev.module, targetFile)) {
      const alreadyExists = result.errors.some(e => e.message.includes(ev.error));
      if (!alreadyExists) {
        result.errors.push({
          message: ev.error.substring(0, 300),
          type: 'RuntimeError',
        });
      }
    }
  }

  // ── Logs ──
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));
  for (const log of logs) {
    if (filePathMatches(log.file || log.pathname || '', targetFile) ||
        moduleMatchesFile(log.module || log.name || log.logger || '', targetFile)) {
      result.logs.push({
        level: (log.level || log.levelname || 'info').toLowerCase(),
        message: (log.message || log.msg || '').substring(0, 200),
        logger: log.logger || log.name,
      });
    }
  }

  // ── Alerts ──
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

  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  // Show alerts relevant to this file (or all if the file has DB functions)
  for (const a of alerts) {
    if (fileFuncNames.has(a.details?.function) ||
        moduleMatchesFile(a.details?.module || '', targetFile) ||
        (fileFuncNames.size > 0 && (a.category === 'n_plus_one' || a.category === 'slow_query'))) {
      result.alerts.push({
        severity: a.severity,
        category: a.category,
        message: a.message,
        suggestion: a.suggestion,
      });
    }
  }

  // ── Summary ──
  const parts: string[] = [];
  parts.push(`${result.functions.length} functions observed`);
  if (result.variables.length > 0) parts.push(`${result.variables.length} variables`);
  if (result.queries.length > 0) parts.push(`${result.queries.length} unique queries`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);
  if (result.dataFlow.length > 0) parts.push(`${result.dataFlow.length} data flows`);
  if (result.callGraph.callers.length > 0) parts.push(`${result.callGraph.callers.length} callers`);
  if (result.callGraph.callees.length > 0) parts.push(`${result.callGraph.callees.length} callees`);
  if (result.alerts.length > 0) parts.push(`${result.alerts.length} alerts`);
  result.summary = parts.join(', ');

  return result;
}

export interface ExplainOptions {
  json?: boolean;
  file: string;
}

export function runExplain(opts: ExplainOptions): ExplainResult {
  const result = explain(opts.file);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold(`  trickle explain ${result.file}`));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (!result.exists) {
    console.log(chalk.yellow(`  File not found: ${result.file}`));
  } else {
    console.log(chalk.gray(`  ${result.sourceLines} lines`));
  }

  // Functions
  if (result.functions.length > 0) {
    console.log('');
    console.log(chalk.bold('  Functions:'));
    for (const f of result.functions) {
      const timing = f.durationMs ? chalk.gray(` (${f.durationMs}ms)`) : '';
      const count = f.callCount > 1 ? chalk.gray(` ×${f.callCount}`) : '';
      console.log(`  ${chalk.green('→')} ${f.signature}${timing}${count}`);
    }
  }

  // Data flow
  if (result.dataFlow.length > 0) {
    console.log('');
    console.log(chalk.bold('  Data Flow:'));
    for (const df of result.dataFlow.slice(0, 10)) {
      const sampleIn = df.sampleInput ? chalk.gray(` e.g. ${JSON.stringify(df.sampleInput)?.substring(0, 50)}`) : '';
      const sampleOut = df.sampleOutput ? chalk.gray(` e.g. ${JSON.stringify(df.sampleOutput)?.substring(0, 50)}`) : '';
      console.log(`    ${chalk.cyan(df.function)}: (${df.inputs}) → ${df.output}`);
      if (sampleIn) console.log(chalk.gray(`      in: ${JSON.stringify(df.sampleInput)?.substring(0, 60)}`));
      if (sampleOut) console.log(chalk.gray(`      out: ${JSON.stringify(df.sampleOutput)?.substring(0, 60)}`));
    }
  }

  // Call graph
  if (result.callGraph.callers.length > 0 || result.callGraph.callees.length > 0) {
    console.log('');
    console.log(chalk.bold('  Call Graph:'));
    if (result.callGraph.callers.length > 0) {
      console.log(chalk.gray('  Callers (who calls this file):'));
      for (const c of result.callGraph.callers.slice(0, 10)) {
        const count = c.callCount > 1 ? chalk.gray(` ×${c.callCount}`) : '';
        console.log(`    ${c.caller} → ${chalk.cyan(c.callee)}${count}`);
      }
    }
    if (result.callGraph.callees.length > 0) {
      console.log(chalk.gray('  Callees (what this file calls):'));
      for (const c of result.callGraph.callees.slice(0, 10)) {
        const count = c.callCount > 1 ? chalk.gray(` ×${c.callCount}`) : '';
        console.log(`    ${chalk.cyan(c.caller)} → ${c.callee}${count}`);
      }
    }
  }

  // Variables
  if (result.variables.length > 0) {
    console.log('');
    console.log(chalk.bold('  Variables:'));
    for (const v of result.variables.slice(0, 15)) {
      const val = typeof v.value === 'string' ? `"${v.value.substring(0, 40)}"` :
        JSON.stringify(v.value)?.substring(0, 50) || '?';
      console.log(`    L${v.line} ${chalk.yellow(v.name)}: ${chalk.gray(v.type)} = ${val}`);
    }
    if (result.variables.length > 15) {
      console.log(chalk.gray(`    ... and ${result.variables.length - 15} more`));
    }
  }

  // Queries
  if (result.queries.length > 0) {
    console.log('');
    console.log(chalk.bold('  Database Queries:'));
    for (const q of result.queries.slice(0, 10)) {
      const driver = q.driver ? chalk.gray(`[${q.driver}]`) : '';
      console.log(`    ${driver} ${q.query.substring(0, 80)}`);
    }
  }

  // Errors
  if (result.errors.length > 0) {
    console.log('');
    console.log(chalk.bold('  Errors:'));
    for (const e of result.errors.slice(0, 5)) {
      const loc = e.line ? chalk.gray(`:${e.line}`) : '';
      console.log(`  ${chalk.red('✗')} ${e.message.split('\n')[0].substring(0, 80)}${loc}`);
    }
  }

  // Alerts
  if (result.alerts.length > 0) {
    console.log('');
    console.log(chalk.bold('  Alerts:'));
    for (const a of result.alerts.slice(0, 5)) {
      const icon = a.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`    ${icon} ${a.message}`);
      if (a.suggestion) console.log(chalk.gray(`      Fix: ${a.suggestion.substring(0, 80)}`));
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray(`  ${result.summary}`));
  console.log('');

  return result;
}
