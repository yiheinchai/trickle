/**
 * trickle eval — Score agent runs using traces already captured.
 *
 * Analyzes agents.jsonl, llm.jsonl, errors.jsonl to produce reliability
 * scores without needing an LLM-as-judge. Zero cost, zero API keys.
 *
 * Scoring dimensions:
 * - Completion: Did the agent finish successfully?
 * - Error rate: How many errors during execution?
 * - Cost efficiency: Tokens per meaningful output
 * - Tool reliability: Success rate of tool calls
 * - Latency: Was execution time reasonable?
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface EvalResult {
  overallScore: number;
  grade: string;
  dimensions: {
    completion: { score: number; detail: string };
    errors: { score: number; detail: string };
    costEfficiency: { score: number; detail: string };
    toolReliability: { score: number; detail: string };
    latency: { score: number; detail: string };
  };
  summary: string;
  recommendations: string[];
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function evalCommand(opts: { json?: boolean; failUnder?: string }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const agentEvents = readJsonl(path.join(dir, 'agents.jsonl'));
  const llmCalls = readJsonl(path.join(dir, 'llm.jsonl'));
  const errors = readJsonl(path.join(dir, 'errors.jsonl'));
  const mcpCalls = readJsonl(path.join(dir, 'mcp.jsonl'));

  if (agentEvents.length === 0 && llmCalls.length === 0) {
    console.log(chalk.yellow('  No agent or LLM data to evaluate. Run an agent with trickle first.'));
    return;
  }

  const result = scoreRun(agentEvents, llmCalls, errors, mcpCalls);

  if (opts.json) {
    const threshold = opts.failUnder ? parseInt(opts.failUnder, 10) : undefined;
    const output = {
      ...result,
      ...(threshold !== undefined ? { threshold, passed: result.overallScore >= threshold } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
    if (threshold !== undefined && result.overallScore < threshold) {
      process.exit(1);
    }
    return;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle eval'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const gradeColor = result.overallScore >= 80 ? chalk.green :
    result.overallScore >= 60 ? chalk.yellow : chalk.red;
  console.log(`  Overall: ${gradeColor(result.grade + ' (' + result.overallScore + '/100)')}`);
  console.log('');

  // Dimension scores
  const dims = result.dimensions;
  printDimension('Completion', dims.completion);
  printDimension('Errors', dims.errors);
  printDimension('Cost Efficiency', dims.costEfficiency);
  printDimension('Tool Reliability', dims.toolReliability);
  printDimension('Latency', dims.latency);

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  Summary'));
  console.log(`  ${result.summary}`);

  if (result.recommendations.length > 0) {
    console.log(chalk.bold('\n  Recommendations'));
    for (const rec of result.recommendations) {
      console.log(`  ${chalk.yellow('→')} ${rec}`);
    }
  }

  console.log('');

  // CI mode: exit with non-zero if score below threshold
  if (opts.failUnder) {
    const threshold = parseInt(opts.failUnder, 10);
    if (!isNaN(threshold) && result.overallScore < threshold) {
      console.log(chalk.red(`  FAIL: Score ${result.overallScore} is below threshold ${threshold}`));
      process.exit(1);
    }
  }
}

function printDimension(name: string, dim: { score: number; detail: string }): void {
  const bar = renderBar(dim.score);
  const color = dim.score >= 80 ? chalk.green : dim.score >= 60 ? chalk.yellow : chalk.red;
  console.log(`  ${name.padEnd(18)} ${bar} ${color(String(dim.score).padStart(3))}/100  ${chalk.gray(dim.detail)}`);
}

function renderBar(score: number): string {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const color = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function scoreRun(
  agentEvents: any[], llmCalls: any[], errors: any[], mcpCalls: any[],
): EvalResult {
  const recommendations: string[] = [];

  // 1. Completion score (0-100)
  const crewStarts = agentEvents.filter(e => e.event === 'crew_start' || e.event === 'chain_start');
  const crewEnds = agentEvents.filter(e => e.event === 'crew_end' || e.event === 'chain_end');
  const crewErrors = agentEvents.filter(e => e.event === 'crew_error' || e.event === 'chain_error');
  const completionRate = crewStarts.length > 0
    ? Math.min(1, crewEnds.length / crewStarts.length)
    : (llmCalls.length > 0 ? (llmCalls.filter(c => !c.error).length / llmCalls.length) : 1);
  const completionScore = Math.round(completionRate * 100);
  let completionDetail = '';
  if (crewStarts.length > 0) {
    completionDetail = `${crewEnds.length}/${crewStarts.length} workflows completed`;
    if (crewErrors.length > 0) completionDetail += `, ${crewErrors.length} failed`;
  } else {
    completionDetail = `${llmCalls.filter(c => !c.error).length}/${llmCalls.length} LLM calls succeeded`;
  }
  if (completionScore < 80) recommendations.push('Improve completion rate — check agent error handling and tool reliability');

  // 2. Error score (0-100, inverse of error rate)
  const totalSteps = agentEvents.length + llmCalls.length + mcpCalls.length;
  const errorEvents = [
    ...agentEvents.filter(e => e.event?.includes('error')),
    ...llmCalls.filter(c => c.error),
    ...mcpCalls.filter(c => c.isError),
    ...errors,
  ];
  const errorRate = totalSteps > 0 ? errorEvents.length / totalSteps : 0;
  const errorScore = Math.round(Math.max(0, (1 - errorRate * 5)) * 100); // 20% errors = 0 score
  const errorDetail = `${errorEvents.length} errors in ${totalSteps} steps (${(errorRate * 100).toFixed(1)}%)`;
  if (errorScore < 80) recommendations.push(`Reduce error rate — ${errorEvents.length} errors detected. Use \`trickle why\` to investigate`);

  // 3. Cost efficiency (0-100)
  const totalCost = llmCalls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
  const totalTokens = llmCalls.reduce((s: number, c: any) => s + (c.totalTokens || 0), 0);
  const outputTokens = llmCalls.reduce((s: number, c: any) => s + (c.outputTokens || 0), 0);
  const inputTokens = llmCalls.reduce((s: number, c: any) => s + (c.inputTokens || 0), 0);
  // Efficiency: ratio of output tokens to input tokens (higher = more efficient)
  const ioRatio = inputTokens > 0 ? outputTokens / inputTokens : 1;
  // Score: 1:1 ratio = 100, 1:10 ratio = 50, 1:100 = 10
  const costScore = llmCalls.length === 0 ? 100 : Math.round(Math.min(100, Math.max(10, ioRatio * 100)));
  const costDetail = llmCalls.length > 0
    ? `$${totalCost.toFixed(4)} total, ${formatTokens(inputTokens)} in → ${formatTokens(outputTokens)} out (${ioRatio.toFixed(2)} ratio)`
    : 'No LLM calls';
  if (costScore < 60 && llmCalls.length > 0) recommendations.push('Reduce prompt size — input tokens far exceed output. Consider summarizing context before sending');

  // 4. Tool reliability (0-100)
  const toolStarts = agentEvents.filter(e => e.event === 'tool_start');
  const toolEnds = agentEvents.filter(e => e.event === 'tool_end');
  const toolErrors = agentEvents.filter(e => e.event === 'tool_error');
  const mcpErrors = mcpCalls.filter(c => c.isError);
  const totalToolCalls = toolStarts.length + mcpCalls.filter(c => c.tool !== '__list_tools').length;
  const totalToolErrors = toolErrors.length + mcpErrors.length;
  const toolSuccessRate = totalToolCalls > 0 ? 1 - (totalToolErrors / totalToolCalls) : 1;
  const toolScore = Math.round(toolSuccessRate * 100);
  const toolDetail = totalToolCalls > 0
    ? `${totalToolCalls - totalToolErrors}/${totalToolCalls} tool calls succeeded`
    : 'No tool calls';
  if (toolScore < 80) recommendations.push(`Fix failing tools — ${totalToolErrors} tool errors detected. Check tool implementations`);

  // Check for retry loops
  const toolNames = toolStarts.map(e => e.tool || '');
  let maxConsecutive = 1;
  let current = 1;
  for (let i = 1; i < toolNames.length; i++) {
    if (toolNames[i] === toolNames[i - 1] && toolNames[i]) { current++; maxConsecutive = Math.max(maxConsecutive, current); }
    else current = 1;
  }
  if (maxConsecutive >= 3) recommendations.push(`Tool retry loop detected (${maxConsecutive} consecutive calls). Agent may be stuck`);

  // 5. Latency score (0-100)
  const durations = [
    ...agentEvents.filter(e => e.durationMs).map(e => e.durationMs),
    ...llmCalls.filter(c => c.durationMs).map(c => c.durationMs),
  ];
  const avgLatency = durations.length > 0 ? durations.reduce((s: number, d: number) => s + d, 0) / durations.length : 0;
  const maxLatency = durations.length > 0 ? Math.max(...durations) : 0;
  // Score: < 500ms avg = 100, 500-2000 = linear, > 5000ms = 20
  const latencyScore = durations.length === 0 ? 100 :
    Math.round(Math.min(100, Math.max(20, 100 - (avgLatency - 500) / 50)));
  const latencyDetail = durations.length > 0
    ? `avg ${avgLatency.toFixed(0)}ms, max ${maxLatency.toFixed(0)}ms across ${durations.length} steps`
    : 'No timing data';
  if (latencyScore < 60) recommendations.push(`High latency — avg ${avgLatency.toFixed(0)}ms. Consider faster models or reducing prompt size`);

  // Overall score (weighted average)
  const weights = { completion: 0.3, errors: 0.25, costEfficiency: 0.15, toolReliability: 0.2, latency: 0.1 };
  const overallScore = Math.round(
    completionScore * weights.completion +
    errorScore * weights.errors +
    costScore * weights.costEfficiency +
    toolScore * weights.toolReliability +
    latencyScore * weights.latency
  );

  const grade = overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' :
    overallScore >= 60 ? 'D' : 'F';

  // Summary
  const parts: string[] = [];
  if (crewStarts.length > 0) parts.push(`${crewStarts.length} workflow(s)`);
  if (llmCalls.length > 0) parts.push(`${llmCalls.length} LLM calls ($${totalCost.toFixed(4)})`);
  if (totalToolCalls > 0) parts.push(`${totalToolCalls} tool calls`);
  if (errorEvents.length > 0) parts.push(`${errorEvents.length} errors`);
  const summary = parts.join(', ') || 'No agent activity detected';

  return {
    overallScore,
    grade,
    dimensions: {
      completion: { score: completionScore, detail: completionDetail },
      errors: { score: errorScore, detail: errorDetail },
      costEfficiency: { score: costScore, detail: costDetail },
      toolReliability: { score: toolScore, detail: toolDetail },
      latency: { score: latencyScore, detail: latencyDetail },
    },
    summary,
    recommendations,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
