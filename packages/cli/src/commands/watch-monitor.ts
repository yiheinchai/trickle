/**
 * trickle watch — continuous monitoring that outputs structured JSON events.
 *
 * Watches .trickle/ data files for changes, re-analyzes on each change,
 * and outputs new alerts as JSON lines to stdout. Designed for:
 * - AI agents polling for issues
 * - Piping to webhook endpoints
 * - Integration with alerting systems
 *
 * Usage:
 *   trickle watch                     # output JSON events to stdout
 *   trickle watch --webhook <url>     # also send to webhook
 *   trickle watch --interval 5        # check every 5 seconds (default: 3)
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface WatchEvent {
  kind: 'alert' | 'status' | 'change';
  timestamp: string;
  alerts?: Array<{
    severity: string;
    category: string;
    message: string;
    suggestion?: string;
  }>;
  summary?: {
    functions: number;
    queries: number;
    errors: number;
    alerts: number;
  };
  changedFile?: string;
}

export interface WatchOptions {
  interval?: number;
  webhook?: string;
  json?: boolean;
}

export async function runWatch(opts: WatchOptions): Promise<void> {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const interval = (opts.interval || 3) * 1000;
  const seenHashes = new Set<string>();

  if (!opts.json) {
    console.error(chalk.bold('\n  trickle watch'));
    console.error(chalk.gray('  ' + '─'.repeat(50)));
    console.error(chalk.gray(`  Monitoring ${trickleDir}`));
    console.error(chalk.gray(`  Interval: ${interval / 1000}s`));
    if (opts.webhook) console.error(chalk.gray(`  Webhook: ${opts.webhook}`));
    console.error(chalk.gray('  ' + '─'.repeat(50)));
    console.error('');
  }

  // Track file sizes to detect changes
  const fileSizes = new Map<string, number>();
  const dataFiles = ['observations.jsonl', 'queries.jsonl', 'errors.jsonl',
    'variables.jsonl', 'calltrace.jsonl', 'logs.jsonl', 'profile.jsonl'];

  function getFileSize(f: string): number {
    try { return fs.statSync(f).size; } catch { return 0; }
  }

  function readJsonl(fp: string): any[] {
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  function hashAlert(a: any): string {
    return `${a.severity}:${a.category}:${a.message}`;
  }

  function emitEvent(event: WatchEvent): void {
    console.log(JSON.stringify(event));
  }

  async function sendWebhook(alerts: any[]): Promise<void> {
    if (!opts.webhook || alerts.length === 0) return;
    try {
      const text = alerts.map(a => {
        const icon = a.severity === 'critical' ? '🔴' : '🟡';
        return `${icon} *${a.category}*: ${a.message}`;
      }).join('\n');

      await fetch(opts.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, alerts }),
      });
    } catch {}
  }

  function check(): void {
    if (!fs.existsSync(trickleDir)) return;

    // Check for file changes
    let changed = false;
    for (const f of dataFiles) {
      const fp = path.join(trickleDir, f);
      const size = getFileSize(fp);
      const prev = fileSizes.get(f) || 0;
      if (size !== prev) {
        changed = true;
        fileSizes.set(f, size);
      }
    }

    if (!changed) return;

    // Re-run monitor silently
    const origLog = console.log;
    const origErr = console.error;
    try {
      console.log = () => {};
      console.error = () => {};
      const { runMonitor } = require('./monitor');
      runMonitor({ dir: trickleDir });
    } catch {} finally {
      console.log = origLog;
      console.error = origErr;
    }

    // Check for new alerts
    const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
    const newAlerts = alerts.filter(a => {
      const h = hashAlert(a);
      if (seenHashes.has(h)) return false;
      seenHashes.add(h);
      return true;
    });

    if (newAlerts.length > 0) {
      emitEvent({
        kind: 'alert',
        timestamp: new Date().toISOString(),
        alerts: newAlerts.map(a => ({
          severity: a.severity,
          category: a.category,
          message: a.message,
          suggestion: a.suggestion,
        })),
      });

      sendWebhook(newAlerts).catch(() => {});

      if (!opts.json) {
        for (const a of newAlerts) {
          const icon = a.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
          console.error(`  ${icon} ${a.message}`);
        }
      }
    }

    // Emit status summary
    const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
    const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
    const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));

    emitEvent({
      kind: 'status',
      timestamp: new Date().toISOString(),
      summary: {
        functions: new Set(observations.map((o: any) => `${o.module}.${o.functionName}`)).size,
        queries: queries.length,
        errors: errors.length,
        alerts: alerts.length,
      },
    });
  }

  // Initial check
  check();

  // Polling loop
  const timer = setInterval(check, interval);

  // Handle shutdown
  process.on('SIGINT', () => {
    clearInterval(timer);
    if (!opts.json) {
      console.error(chalk.gray('\n  Watch stopped.'));
    }
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}
