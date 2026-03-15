/**
 * trickle status — quick overview of available observability data.
 * Shows what data files exist, how fresh they are, and counts.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface FileInfo {
  name: string;
  label: string;
  count: number;
  age: string;
  size: string;
}

function countLines(fp: string): number {
  if (!fs.existsSync(fp)) return 0;
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).length;
}

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export function runStatus(): void {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  console.log('');
  console.log(chalk.bold('  trickle status'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory. Run: trickle run <command>'));
    console.log('');
    return;
  }

  const files = [
    { file: 'variables.jsonl', label: 'Variables' },
    { file: 'observations.jsonl', label: 'Functions' },
    { file: 'calltrace.jsonl', label: 'Call trace' },
    { file: 'queries.jsonl', label: 'DB queries' },
    { file: 'logs.jsonl', label: 'Logs' },
    { file: 'errors.jsonl', label: 'Errors' },
    { file: 'console.jsonl', label: 'Console' },
    { file: 'traces.jsonl', label: 'Traces' },
    { file: 'websocket.jsonl', label: 'WebSocket' },
    { file: 'profile.jsonl', label: 'Memory' },
    { file: 'alerts.jsonl', label: 'Alerts' },
    { file: 'heal.jsonl', label: 'Heal plans' },
    { file: 'environment.json', label: 'Environment' },
  ];

  let totalSize = 0;
  let latestMtime = 0;

  for (const f of files) {
    const fp = path.join(trickleDir, f.file);
    if (!fs.existsSync(fp)) continue;

    const stat = fs.statSync(fp);
    const count = f.file.endsWith('.json') ? 1 : countLines(fp);
    const age = formatAge(Date.now() - stat.mtimeMs);
    const size = formatSize(stat.size);
    totalSize += stat.size;
    latestMtime = Math.max(latestMtime, stat.mtimeMs);

    if (count === 0 && stat.size < 5) continue; // Skip empty files

    const countStr = count > 0 ? chalk.bold(String(count).padStart(5)) : chalk.gray('    0');
    const icon = count > 0 ? chalk.green('✓') : chalk.gray('○');
    console.log(`  ${icon} ${f.label.padEnd(14)} ${countStr}  ${chalk.gray(size.padStart(6))}  ${chalk.gray(age + ' ago')}`);
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Total: ${formatSize(totalSize)} | Last updated: ${formatAge(Date.now() - latestMtime)} ago`);
  console.log('');
}
