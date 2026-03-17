/**
 * trickle cost-report — LLM cost attribution by provider, model, and function.
 *
 * Reads .trickle/llm.jsonl and .trickle/agents.jsonl to produce a cost
 * breakdown showing where money is being spent.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface LlmCall {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  stream: boolean;
  inputPreview: string;
  outputPreview: string;
  timestamp: number;
  error?: string;
}

export function costReportCommand(opts: { json?: boolean; budget?: string }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const llmFile = path.join(dir, 'llm.jsonl');

  if (!fs.existsSync(llmFile)) {
    console.log(chalk.yellow('  No LLM call data found. Run your app with trickle first.'));
    return;
  }

  const calls: LlmCall[] = fs.readFileSync(llmFile, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (calls.length === 0) {
    console.log(chalk.yellow('  No LLM calls captured.'));
    return;
  }

  // Aggregate by provider
  const byProvider: Record<string, { calls: number; tokens: number; cost: number; inputTokens: number; outputTokens: number }> = {};
  for (const c of calls) {
    const key = c.provider || 'unknown';
    if (!byProvider[key]) byProvider[key] = { calls: 0, tokens: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
    byProvider[key].calls++;
    byProvider[key].tokens += c.totalTokens || 0;
    byProvider[key].cost += c.estimatedCostUsd || 0;
    byProvider[key].inputTokens += c.inputTokens || 0;
    byProvider[key].outputTokens += c.outputTokens || 0;
  }

  // Aggregate by model
  const byModel: Record<string, { calls: number; tokens: number; cost: number; avgLatency: number; errors: number }> = {};
  for (const c of calls) {
    const key = `${c.provider}/${c.model}`;
    if (!byModel[key]) byModel[key] = { calls: 0, tokens: 0, cost: 0, avgLatency: 0, errors: 0 };
    byModel[key].calls++;
    byModel[key].tokens += c.totalTokens || 0;
    byModel[key].cost += c.estimatedCostUsd || 0;
    byModel[key].avgLatency += c.durationMs || 0;
    if (c.error) byModel[key].errors++;
  }
  for (const m of Object.values(byModel)) {
    m.avgLatency = m.calls > 0 ? m.avgLatency / m.calls : 0;
  }

  // Totals
  const totalCost = calls.reduce((s, c) => s + (c.estimatedCostUsd || 0), 0);
  const totalTokens = calls.reduce((s, c) => s + (c.totalTokens || 0), 0);
  const totalInputTokens = calls.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const totalOutputTokens = calls.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const totalDuration = calls.reduce((s, c) => s + (c.durationMs || 0), 0);
  const errorCount = calls.filter(c => c.error).length;

  // Monthly projection (extrapolate from the time window)
  const timestamps = calls.map(c => c.timestamp).filter(Boolean).sort();
  const timeSpanMs = timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const monthlyProjection = timeSpanMs > 60000
    ? (totalCost / timeSpanMs) * 30 * 24 * 60 * 60 * 1000
    : null;

  // Per-agent cost roll-up — read agents.jsonl and attribute LLM costs to agents
  const agentsFile = path.join(dir, 'agents.jsonl');
  const byAgent: Record<string, { calls: number; tokens: number; cost: number; framework: string }> = {};
  if (fs.existsSync(agentsFile)) {
    const agentEvents = fs.readFileSync(agentsFile, 'utf-8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Build agent activity windows: agent_start → agent_end with timestamps
    const activeAgents: { name: string; framework: string; start: number; end: number }[] = [];
    const startTimes: Record<string, { name: string; framework: string; ts: number }> = {};

    for (const ev of agentEvents) {
      const name = ev.chain || ev.tool || 'unknown';
      const fw = ev.framework || 'unknown';
      if (ev.event === 'agent_start' || ev.event === 'crew_start') {
        startTimes[name] = { name, framework: fw, ts: ev.timestamp || 0 };
      } else if ((ev.event === 'agent_end' || ev.event === 'crew_end') && startTimes[name]) {
        activeAgents.push({ name, framework: fw, start: startTimes[name].ts, end: ev.timestamp || Date.now() });
        delete startTimes[name];
      }
    }

    // Attribute each LLM call to the most-recently-started agent active at that time
    for (const call of calls) {
      const ts = call.timestamp || 0;
      const matching = activeAgents.filter(a => ts >= a.start && ts <= a.end);
      const agent = matching.length > 0 ? matching[matching.length - 1] : null;
      if (agent) {
        const key = `${agent.framework}/${agent.name}`;
        if (!byAgent[key]) byAgent[key] = { calls: 0, tokens: 0, cost: 0, framework: agent.framework };
        byAgent[key].calls++;
        byAgent[key].tokens += call.totalTokens || 0;
        byAgent[key].cost += call.estimatedCostUsd || 0;
      }
    }
  }

  // Model tier analysis — classify models into frontier/standard/mini tiers
  // Ordered longest-first to avoid substring matches (gpt-4o-mini before gpt-4o)
  const TIER_RULES: Array<[string, string]> = [
    ['gpt-4o-mini', 'mini'], ['gpt-4-turbo', 'frontier'], ['gpt-4o', 'standard'], ['gpt-4', 'frontier'],
    ['gpt-3.5-turbo', 'mini'], ['o1-mini', 'standard'], ['o1-pro', 'frontier'], ['o1', 'frontier'],
    ['o3-mini', 'standard'], ['o3', 'frontier'], ['o4-mini', 'standard'],
    ['claude-opus', 'frontier'], ['claude-sonnet', 'standard'], ['claude-haiku', 'mini'],
    ['gemini-2.5-flash-lite', 'mini'], ['gemini-2.5-flash', 'standard'], ['gemini-2.5-pro', 'frontier'],
    ['gemini-2.0-flash', 'mini'], ['gemini-1.5-pro', 'frontier'], ['gemini-1.5-flash', 'mini'],
    ['mistral-large', 'frontier'], ['mistral-medium', 'standard'], ['mistral-small', 'mini'], ['codestral', 'standard'],
    ['command-r-plus', 'frontier'], ['command-r', 'standard'], ['command-light', 'mini'],
  ];

  function classifyTier(model: string): string {
    for (const [pattern, tier] of TIER_RULES) {
      if (model.includes(pattern)) return tier;
    }
    if (model.includes('mini') || model.includes('lite') || model.includes('haiku') || model.includes('flash')) return 'mini';
    if (model.includes('pro') || model.includes('opus') || model.includes('turbo')) return 'frontier';
    return 'standard';
  }

  const byTier: Record<string, { calls: number; tokens: number; cost: number; avgLatency: number; errors: number }> = {};
  for (const c of calls) {
    const tier = classifyTier(c.model || '');
    if (!byTier[tier]) byTier[tier] = { calls: 0, tokens: 0, cost: 0, avgLatency: 0, errors: 0 };
    byTier[tier].calls++;
    byTier[tier].tokens += c.totalTokens || 0;
    byTier[tier].cost += c.estimatedCostUsd || 0;
    byTier[tier].avgLatency += c.durationMs || 0;
    if (c.error) byTier[tier].errors++;
  }
  for (const t of Object.values(byTier)) {
    t.avgLatency = t.calls > 0 ? t.avgLatency / t.calls : 0;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      summary: { totalCost, totalTokens, totalInputTokens, totalOutputTokens, totalCalls: calls.length, totalDurationMs: totalDuration, errors: errorCount, monthlyProjection },
      byProvider, byModel, byTier,
      ...(Object.keys(byAgent).length > 0 ? { byAgent } : {}),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cost-report'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Summary
  console.log(`  Total: ${chalk.green('$' + totalCost.toFixed(4))} across ${chalk.cyan(String(calls.length))} calls`);
  console.log(`  Tokens: ${chalk.yellow(formatTokens(totalInputTokens))} in → ${chalk.yellow(formatTokens(totalOutputTokens))} out (${chalk.yellow(formatTokens(totalTokens))} total)`);
  console.log(`  Latency: ${chalk.gray(formatDuration(totalDuration))} total, ${chalk.gray(formatDuration(totalDuration / calls.length))} avg`);
  if (errorCount > 0) console.log(`  Errors: ${chalk.red(String(errorCount))}`);
  if (monthlyProjection !== null) {
    console.log(`  Monthly projection: ${chalk.bold('$' + monthlyProjection.toFixed(2))}/mo at current rate`);
  }

  // Budget check
  if (opts.budget) {
    const budget = parseFloat(opts.budget);
    if (!isNaN(budget)) {
      const pct = (totalCost / budget) * 100;
      const color = pct > 100 ? chalk.red : pct > 80 ? chalk.yellow : chalk.green;
      console.log(`  Budget: ${color(pct.toFixed(1) + '%')} of $${budget.toFixed(2)} (${color(totalCost > budget ? 'OVER' : 'within budget')})`);
    }
  }

  // By provider
  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  By Provider'));
  const sortedProviders = Object.entries(byProvider).sort((a, b) => b[1].cost - a[1].cost);
  for (const [name, data] of sortedProviders) {
    const pct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(0) : '0';
    console.log(`  ${chalk.cyan(name.padEnd(12))} $${data.cost.toFixed(4).padEnd(10)} ${chalk.gray(pct + '%')}  ${data.calls} calls  ${formatTokens(data.tokens)} tokens`);
  }

  // By model
  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  By Model'));
  const sortedModels = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  for (const [name, data] of sortedModels) {
    const pct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(0) : '0';
    const errStr = data.errors > 0 ? chalk.red(` (${data.errors} err)`) : '';
    console.log(`  ${chalk.cyan(name.padEnd(30))} $${data.cost.toFixed(4).padEnd(10)} ${chalk.gray(pct + '%')}  ${data.calls} calls  avg ${data.avgLatency.toFixed(0)}ms${errStr}`);
  }

  // Top costly calls
  const costlyCalls = calls.filter(c => c.estimatedCostUsd > 0).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd).slice(0, 5);
  // By tier
  if (Object.keys(byTier).length > 1) {
    console.log(chalk.gray('\n  ' + '─'.repeat(60)));
    console.log(chalk.bold('  Model Tier Analysis'));
    const tierOrder = ['frontier', 'standard', 'mini'];
    const tierLabels: Record<string, string> = { frontier: '🔴 Frontier', standard: '🟡 Standard', mini: '🟢 Mini' };
    for (const tier of tierOrder) {
      const data = byTier[tier];
      if (!data) continue;
      const pct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(0) : '0';
      const callPct = calls.length > 0 ? ((data.calls / calls.length) * 100).toFixed(0) : '0';
      const errRate = data.calls > 0 ? ((data.errors / data.calls) * 100).toFixed(0) : '0';
      console.log(`  ${(tierLabels[tier] || tier).padEnd(16)} $${data.cost.toFixed(4).padEnd(10)} ${chalk.gray(pct + '% cost')}  ${data.calls} calls (${callPct}%)  avg ${data.avgLatency.toFixed(0)}ms  ${data.errors > 0 ? chalk.red(errRate + '% err') : chalk.green('0% err')}`);
    }
    // Tier optimization suggestion
    const frontierPct = byTier.frontier ? (byTier.frontier.calls / calls.length) * 100 : 0;
    if (frontierPct > 50) {
      console.log(chalk.yellow(`  💡 ${frontierPct.toFixed(0)}% of calls use frontier models. Consider routing simple tasks to mini tier for ~75% savings.`));
    }
  }

  // By agent (if agent data exists)
  if (Object.keys(byAgent).length > 0) {
    console.log(chalk.gray('\n  ' + '─'.repeat(60)));
    console.log(chalk.bold('  By Agent/Workflow'));
    const sortedAgents = Object.entries(byAgent).sort((a, b) => b[1].cost - a[1].cost);
    for (const [name, data] of sortedAgents) {
      const pct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(0) : '0';
      console.log(`  ${chalk.cyan(name.padEnd(30))} $${data.cost.toFixed(4).padEnd(10)} ${chalk.gray(pct + '%')}  ${data.calls} calls  ${formatTokens(data.tokens)} tokens`);
    }
  }

  // Cache hit/miss analysis — detect from latency bimodality
  if (calls.length >= 4) {
    // Group by model, find bimodal latency distribution
    const modelLatencies: Record<string, number[]> = {};
    for (const c of calls) {
      if (!c.durationMs || c.error) continue;
      const key = c.model || 'unknown';
      if (!modelLatencies[key]) modelLatencies[key] = [];
      modelLatencies[key].push(c.durationMs);
    }

    let cacheDetected = false;
    const cacheAnalysis: Array<{ model: string; fastCalls: number; slowCalls: number; fastAvg: number; slowAvg: number; hitRate: number }> = [];

    for (const [model, latencies] of Object.entries(modelLatencies)) {
      if (latencies.length < 3) continue;
      latencies.sort((a, b) => a - b);
      const median = latencies[Math.floor(latencies.length / 2)];
      // Split into fast (< 30% of median) and slow (>= 30% of median)
      const threshold = median * 0.3;
      const fast = latencies.filter(l => l < threshold);
      const slow = latencies.filter(l => l >= threshold);

      if (fast.length >= 1 && slow.length >= 1 && fast.length / latencies.length >= 0.1) {
        const fastAvg = fast.reduce((s, l) => s + l, 0) / fast.length;
        const slowAvg = slow.reduce((s, l) => s + l, 0) / slow.length;
        // Only report if there's a significant speed difference (5x+)
        if (slowAvg / Math.max(1, fastAvg) >= 5) {
          cacheDetected = true;
          cacheAnalysis.push({
            model, fastCalls: fast.length, slowCalls: slow.length,
            fastAvg: Math.round(fastAvg), slowAvg: Math.round(slowAvg),
            hitRate: Math.round((fast.length / latencies.length) * 100),
          });
        }
      }
    }

    // Provider-reported cache tokens (Anthropic cache_read/cache_creation)
    const cacheReadTotal = calls.reduce((s: number, c: any) => s + (c.cacheReadTokens || 0), 0);
    const cacheWriteTotal = calls.reduce((s: number, c: any) => s + (c.cacheWriteTokens || 0), 0);
    const callsWithCache = calls.filter((c: any) => c.cacheReadTokens > 0 || c.cacheWriteTokens > 0);

    if (callsWithCache.length > 0 || cacheDetected) {
      console.log(chalk.gray('\n  ' + '─'.repeat(60)));
      console.log(chalk.bold('  Cache Analysis'));

      if (callsWithCache.length > 0) {
        const cacheHitCalls = calls.filter((c: any) => c.cacheReadTokens > 0);
        const hitRate = calls.length > 0 ? Math.round((cacheHitCalls.length / calls.length) * 100) : 0;
        // Estimate savings: cached tokens cost ~90% less
        const savedTokens = cacheReadTotal;
        const avgInputPrice = totalCost > 0 && totalTokens > 0 ? (totalCost / totalTokens) : 0.000003;
        const estimatedSavings = savedTokens * avgInputPrice * 0.9;
        console.log(chalk.gray('  Provider-reported cache tokens:'));
        console.log(`  Hit rate: ${chalk.green(hitRate + '%')} (${cacheHitCalls.length}/${calls.length} calls used cache)`);
        console.log(`  Cache read: ${formatTokens(cacheReadTotal)} tokens | Cache write: ${formatTokens(cacheWriteTotal)} tokens`);
        if (estimatedSavings > 0) {
          console.log(`  Estimated savings: ${chalk.green('~$' + estimatedSavings.toFixed(4))} from cached tokens`);
        }
      }

      if (cacheDetected) {
        console.log(chalk.gray('  Latency-based detection:'));
        for (const ca of cacheAnalysis) {
          const speedup = (ca.slowAvg / Math.max(1, ca.fastAvg)).toFixed(0);
          console.log(`  ${chalk.cyan(ca.model.padEnd(25))} hit rate: ${chalk.green(ca.hitRate + '%')} (${ca.fastCalls} fast, ${ca.slowCalls} slow)  ${speedup}x speedup`);
        }
      }
    }
  }

  if (costlyCalls.length > 0) {
    console.log(chalk.gray('\n  ' + '─'.repeat(60)));
    console.log(chalk.bold('  Most Expensive Calls'));
    for (const c of costlyCalls) {
      const preview = c.inputPreview ? c.inputPreview.substring(0, 60) : '';
      console.log(`  ${chalk.green('$' + c.estimatedCostUsd.toFixed(4))} ${chalk.cyan(c.model)} ${chalk.yellow(formatTokens(c.totalTokens))} ${chalk.gray(preview)}`);
    }
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
