/**
 * trickle llm — Show captured LLM/AI API calls with token counts, cost, and latency.
 *
 * Reads from .trickle/llm.jsonl (written by the LLM observer in client-js/client-python).
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface LlmCall {
  kind: string;
  provider: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  stream: boolean;
  finishReason: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  inputPreview: string;
  outputPreview: string;
  messageCount: number;
  toolUse: boolean;
  timestamp: number;
  error?: string;
}

export function llmCommand(opts: { json?: boolean; provider?: string; model?: string }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const llmFile = path.join(dir, 'llm.jsonl');

  if (!fs.existsSync(llmFile)) {
    console.log(chalk.yellow('  No LLM call data found. Run your app with trickle first.'));
    console.log(chalk.gray('  Supported: OpenAI, Anthropic (auto-detected, zero code changes)'));
    return;
  }

  let calls: LlmCall[] = fs.readFileSync(llmFile, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (opts.provider) {
    calls = calls.filter(c => c.provider === opts.provider);
  }
  if (opts.model) {
    calls = calls.filter(c => c.model.includes(opts.model!));
  }

  if (opts.json) {
    console.log(JSON.stringify(calls, null, 2));
    return;
  }

  if (calls.length === 0) {
    console.log(chalk.yellow('  No LLM calls captured.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle llm'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Summary stats
  const totalCost = calls.reduce((s, c) => s + (c.estimatedCostUsd || 0), 0);
  const totalTokens = calls.reduce((s, c) => s + (c.totalTokens || 0), 0);
  const totalDuration = calls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const errorCount = calls.filter(c => c.error).length;
  const streamCount = calls.filter(c => c.stream).length;

  console.log(`  ${chalk.cyan(String(calls.length))} LLM calls  ` +
    `${chalk.green('$' + totalCost.toFixed(4))} est. cost  ` +
    `${chalk.yellow(formatTokens(totalTokens))} tokens  ` +
    `${chalk.gray(formatDuration(totalDuration))} total`);

  if (errorCount > 0) {
    console.log(`  ${chalk.red(String(errorCount) + ' errors')}`);
  }

  // Group by model
  const byModel: Record<string, LlmCall[]> = {};
  for (const c of calls) {
    const key = `${c.provider}/${c.model}`;
    if (!byModel[key]) byModel[key] = [];
    byModel[key].push(c);
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));

  for (const [model, modelCalls] of Object.entries(byModel)) {
    const mCost = modelCalls.reduce((s, c) => s + (c.estimatedCostUsd || 0), 0);
    const mTokens = modelCalls.reduce((s, c) => s + (c.totalTokens || 0), 0);
    const avgLatency = modelCalls.reduce((s, c) => s + (c.durationMs || 0), 0) / modelCalls.length;
    console.log(`  ${chalk.bold(model)} — ${modelCalls.length} calls, ${formatTokens(mTokens)} tokens, $${mCost.toFixed(4)}, avg ${avgLatency.toFixed(0)}ms`);
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Show last N calls
  const recent = calls.slice(-10).reverse();
  for (const c of recent) {
    const costStr = c.estimatedCostUsd ? chalk.green('$' + c.estimatedCostUsd.toFixed(4)) : '';
    const tokenStr = c.totalTokens ? chalk.yellow(`${c.totalTokens}tok`) : '';
    const latencyStr = c.durationMs ? chalk.gray(`${c.durationMs.toFixed(0)}ms`) : '';
    const streamStr = c.stream ? chalk.blue(' stream') : '';
    const errorStr = c.error ? chalk.red(' ERR: ' + c.error.substring(0, 50)) : '';
    const toolStr = c.toolUse ? chalk.magenta(' [tools]') : '';
    const modelStr = chalk.cyan(c.model);

    console.log(`  ${modelStr} ${tokenStr} ${costStr} ${latencyStr}${streamStr}${toolStr}${errorStr}`);
    if (c.inputPreview) {
      console.log(chalk.gray(`    → ${c.inputPreview.substring(0, 80)}`));
    }
    if (c.outputPreview && c.outputPreview !== '(streaming)') {
      console.log(chalk.gray(`    ← ${c.outputPreview.substring(0, 80)}`));
    }
  }

  if (calls.length > 10) {
    console.log(chalk.gray(`  ... and ${calls.length - 10} more (use --json for full output)`));
  }

  console.log('');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'min';
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
  return ms.toFixed(0) + 'ms';
}
