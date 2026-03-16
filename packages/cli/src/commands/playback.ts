/**
 * trickle playback — Step-by-step replay of agent execution.
 *
 * Reads agents.jsonl, llm.jsonl, mcp.jsonl and plays back events
 * in chronological order with timing. Local-first: instant replay
 * from local JSONL files, no server needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

interface PlaybackEvent {
  timestamp: number;
  source: string;
  icon: string;
  title: string;
  detail: string;
  durationMs?: number;
  cost?: number;
}

export function playbackCommand(opts: { json?: boolean; speed?: string }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const events: PlaybackEvent[] = [];

  // Collect events from all sources
  for (const e of readJsonl(path.join(dir, 'agents.jsonl'))) {
    const evt = e.event || '?';
    const name = e.chain || e.tool || '';
    let icon = '→';
    if (evt.includes('start')) icon = '▶';
    if (evt.includes('end')) icon = '■';
    if (evt.includes('error')) icon = '✗';
    if (evt === 'action') icon = '⚒';
    if (evt === 'finish') icon = '✔';

    let detail = '';
    if (e.toolInput) detail = `→ ${String(e.toolInput).substring(0, 80)}`;
    if (e.output) detail = `← ${String(e.output).substring(0, 80)}`;
    if (e.thought) detail = `💭 ${String(e.thought).substring(0, 80)}`;
    if (e.error) detail = `✗ ${String(e.error).substring(0, 80)}`;

    events.push({
      timestamp: e.timestamp || 0,
      source: `agent:${evt}`,
      icon,
      title: `${name} [${evt}]`,
      detail,
      durationMs: e.durationMs,
    });
  }

  for (const c of readJsonl(path.join(dir, 'llm.jsonl'))) {
    const err = c.error ? ` ERR: ${String(c.error).substring(0, 40)}` : '';
    events.push({
      timestamp: c.timestamp || 0,
      source: 'llm',
      icon: '✦',
      title: `${c.provider}/${c.model}`,
      detail: `${c.totalTokens || 0}tok ${c.estimatedCostUsd ? '$' + c.estimatedCostUsd.toFixed(4) : ''} → ${(c.inputPreview || '').substring(0, 50)}${err}`,
      durationMs: c.durationMs,
      cost: c.estimatedCostUsd,
    });
  }

  for (const m of readJsonl(path.join(dir, 'mcp.jsonl'))) {
    if (m.tool === '__list_tools') continue;
    const dir2 = m.direction === 'outgoing' ? '→' : '←';
    events.push({
      timestamp: m.timestamp || 0,
      source: 'mcp',
      icon: dir2,
      title: `MCP: ${m.tool}`,
      detail: m.resultPreview ? `← ${String(m.resultPreview).substring(0, 60)}` : '',
      durationMs: m.durationMs,
    });
  }

  if (events.length === 0) {
    console.log(chalk.yellow('  No agent/LLM/MCP events to replay.'));
    return;
  }

  // Sort chronologically
  events.sort((a, b) => a.timestamp - b.timestamp);

  if (opts.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  // Playback
  console.log('');
  console.log(chalk.bold('  trickle playback'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(chalk.gray(`  ${events.length} events | replaying chronologically`));
  console.log('');

  const startTs = events[0].timestamp;
  let cumulativeCost = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const elapsed = e.timestamp - startTs;
    const timeStr = formatTime(elapsed);
    const durStr = e.durationMs ? chalk.gray(` (${e.durationMs.toFixed(0)}ms)`) : '';
    if (e.cost) cumulativeCost += e.cost;

    const iconColor = e.source === 'llm' ? chalk.magenta : e.source === 'mcp' ? chalk.green :
      e.icon === '✗' ? chalk.red : e.icon === '✔' ? chalk.green : chalk.blue;

    console.log(`  ${chalk.gray(timeStr)} ${iconColor(e.icon)} ${chalk.bold(e.title)}${durStr}`);
    if (e.detail) {
      console.log(`  ${chalk.gray('         ')} ${chalk.gray(e.detail)}`);
    }
  }

  // Summary
  const totalDuration = events[events.length - 1].timestamp - startTs;
  console.log('');
  console.log(chalk.gray('  ' + '─'.repeat(60)));
  console.log(`  ${events.length} events in ${formatTime(totalDuration)}${cumulativeCost > 0 ? ` | $${cumulativeCost.toFixed(4)} total cost` : ''}`);
  console.log('');
}

function formatTime(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
