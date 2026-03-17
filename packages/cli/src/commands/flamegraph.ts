/**
 * trickle flamegraph — generate an interactive flamegraph from call traces.
 *
 * Reads .trickle/calltrace.jsonl and generates:
 * - Folded stacks format (for standard flamegraph tools)
 * - Self-contained HTML flamegraph (using d3-flame-graph)
 * - Structured JSON for MCP/agent consumption
 *
 * Usage:
 *   trickle flamegraph                # generate HTML flamegraph
 *   trickle flamegraph --json         # output structured data
 *   trickle flamegraph -o flame.html  # write to specific file
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface CallEvent {
  kind: string;
  function: string;
  module: string;
  callId: number;
  parentId: number;
  depth: number;
  timestamp: number;
  durationMs?: number;
  error?: string;
}

interface FlameNode {
  name: string;
  value: number; // duration in ms
  children: FlameNode[];
  error?: string;
}

export interface FlamegraphResult {
  tree: FlameNode;
  folded: string;
  totalMs: number;
  hotspots: Array<{ name: string; selfMs: number; totalMs: number; percentage: number }>;
}

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function generateFlamegraph(opts?: { dir?: string }): FlamegraphResult | null {
  const trickleDir = opts?.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl')) as CallEvent[];
  const callEvents = calltrace.filter(e => e.kind === 'call');

  if (callEvents.length === 0) return null;

  // Build tree
  const byCallId = new Map<number, CallEvent>();
  for (const ev of callEvents) byCallId.set(ev.callId, ev);

  const nodeMap = new Map<number, FlameNode>();
  const roots: FlameNode[] = [];

  for (const ev of callEvents) {
    const node: FlameNode = {
      name: `${ev.module}.${ev.function}`,
      value: ev.durationMs || 0,
      children: [],
      error: ev.error,
    };
    nodeMap.set(ev.callId, node);
  }

  for (const ev of callEvents) {
    const node = nodeMap.get(ev.callId)!;
    const parent = nodeMap.get(ev.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Create root node
  const totalMs = roots.reduce((sum, r) => sum + r.value, 0);
  const tree: FlameNode = {
    name: 'all',
    value: totalMs,
    children: roots,
  };

  // Generate folded stacks
  const foldedLines: string[] = [];
  function walkFolded(node: FlameNode, stack: string[]): void {
    const currentStack = [...stack, node.name];
    if (node.children.length === 0) {
      foldedLines.push(`${currentStack.join(';')} ${Math.round(node.value * 1000)}`);
    } else {
      // Self time = total - children
      const childTime = node.children.reduce((sum, c) => sum + c.value, 0);
      const selfTime = Math.max(0, node.value - childTime);
      if (selfTime > 0) {
        foldedLines.push(`${currentStack.join(';')} ${Math.round(selfTime * 1000)}`);
      }
      for (const child of node.children) {
        walkFolded(child, currentStack);
      }
    }
  }
  for (const root of roots) {
    walkFolded(root, []);
  }

  // Compute hotspots (functions with highest self-time)
  const selfTimes = new Map<string, { selfMs: number; totalMs: number }>();
  function walkSelfTime(node: FlameNode): void {
    const childTime = node.children.reduce((sum, c) => sum + c.value, 0);
    const selfMs = Math.max(0, node.value - childTime);
    const existing = selfTimes.get(node.name) || { selfMs: 0, totalMs: 0 };
    existing.selfMs += selfMs;
    existing.totalMs += node.value;
    selfTimes.set(node.name, existing);
    for (const child of node.children) walkSelfTime(child);
  }
  for (const root of roots) walkSelfTime(root);

  const hotspots = Array.from(selfTimes.entries())
    .map(([name, { selfMs, totalMs: tMs }]) => ({
      name,
      selfMs: Math.round(selfMs * 100) / 100,
      totalMs: Math.round(tMs * 100) / 100,
      percentage: totalMs > 0 ? Math.round((tMs / totalMs) * 10000) / 100 : 0,
    }))
    .filter(h => h.name !== 'all')
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    tree,
    folded: foldedLines.join('\n'),
    totalMs: Math.round(totalMs * 100) / 100,
    hotspots,
  };
}

export function generateFlamegraphHtml(data: FlamegraphResult): string {
  // Self-contained HTML flamegraph using inline d3-flame-graph
  const treeJson = JSON.stringify(data.tree);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>trickle flamegraph</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; }
    .header { padding: 16px 24px; background: #16213e; border-bottom: 1px solid #333; }
    .header h1 { font-size: 18px; color: #fff; }
    .header .stats { font-size: 13px; color: #888; margin-top: 4px; }
    .flamegraph { padding: 24px; }
    .bar { cursor: pointer; transition: opacity 0.15s; }
    .bar:hover { opacity: 0.85; }
    .bar text { font-size: 11px; fill: #fff; pointer-events: none; }
    .hotspots { padding: 0 24px 24px; }
    .hotspots h2 { font-size: 15px; margin-bottom: 8px; color: #aaa; }
    .hotspot { display: flex; align-items: center; padding: 6px 0; border-bottom: 1px solid #2a2a4a; font-size: 13px; }
    .hotspot .name { flex: 1; color: #e0e0e0; font-family: monospace; }
    .hotspot .time { width: 80px; text-align: right; color: #ff6b6b; }
    .hotspot .pct { width: 60px; text-align: right; color: #888; }
    .hotspot .bar-bg { width: 120px; height: 8px; background: #2a2a4a; border-radius: 4px; margin-left: 12px; }
    .hotspot .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #ff6b6b, #ffa500); }
    .error { color: #ff4444; }
    svg { width: 100%; }
  </style>
</head>
<body>
  <div class="header">
    <h1>trickle flamegraph</h1>
    <div class="stats">Total: ${data.totalMs}ms | ${data.hotspots.length} functions | Generated ${new Date().toISOString()}</div>
  </div>

  <div class="flamegraph">
    <svg id="flame"></svg>
  </div>

  <div class="hotspots">
    <h2>Hotspots (by total time)</h2>
    ${data.hotspots.slice(0, 20).map(h => `
    <div class="hotspot">
      <span class="name">${h.name}${h.name.includes('error') ? ' <span class="error">✗</span>' : ''}</span>
      <span class="time">${h.totalMs}ms</span>
      <span class="pct">${h.percentage}%</span>
      <div class="bar-bg"><div class="bar-fill" style="width: ${h.percentage}%"></div></div>
    </div>`).join('')}
  </div>

  <script>
    const data = ${treeJson};
    const svg = document.getElementById('flame');
    const width = svg.parentElement.clientWidth;
    const barHeight = 22;
    const padding = 1;

    // Flatten the tree into layers for rendering
    function flatten(node, depth, x0, x1) {
      const items = [{ name: node.name, depth, x0, x1, value: node.value, error: node.error }];
      if (node.children && node.children.length > 0) {
        const totalChildValue = node.children.reduce((s, c) => s + c.value, 0) || 1;
        let cx = x0;
        for (const child of node.children) {
          const childWidth = (child.value / totalChildValue) * (x1 - x0);
          items.push(...flatten(child, depth + 1, cx, cx + childWidth));
          cx += childWidth;
        }
      }
      return items;
    }

    const items = flatten(data, 0, 0, width);
    const maxDepth = Math.max(...items.map(i => i.depth)) + 1;
    const svgHeight = maxDepth * (barHeight + padding) + 10;
    svg.setAttribute('height', svgHeight);
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + svgHeight);

    const colors = ['#ff6b6b','#ffa500','#ffd93d','#6bcb77','#4d96ff','#9b59b6','#e74c3c','#2ecc71','#3498db','#e67e22'];

    for (const item of items) {
      if (item.x1 - item.x0 < 2) continue;
      const y = svgHeight - (item.depth + 1) * (barHeight + padding);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'bar');

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', item.x0);
      rect.setAttribute('y', y);
      rect.setAttribute('width', Math.max(0, item.x1 - item.x0 - padding));
      rect.setAttribute('height', barHeight);
      const colorIdx = Math.abs(item.name.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)) % colors.length;
      rect.setAttribute('fill', item.error ? '#cc3333' : colors[colorIdx]);
      rect.setAttribute('rx', '2');

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', item.x0 + 4);
      text.setAttribute('y', y + 15);
      const label = item.name + (item.value ? ' (' + item.value.toFixed(1) + 'ms)' : '');
      text.textContent = (item.x1 - item.x0) > 60 ? label : '';

      g.appendChild(rect);
      g.appendChild(text);
      g.addEventListener('click', () => alert(item.name + '\\n' + item.value.toFixed(2) + 'ms'));
      svg.appendChild(g);
    }
  </script>
</body>
</html>`;
}

export interface FlamegraphOptions {
  json?: boolean;
  out?: string;
  port?: number;
}

export function runFlamegraph(opts: FlamegraphOptions): void {
  const data = generateFlamegraph();

  if (!data) {
    console.log(chalk.yellow('\n  No call trace data found. Run your app with trickle first.\n'));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      totalMs: data.totalMs,
      hotspots: data.hotspots,
      tree: data.tree,
      folded: data.folded,
    }, null, 2));
    return;
  }

  // Generate HTML
  const html = generateFlamegraphHtml(data);
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const outPath = opts.out || path.join(trickleDir, 'flamegraph.html');

  if (!fs.existsSync(path.dirname(outPath))) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  }
  fs.writeFileSync(outPath, html);

  console.log('');
  console.log(chalk.bold('  trickle flamegraph'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Total: ${data.totalMs}ms across ${data.hotspots.length} functions`);
  console.log('');

  if (data.hotspots.length > 0) {
    console.log(chalk.bold('  Hotspots:'));
    for (const h of data.hotspots.slice(0, 8)) {
      const bar = '█'.repeat(Math.ceil(h.percentage / 5)) + '░'.repeat(Math.max(0, 20 - Math.ceil(h.percentage / 5)));
      console.log(`  ${bar} ${h.percentage.toFixed(1).padStart(5)}%  ${h.totalMs}ms  ${h.name}`);
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  ${chalk.green('✓')} Flamegraph: ${chalk.bold(path.relative(process.cwd(), outPath))}`);
  console.log(chalk.gray(`    Open in browser to explore interactively`));
  console.log('');
}
