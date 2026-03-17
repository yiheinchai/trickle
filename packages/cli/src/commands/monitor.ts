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
  webhook?: string;
  watch?: boolean;
  rulesFile?: string;
}

// ── Rules engine ──

interface Rule {
  name: string;
  category: string;
  enabled: boolean;
  severity?: 'critical' | 'warning' | 'info';
  threshold?: Record<string, number>;
  criticalThreshold?: Record<string, number>;
  pattern?: string;
  message?: string;
}

interface RulesConfig {
  rules: Rule[];
}

const DEFAULT_RULES: RulesConfig = {
  rules: [
    {
      name: "Slow queries",
      category: "slow_query",
      enabled: true,
      threshold: { durationMs: 100 },
      severity: "warning",
      criticalThreshold: { durationMs: 500 },
    },
    {
      name: "N+1 queries",
      category: "n_plus_one",
      enabled: true,
      threshold: { count: 5 },
      severity: "warning",
      criticalThreshold: { count: 10 },
    },
    {
      name: "Slow functions",
      category: "slow_function",
      enabled: true,
      threshold: { durationMs: 1000 },
      severity: "warning",
      criticalThreshold: { durationMs: 5000 },
    },
    {
      name: "Memory usage",
      category: "memory",
      enabled: true,
      threshold: { maxMb: 512 },
      severity: "warning",
      criticalThreshold: { maxMb: 1024 },
    },
    {
      name: "Errors",
      category: "error",
      enabled: true,
      threshold: { count: 1 },
      severity: "warning",
      criticalThreshold: { count: 3 },
    },
    {
      name: "Deep call stack",
      category: "deep_call_stack",
      enabled: true,
      threshold: { maxDepth: 10 },
      severity: "warning",
      criticalThreshold: { maxDepth: 20 },
    },
    {
      name: "Total query count",
      category: "query_count",
      enabled: false,
      threshold: { maxQueries: 100 },
      severity: "warning",
      message: "Too many queries in a single run — consider batching or caching",
    },
    {
      name: "SELECT * detection",
      category: "query_pattern",
      enabled: false,
      pattern: "SELECT \\*",
      severity: "info",
      message: "Avoid SELECT * — select specific columns for better performance",
    },
  ],
};

function loadRules(trickleDir: string, rulesFile?: string): RulesConfig {
  const filePath = rulesFile || path.join(trickleDir, 'rules.json');
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw.rules && Array.isArray(raw.rules)) {
        return raw;
      }
    }
  } catch {}
  return DEFAULT_RULES;
}

function getRuleThreshold(rules: RulesConfig, category: string, key: string, fallback: number): number {
  const rule = rules.rules.find(r => r.category === category && r.enabled !== false);
  if (rule?.threshold?.[key] !== undefined) return rule.threshold[key];
  return fallback;
}

function getRuleCriticalThreshold(rules: RulesConfig, category: string, key: string, fallback: number): number {
  const rule = rules.rules.find(r => r.category === category && r.enabled !== false);
  if (rule?.criticalThreshold?.[key] !== undefined) return rule.criticalThreshold[key];
  return fallback;
}

function isRuleEnabled(rules: RulesConfig, category: string): boolean {
  const rule = rules.rules.find(r => r.category === category);
  return rule ? rule.enabled !== false : true;
}

export function initRules(dir?: string): void {
  const trickleDir = findTrickleDir(dir);
  fs.mkdirSync(trickleDir, { recursive: true });
  const filePath = path.join(trickleDir, 'rules.json');

  if (fs.existsSync(filePath)) {
    console.log(chalk.yellow(`  Rules file already exists: ${filePath}`));
    console.log(chalk.gray('  Edit it to customize thresholds and enable/disable rules.'));
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_RULES, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(chalk.green(`  ✓ Created ${path.relative(process.cwd(), filePath)}`));
  console.log('');
  console.log(chalk.gray('  Customize thresholds by editing the file:'));
  console.log(chalk.gray('    - slow_query.threshold.durationMs: 100ms (warning), 500ms (critical)'));
  console.log(chalk.gray('    - n_plus_one.threshold.count: 5 (warning), 10 (critical)'));
  console.log(chalk.gray('    - slow_function.threshold.durationMs: 1000ms'));
  console.log(chalk.gray('    - memory.threshold.maxMb: 512MB'));
  console.log(chalk.gray('    - Enable query_count or query_pattern rules for stricter checks'));
  console.log('');
  console.log(chalk.gray('  Run `trickle monitor` to apply rules, or `trickle rules list` to view them.'));
  console.log('');
}

export function listRules(dir?: string): void {
  const trickleDir = findTrickleDir(dir);
  const rules = loadRules(trickleDir);
  const hasCustomFile = fs.existsSync(path.join(trickleDir, 'rules.json'));

  console.log('');
  console.log(chalk.bold('  trickle rules'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray(`  Source: ${hasCustomFile ? '.trickle/rules.json' : 'built-in defaults'}`));
  console.log('');

  for (const rule of rules.rules) {
    const status = rule.enabled !== false ? chalk.green('✓') : chalk.gray('○');
    const sev = rule.severity === 'critical' ? chalk.red(rule.severity) :
      rule.severity === 'warning' ? chalk.yellow(rule.severity) :
      chalk.blue(rule.severity || 'warning');

    let thresholdStr = '';
    if (rule.threshold) {
      thresholdStr = Object.entries(rule.threshold).map(([k, v]) => `${k}=${v}`).join(', ');
    }
    if (rule.pattern) {
      thresholdStr = `pattern: /${rule.pattern}/`;
    }
    if (rule.criticalThreshold) {
      thresholdStr += ` | critical: ${Object.entries(rule.criticalThreshold).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    }

    console.log(`  ${status} ${chalk.bold(rule.name)} [${sev}]`);
    console.log(chalk.gray(`    ${rule.category} — ${thresholdStr}`));
    if (rule.message) console.log(chalk.gray(`    "${rule.message}"`));
  }

  console.log('');
  if (!hasCustomFile) {
    console.log(chalk.gray('  Run `trickle rules init` to create a customizable rules file.'));
    console.log('');
  }
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

function analyzeQueries(trickleDir: string, slowThreshold: number, rules: RulesConfig): Alert[] {
  const alerts: Alert[] = [];
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl')) as any[];

  // Slow query detection
  if (isRuleEnabled(rules, 'slow_query')) {
    const threshold = getRuleThreshold(rules, 'slow_query', 'durationMs', slowThreshold);
    const critThreshold = getRuleCriticalThreshold(rules, 'slow_query', 'durationMs', threshold * 5);
    const slowQueries = queries.filter(q => q.durationMs > threshold);
    for (const q of slowQueries.slice(0, 5)) {
      alerts.push({
        kind: 'alert',
        severity: q.durationMs > critThreshold ? 'critical' : 'warning',
        category: 'slow_query',
        message: `Slow ${q.driver || 'SQL'} query: ${q.durationMs.toFixed(1)}ms`,
        details: { query: q.query, durationMs: q.durationMs, driver: q.driver },
        timestamp: q.timestamp || Date.now(),
        suggestion: `Optimize this query or add an index. Query: ${q.query?.substring(0, 100)}`,
      });
    }
  }

  // N+1 pattern detection
  if (isRuleEnabled(rules, 'n_plus_one')) {
    const n1Threshold = getRuleThreshold(rules, 'n_plus_one', 'count', 5);
    const n1CritThreshold = getRuleCriticalThreshold(rules, 'n_plus_one', 'count', 10);
    const queryCounts = new Map<string, number>();
    const skipPatterns = /^(PRAGMA|CREATE |ALTER |DROP |INSERT INTO|BEGIN|COMMIT|ROLLBACK)/i;
    for (const q of queries) {
      const key = q.query?.substring(0, 100);
      if (key && !skipPatterns.test(key)) queryCounts.set(key, (queryCounts.get(key) || 0) + 1);
    }
    for (const [query, count] of queryCounts) {
      if (count >= n1Threshold) {
        alerts.push({
          kind: 'alert',
          severity: count >= n1CritThreshold ? 'critical' : 'warning',
          category: 'n_plus_one',
          message: `N+1 query pattern: "${query.substring(0, 60)}" executed ${count} times`,
          details: { query, executionCount: count },
          timestamp: Date.now(),
          suggestion: `Use a JOIN or batch query instead of executing "${query.substring(0, 40)}" in a loop.`,
        });
      }
    }
  }

  // Total query count check
  if (isRuleEnabled(rules, 'query_count')) {
    const maxQueries = getRuleThreshold(rules, 'query_count', 'maxQueries', 100);
    if (queries.length > maxQueries) {
      const rule = rules.rules.find(r => r.category === 'query_count');
      alerts.push({
        kind: 'alert',
        severity: 'warning',
        category: 'query_count',
        message: `${queries.length} queries executed (limit: ${maxQueries})`,
        details: { count: queries.length, limit: maxQueries },
        timestamp: Date.now(),
        suggestion: rule?.message || 'Consider batching or caching queries to reduce total count.',
      });
    }
  }

  // Custom query pattern detection
  const patternRules = rules.rules.filter(r => r.category === 'query_pattern' && r.enabled !== false && r.pattern);
  for (const rule of patternRules) {
    try {
      const regex = new RegExp(rule.pattern!, 'i');
      const matching = queries.filter(q => q.query && regex.test(q.query));
      if (matching.length > 0) {
        alerts.push({
          kind: 'alert',
          severity: rule.severity || 'info',
          category: 'query_pattern',
          message: `${rule.name}: ${matching.length} query(ies) match pattern /${rule.pattern}/`,
          details: { pattern: rule.pattern, count: matching.length, sampleQuery: matching[0].query?.substring(0, 100) },
          timestamp: Date.now(),
          suggestion: rule.message || `Review queries matching /${rule.pattern}/`,
        });
      }
    } catch {}
  }

  return alerts;
}

function analyzeErrors(trickleDir: string, rules: RulesConfig): Alert[] {
  if (!isRuleEnabled(rules, 'error')) return [];
  const alerts: Alert[] = [];
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl')) as any[];
  const critThreshold = getRuleCriticalThreshold(rules, 'error', 'count', 3);

  if (errors.length > 0) {
    const byType = new Map<string, any[]>();
    for (const e of errors) {
      const type = e.type || e.error || 'Unknown';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(e);
    }

    for (const [type, errs] of byType) {
      alerts.push({
        kind: 'alert',
        severity: errs.length >= critThreshold ? 'critical' : 'warning',
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

function analyzeMemory(trickleDir: string, thresholdMb: number, rules: RulesConfig): Alert[] {
  if (!isRuleEnabled(rules, 'memory')) return [];
  const alerts: Alert[] = [];
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl')) as any[];

  const start = profile.find(p => p.event === 'start');
  const end = profile.find(p => p.event === 'end');

  if (start && end && start.rssKb && end.rssKb) {
    const startMb = start.rssKb / 1024;
    const endMb = end.rssKb / 1024;
    const growthMb = endMb - startMb;

    const memThreshold = getRuleThreshold(rules, 'memory', 'maxMb', thresholdMb);
    const memCritThreshold = getRuleCriticalThreshold(rules, 'memory', 'maxMb', memThreshold * 2);

    if (endMb > memThreshold) {
      alerts.push({
        kind: 'alert',
        severity: endMb > memCritThreshold ? 'critical' : 'warning',
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

function analyzeFunctions(trickleDir: string, slowThreshold: number, rules: RulesConfig): Alert[] {
  if (!isRuleEnabled(rules, 'slow_function')) return [];
  const alerts: Alert[] = [];
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl')) as any[];

  const fnThreshold = getRuleThreshold(rules, 'slow_function', 'durationMs', slowThreshold);
  const fnCritThreshold = getRuleCriticalThreshold(rules, 'slow_function', 'durationMs', fnThreshold * 5);

  const slowFuncs = observations.filter(o => o.durationMs && o.durationMs > fnThreshold);
  for (const fn of slowFuncs.slice(0, 5)) {
    alerts.push({
      kind: 'alert',
      severity: fn.durationMs > fnCritThreshold ? 'critical' : 'warning',
      category: 'slow_function',
      message: `Slow function: ${fn.functionName} took ${fn.durationMs.toFixed(1)}ms`,
      details: { function: fn.functionName, module: fn.module, durationMs: fn.durationMs },
      timestamp: Date.now(),
      suggestion: `Profile ${fn.functionName} in ${fn.module} — it took ${fn.durationMs.toFixed(0)}ms.`,
    });
  }

  return alerts;
}

function analyzeCallTrace(trickleDir: string, rules: RulesConfig): Alert[] {
  if (!isRuleEnabled(rules, 'deep_call_stack')) return [];
  const alerts: Alert[] = [];
  const trace = readJsonl(path.join(trickleDir, 'calltrace.jsonl')) as any[];

  const depthThreshold = getRuleThreshold(rules, 'deep_call_stack', 'maxDepth', 10);
  const depthCritThreshold = getRuleCriticalThreshold(rules, 'deep_call_stack', 'maxDepth', 20);

  const maxDepth = Math.max(0, ...trace.map((t: any) => t.depth || 0));
  if (maxDepth > depthThreshold) {
    alerts.push({
      kind: 'alert',
      severity: maxDepth > depthCritThreshold ? 'critical' : 'warning',
      category: 'deep_call_stack',
      message: `Deep call stack detected: max depth ${maxDepth}`,
      details: { maxDepth },
      timestamp: Date.now(),
      suggestion: `Call stack reaches depth ${maxDepth}. Check for recursion or overly nested function calls.`,
    });
  }

  return alerts;
}

function analyzeLlmCalls(trickleDir: string): Alert[] {
  const alerts: Alert[] = [];
  const llmFile = path.join(trickleDir, 'llm.jsonl');
  if (!fs.existsSync(llmFile)) return [];
  const calls = readJsonl(llmFile) as any[];
  if (calls.length === 0) return [];

  // 1. High error rate
  const errors = calls.filter(c => c.error);
  if (errors.length > 0 && errors.length / calls.length > 0.3) {
    alerts.push({
      kind: 'alert', severity: 'critical', category: 'llm_errors',
      message: `High LLM error rate: ${errors.length}/${calls.length} calls failed (${Math.round(errors.length / calls.length * 100)}%)`,
      details: { errorCount: errors.length, totalCalls: calls.length },
      timestamp: Date.now(),
      suggestion: `Check API keys, rate limits, and model availability. Common errors: ${[...new Set(errors.slice(0, 3).map(e => (e.error || '').substring(0, 50)))].join('; ')}`,
    });
  }

  // 2. Cost spike — single call > 50% of total
  const totalCost = calls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
  if (totalCost > 0) {
    const maxCall = calls.reduce((max: any, c: any) => (c.estimatedCostUsd || 0) > (max.estimatedCostUsd || 0) ? c : max, calls[0]);
    if (maxCall.estimatedCostUsd > totalCost * 0.5 && calls.length > 2) {
      alerts.push({
        kind: 'alert', severity: 'warning', category: 'llm_cost_spike',
        message: `Single LLM call consumed ${Math.round(maxCall.estimatedCostUsd / totalCost * 100)}% of total cost ($${maxCall.estimatedCostUsd.toFixed(4)} of $${totalCost.toFixed(4)})`,
        details: { model: maxCall.model, tokens: maxCall.totalTokens, cost: maxCall.estimatedCostUsd, input: (maxCall.inputPreview || '').substring(0, 80) },
        timestamp: Date.now(),
        suggestion: `Review this prompt for unnecessary length. Consider using a cheaper model (e.g., gpt-4o-mini instead of gpt-4o).`,
      });
    }
  }

  // 3. Excessive token usage per call (> 10K tokens)
  const highTokenCalls = calls.filter(c => (c.totalTokens || 0) > 10000);
  if (highTokenCalls.length > 0) {
    alerts.push({
      kind: 'alert', severity: 'warning', category: 'llm_high_tokens',
      message: `${highTokenCalls.length} LLM call(s) used >10K tokens`,
      details: { calls: highTokenCalls.map((c: any) => ({ model: c.model, tokens: c.totalTokens, input: (c.inputPreview || '').substring(0, 50) })) },
      timestamp: Date.now(),
      suggestion: `Large prompts increase cost and latency. Consider chunking input, using summarization, or reducing context window.`,
    });
  }

  // 4. Structured output validation — detect malformed JSON in LLM outputs
  let malformedCount = 0;
  const malformedExamples: string[] = [];
  for (const c of calls) {
    const output = c.outputPreview || '';
    if (!output || c.error) continue;
    // Detect if output looks like it was supposed to be JSON but isn't valid
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```json')) {
      let jsonStr = trimmed;
      if (jsonStr.startsWith('```json')) jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      try {
        JSON.parse(jsonStr);
      } catch {
        malformedCount++;
        if (malformedExamples.length < 3) {
          malformedExamples.push(`${c.model}: "${trimmed.substring(0, 60)}..."`);
        }
      }
    }
  }
  if (malformedCount > 0) {
    alerts.push({
      kind: 'alert', severity: 'warning', category: 'llm_malformed_json',
      message: `${malformedCount} LLM response(s) contain malformed JSON`,
      details: { count: malformedCount, examples: malformedExamples },
      timestamp: Date.now(),
      suggestion: `LLM returned JSON-like output that doesn't parse. Use structured output mode (response_format: {type: "json_object"}) or add output validation.`,
    });
  }

  return alerts;
}

function analyzeAgentEvents(trickleDir: string): Alert[] {
  const alerts: Alert[] = [];
  const agentsFile = path.join(trickleDir, 'agents.jsonl');
  if (!fs.existsSync(agentsFile)) return [];
  const events = readJsonl(agentsFile) as any[];
  if (events.length === 0) return [];

  // 1. Repeated tool retries — same tool called 3+ times in a row
  const toolCalls = events.filter(e => e.event === 'tool_start' || e.event === 'tool_end');
  const toolNames = toolCalls.filter(e => e.event === 'tool_start').map(e => e.tool || '');
  for (let i = 0; i < toolNames.length - 2; i++) {
    if (toolNames[i] === toolNames[i + 1] && toolNames[i] === toolNames[i + 2] && toolNames[i]) {
      alerts.push({
        kind: 'alert', severity: 'warning', category: 'agent_tool_retry',
        message: `Tool "${toolNames[i]}" called 3+ times in a row — possible retry loop`,
        details: { tool: toolNames[i], consecutiveCalls: 3 },
        timestamp: Date.now(),
        suggestion: `The agent may be retrying a failing tool. Check if the tool input is correct or if the agent misunderstands the tool's capabilities.`,
      });
      break; // Only report once
    }
  }

  // 2. Tool errors
  const toolErrors = events.filter(e => e.event === 'tool_error');
  if (toolErrors.length > 0) {
    alerts.push({
      kind: 'alert', severity: toolErrors.length >= 3 ? 'critical' : 'warning', category: 'agent_tool_errors',
      message: `${toolErrors.length} tool execution error(s) during agent run`,
      details: { errors: toolErrors.slice(0, 5).map((e: any) => ({ tool: e.tool, error: (e.error || '').substring(0, 100) })) },
      timestamp: Date.now(),
      suggestion: `Agent tools are failing. Check tool implementations and ensure inputs match expected schemas.`,
    });
  }

  // 3. Agent errors / crew failures
  const agentErrors = events.filter(e => e.event === 'crew_error' || e.event === 'chain_error' || e.event === 'agent_error');
  if (agentErrors.length > 0) {
    for (const err of agentErrors.slice(0, 3)) {
      alerts.push({
        kind: 'alert', severity: 'critical', category: 'agent_failure',
        message: `Agent workflow failed: ${(err.error || err.chain || 'unknown error').substring(0, 100)}`,
        details: { event: err.event, framework: err.framework, error: err.error },
        timestamp: Date.now(),
        suggestion: `Use \`trickle why\` to trace the causal chain leading to this failure.`,
      });
    }
  }

  // 4. Long agent runs (> 30s)
  const crewEnds = events.filter(e => e.event === 'crew_end' && e.durationMs);
  for (const run of crewEnds) {
    if (run.durationMs > 30000) {
      alerts.push({
        kind: 'alert', severity: 'warning', category: 'agent_slow',
        message: `Agent run took ${(run.durationMs / 1000).toFixed(1)}s — consider optimizing`,
        details: { framework: run.framework, durationMs: run.durationMs },
        timestamp: Date.now(),
        suggestion: `Long agent runs increase cost and user wait time. Check for unnecessary tool calls or verbose prompts.`,
      });
    }
  }

  return alerts;
}

export function runMonitor(opts: MonitorOptions): Alert[] {
  const trickleDir = findTrickleDir(opts.dir);
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return [];
  }

  const rules = loadRules(trickleDir, opts.rulesFile);
  const slowQueryMs = opts.slowQueryMs || 100;
  const slowFunctionMs = opts.slowFunctionMs || 1000;
  const memoryThresholdMb = opts.memoryThresholdMb || 512;

  const allAlerts: Alert[] = [
    ...analyzeQueries(trickleDir, slowQueryMs, rules),
    ...analyzeErrors(trickleDir, rules),
    ...analyzeMemory(trickleDir, memoryThresholdMb, rules),
    ...analyzeFunctions(trickleDir, slowFunctionMs, rules),
    ...analyzeCallTrace(trickleDir, rules),
    ...analyzeLlmCalls(trickleDir),
    ...analyzeAgentEvents(trickleDir),
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

  // Send to webhook if configured
  if (opts.webhook && allAlerts.length > 0) {
    sendWebhook(opts.webhook, allAlerts).catch(() => {});
  }

  // Watch mode: re-analyze when data files change
  if (opts.watch) {
    console.log(chalk.gray('  Watching for changes...'));
    const dataFiles = ['observations.jsonl', 'queries.jsonl', 'errors.jsonl', 'variables.jsonl', 'calltrace.jsonl', 'profile.jsonl'];
    for (const f of dataFiles) {
      const filePath = path.join(trickleDir, f);
      if (fs.existsSync(filePath)) {
        fs.watchFile(filePath, { interval: 2000 }, () => {
          console.log(chalk.gray(`\n  [${new Date().toLocaleTimeString()}] ${f} changed — re-analyzing...`));
          runMonitor({ ...opts, watch: false }); // Don't recurse watch
        });
      }
    }
  }

  return allAlerts;
}

async function sendWebhook(url: string, alerts: Alert[]): Promise<void> {
  const critical = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const isSlack = url.includes('hooks.slack.com') || url.includes('slack.com/api');

  // Slack Block Kit for rich formatting
  if (isSlack) {
    const color = critical.length > 0 ? '#e74c3c' : warnings.length > 0 ? '#f39c12' : '#2ecc71';
    const status = critical.length > 0 ? '🔴 Critical Issues' : warnings.length > 0 ? '🟡 Warnings' : '🟢 Healthy';

    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: `trickle: ${status}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${critical.length}* critical | *${warnings.length}* warnings | *${alerts.length}* total` } },
      { type: 'divider' },
    ];

    for (const a of alerts.slice(0, 5)) {
      const icon = a.severity === 'critical' ? '🔴' : '🟡';
      let text = `${icon} *${a.category}*: ${a.message}`;
      if (a.suggestion) text += `\n> _${a.suggestion}_`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    }

    if (alerts.length > 5) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_...and ${alerts.length - 5} more alerts_` }] });
    }

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Run \`trickle summary\` for full analysis | <https://github.com/yiheinchai/trickle|trickle>_` }] });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `trickle: ${critical.length} critical, ${warnings.length} warnings`,
          attachments: [{ color, blocks }],
        }),
      });
      if (res.ok) console.log(chalk.green(`  ✓ Alerts sent to Slack`));
      else console.log(chalk.yellow(`  ⚠ Slack responded with ${res.status}`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to send to Slack: ${err.message}`));
    }
    return;
  }

  // OpsGenie Alert API
  if (url.includes('opsgenie.com') || url.includes('api.opsgenie.com')) {
    const apiKey = process.env.OPSGENIE_API_KEY || '';
    const summary = `trickle: ${critical.length} critical, ${warnings.length} warnings`;
    const priority = critical.length > 0 ? 'P1' : warnings.length > 0 ? 'P3' : 'P5';

    try {
      const res = await fetch('https://api.opsgenie.com/v2/alerts', {
        method: 'POST',
        headers: { 'Authorization': `GenieKey ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: summary,
          description: alerts.slice(0, 5).map(a => `${a.severity}: ${a.message}`).join('\n'),
          priority,
          source: 'trickle',
          tags: ['trickle', ...alerts.map(a => a.category).filter((v, i, a) => a.indexOf(v) === i)],
          details: { alerts: JSON.stringify(alerts.slice(0, 10)) },
        }),
      });
      if (res.ok) console.log(chalk.green(`  ✓ Alert sent to OpsGenie`));
      else console.log(chalk.yellow(`  ⚠ OpsGenie responded with ${res.status}`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to send to OpsGenie: ${err.message}`));
    }
    return;
  }

  // Microsoft Teams webhook (Adaptive Cards)
  if (url.includes('webhook.office.com') || url.includes('microsoft.com')) {
    const color = critical.length > 0 ? 'attention' : warnings.length > 0 ? 'warning' : 'good';
    const title = `trickle: ${critical.length} critical, ${warnings.length} warnings`;

    const facts = alerts.slice(0, 6).map(a => ({
      title: a.severity === 'critical' ? '🔴 ' + a.category : '🟡 ' + a.category,
      value: a.message + (a.suggestion ? ` → ${a.suggestion}` : ''),
    }));

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@type': 'MessageCard',
          '@context': 'http://schema.org/extensions',
          themeColor: critical.length > 0 ? 'FF0000' : warnings.length > 0 ? 'FFA500' : '00FF00',
          summary: title,
          sections: [{
            activityTitle: title,
            facts,
            markdown: true,
          }],
          potentialAction: [{
            '@type': 'OpenUri',
            name: 'View trickle docs',
            targets: [{ os: 'default', uri: 'https://github.com/yiheinchai/trickle' }],
          }],
        }),
      });
      if (res.ok) console.log(chalk.green(`  ✓ Alerts sent to Teams`));
      else console.log(chalk.yellow(`  ⚠ Teams responded with ${res.status}`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to send to Teams: ${err.message}`));
    }
    return;
  }

  // PagerDuty Events API v2
  if (url.includes('pagerduty.com') || url.includes('events.pagerduty')) {
    const routingKey = process.env.PAGERDUTY_ROUTING_KEY || url.split('/').pop() || '';
    const severity = critical.length > 0 ? 'critical' : 'warning';
    const summary = `trickle: ${critical.length} critical, ${warnings.length} warnings — ${alerts.slice(0, 3).map(a => a.message).join('; ').substring(0, 200)}`;

    try {
      const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: 'trigger',
          payload: {
            summary,
            severity,
            source: 'trickle',
            component: process.cwd().split('/').pop() || 'app',
            custom_details: {
              alerts: alerts.map(a => ({ severity: a.severity, category: a.category, message: a.message })),
              critical_count: critical.length,
              warning_count: warnings.length,
            },
          },
        }),
      });
      if (res.ok) console.log(chalk.green(`  ✓ Incident sent to PagerDuty`));
      else console.log(chalk.yellow(`  ⚠ PagerDuty responded with ${res.status}`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to send to PagerDuty: ${err.message}`));
    }
    return;
  }

  // Generic webhook (works with Discord, custom endpoints)
  const text = [
    `trickle monitor: ${critical.length} critical, ${warnings.length} warnings`,
    ...alerts.slice(0, 10).map(a => {
      const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : 'ℹ️';
      return `${icon} ${a.category}: ${a.message}${a.suggestion ? ` → ${a.suggestion}` : ''}`;
    }),
  ].join('\n');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        content: text, // Discord compatibility
        alerts: alerts.map(a => ({
          severity: a.severity,
          category: a.category,
          message: a.message,
          suggestion: a.suggestion,
        })),
      }),
    });
    if (res.ok) console.log(chalk.green(`  ✓ Alerts sent to webhook`));
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Failed to send webhook: ${err.message}`));
  }
}
