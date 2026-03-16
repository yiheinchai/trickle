/**
 * trickle cleanup — Smart data management for .trickle/ files.
 *
 * Prunes old data, compacts JSONL files, and manages retention.
 * Essential for heavy workloads where agents produce 10-100x more data.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface CleanupResult {
  filesProcessed: number;
  linesRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesSaved: number;
}

export function cleanupCommand(opts: {
  retainDays?: string;
  retainLines?: string;
  dryRun?: boolean;
  json?: boolean;
}): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(dir)) {
    console.log(chalk.yellow('  No .trickle/ directory found.'));
    return;
  }

  const retainDays = opts.retainDays ? parseInt(opts.retainDays, 10) : 7;
  const retainLines = opts.retainLines ? parseInt(opts.retainLines, 10) : 0;
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const dryRun = opts.dryRun || false;

  const jsonlFiles = [
    'observations.jsonl', 'variables.jsonl', 'calltrace.jsonl',
    'queries.jsonl', 'errors.jsonl', 'llm.jsonl', 'agents.jsonl',
    'mcp.jsonl', 'logs.jsonl', 'console.jsonl', 'traces.jsonl',
    'alerts.jsonl', 'profile.jsonl',
  ];

  let totalBefore = 0;
  let totalAfter = 0;
  let totalLinesRemoved = 0;
  let filesProcessed = 0;

  const details: Array<{ file: string; before: number; after: number; removed: number }> = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const beforeSize = Buffer.byteLength(content);
    totalBefore += beforeSize;

    const lines = content.split('\n').filter(Boolean);
    let kept: string[];

    if (retainLines > 0) {
      // Keep only the last N lines
      kept = lines.slice(-retainLines);
    } else {
      // Keep lines with timestamp newer than cutoff
      kept = lines.filter(line => {
        try {
          const obj = JSON.parse(line);
          const ts = obj.timestamp || 0;
          // If timestamp is in seconds (< 2000000000), convert to ms
          const tsMs = ts < 2_000_000_000 ? ts * 1000 : ts;
          // Keep if no timestamp (can't determine age) or if newer than cutoff
          return !ts || tsMs > cutoffMs;
        } catch {
          return true; // Keep unparseable lines
        }
      });
    }

    const removed = lines.length - kept.length;
    totalLinesRemoved += removed;

    const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
    const afterSize = Buffer.byteLength(newContent);
    totalAfter += afterSize;
    filesProcessed++;

    details.push({ file, before: beforeSize, after: afterSize, removed });

    if (!dryRun && removed > 0) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }
  }

  // Also clean up snapshot directory if it exists and is old
  const snapshotDir = path.join(dir, 'snapshot');
  if (fs.existsSync(snapshotDir)) {
    try {
      const stat = fs.statSync(snapshotDir);
      if (stat.mtimeMs < cutoffMs && !dryRun) {
        fs.rmSync(snapshotDir, { recursive: true });
        details.push({ file: 'snapshot/', before: 0, after: 0, removed: -1 });
      }
    } catch {}
  }

  // Clean up CSV export directory
  const csvDir = path.join(dir, 'csv');
  if (fs.existsSync(csvDir) && !dryRun) {
    try {
      const stat = fs.statSync(csvDir);
      if (stat.mtimeMs < cutoffMs) {
        fs.rmSync(csvDir, { recursive: true });
      }
    } catch {}
  }

  const result: CleanupResult = {
    filesProcessed,
    linesRemoved: totalLinesRemoved,
    bytesBefore: totalBefore,
    bytesAfter: totalAfter,
    bytesSaved: totalBefore - totalAfter,
  };

  if (opts.json) {
    console.log(JSON.stringify({ ...result, details, dryRun, retainDays }, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold(`  trickle cleanup${dryRun ? ' (dry run)' : ''}`));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Retention: ${retainLines > 0 ? `last ${retainLines} lines per file` : `${retainDays} days`}`);
  console.log(`  Files scanned: ${filesProcessed}`);

  if (totalLinesRemoved === 0) {
    console.log(chalk.green('  No data to prune — all data is within retention window.'));
  } else {
    console.log(`  Lines removed: ${chalk.yellow(String(totalLinesRemoved))}`);
    console.log(`  Space: ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (${chalk.green('saved ' + formatBytes(result.bytesSaved))})`);

    if (dryRun) {
      console.log(chalk.yellow('\n  Dry run — no files modified. Remove --dry-run to apply.'));
    } else {
      for (const d of details.filter(d => d.removed > 0)) {
        console.log(chalk.gray(`    ${d.file}: ${d.removed} lines removed`));
      }
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + 'MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + 'KB';
  return bytes + 'B';
}
