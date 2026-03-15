/**
 * trickle heal — agent auto-remediation loop.
 *
 * Detects issues via trickle monitor, generates diagnostic context,
 * and outputs a structured remediation plan that an AI agent can execute.
 *
 * Flow: detect alerts → gather context → generate fix plan → output
 *
 * This command is designed to be called by AI agents (via MCP or CLI).
 * It provides all the context an agent needs to fix an issue in one call.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { runMonitor } from './monitor';

interface HealPlan {
  kind: 'heal_plan';
  alert: {
    severity: string;
    category: string;
    message: string;
    suggestion: string;
  };
  context: {
    relevantCode?: string;
    variableValues?: unknown[];
    callTrace?: unknown[];
    queries?: unknown[];
    errors?: unknown[];
  };
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
  timestamp: number;
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function gatherContextForAlert(alert: any, trickleDir: string): HealPlan['context'] {
  const ctx: HealPlan['context'] = {};

  switch (alert.category) {
    case 'n_plus_one': {
      // Get the repeated query and related call trace
      const queries = readJsonl(path.join(trickleDir, 'queries.jsonl')) as any[];
      const matchingQueries = queries.filter(q =>
        q.query && alert.details?.query && q.query.startsWith(alert.details.query.substring(0, 50))
      );
      ctx.queries = matchingQueries.slice(0, 5);

      // Get call trace to show where the loop happens
      const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl')) as any[];
      ctx.callTrace = calltrace.slice(0, 20);
      break;
    }

    case 'slow_query': {
      const queries = readJsonl(path.join(trickleDir, 'queries.jsonl')) as any[];
      ctx.queries = queries.filter(q => q.durationMs > (alert.details?.durationMs || 0) * 0.5).slice(0, 5);
      break;
    }

    case 'slow_function': {
      const observations = readJsonl(path.join(trickleDir, 'observations.jsonl')) as any[];
      const fn = observations.find(o => o.functionName === alert.details?.function);
      if (fn) {
        ctx.variableValues = [fn];
      }
      // Show call trace for the slow function
      const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl')) as any[];
      const fnTrace = calltrace.filter((t: any) => t.function === alert.details?.function);
      ctx.callTrace = fnTrace.length > 0 ? fnTrace : calltrace.slice(0, 10);
      break;
    }

    case 'error': {
      const errors = readJsonl(path.join(trickleDir, 'errors.jsonl')) as any[];
      ctx.errors = errors.filter(e =>
        (e.type || e.error) === alert.details?.errorType
      ).slice(0, 3);

      // Get variable values near the error
      const variables = readJsonl(path.join(trickleDir, 'variables.jsonl')) as any[];
      if (alert.details?.file) {
        ctx.variableValues = variables.filter((v: any) =>
          v.file?.includes(alert.details.file)
        ).slice(0, 10);
      }
      break;
    }

    case 'memory': {
      const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
      ctx.variableValues = profile;
      // Get functions sorted by their potential memory impact
      const observations = readJsonl(path.join(trickleDir, 'observations.jsonl')) as any[];
      ctx.callTrace = observations.sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 5);
      break;
    }

    default: {
      // Generic: include top-level context
      const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
      ctx.callTrace = (calltrace as any[]).slice(0, 10);
    }
  }

  return ctx;
}

function generateRecommendation(alert: any): { recommendation: string; confidence: 'high' | 'medium' | 'low' } {
  switch (alert.category) {
    case 'n_plus_one':
      return {
        recommendation: `Replace the N+1 query pattern with a batch query. Instead of executing "${(alert.details?.query || '').substring(0, 60)}" in a loop, use a single query with an IN clause or JOIN. Look at the call trace to find the loop that triggers repeated queries.`,
        confidence: 'high',
      };

    case 'slow_query':
      return {
        recommendation: `Optimize the slow query (${alert.details?.durationMs?.toFixed(0)}ms). Consider: 1) Add an index on the filtered columns, 2) Use EXPLAIN to check the query plan, 3) Reduce the result set with LIMIT or more specific WHERE clauses.`,
        confidence: 'medium',
      };

    case 'slow_function':
      return {
        recommendation: `Profile ${alert.details?.function} (${alert.details?.durationMs?.toFixed(0)}ms). Check: 1) Database calls inside the function (see queries context), 2) Nested loops or repeated operations, 3) Consider caching if the function is called with the same arguments.`,
        confidence: 'medium',
      };

    case 'error':
      return {
        recommendation: `Fix the ${alert.details?.errorType} error in ${alert.details?.file || 'the source file'}. Check the nearby variable values to understand the state when the error occurred. The error message: "${alert.details?.firstMessage || ''}"`,
        confidence: 'high',
      };

    case 'memory':
      return {
        recommendation: `Investigate memory growth (${alert.details?.growthMb}MB during execution). Check: 1) Large data structures that aren't freed, 2) Accumulating lists in loops, 3) Cached data that grows unbounded. Consider streaming processing or pagination.`,
        confidence: 'medium',
      };

    case 'deep_call_stack':
      return {
        recommendation: `Deep call stack (depth ${alert.details?.maxDepth}). Check for: 1) Unintended recursion, 2) Overly nested function calls that could be flattened, 3) Recursive data structures.`,
        confidence: 'low',
      };

    default:
      return { recommendation: alert.suggestion || 'Review the alert details and fix the underlying issue.', confidence: 'low' };
  }
}

export function runHeal(opts: { dir?: string; json?: boolean }): HealPlan[] {
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return [];
  }

  // Run monitor to get fresh alerts
  const alerts = runMonitor({ dir: trickleDir });

  if (alerts.length === 0) {
    if (!opts.json) {
      console.log(chalk.green('  No issues to heal — all clear.'));
    }
    return [];
  }

  // Generate heal plans for each alert
  const plans: HealPlan[] = alerts.map(alert => {
    const context = gatherContextForAlert(alert, trickleDir);
    const { recommendation, confidence } = generateRecommendation(alert);

    return {
      kind: 'heal_plan' as const,
      alert: {
        severity: alert.severity,
        category: alert.category,
        message: alert.message,
        suggestion: alert.suggestion || '',
      },
      context,
      recommendation,
      confidence,
      timestamp: Date.now(),
    };
  });

  // Write heal plans for agent consumption
  const healFile = path.join(trickleDir, 'heal.jsonl');
  fs.writeFileSync(healFile, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  if (opts.json) {
    console.log(JSON.stringify(plans, null, 2));
  } else {
    console.log('');
    console.log(chalk.bold('  trickle heal'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  ${plans.length} remediation plan(s) generated`);
    console.log('');

    for (const plan of plans) {
      const icon = plan.alert.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
      const conf = plan.confidence === 'high' ? chalk.green('HIGH') : plan.confidence === 'medium' ? chalk.yellow('MED') : chalk.gray('LOW');
      console.log(`  ${icon} [${conf}] ${plan.alert.message}`);
      console.log(chalk.gray(`    ${plan.recommendation.substring(0, 120)}`));
      console.log('');
    }

    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(chalk.gray(`  Plans written to ${path.relative(process.cwd(), healFile)}`));
    console.log(chalk.gray(`  Use trickle heal --json for structured output`));
    console.log('');
  }

  return plans;
}
