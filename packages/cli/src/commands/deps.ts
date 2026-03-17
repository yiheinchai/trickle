/**
 * trickle deps — visualize module/function dependency graph from call traces.
 *
 * Shows which modules call which, how many times, and generates
 * an interactive HTML graph or Mermaid diagram.
 *
 * Usage:
 *   trickle deps                # interactive HTML graph
 *   trickle deps --mermaid      # Mermaid diagram (paste into GitHub/docs)
 *   trickle deps --json         # structured JSON
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

interface DepEdge {
  from: string;
  to: string;
  calls: number;
  avgMs: number;
}

interface DepNode {
  name: string;
  functions: number;
  totalMs: number;
}

export interface DepsResult {
  nodes: DepNode[];
  edges: DepEdge[];
  mermaid: string;
}

export function analyzeDeps(dir?: string): DepsResult {
  const trickleDir = dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const callEvents = calltrace.filter((e: any) => e.kind === 'call');

  // Build callId -> event map
  const byCallId = new Map<number, any>();
  for (const ev of callEvents) byCallId.set(ev.callId, ev);

  // Count module-level edges
  const edgeCounts = new Map<string, { calls: number; totalMs: number }>();
  const moduleStats = new Map<string, { functions: Set<string>; totalMs: number }>();

  for (const ev of callEvents) {
    const mod = ev.module || 'unknown';
    if (!moduleStats.has(mod)) moduleStats.set(mod, { functions: new Set(), totalMs: 0 });
    moduleStats.get(mod)!.functions.add(ev.function);
    moduleStats.get(mod)!.totalMs += ev.durationMs || 0;

    const parent = byCallId.get(ev.parentId);
    if (parent && parent.module !== ev.module) {
      const key = `${parent.module}→${ev.module}`;
      const existing = edgeCounts.get(key) || { calls: 0, totalMs: 0 };
      existing.calls++;
      existing.totalMs += ev.durationMs || 0;
      edgeCounts.set(key, existing);
    }
  }

  const nodes: DepNode[] = Array.from(moduleStats.entries()).map(([name, stats]) => ({
    name,
    functions: stats.functions.size,
    totalMs: Math.round(stats.totalMs * 100) / 100,
  }));

  const edges: DepEdge[] = Array.from(edgeCounts.entries()).map(([key, stats]) => {
    const [from, to] = key.split('→');
    return {
      from,
      to,
      calls: stats.calls,
      avgMs: Math.round((stats.totalMs / stats.calls) * 100) / 100,
    };
  });

  edges.sort((a, b) => b.calls - a.calls);

  // Generate Mermaid diagram
  const mermaidLines = ['graph LR'];
  for (const node of nodes) {
    mermaidLines.push(`  ${node.name}["${node.name}<br/>${node.functions} fns, ${node.totalMs}ms"]`);
  }
  for (const edge of edges) {
    mermaidLines.push(`  ${edge.from} -->|${edge.calls}x| ${edge.to}`);
  }

  return { nodes, edges, mermaid: mermaidLines.join('\n') };
}

export function generateDepsHtml(data: DepsResult): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>trickle deps</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 16px; }
  .graph { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .node { background: #16213e; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; min-width: 140px; }
  .node .name { font-weight: bold; font-size: 14px; color: #4d96ff; }
  .node .stats { font-size: 12px; color: #888; margin-top: 4px; }
  .edges { margin-top: 16px; }
  .edge { display: flex; align-items: center; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #2a2a4a; }
  .edge .arrow { color: #6bcb77; margin: 0 8px; }
  .edge .count { color: #ffa500; margin-left: 8px; }
  .mermaid-section { margin-top: 24px; background: #16213e; padding: 16px; border-radius: 8px; }
  .mermaid-section pre { font-size: 12px; color: #aaa; white-space: pre-wrap; }
  .mermaid-section h2 { font-size: 14px; margin-bottom: 8px; color: #888; }
</style>
</head>
<body>
<h1>trickle deps — module dependency graph</h1>
<div class="graph">
${data.nodes.map(n => `<div class="node"><div class="name">${n.name}</div><div class="stats">${n.functions} functions, ${n.totalMs}ms total</div></div>`).join('\n')}
</div>
<div class="edges">
<h2 style="font-size:14px;color:#888;margin-bottom:8px;">Dependencies</h2>
${data.edges.map(e => `<div class="edge"><span>${e.from}</span><span class="arrow">→</span><span>${e.to}</span><span class="count">${e.calls}x (avg ${e.avgMs}ms)</span></div>`).join('\n')}
</div>
<div class="mermaid-section">
<h2>Mermaid (paste into GitHub/docs)</h2>
<pre>${data.mermaid}</pre>
</div>
</body>
</html>`;
}

export interface DepsOptions {
  json?: boolean;
  mermaid?: boolean;
}

export function runDeps(opts: DepsOptions): void {
  const data = analyzeDeps();

  if (data.nodes.length === 0) {
    console.log(chalk.yellow('\n  No call trace data. Run trickle run first.\n'));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.mermaid) {
    console.log(data.mermaid);
    return;
  }

  // Generate HTML
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const html = generateDepsHtml(data);
  const outPath = path.join(trickleDir, 'deps.html');
  fs.writeFileSync(outPath, html);

  console.log('');
  console.log(chalk.bold('  trickle deps'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Modules: ${data.nodes.length}`);
  console.log(`  Dependencies: ${data.edges.length}`);
  for (const e of data.edges.slice(0, 5)) {
    console.log(`    ${e.from} → ${e.to} (${e.calls}x, avg ${e.avgMs}ms)`);
  }
  console.log(`  ${chalk.green('✓')} Graph: ${path.relative(process.cwd(), outPath)}`);
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}
