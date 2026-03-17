/**
 * trickle changelog — auto-generate API changelog from type diffs.
 *
 * Compares function signatures between snapshot and current data,
 * showing what was added, removed, or changed. Useful for PR reviews,
 * release notes, and breaking change detection.
 *
 * Usage:
 *   trickle changelog             # compare against snapshot
 *   trickle changelog --markdown  # output as Markdown (for PR comments)
 *   trickle changelog --json      # structured JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function compactType(node: any): string {
  if (!node) return 'unknown';
  switch (node.kind) {
    case 'primitive': return node.name || 'unknown';
    case 'object': {
      if (node.class_name) return node.class_name;
      if (!node.properties) return '{}';
      const props = Object.entries(node.properties).slice(0, 4)
        .map(([k, v]) => `${k}: ${compactType(v)}`);
      return `{ ${props.join(', ')}${Object.keys(node.properties).length > 4 ? ', ...' : ''} }`;
    }
    case 'array': return `${compactType(node.element)}[]`;
    case 'tuple': return `[${(node.elements || []).map(compactType).join(', ')}]`;
    case 'union': return (node.elements || []).map(compactType).join(' | ');
    default: return node.kind || 'unknown';
  }
}

function getSignature(obs: any): string {
  const params = (obs.argsType?.elements || [])
    .map((e: any, i: number) => `${obs.paramNames?.[i] || `arg${i}`}: ${compactType(e)}`)
    .join(', ');
  return `${obs.functionName}(${params}) -> ${compactType(obs.returnType)}`;
}

interface ChangeEntry {
  type: 'added' | 'removed' | 'changed';
  breaking: boolean;
  name: string;
  before?: string;
  after?: string;
  details?: string;
}

export interface ChangelogResult {
  changes: ChangeEntry[];
  added: number;
  removed: number;
  changed: number;
  breaking: number;
}

export function generateChangelog(opts?: { dir?: string }): ChangelogResult {
  const trickleDir = opts?.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const snapshotDir = path.join(trickleDir, 'snapshot');

  const beforeObs = readJsonl(path.join(snapshotDir, 'observations.jsonl'));
  const afterObs = readJsonl(path.join(trickleDir, 'observations.jsonl'));

  // Build signature maps
  const beforeSigs = new Map<string, string>();
  for (const obs of beforeObs) {
    if (!obs.functionName) continue;
    const key = `${obs.module}.${obs.functionName}`;
    beforeSigs.set(key, getSignature(obs));
  }

  const afterSigs = new Map<string, string>();
  for (const obs of afterObs) {
    if (!obs.functionName) continue;
    const key = `${obs.module}.${obs.functionName}`;
    afterSigs.set(key, getSignature(obs));
  }

  const changes: ChangeEntry[] = [];

  // Added functions
  for (const [name, sig] of afterSigs) {
    if (!beforeSigs.has(name)) {
      changes.push({ type: 'added', breaking: false, name, after: sig });
    }
  }

  // Removed functions (breaking!)
  for (const [name, sig] of beforeSigs) {
    if (!afterSigs.has(name)) {
      changes.push({ type: 'removed', breaking: true, name, before: sig });
    }
  }

  // Changed signatures
  for (const [name, afterSig] of afterSigs) {
    const beforeSig = beforeSigs.get(name);
    if (beforeSig && beforeSig !== afterSig) {
      // Detect breaking changes: return type changed, params removed
      const beforeParams = (beforeSig.match(/\(([^)]*)\)/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean);
      const afterParams = (afterSig.match(/\(([^)]*)\)/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean);
      const beforeReturn = beforeSig.split('->').pop()?.trim() || '';
      const afterReturn = afterSig.split('->').pop()?.trim() || '';

      const breaking = beforeReturn !== afterReturn || afterParams.length < beforeParams.length;

      changes.push({
        type: 'changed',
        breaking,
        name,
        before: beforeSig,
        after: afterSig,
        details: breaking ? 'Return type or parameter count changed' : 'Signature updated',
      });
    }
  }

  changes.sort((a, b) => (a.breaking ? 0 : 1) - (b.breaking ? 0 : 1));

  return {
    changes,
    added: changes.filter(c => c.type === 'added').length,
    removed: changes.filter(c => c.type === 'removed').length,
    changed: changes.filter(c => c.type === 'changed').length,
    breaking: changes.filter(c => c.breaking).length,
  };
}

export function toMarkdown(result: ChangelogResult): string {
  if (result.changes.length === 0) return '## No API Changes\n\nNo function signature changes detected.\n';

  const lines: string[] = [];
  const breakingIcon = result.breaking > 0 ? '🔴' : '🟢';
  lines.push(`## ${breakingIcon} API Changelog`);
  lines.push('');
  lines.push(`**${result.added}** added | **${result.removed}** removed | **${result.changed}** changed | **${result.breaking}** breaking`);
  lines.push('');

  const breaking = result.changes.filter(c => c.breaking);
  if (breaking.length > 0) {
    lines.push('### Breaking Changes');
    lines.push('');
    for (const c of breaking) {
      if (c.type === 'removed') {
        lines.push(`- 🔴 **Removed**: \`${c.name}\``);
        lines.push(`  - Was: \`${c.before}\``);
      } else {
        lines.push(`- 🔴 **Changed**: \`${c.name}\``);
        lines.push(`  - Before: \`${c.before}\``);
        lines.push(`  - After: \`${c.after}\``);
      }
    }
    lines.push('');
  }

  const added = result.changes.filter(c => c.type === 'added');
  if (added.length > 0) {
    lines.push('### Added');
    lines.push('');
    for (const c of added) lines.push(`- ➕ \`${c.after}\``);
    lines.push('');
  }

  const changed = result.changes.filter(c => c.type === 'changed' && !c.breaking);
  if (changed.length > 0) {
    lines.push('### Changed');
    lines.push('');
    for (const c of changed) {
      lines.push(`- \`${c.name}\`: \`${c.before}\` → \`${c.after}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by [trickle](https://github.com/yiheinchai/trickle)*');
  return lines.join('\n');
}

export interface ChangelogOptions {
  json?: boolean;
  markdown?: boolean;
}

export function runChangelog(opts: ChangelogOptions): void {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const snapshotDir = path.join(trickleDir, 'snapshot');

  if (!fs.existsSync(snapshotDir)) {
    console.log(chalk.yellow('\n  No snapshot. Run: trickle diff-runs --snapshot\n'));
    return;
  }

  const result = generateChangelog();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (opts.markdown) {
    console.log(toMarkdown(result));
    return;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle changelog'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (result.changes.length === 0) {
    console.log(chalk.green('  No API changes. ✓'));
  } else {
    console.log(`  ${result.added} added | ${result.removed} removed | ${result.changed} changed | ${result.breaking > 0 ? chalk.red(String(result.breaking) + ' breaking') : '0 breaking'}`);
    console.log('');
    for (const c of result.changes.slice(0, 10)) {
      const icon = c.breaking ? chalk.red('✗') : c.type === 'added' ? chalk.green('+') : c.type === 'removed' ? chalk.red('-') : chalk.yellow('~');
      console.log(`  ${icon} ${c.name}`);
      if (c.before && c.after) {
        console.log(chalk.red(`    - ${c.before}`));
        console.log(chalk.green(`    + ${c.after}`));
      } else if (c.after) {
        console.log(chalk.green(`    + ${c.after}`));
      } else if (c.before) {
        console.log(chalk.red(`    - ${c.before}`));
      }
    }
  }
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}
