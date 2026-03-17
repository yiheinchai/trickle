/**
 * trickle why [query] — Causal debugging: trace back from an error or behavior
 * to show WHY it happened.
 *
 * Given an error message, function name, or search query, finds the relevant
 * events and builds a causal chain: what led to what, with variable values,
 * function call paths, LLM reasoning, and cost attribution.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface AnyEvent {
  [key: string]: unknown;
}

function readJsonl(filePath: string): AnyEvent[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function whyCommand(query: string | undefined, opts: { json?: boolean }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  // Load all data sources
  const errors = readJsonl(path.join(dir, 'errors.jsonl'));
  const observations = readJsonl(path.join(dir, 'observations.jsonl'));
  const calltrace = readJsonl(path.join(dir, 'calltrace.jsonl'));
  const variables = readJsonl(path.join(dir, 'variables.jsonl'));
  const llmCalls = readJsonl(path.join(dir, 'llm.jsonl'));
  const agentEvents = readJsonl(path.join(dir, 'agents.jsonl'));
  const mcpCalls = readJsonl(path.join(dir, 'mcp.jsonl'));

  // If no query, auto-detect: show the most recent error or issue
  if (!query) {
    if (errors.length > 0) {
      query = String(errors[errors.length - 1].message || errors[errors.length - 1].type || 'error');
    } else {
      // No errors — show a summary of what happened
      showOverviewWhy(observations, calltrace, variables, llmCalls, agentEvents, mcpCalls);
      return;
    }
  }

  const q = query.toLowerCase();

  if (opts.json) {
    const result = buildCausalChain(q, errors, observations, calltrace, variables, llmCalls, agentEvents, mcpCalls);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold(`  trickle why "${query}"`));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // 1. Find matching errors
  const matchingErrors = errors.filter(e =>
    String(e.message || '').toLowerCase().includes(q) ||
    String(e.type || '').toLowerCase().includes(q) ||
    String(e.function || '').toLowerCase().includes(q) ||
    String(e.file || '').toLowerCase().includes(q)
  );

  if (matchingErrors.length > 0) {
    console.log(chalk.red.bold('\n  Error Found'));
    for (const err of matchingErrors.slice(0, 3)) {
      console.log(`  ${chalk.red(String(err.type || 'Error'))}: ${String(err.message || '').substring(0, 100)}`);
      if (err.file) console.log(chalk.gray(`  at ${err.file}:${err.line}`));
      if (err.function) console.log(chalk.gray(`  in ${err.function}()`));
    }
  }

  // 2. Find the call chain leading to the error
  const matchingFunctions = observations.filter(o =>
    String(o.functionName || '').toLowerCase().includes(q) ||
    String(o.module || '').toLowerCase().includes(q)
  );

  const errorFile = matchingErrors[0]?.file as string;
  const errorFunc = matchingErrors[0]?.function as string;

  // Find calltrace entries near the error
  const relevantCalls = calltrace.filter(c =>
    String(c.function || '').toLowerCase().includes(q) ||
    (errorFunc && String(c.function || '').toLowerCase().includes(errorFunc.toLowerCase())) ||
    (c.error && String(c.error).toLowerCase().includes(q))
  );

  if (relevantCalls.length > 0) {
    console.log(chalk.blue.bold('\n  Call Chain'));
    // Build call path from depth info
    const sorted = relevantCalls.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const call of sorted.slice(-10)) {
      const indent = '  '.repeat(Math.min((call.depth as number) || 0, 5));
      const dur = call.durationMs ? chalk.gray(` (${(call.durationMs as number).toFixed(1)}ms)`) : '';
      const err = call.error ? chalk.red(` → ${String(call.error).substring(0, 60)}`) : '';
      console.log(`  ${indent}${chalk.cyan(String(call.function))}${dur}${err}`);
    }
  }

  // 3. Show variable values near the error
  const relevantVars = variables.filter(v => {
    const file = String(v.file || '').toLowerCase();
    const func = String(v.funcName || '').toLowerCase();
    return (errorFile && file.includes(path.basename(errorFile).toLowerCase())) ||
           (errorFunc && func.includes(errorFunc.toLowerCase())) ||
           String(v.varName || '').toLowerCase().includes(q);
  });

  if (relevantVars.length > 0) {
    console.log(chalk.yellow.bold('\n  Variable Values at Crash Point'));
    const shown = new Set<string>();
    for (const v of relevantVars.slice(-15)) {
      const key = `${v.varName}:${v.line}`;
      if (shown.has(key)) continue;
      shown.add(key);
      const sample = v.sample !== undefined ? chalk.gray(` = ${String(v.sample).substring(0, 60)}`) : '';
      const typeStr = formatType(v.type as any);
      console.log(`  L${v.line} ${chalk.bold(String(v.varName))}: ${chalk.green(typeStr)}${sample}`);
    }
  }

  // 4. Show LLM calls that may have led to the behavior
  const relevantLlm = llmCalls.filter(c =>
    String(c.model || '').toLowerCase().includes(q) ||
    String(c.provider || '').toLowerCase().includes(q) ||
    String(c.inputPreview || '').toLowerCase().includes(q) ||
    String(c.outputPreview || '').toLowerCase().includes(q) ||
    String(c.error || '').toLowerCase().includes(q)
  );

  if (relevantLlm.length > 0) {
    console.log(chalk.magenta.bold('\n  LLM Calls (Reasoning Chain)'));
    for (const c of relevantLlm.slice(-5)) {
      const cost = c.estimatedCostUsd ? chalk.green(`$${(c.estimatedCostUsd as number).toFixed(4)}`) : '';
      const tokens = c.totalTokens ? chalk.yellow(`${c.totalTokens}tok`) : '';
      console.log(`  ${chalk.cyan(String(c.model))} ${tokens} ${cost} ${chalk.gray(String(c.durationMs) + 'ms')}`);
      if (c.inputPreview) console.log(chalk.gray(`    → ${String(c.inputPreview).substring(0, 80)}`));
      if (c.outputPreview) console.log(chalk.gray(`    ← ${String(c.outputPreview).substring(0, 80)}`));
      if (c.error) console.log(chalk.red(`    ✗ ${String(c.error).substring(0, 80)}`));
    }
  }

  // 5. Show agent events if relevant
  const relevantAgent = agentEvents.filter(e =>
    String(e.tool || '').toLowerCase().includes(q) ||
    String(e.chain || '').toLowerCase().includes(q) ||
    String(e.thought || '').toLowerCase().includes(q) ||
    String(e.output || '').toLowerCase().includes(q) ||
    String(e.error || '').toLowerCase().includes(q)
  );

  if (relevantAgent.length > 0) {
    console.log(chalk.blue.bold('\n  Agent Decisions'));
    for (const e of relevantAgent.slice(-8)) {
      const evt = String(e.event || '?');
      const name = String(e.tool || e.chain || '');
      const dur = e.durationMs ? chalk.gray(` (${e.durationMs}ms)`) : '';
      console.log(`  ${evt.padEnd(14)} ${chalk.cyan(name)}${dur}`);
      if (e.thought) console.log(chalk.yellow(`    💭 ${String(e.thought).substring(0, 80)}`));
      if (e.toolInput) console.log(chalk.gray(`    → ${String(e.toolInput).substring(0, 80)}`));
      if (e.output) console.log(chalk.gray(`    ← ${String(e.output).substring(0, 80)}`));
      if (e.error) console.log(chalk.red(`    ✗ ${String(e.error).substring(0, 80)}`));
    }
  }

  // 6. Show MCP tool calls if relevant
  const relevantMcp = mcpCalls.filter(c =>
    String(c.tool || '').toLowerCase().includes(q) ||
    String(c.resultPreview || '').toLowerCase().includes(q) ||
    String(c.errorMessage || '').toLowerCase().includes(q)
  );

  if (relevantMcp.length > 0) {
    console.log(chalk.green.bold('\n  MCP Tool Calls'));
    for (const c of relevantMcp.slice(-5)) {
      const dir = c.direction === 'outgoing' ? '→' : '←';
      const err = c.isError ? chalk.red(' ERR') : '';
      console.log(`  ${dir} ${chalk.cyan(String(c.tool))} ${chalk.gray(String(c.durationMs) + 'ms')}${err}`);
      if (c.resultPreview) console.log(chalk.gray(`    ${String(c.resultPreview).substring(0, 80)}`));
    }
  }

  // If nothing was found
  if (matchingErrors.length === 0 && relevantCalls.length === 0 && relevantVars.length === 0 &&
      relevantLlm.length === 0 && relevantAgent.length === 0 && relevantMcp.length === 0) {
    console.log(chalk.yellow(`\n  No matching events found for "${query}".`));
    console.log(chalk.gray('  Try: a function name, error message, or variable name.'));
  }

  console.log('');
}

function showOverviewWhy(
  observations: AnyEvent[], calltrace: AnyEvent[], variables: AnyEvent[],
  llmCalls: AnyEvent[], agentEvents: AnyEvent[], mcpCalls: AnyEvent[],
): void {
  console.log('');
  console.log(chalk.bold('  trickle why'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(chalk.gray('  No query provided — showing execution overview.\n'));

  const totalFns = observations.length;
  const totalVars = variables.length;
  const totalLlm = llmCalls.length;
  const totalAgent = agentEvents.length;
  const totalMcp = mcpCalls.length;
  const totalCost = llmCalls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);

  if (totalFns > 0) console.log(`  ${chalk.cyan(String(totalFns))} functions observed`);
  if (totalVars > 0) console.log(`  ${chalk.yellow(String(totalVars))} variables traced`);
  if (totalLlm > 0) console.log(`  ${chalk.magenta(String(totalLlm))} LLM calls (${chalk.green('$' + totalCost.toFixed(4))})`);
  if (totalAgent > 0) console.log(`  ${chalk.blue(String(totalAgent))} agent events`);
  if (totalMcp > 0) console.log(`  ${chalk.green(String(totalMcp))} MCP tool calls`);

  console.log(chalk.gray('\n  Usage: trickle why "error message"'));
  console.log(chalk.gray('         trickle why "functionName"'));
  console.log(chalk.gray('         trickle why "variableName"'));
  console.log('');
}

function buildCausalChain(
  query: string, errors: AnyEvent[], observations: AnyEvent[],
  calltrace: AnyEvent[], variables: AnyEvent[], llmCalls: AnyEvent[],
  agentEvents: AnyEvent[], mcpCalls: AnyEvent[],
): any {
  const matchErrors = errors.filter(e => JSON.stringify(e).toLowerCase().includes(query));
  const matchCalls = calltrace.filter(c => JSON.stringify(c).toLowerCase().includes(query)).slice(-20);
  const matchVars = variables.filter(v => JSON.stringify(v).toLowerCase().includes(query)).slice(-20);
  const matchLlm = llmCalls.filter(c => JSON.stringify(c).toLowerCase().includes(query)).slice(-10);
  const matchAgent = agentEvents.filter(e => JSON.stringify(e).toLowerCase().includes(query)).slice(-10);
  const matchMcp = mcpCalls.filter(c => JSON.stringify(c).toLowerCase().includes(query)).slice(-10);

  return {
    query,
    errors: matchErrors,
    callChain: matchCalls,
    variables: matchVars,
    llmCalls: matchLlm,
    agentEvents: matchAgent,
    mcpCalls: matchMcp,
  };
}

function formatType(t: any): string {
  if (!t) return '?';
  if (t.kind === 'primitive') return t.name || '?';
  if (t.kind === 'object') return t.class_name || 'object';
  if (t.kind === 'array') return `${formatType(t.element)}[]`;
  return t.kind || '?';
}
