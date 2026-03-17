/**
 * trickle waterfall — interactive HTML waterfall view for per-request traces.
 *
 * Shows all functions and queries for each HTTP request as a timeline,
 * like Jaeger/Zipkin but with trickle's richer data.
 *
 * Usage:
 *   trickle waterfall                # generate HTML for all requests
 *   trickle waterfall --request req-3  # specific request
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

interface WaterfallSpan {
  name: string;
  type: 'function' | 'query';
  startMs: number;
  durationMs: number;
  depth: number;
  error?: string;
  requestId?: string;
}

export function generateWaterfallHtml(trickleDir: string): string {
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));

  // Group by requestId
  const requests = new Map<string, WaterfallSpan[]>();

  // Find earliest timestamp as baseline
  let minTs = Infinity;
  for (const e of calltrace) if (e.timestamp < minTs) minTs = e.timestamp;
  for (const q of queries) if (q.timestamp < minTs) minTs = q.timestamp;

  for (const e of calltrace) {
    if (e.kind !== 'call') continue;
    const rid = e.requestId || 'unknown';
    if (!requests.has(rid)) requests.set(rid, []);
    requests.get(rid)!.push({
      name: `${e.module}.${e.function}`,
      type: 'function',
      startMs: e.timestamp - minTs,
      durationMs: e.durationMs || 0,
      depth: e.depth || 0,
      error: e.error,
      requestId: rid,
    });
  }

  for (const q of queries) {
    const rid = q.requestId || 'unknown';
    if (!requests.has(rid)) requests.set(rid, []);
    requests.get(rid)!.push({
      name: (q.query || '').substring(0, 60),
      type: 'query',
      startMs: q.timestamp - minTs,
      durationMs: q.durationMs || 0,
      depth: 1,
      requestId: rid,
    });
  }

  // Sort spans within each request by start time
  for (const spans of requests.values()) {
    spans.sort((a, b) => a.startMs - b.startMs);
  }

  const requestsJson = JSON.stringify(Object.fromEntries(requests));
  const totalMs = Math.max(...[...requests.values()].flat().map(s => s.startMs + s.durationMs), 1);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>trickle waterfall</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 18px; }
  .header select { background: #2a2a4a; color: #e0e0e0; border: 1px solid #444; padding: 4px 8px; border-radius: 4px; }
  .waterfall { padding: 16px 24px; }
  .span-row { display: flex; align-items: center; height: 26px; margin: 2px 0; }
  .span-label { width: 250px; font-size: 12px; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; text-align: right; }
  .span-bar-container { flex: 1; position: relative; height: 20px; }
  .span-bar { position: absolute; height: 18px; border-radius: 3px; min-width: 2px; cursor: pointer; transition: opacity 0.1s; display: flex; align-items: center; padding: 0 4px; }
  .span-bar:hover { opacity: 0.85; }
  .span-bar .timing { font-size: 10px; color: #fff; white-space: nowrap; }
  .fn-bar { background: #4d96ff; }
  .query-bar { background: #6bcb77; }
  .error-bar { background: #e74c3c; }
  .request-header { padding: 8px 0 4px; font-size: 13px; font-weight: bold; color: #aaa; border-top: 1px solid #2a2a4a; margin-top: 8px; }
  .stats { font-size: 12px; color: #666; padding: 8px 24px; }
</style>
</head>
<body>
<div class="header">
  <h1>trickle waterfall</h1>
  <select id="filter"><option value="all">All Requests</option></select>
  <span class="stats" id="stats"></span>
</div>
<div class="waterfall" id="waterfall"></div>
<script>
const data = ${requestsJson};
const totalMs = ${totalMs};
const container = document.getElementById('waterfall');
const filter = document.getElementById('filter');
const statsEl = document.getElementById('stats');

// Populate filter
for (const rid of Object.keys(data)) {
  const opt = document.createElement('option');
  opt.value = rid;
  opt.textContent = rid + ' (' + data[rid].length + ' spans)';
  filter.appendChild(opt);
}

function render(selectedRid) {
  container.innerHTML = '';
  const entries = selectedRid === 'all' ? Object.entries(data) : [[selectedRid, data[selectedRid] || []]];
  let totalSpans = 0;

  for (const [rid, spans] of entries) {
    if (!spans || spans.length === 0) continue;
    const header = document.createElement('div');
    header.className = 'request-header';
    header.textContent = rid + ' (' + spans.length + ' spans)';
    container.appendChild(header);

    const reqMinMs = Math.min(...spans.map(s => s.startMs));
    const reqMaxMs = Math.max(...spans.map(s => s.startMs + s.durationMs));
    const reqDuration = reqMaxMs - reqMinMs || 1;

    for (const span of spans) {
      totalSpans++;
      const row = document.createElement('div');
      row.className = 'span-row';

      const label = document.createElement('div');
      label.className = 'span-label';
      label.textContent = span.name;
      label.style.paddingLeft = (span.depth * 12) + 'px';

      const barContainer = document.createElement('div');
      barContainer.className = 'span-bar-container';

      const bar = document.createElement('div');
      const left = ((span.startMs - reqMinMs) / reqDuration) * 100;
      const width = Math.max((span.durationMs / reqDuration) * 100, 0.5);
      bar.className = 'span-bar ' + (span.error ? 'error-bar' : span.type === 'query' ? 'query-bar' : 'fn-bar');
      bar.style.left = left + '%';
      bar.style.width = width + '%';

      const timing = document.createElement('span');
      timing.className = 'timing';
      timing.textContent = span.durationMs > 0.01 ? span.durationMs.toFixed(1) + 'ms' : '';
      bar.appendChild(timing);
      bar.title = span.name + ' — ' + span.durationMs.toFixed(2) + 'ms' + (span.error ? ' ERROR: ' + span.error : '');

      barContainer.appendChild(bar);
      row.appendChild(label);
      row.appendChild(barContainer);
      container.appendChild(row);
    }
  }
  statsEl.textContent = totalSpans + ' spans across ' + entries.length + ' request(s)';
}

filter.addEventListener('change', () => render(filter.value));
render('all');
</script>
</body>
</html>`;
}

export interface WaterfallOptions {
  request?: string;
}

export function runWaterfall(opts: WaterfallOptions): void {
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('\n  No .trickle/ data. Run trickle run first.\n'));
    return;
  }

  const html = generateWaterfallHtml(trickleDir);
  const outPath = path.join(trickleDir, 'waterfall.html');
  fs.writeFileSync(outPath, html);

  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const rids = new Set<string>();
  for (const e of calltrace) if (e.requestId) rids.add(e.requestId);
  for (const q of queries) if (q.requestId) rids.add(q.requestId);

  console.log('');
  console.log(chalk.bold('  trickle waterfall'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Requests: ${rids.size}`);
  console.log(`  Spans: ${calltrace.length} functions + ${queries.length} queries`);
  console.log(`  ${chalk.green('✓')} Waterfall: ${chalk.bold(path.relative(process.cwd(), outPath))}`);
  console.log(chalk.gray('    Open in browser for interactive timeline view'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}
