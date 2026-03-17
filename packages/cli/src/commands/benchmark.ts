/**
 * trickle benchmark <command> --runs N — Multi-trial agent reliability testing.
 *
 * Runs the same command N times, captures trickle data for each run,
 * and reports variance: pass@k, consistency, cost/latency distribution.
 *
 * 85% per-step accuracy compounds to 20% on 10 steps — this measures
 * whether your agent gives consistent results across identical inputs.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { spawn } from 'child_process';

interface TrialResult {
  run: number;
  exitCode: number;
  durationMs: number;
  functions: number;
  variables: number;
  errors: number;
  llmCalls: number;
  llmCost: number;
  llmTokens: number;
  agentEvents: number;
  evalScore: number;
}

function countLines(fp: string): number {
  if (!fs.existsSync(fp)) return 0;
  return fs.readFileSync(fp, 'utf-8').trim().split('\n').filter(Boolean).length;
}

function sumField(fp: string, field: string): number {
  if (!fs.existsSync(fp)) return 0;
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
    .reduce((s, l) => { try { return s + (JSON.parse(l)[field] || 0); } catch { return s; } }, 0);
}

async function runTrial(command: string, trialDir: string): Promise<{ exitCode: number; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env, TRICKLE_LOCAL: '1', TRICKLE_LOCAL_DIR: trialDir };
    const proc = spawn(command, [], { shell: true, env, stdio: 'pipe' });
    proc.on('exit', (code) => resolve({ exitCode: code ?? 1, durationMs: Date.now() - start }));
    proc.on('error', () => resolve({ exitCode: 1, durationMs: Date.now() - start }));
  });
}

export async function benchmarkCommand(
  command: string | undefined,
  opts: { runs?: string; json?: boolean; failUnderConsistency?: string },
): Promise<void> {
  if (!command) {
    console.log(chalk.yellow('  Usage: trickle benchmark "python my_agent.py" --runs 5'));
    return;
  }

  const numRuns = parseInt(opts.runs || '5', 10);
  const baseDir = path.join(process.cwd(), '.trickle', 'benchmark');
  fs.mkdirSync(baseDir, { recursive: true });

  console.log('');
  console.log(chalk.bold('  trickle benchmark'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(`  Command: ${chalk.cyan(command)}`);
  console.log(`  Runs: ${numRuns}`);
  console.log('');

  const results: TrialResult[] = [];

  for (let i = 1; i <= numRuns; i++) {
    const trialDir = path.join(baseDir, `run-${i}`);
    fs.mkdirSync(trialDir, { recursive: true });
    // Clear previous data
    for (const f of fs.readdirSync(trialDir)) {
      if (f.endsWith('.jsonl') || f.endsWith('.json')) fs.unlinkSync(path.join(trialDir, f));
    }

    process.stdout.write(chalk.gray(`  Run ${i}/${numRuns}... `));
    const { exitCode, durationMs } = await runTrial(command, trialDir);

    const functions = countLines(path.join(trialDir, 'observations.jsonl'));
    const variables = countLines(path.join(trialDir, 'variables.jsonl'));
    const errors = countLines(path.join(trialDir, 'errors.jsonl'));
    const llmCalls = countLines(path.join(trialDir, 'llm.jsonl'));
    const llmCost = Math.round(sumField(path.join(trialDir, 'llm.jsonl'), 'estimatedCostUsd') * 10000) / 10000;
    const llmTokens = sumField(path.join(trialDir, 'llm.jsonl'), 'totalTokens');
    const agentEvents = countLines(path.join(trialDir, 'agents.jsonl'));

    // Simple eval score: 100 if exit 0 and no errors, minus penalties
    const evalScore = Math.max(0, (exitCode === 0 ? 100 : 30) - errors * 15);

    results.push({ run: i, exitCode, durationMs, functions, variables, errors, llmCalls, llmCost, llmTokens, agentEvents, evalScore });

    const icon = exitCode === 0 ? chalk.green('✓') : chalk.red('✗');
    console.log(`${icon} ${durationMs}ms | ${functions} fn | ${errors} err | ${llmCalls} llm ($${llmCost})`);
  }

  // Compute statistics
  const passes = results.filter(r => r.exitCode === 0).length;
  const passAtK = passes > 0 ? 1 : 0; // At least 1 succeeds
  const passAllK = passes === numRuns ? 1 : 0; // All succeed
  const consistency = Math.round((passes / numRuns) * 100);

  const durations = results.map(r => r.durationMs);
  const costs = results.map(r => r.llmCost);
  const tokens = results.map(r => r.llmTokens);
  const scores = results.map(r => r.evalScore);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const stddev = (arr: number[]) => {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, arr.length));
  };
  const min = (arr: number[]) => arr.length ? Math.min(...arr) : 0;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : 0;

  const report = {
    command, runs: numRuns,
    passRate: consistency,
    passAtK, passAllK,
    latency: { avg: Math.round(avg(durations)), stddev: Math.round(stddev(durations)), min: min(durations), max: max(durations) },
    cost: { total: Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000, avg: Math.round(avg(costs) * 10000) / 10000, stddev: Math.round(stddev(costs) * 10000) / 10000 },
    tokens: { total: tokens.reduce((a, b) => a + b, 0), avg: Math.round(avg(tokens)) },
    evalScore: { avg: Math.round(avg(scores)), min: min(scores), max: max(scores) },
    trials: results,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    if (opts.failUnderConsistency) {
      const threshold = parseInt(opts.failUnderConsistency, 10);
      if (consistency < threshold) process.exit(1);
    }
    return;
  }

  // Pretty print results
  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  Results'));

  const grade = consistency >= 90 ? chalk.green('A') : consistency >= 70 ? chalk.yellow('B') :
    consistency >= 50 ? chalk.yellow('C') : chalk.red('F');
  console.log(`  Consistency: ${grade} ${consistency}% (${passes}/${numRuns} passed)`);
  console.log(`  pass@k: ${passAtK ? chalk.green('YES') : chalk.red('NO')} (at least 1 succeeds)`);
  console.log(`  pass^k: ${passAllK ? chalk.green('YES') : chalk.red('NO')} (all succeed)`);

  console.log(chalk.gray('\n  Latency'));
  console.log(`  avg ${avg(durations).toFixed(0)}ms | stddev ${stddev(durations).toFixed(0)}ms | min ${min(durations)}ms | max ${max(durations)}ms`);

  if (costs.some(c => c > 0)) {
    console.log(chalk.gray('\n  Cost'));
    console.log(`  total $${report.cost.total} | avg $${report.cost.avg}/run | stddev $${report.cost.stddev}`);
    console.log(`  tokens: ${report.tokens.total} total | ${report.tokens.avg} avg/run`);
  }

  console.log(chalk.gray('\n  Eval Score'));
  console.log(`  avg ${report.evalScore.avg}/100 | min ${report.evalScore.min} | max ${report.evalScore.max}`);

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));

  if (opts.failUnderConsistency) {
    const threshold = parseInt(opts.failUnderConsistency, 10);
    if (consistency < threshold) {
      console.log(chalk.red(`  FAIL: Consistency ${consistency}% below threshold ${threshold}%`));
      process.exit(1);
    }
  }

  console.log('');
}
