/**
 * trickle summarize — Compress verbose agent traces into key decision points.
 *
 * Reads agents.jsonl, llm.jsonl, mcp.jsonl and produces a concise
 * narrative of what the agent did, why, and at what cost.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function summarizeCommand(opts: { json?: boolean }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const agentEvents = readJsonl(path.join(dir, 'agents.jsonl'));
  const llmCalls = readJsonl(path.join(dir, 'llm.jsonl'));
  const mcpCalls = readJsonl(path.join(dir, 'mcp.jsonl'));
  const errors = readJsonl(path.join(dir, 'errors.jsonl'));

  if (agentEvents.length === 0 && llmCalls.length === 0 && mcpCalls.length === 0) {
    console.log(chalk.yellow('  No agent, LLM, or MCP data to summarize.'));
    return;
  }

  const summary = buildSummary(agentEvents, llmCalls, mcpCalls, errors);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle summarize'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // One-line overview
  console.log(`  ${summary.overview}`);
  console.log('');

  // Key decisions
  if (summary.decisions.length > 0) {
    console.log(chalk.bold('  Key Decisions'));
    for (const d of summary.decisions) {
      const icon = d.type === 'error' ? chalk.red('✗') : d.type === 'tool' ? chalk.green('⚙') : d.type === 'llm' ? chalk.magenta('✦') : chalk.blue('→');
      console.log(`  ${icon} ${d.description}`);
    }
    console.log('');
  }

  // Cost breakdown
  if (summary.cost.total > 0) {
    console.log(chalk.bold('  Cost'));
    console.log(`  ${chalk.green('$' + summary.cost.total.toFixed(4))} total across ${summary.cost.llmCalls} LLM calls (${formatTokens(summary.cost.tokens)} tokens)`);
    if (summary.cost.mostExpensive) {
      console.log(chalk.gray(`  Most expensive: $${summary.cost.mostExpensive.cost.toFixed(4)} — ${summary.cost.mostExpensive.description}`));
    }
    console.log('');
  }

  // Issues
  if (summary.issues.length > 0) {
    console.log(chalk.bold('  Issues'));
    for (const issue of summary.issues) {
      console.log(`  ${chalk.red('!')} ${issue}`);
    }
    console.log('');
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log('');
}

interface TraceSummary {
  overview: string;
  decisions: Array<{ type: string; description: string }>;
  cost: { total: number; llmCalls: number; tokens: number; mostExpensive: { cost: number; description: string } | null };
  issues: string[];
  duration: number;
}

function buildSummary(agentEvents: any[], llmCalls: any[], mcpCalls: any[], errors: any[]): TraceSummary {
  const decisions: TraceSummary['decisions'] = [];
  const issues: string[] = [];

  // Extract key agent decisions
  const crewStarts = agentEvents.filter(e => e.event === 'crew_start' || e.event === 'chain_start');
  const crewEnds = agentEvents.filter(e => e.event === 'crew_end' || e.event === 'chain_end');
  const toolStarts = agentEvents.filter(e => e.event === 'tool_start');
  const toolEnds = agentEvents.filter(e => e.event === 'tool_end');
  const toolErrors = agentEvents.filter(e => e.event === 'tool_error');
  const agentActions = agentEvents.filter(e => e.event === 'action');

  // Tools used
  const toolNames = [...new Set(toolStarts.map(e => e.tool).filter(Boolean))];
  if (toolNames.length > 0) {
    decisions.push({ type: 'tool', description: `Used ${toolNames.length} tools: ${toolNames.join(', ')}` });
  }

  // Agent reasoning (from action events with thoughts)
  for (const a of agentActions.slice(0, 3)) {
    if (a.thought) {
      decisions.push({ type: 'reasoning', description: `Thought: "${truncate(a.thought, 80)}"` });
    }
  }

  // Handoffs
  const handoffs = agentEvents.filter(e => e.tool === 'handoff');
  for (const h of handoffs) {
    decisions.push({ type: 'handoff', description: `Handoff: ${truncate(h.toolInput || '', 80)}` });
  }

  // LLM calls summary
  const models = [...new Set(llmCalls.map(c => `${c.provider}/${c.model}`))];
  if (models.length > 0) {
    decisions.push({ type: 'llm', description: `${llmCalls.length} LLM calls using ${models.join(', ')}` });
  }

  // MCP tool calls
  const mcpTools = [...new Set(mcpCalls.filter(c => c.tool !== '__list_tools').map(c => c.tool))];
  if (mcpTools.length > 0) {
    decisions.push({ type: 'tool', description: `${mcpCalls.length} MCP tool calls: ${mcpTools.join(', ')}` });
  }

  // Errors
  for (const te of toolErrors.slice(0, 2)) {
    decisions.push({ type: 'error', description: `Tool "${te.tool}" failed: ${truncate(te.error || '', 60)}` });
  }
  for (const err of errors.slice(0, 2)) {
    issues.push(`${err.type || 'Error'}: ${truncate(err.message || '', 80)}`);
  }

  // Detect patterns
  const toolNameList = toolStarts.map(e => e.tool || '');
  for (let i = 0; i < toolNameList.length - 2; i++) {
    if (toolNameList[i] === toolNameList[i + 1] && toolNameList[i] === toolNameList[i + 2]) {
      issues.push(`Tool "${toolNameList[i]}" called 3+ times — possible retry loop`);
      break;
    }
  }

  const llmErrors = llmCalls.filter(c => c.error);
  if (llmErrors.length > 0) {
    issues.push(`${llmErrors.length}/${llmCalls.length} LLM calls failed`);
  }

  // Cost
  const totalCost = llmCalls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
  const totalTokens = llmCalls.reduce((s: number, c: any) => s + (c.totalTokens || 0), 0);
  const mostExpensiveCall = llmCalls.length > 0
    ? llmCalls.reduce((max: any, c: any) => (c.estimatedCostUsd || 0) > (max.estimatedCostUsd || 0) ? c : max, llmCalls[0])
    : null;

  // Duration
  const allTimestamps = [
    ...agentEvents.map(e => e.timestamp),
    ...llmCalls.map(c => c.timestamp),
    ...mcpCalls.map(c => c.timestamp),
  ].filter(Boolean).sort();
  const duration = allTimestamps.length >= 2 ? allTimestamps[allTimestamps.length - 1] - allTimestamps[0] : 0;

  // Build overview
  const parts: string[] = [];
  if (crewStarts.length > 0) {
    const frameworks = [...new Set(agentEvents.map(e => e.framework).filter(Boolean))];
    parts.push(`${crewStarts.length} agent run(s)${frameworks.length > 0 ? ` (${frameworks.join(', ')})` : ''}`);
  }
  if (llmCalls.length > 0) parts.push(`${llmCalls.length} LLM calls ($${totalCost.toFixed(4)})`);
  if (toolNames.length > 0) parts.push(`${toolStarts.length} tool calls`);
  if (mcpTools.length > 0) parts.push(`${mcpCalls.length} MCP calls`);
  if (toolErrors.length > 0) parts.push(`${toolErrors.length} tool errors`);
  if (duration > 0) parts.push(formatDuration(duration));

  const completed = crewEnds.length > 0 ? 'completed' : crewStarts.length > 0 ? 'started' : '';
  const overview = parts.length > 0
    ? `${completed ? completed.charAt(0).toUpperCase() + completed.slice(1) + ': ' : ''}${parts.join(', ')}`
    : 'No significant events captured';

  return {
    overview, decisions, issues, duration,
    cost: {
      total: totalCost, llmCalls: llmCalls.length, tokens: totalTokens,
      mostExpensive: mostExpensiveCall && mostExpensiveCall.estimatedCostUsd > 0
        ? { cost: mostExpensiveCall.estimatedCostUsd, description: `${mostExpensiveCall.model}: "${truncate(mostExpensiveCall.inputPreview || '', 50)}"` }
        : null,
    },
  };
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.substring(0, len) + '...' : s;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'min';
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
  return ms + 'ms';
}
