/**
 * trickle mcp-calls — Show captured MCP tool call data.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface McpCall {
  kind: string;
  tool: string;
  direction: string;
  durationMs: number;
  args: unknown;
  resultPreview: string;
  isError: boolean;
  errorMessage?: string;
  timestamp: number;
}

export function mcpCallsCommand(opts: { json?: boolean }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const mcpFile = path.join(dir, 'mcp.jsonl');

  if (!fs.existsSync(mcpFile)) {
    console.log(chalk.yellow('  No MCP tool call data found.'));
    console.log(chalk.gray('  Run your app with trickle to capture MCP tool calls automatically.'));
    return;
  }

  const calls: McpCall[] = fs.readFileSync(mcpFile, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((c: McpCall | null): c is McpCall => c !== null && c.kind === 'mcp_tool_call');

  if (opts.json) {
    console.log(JSON.stringify(calls, null, 2));
    return;
  }

  if (calls.length === 0) {
    console.log(chalk.yellow('  No MCP tool calls captured.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle mcp-calls'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const outgoing = calls.filter(c => c.direction === 'outgoing');
  const incoming = calls.filter(c => c.direction === 'incoming');
  const errors = calls.filter(c => c.isError);
  const totalDuration = calls.reduce((s, c) => s + (c.durationMs || 0), 0);

  console.log(`  ${chalk.cyan(String(calls.length))} tool calls  ` +
    `${chalk.blue(String(outgoing.length))} outgoing  ` +
    `${chalk.green(String(incoming.length))} incoming  ` +
    (errors.length > 0 ? chalk.red(`${errors.length} errors  `) : '') +
    chalk.gray(formatDuration(totalDuration) + ' total'));

  // Group by tool
  const byTool: Record<string, McpCall[]> = {};
  for (const c of calls) {
    if (c.tool === '__list_tools') continue;
    if (!byTool[c.tool]) byTool[c.tool] = [];
    byTool[c.tool].push(c);
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));

  for (const [tool, toolCalls] of Object.entries(byTool)) {
    const avg = toolCalls.reduce((s, c) => s + c.durationMs, 0) / toolCalls.length;
    const errCount = toolCalls.filter(c => c.isError).length;
    const dir = toolCalls[0].direction === 'outgoing' ? chalk.blue('→') : chalk.green('←');
    console.log(`  ${dir} ${chalk.bold(tool)} — ${toolCalls.length} calls, avg ${avg.toFixed(0)}ms` +
      (errCount > 0 ? chalk.red(` (${errCount} err)`) : ''));
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Show recent calls
  const recent = calls.filter(c => c.tool !== '__list_tools').slice(-8).reverse();
  for (const c of recent) {
    const dir = c.direction === 'outgoing' ? chalk.blue('→') : chalk.green('←');
    const err = c.isError ? chalk.red(' ERR') : '';
    const latency = chalk.gray(`${c.durationMs.toFixed(0)}ms`);
    console.log(`  ${dir} ${chalk.cyan(c.tool)} ${latency}${err}`);
    if (c.resultPreview) {
      console.log(chalk.gray(`    ${c.resultPreview.substring(0, 80)}`));
    }
  }
  console.log('');
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'min';
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
  return ms.toFixed(0) + 'ms';
}
