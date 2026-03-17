/**
 * trickle memory — Show captured agent memory operations (Mem0).
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export function memoryCommand(opts: { json?: boolean }): void {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const memFile = path.join(dir, 'memory.jsonl');

  if (!fs.existsSync(memFile)) {
    console.log(chalk.yellow('  No memory data. Run an app that uses Mem0 with trickle.'));
    return;
  }

  const events = fs.readFileSync(memFile, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e: any) => e && e.kind === 'memory_op');

  if (events.length === 0) {
    console.log(chalk.yellow('  No memory operations captured.'));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle memory'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const adds = events.filter((e: any) => e.operation === 'add');
  const searches = events.filter((e: any) => e.operation === 'search');
  const gets = events.filter((e: any) => e.operation === 'get' || e.operation === 'get_all');
  const updates = events.filter((e: any) => e.operation === 'update');
  const deletes = events.filter((e: any) => e.operation === 'delete');
  const errors = events.filter((e: any) => e.error);

  console.log(`  ${chalk.cyan(String(events.length))} operations: ${adds.length} add, ${searches.length} search, ${gets.length} get, ${updates.length} update, ${deletes.length} delete${errors.length > 0 ? chalk.red(`, ${errors.length} errors`) : ''}`);
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  for (const e of events.slice(-15)) {
    const op = (e as any).operation;
    const dur = (e as any).durationMs ? chalk.gray(`${(e as any).durationMs}ms`) : '';
    const icon = op === 'add' ? chalk.green('+') : op === 'search' ? chalk.blue('?') : op === 'delete' ? chalk.red('-') : op === 'update' ? chalk.yellow('~') : chalk.gray('→');
    let detail = '';
    if ((e as any).input) detail = (e as any).input.substring(0, 60);
    if ((e as any).query) detail = `"${(e as any).query.substring(0, 50)}"`;
    if ((e as any).memoryId) detail = `id:${(e as any).memoryId}`;
    if ((e as any).resultsCount !== undefined) detail += ` → ${(e as any).resultsCount} results`;
    if ((e as any).memoriesCount !== undefined) detail += ` (${(e as any).memoriesCount} memories)`;
    if ((e as any).error) detail = chalk.red((e as any).error.substring(0, 50));

    console.log(`  ${icon} ${chalk.bold(op.padEnd(10))} ${dur.padEnd(8)} ${detail}`);
  }

  if (events.length > 15) console.log(chalk.gray(`  ... and ${events.length - 15} more`));
  console.log('');
}
