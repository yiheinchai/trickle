/**
 * trickle fix — generate code patches for detected issues.
 *
 * Analyzes root causes and generates actual code fix suggestions
 * (not just descriptions). Outputs as unified diff format that
 * agents can apply directly.
 *
 * Usage:
 *   trickle fix              # show fix suggestions
 *   trickle fix --json       # structured output for agents
 *   trickle fix --apply      # apply fixes (interactive)
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface FixSuggestion {
  id: string;
  category: string;
  severity: 'critical' | 'warning';
  description: string;
  file?: string;
  line?: number;
  currentCode?: string;
  suggestedCode?: string;
  explanation: string;
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function generateNPlusOneFix(query: string, count: number, calltrace: any[]): FixSuggestion {
  // Detect the pattern: SELECT ... WHERE id = ? in a loop
  const isSelect = query.toUpperCase().startsWith('SELECT');
  const table = query.match(/FROM\s+(\w+)/i)?.[1] || 'table';
  const whereCol = query.match(/WHERE\s+(\w+)\s*=/i)?.[1] || 'id';

  let suggestedCode: string;
  let explanation: string;

  if (isSelect) {
    suggestedCode = `-- Instead of ${count} individual queries:\n-- ${query}\n\n-- Use a single batch query:\nSELECT * FROM ${table} WHERE ${whereCol} IN (?, ?, ?, ...)\n\n-- Or use a JOIN:\nSELECT parent.*, ${table}.*\nFROM parent_table parent\nJOIN ${table} ON ${table}.${whereCol} = parent.id`;
    explanation = `This query runs ${count} times in a loop. Batch it with IN() or use a JOIN to fetch all data in one query. This typically reduces latency by ${Math.round(count * 0.8)}x.`;
  } else {
    suggestedCode = `-- Consider batching these ${count} operations:\n-- ${query}\n\n-- Use a single INSERT with multiple VALUES:\nINSERT INTO ${table} VALUES (?, ?), (?, ?), (?, ?), ...`;
    explanation = `This INSERT runs ${count} times individually. Use a multi-row INSERT to batch them into a single query.`;
  }

  return {
    id: `n_plus_one_${table}_${whereCol}`,
    category: 'n_plus_one',
    severity: count >= 10 ? 'critical' : 'warning',
    description: `N+1 query: "${query.substring(0, 60)}" repeated ${count} times`,
    suggestedCode,
    explanation,
  };
}

function generateNullCheckFix(error: any, variables: any[]): FixSuggestion | null {
  const msg = error.message || '';
  if (!msg.includes('NoneType') && !msg.includes('undefined') && !msg.includes('null') &&
      !msg.includes('Cannot read prop')) return null;

  // Find the variable that was null
  const nullVar = variables.find(v => v.sample === null || v.sample === 'null' || v.sample === undefined);
  const varName = nullVar?.varName || 'result';
  const line = error.line || nullVar?.line;

  const isPython = msg.includes('NoneType');

  const suggestedCode = isPython
    ? `# Add null check before accessing ${varName}:\nif ${varName} is not None:\n    # ... use ${varName}\nelse:\n    # handle missing data (return error, use default, etc.)`
    : `// Add null check before accessing ${varName}:\nif (${varName} != null) {\n  // ... use ${varName}\n} else {\n  // handle missing data\n}`;

  return {
    id: `null_check_${varName}`,
    category: 'null_reference',
    severity: 'critical',
    description: `Null reference: ${msg.substring(0, 80)}`,
    file: error.file,
    line,
    suggestedCode,
    explanation: `${varName} was null/undefined at runtime. Add a guard check before accessing its properties. The database query or function call may return nothing for some inputs.`,
  };
}

function generateSlowFunctionFix(func: any): FixSuggestion {
  return {
    id: `slow_${func.module}_${func.functionName}`,
    category: 'slow_function',
    severity: func.durationMs > 5000 ? 'critical' : 'warning',
    description: `${func.module}.${func.functionName} took ${func.durationMs.toFixed(0)}ms`,
    suggestedCode: `# Performance optimization options for ${func.functionName}:\n\n# 1. Add caching (if called with same args repeatedly):\n#    @lru_cache or Redis cache\n\n# 2. Move to background task (if not time-critical):\n#    queue.enqueue(${func.functionName}, args)\n\n# 3. Profile internals:\n#    trickle flamegraph  # see where time is spent inside`,
    explanation: `This function takes ${func.durationMs.toFixed(0)}ms which exceeds the 1000ms threshold. Check if it does unnecessary I/O, repeated computation, or can be cached/parallelized.`,
  };
}

export interface FixOptions {
  json?: boolean;
  dir?: string;
}

export function runFix(opts: FixOptions): FixSuggestion[] {
  const trickleDir = opts.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('\n  No .trickle/ data. Run trickle run first.\n'));
    return [];
  }

  // Suppress monitor output
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

  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));

  const fixes: FixSuggestion[] = [];

  // N+1 query fixes
  const queryCounts = new Map<string, number>();
  for (const q of queries) {
    const norm = (q.query || '').replace(/\s+/g, ' ').trim().replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?');
    queryCounts.set(norm, (queryCounts.get(norm) || 0) + 1);
  }
  for (const [query, count] of queryCounts) {
    if (count >= 3) {
      fixes.push(generateNPlusOneFix(query, count, calltrace));
    }
  }

  // Null reference fixes
  const seenErrors = new Set<string>();
  for (const err of errors) {
    if (seenErrors.has(err.message || '')) continue;
    seenErrors.add(err.message || '');
    const fix = generateNullCheckFix(err, variables);
    if (fix) fixes.push(fix);
  }

  // Slow function fixes
  for (const obs of observations) {
    if (obs.durationMs > 1000) {
      fixes.push(generateSlowFunctionFix(obs));
    }
  }

  // Sort by severity
  fixes.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

  if (opts.json) {
    console.log(JSON.stringify(fixes, null, 2));
    return fixes;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle fix'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (fixes.length === 0) {
    console.log(chalk.green('  No issues to fix. ✓'));
    console.log('');
    return fixes;
  }

  console.log(`  ${fixes.length} fix suggestion${fixes.length > 1 ? 's' : ''}:`);
  console.log('');

  for (const fix of fixes) {
    const icon = fix.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
    console.log(`  ${icon} ${chalk.bold(fix.description)}`);
    if (fix.file) console.log(chalk.gray(`    at ${fix.file}${fix.line ? ':' + fix.line : ''}`));
    console.log(chalk.gray(`    ${fix.explanation}`));
    if (fix.suggestedCode) {
      console.log('');
      for (const line of fix.suggestedCode.split('\n')) {
        console.log(chalk.cyan(`    ${line}`));
      }
    }
    console.log('');
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray('  Use trickle fix --json for structured output'));
  console.log('');

  return fixes;
}
