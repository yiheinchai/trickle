/**
 * trickle dashboard --local — serves a self-contained observability dashboard
 * that reads directly from .trickle/ files. No backend needed.
 *
 * Shows: alerts, function timing, call trace, DB queries, errors, memory profile.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function generateDashboardHtml(trickleDir: string): string {
  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const profile = readJsonl(path.join(trickleDir, 'profile.jsonl'));
  const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));

  const critical = (alerts as any[]).filter(a => a.severity === 'critical').length;
  const warnings = (alerts as any[]).filter(a => a.severity === 'warning').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trickle dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
  h2 { color: #8b949e; font-size: 14px; font-weight: normal; margin-bottom: 24px; }
  h3 { color: #58a6ff; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; }
  .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
  .card .value.critical { color: #f85149; }
  .card .value.warning { color: #d29922; }
  .card .value.ok { color: #3fb950; }
  .section { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #8b949e; padding: 8px; border-bottom: 1px solid #21262d; font-weight: 500; }
  td { padding: 8px; border-bottom: 1px solid #21262d; }
  .severity-critical { color: #f85149; font-weight: 600; }
  .severity-warning { color: #d29922; }
  .severity-info { color: #58a6ff; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; }
  .tag-critical { background: #f8514922; color: #f85149; }
  .tag-warning { background: #d2992222; color: #d29922; }
  .tag-ok { background: #3fb95022; color: #3fb950; }
  .bar { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .suggestion { color: #8b949e; font-size: 12px; margin-top: 4px; }
  .empty { color: #484f58; text-align: center; padding: 24px; }
</style>
</head>
<body>
<h1>trickle</h1>
<h2>Runtime Observability Dashboard</h2>

<div class="grid">
  <div class="card">
    <div class="label">Alerts</div>
    <div class="value ${critical > 0 ? 'critical' : warnings > 0 ? 'warning' : 'ok'}">${critical > 0 ? critical + ' critical' : warnings > 0 ? warnings + ' warnings' : 'All clear'}</div>
  </div>
  <div class="card">
    <div class="label">Functions</div>
    <div class="value">${observations.length}</div>
  </div>
  <div class="card">
    <div class="label">Variables</div>
    <div class="value">${variables.length}</div>
  </div>
  <div class="card">
    <div class="label">DB Queries</div>
    <div class="value">${queries.length}</div>
  </div>
  <div class="card">
    <div class="label">Errors</div>
    <div class="value ${errors.length > 0 ? 'critical' : 'ok'}">${errors.length}</div>
  </div>
  <div class="card">
    <div class="label">Call Trace</div>
    <div class="value">${calltrace.length} events</div>
  </div>
</div>

${alerts.length > 0 ? `
<div class="section">
  <h3>Alerts</h3>
  <table>
    <tr><th>Severity</th><th>Category</th><th>Message</th><th>Suggestion</th></tr>
    ${(alerts as any[]).map(a => `
    <tr>
      <td><span class="tag tag-${a.severity}">${a.severity}</span></td>
      <td>${a.category}</td>
      <td>${a.message}</td>
      <td class="suggestion">${a.suggestion || ''}</td>
    </tr>`).join('')}
  </table>
</div>` : ''}

${observations.length > 0 ? `
<div class="section">
  <h3>Functions (by execution time)</h3>
  <table>
    <tr><th>Function</th><th>Module</th><th>Duration</th><th>Async</th></tr>
    ${(observations as any[]).sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 20).map((f: any) => `
    <tr>
      <td class="mono">${f.functionName}</td>
      <td>${f.module || ''}</td>
      <td>${f.durationMs ? f.durationMs.toFixed(1) + 'ms' : '—'}</td>
      <td>${f.isAsync ? 'async' : ''}</td>
    </tr>`).join('')}
  </table>
</div>` : ''}

${queries.length > 0 ? `
<div class="section">
  <h3>Database Queries (by duration)</h3>
  <table>
    <tr><th>Driver</th><th>Query</th><th>Duration</th><th>Rows</th></tr>
    ${(queries as any[]).sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 20).map((q: any) => `
    <tr>
      <td><span class="tag tag-ok">${q.driver || 'sql'}</span></td>
      <td class="mono">${(q.query || '').substring(0, 80)}</td>
      <td>${q.durationMs ? q.durationMs.toFixed(1) + 'ms' : '—'}</td>
      <td>${q.rowCount ?? '—'}</td>
    </tr>`).join('')}
  </table>
</div>` : ''}

${profile.length > 0 ? `
<div class="section">
  <h3>Memory Profile</h3>
  <table>
    <tr><th>Event</th><th>RSS</th><th>Heap</th><th>Peak Heap</th></tr>
    ${(profile as any[]).map((p: any) => `
    <tr>
      <td>${p.event}</td>
      <td>${p.rssKb ? (p.rssKb / 1024).toFixed(1) + ' MB' : '—'}</td>
      <td>${p.heapKb ? (p.heapKb / 1024).toFixed(1) + ' MB' : '—'}</td>
      <td>${p.peakHeapKb ? (p.peakHeapKb / 1024).toFixed(1) + ' MB' : '—'}</td>
    </tr>`).join('')}
  </table>
</div>` : ''}

${errors.length > 0 ? `
<div class="section">
  <h3>Errors</h3>
  <table>
    <tr><th>Type</th><th>Message</th><th>File</th><th>Line</th></tr>
    ${(errors as any[]).slice(0, 10).map((e: any) => `
    <tr>
      <td class="severity-critical">${e.type || 'Error'}</td>
      <td>${(e.message || e.error || '').substring(0, 100)}</td>
      <td class="mono">${e.file || ''}</td>
      <td>${e.line || ''}</td>
    </tr>`).join('')}
  </table>
</div>` : ''}

<div style="color: #484f58; font-size: 11px; margin-top: 24px; text-align: center;">
  trickle — runtime observability for JS &amp; Python &bull; ${new Date().toLocaleString()}
</div>
</body>
</html>`;
}

function generateAdvancedDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>trickle dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9}
.topbar{background:#161b22;border-bottom:1px solid #21262d;padding:12px 24px;display:flex;align-items:center;gap:16px}
.topbar h1{color:#58a6ff;font-size:18px}
.topbar .search{flex:1;max-width:500px}
.topbar input{width:100%;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 12px;border-radius:6px;font-size:13px}
.topbar input:focus{outline:none;border-color:#58a6ff}
.tabs{display:flex;background:#161b22;border-bottom:1px solid #21262d;padding:0 24px;gap:0}
.tab{padding:10px 16px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:#8b949e}
.tab:hover{color:#c9d1d9}.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.tab .badge{background:#30363d;color:#8b949e;padding:1px 6px;border-radius:10px;font-size:11px;margin-left:4px}
.content{padding:16px 24px}
.stats{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.stat{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:10px 16px;min-width:120px}
.stat .label{font-size:11px;color:#8b949e;text-transform:uppercase}.stat .val{font-size:22px;font-weight:600}
.stat .val.red{color:#f85149}.stat .val.yellow{color:#d29922}.stat .val.green{color:#3fb950}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#8b949e;padding:8px 12px;border-bottom:1px solid #21262d;font-weight:500;cursor:pointer;user-select:none}
th:hover{color:#c9d1d9}
td{padding:8px 12px;border-bottom:1px solid #161b22}
tr:hover{background:#161b22}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px}
.tag-critical{background:#f8514922;color:#f85149}.tag-warning{background:#d2992222;color:#d29922}
.tag-ok{background:#3fb95022;color:#3fb950}.tag-info{background:#58a6ff22;color:#58a6ff}
.expandable{cursor:pointer}.expanded-row{background:#0d1117}
.expanded-content{padding:12px;font-size:12px;white-space:pre-wrap;max-height:300px;overflow-y:auto}
.bar{height:4px;background:#21262d;border-radius:2px;min-width:40px;display:inline-block;vertical-align:middle}
.bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,#3fb950,#58a6ff)}
.empty{color:#484f58;text-align:center;padding:48px}
.facets{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.facet{background:#21262d;border:1px solid #30363d;padding:4px 10px;border-radius:16px;font-size:12px;cursor:pointer}
.facet:hover,.facet.active{background:#30363d;border-color:#58a6ff;color:#58a6ff}
</style>
</head>
<body>
<div class="topbar">
  <h1>trickle</h1>
  <div class="search"><input id="search" placeholder="Search functions, queries, logs, errors..." /></div>
  <span style="color:#8b949e;font-size:12px" id="timestamp"></span>
</div>
<div class="tabs" id="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="functions">Functions <span class="badge" id="fn-count">0</span></div>
  <div class="tab" data-tab="queries">Queries <span class="badge" id="q-count">0</span></div>
  <div class="tab" data-tab="logs">Logs <span class="badge" id="l-count">0</span></div>
  <div class="tab" data-tab="errors">Errors <span class="badge" id="e-count">0</span></div>
  <div class="tab" data-tab="calltrace">Call Trace <span class="badge" id="ct-count">0</span></div>
  <div class="tab" data-tab="variables">Variables <span class="badge" id="v-count">0</span></div>
</div>
<div class="content" id="content"></div>
<script>
let DATA={};let currentTab='overview';let searchQuery='';
async function load(){const r=await fetch('/api/data');DATA=await r.json();
document.getElementById('fn-count').textContent=DATA.functions?.length||0;
document.getElementById('q-count').textContent=DATA.queries?.length||0;
document.getElementById('l-count').textContent=DATA.logs?.length||0;
document.getElementById('e-count').textContent=DATA.errors?.length||0;
document.getElementById('ct-count').textContent=DATA.calltrace?.length||0;
document.getElementById('v-count').textContent=DATA.variables?.length||0;
document.getElementById('timestamp').textContent=new Date().toLocaleString();
render();}
function matchSearch(item){if(!searchQuery)return true;const s=searchQuery.toLowerCase();return JSON.stringify(item).toLowerCase().includes(s);}
function render(){const c=document.getElementById('content');
if(currentTab==='overview')renderOverview(c);
else if(currentTab==='functions')renderTable(c,DATA.functions||[],'functions');
else if(currentTab==='queries')renderTable(c,DATA.queries||[],'queries');
else if(currentTab==='logs')renderTable(c,DATA.logs||[],'logs');
else if(currentTab==='errors')renderTable(c,DATA.errors||[],'errors');
else if(currentTab==='calltrace')renderTable(c,DATA.calltrace||[],'calltrace');
else if(currentTab==='variables')renderTable(c,DATA.variables||[],'variables');}
function renderOverview(c){const a=DATA.alerts||[];const cr=a.filter(x=>x.severity==='critical').length;
const w=a.filter(x=>x.severity==='warning').length;
c.innerHTML='<div class="stats">'+
'<div class="stat"><div class="label">Status</div><div class="val '+(cr>0?'red':w>0?'yellow':'green')+'">'+(cr>0?'CRITICAL':w>0?'WARNING':'HEALTHY')+'</div></div>'+
'<div class="stat"><div class="label">Functions</div><div class="val">'+(DATA.functions?.length||0)+'</div></div>'+
'<div class="stat"><div class="label">Queries</div><div class="val">'+(DATA.queries?.length||0)+'</div></div>'+
'<div class="stat"><div class="label">Errors</div><div class="val '+(DATA.errors?.length>0?'red':'green')+'">'+(DATA.errors?.length||0)+'</div></div>'+
'<div class="stat"><div class="label">Logs</div><div class="val">'+(DATA.logs?.length||0)+'</div></div>'+
'<div class="stat"><div class="label">Alerts</div><div class="val '+(cr>0?'red':w>0?'yellow':'green')+'">'+a.length+'</div></div>'+
'</div>'+
(a.length>0?'<h3 style="color:#58a6ff;margin:16px 0 8px">Alerts</h3><table><tr><th>Severity</th><th>Category</th><th>Message</th><th>Fix</th></tr>'+
a.map(x=>'<tr><td><span class="tag tag-'+x.severity+'">'+x.severity+'</span></td><td>'+x.category+'</td><td>'+x.message+'</td><td style="color:#8b949e;font-size:12px">'+(x.suggestion||'')+'</td></tr>').join('')+'</table>':'');}
function renderTable(c,items,type){const filtered=items.filter(matchSearch);
let cols=[];let rowFn;
if(type==='functions'){cols=['Function','Module','Duration','Params'];rowFn=r=>'<td class="mono">'+r.functionName+'</td><td>'+r.module+'</td><td>'+(r.durationMs?r.durationMs.toFixed(1)+'ms':'—')+'</td><td class="mono" style="color:#8b949e;max-width:300px;overflow:hidden;text-overflow:ellipsis">'+(r.paramNames||[]).join(', ')+'</td>';}
else if(type==='queries'){cols=['Driver','Query','Duration','Rows','Request'];rowFn=r=>'<td><span class="tag tag-ok">'+(r.driver||'sql')+'</span></td><td class="mono" style="max-width:400px;overflow:hidden;text-overflow:ellipsis">'+(r.query||'').substring(0,100)+'</td><td>'+(r.durationMs?r.durationMs.toFixed(1)+'ms':'—')+'</td><td>'+(r.rowCount??'—')+'</td><td style="color:#8b949e;font-size:11px">'+(r.requestId||'')+'</td>';}
else if(type==='logs'){cols=['Level','Logger','Message','Time'];rowFn=r=>{const lvl=(r.level||r.levelname||'info').toLowerCase();const cls=lvl==='error'||lvl==='critical'?'tag-critical':lvl==='warning'?'tag-warning':'tag-info';return '<td><span class="tag '+cls+'">'+lvl+'</span></td><td>'+(r.logger||r.name||'')+'</td><td>'+(r.message||r.msg||'').substring(0,120)+'</td><td style="color:#8b949e;font-size:11px">'+(r.timestamp?new Date(r.timestamp).toLocaleTimeString():'')+'</td>';};}
else if(type==='errors'){cols=['Type','Message','File','Line'];rowFn=r=>'<td class="tag tag-critical">'+(r.type||'Error')+'</td><td>'+(r.message||r.error||'').substring(0,100)+'</td><td class="mono">'+(r.file||'').split('/').pop()+'</td><td>'+(r.line||'')+'</td>';}
else if(type==='calltrace'){cols=['Function','Module','Duration','Depth','Error'];rowFn=r=>'<td class="mono" style="padding-left:'+(r.depth||0)*16+'px">'+r.function+'</td><td>'+r.module+'</td><td>'+(r.durationMs?r.durationMs.toFixed(1)+'ms':'—')+'</td><td>'+r.depth+'</td><td style="color:#f85149">'+(r.error||'')+'</td>';}
else if(type==='variables'){cols=['Variable','Line','Module','Type','Value'];rowFn=r=>'<td class="mono">'+r.varName+'</td><td>'+r.line+'</td><td>'+r.module+'</td><td style="color:#8b949e">'+typeStr(r.type)+'</td><td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;color:#8b949e">'+(typeof r.sample==='string'?r.sample:JSON.stringify(r.sample)||'').substring(0,60)+'</td>';}
const facets=getFacets(filtered,type);
c.innerHTML='<div class="facets">'+facets+'</div>'+
'<div style="color:#8b949e;font-size:12px;margin-bottom:8px">'+filtered.length+' / '+items.length+' items</div>'+
(filtered.length>0?'<table><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+
filtered.slice(0,100).map(r=>'<tr class="expandable" onclick="toggleRow(this)">'+rowFn(r)+'</tr><tr class="expanded-row" style="display:none"><td colspan="'+cols.length+'"><div class="expanded-content">'+JSON.stringify(r,null,2)+'</div></td></tr>').join('')+'</table>':'<div class="empty">No data</div>');}
function typeStr(t){if(!t)return'?';if(t.kind==='primitive')return t.name||'?';if(t.kind==='object')return t.class_name||'object';if(t.kind==='array')return typeStr(t.element)+'[]';return t.kind||'?';}
function getFacets(items,type){const counts={};
if(type==='queries')items.forEach(r=>{const d=r.driver||'sql';counts[d]=(counts[d]||0)+1;});
else if(type==='logs')items.forEach(r=>{const l=(r.level||r.levelname||'info').toLowerCase();counts[l]=(counts[l]||0)+1;});
else if(type==='functions')items.forEach(r=>{counts[r.module||'?']=(counts[r.module||'?']||0)+1;});
else return'';
return Object.entries(counts).map(([k,v])=>'<span class="facet" onclick="filterFacet(this,\\''+k+'\\')">'+k+' ('+v+')</span>').join('');}
function filterFacet(el,val){const active=el.classList.toggle('active');
if(active){searchQuery=val;document.getElementById('search').value=val;}else{searchQuery='';document.getElementById('search').value='';}render();}
function toggleRow(tr){const next=tr.nextElementSibling;next.style.display=next.style.display==='none'?'':'none';}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');
currentTab=t.dataset.tab;render();}));
document.getElementById('search').addEventListener('input',e=>{searchQuery=e.target.value;render();});
load();setInterval(load,5000);
</script>
</body></html>`;
}

export function serveDashboard(opts: { port?: number; dir?: string }): void {
  const port = opts.port || 4321;
  const trickleDir = opts.dir || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return;
  }

  // Run monitor to generate alerts
  try {
    const { runMonitor } = require('./monitor');
    runMonitor({ dir: trickleDir });
  } catch {}

  const server = http.createServer((req, res) => {
    if (req.url === '/api/data') {
      // JSON API endpoint — all data for client-side rendering
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const data = {
        alerts: readJsonl(path.join(trickleDir, 'alerts.jsonl')),
        functions: readJsonl(path.join(trickleDir, 'observations.jsonl')),
        queries: readJsonl(path.join(trickleDir, 'queries.jsonl')),
        errors: readJsonl(path.join(trickleDir, 'errors.jsonl')),
        profile: readJsonl(path.join(trickleDir, 'profile.jsonl')),
        calltrace: readJsonl(path.join(trickleDir, 'calltrace.jsonl')),
        logs: readJsonl(path.join(trickleDir, 'logs.jsonl')),
        variables: readJsonl(path.join(trickleDir, 'variables.jsonl')),
      };
      res.end(JSON.stringify(data));
      return;
    }
    // Serve dashboard HTML (enhanced version loads data via API for interactivity)
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateAdvancedDashboardHtml(port));
  });

  server.listen(port, () => {
    console.log('');
    console.log(chalk.bold('  trickle dashboard'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`  API:       ${chalk.cyan(`http://localhost:${port}/api/data`)}`);
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(chalk.gray('  Press Ctrl+C to stop'));
    console.log('');

    // Open in browser
    const { exec } = require('child_process');
    if (process.platform === 'darwin') exec(`open http://localhost:${port}`);
    else if (process.platform === 'linux') exec(`xdg-open http://localhost:${port}`);
  });
}
