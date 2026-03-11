import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHtml());
});

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>trickle dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }

  header { display: flex; align-items: center; justify-content: space-between;
    padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header h1 span { color: var(--accent); }
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.live { background: var(--green); animation: pulse 2s infinite; }
  .dot.off { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; }
  .stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

  .search { margin-bottom: 16px; }
  .search input { width: 100%; padding: 10px 14px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; color: var(--text);
    font-size: 14px; outline: none; }
  .search input:focus { border-color: var(--accent); }
  .search input::placeholder { color: var(--muted); }

  .route-list { display: flex; flex-direction: column; gap: 8px; }
  .route { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden; transition: border-color 0.15s; }
  .route:hover { border-color: var(--accent); }
  .route.new { animation: highlight 1.5s; }
  @keyframes highlight { 0% { border-color: var(--green); box-shadow: 0 0 12px rgba(63,185,80,0.15); }
    100% { border-color: var(--border); box-shadow: none; } }

  .route-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    cursor: pointer; user-select: none; }
  .method { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;
    text-transform: uppercase; letter-spacing: 0.5px; }
  .method.get { background: rgba(63,185,80,0.15); color: var(--green); }
  .method.post { background: rgba(88,166,255,0.15); color: var(--accent); }
  .method.put { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .method.delete { background: rgba(248,81,73,0.15); color: var(--red); }
  .method.patch { background: rgba(188,140,255,0.15); color: var(--purple); }
  .route-path { font-size: 14px; font-weight: 500; font-family: 'SF Mono', Menlo, monospace; }
  .route-meta { margin-left: auto; font-size: 12px; color: var(--muted); }
  .chevron { color: var(--muted); transition: transform 0.15s; font-size: 12px; }
  .route.open .chevron { transform: rotate(90deg); }

  .route-detail { display: none; padding: 0 16px 16px; border-top: 1px solid var(--border); }
  .route.open .route-detail { display: block; }

  .type-section { margin-top: 12px; }
  .type-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 6px; }
  .type-block { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px;
    line-height: 1.6; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .type-block .key { color: var(--accent); }
  .type-block .type { color: var(--green); }
  .type-block .punct { color: var(--muted); }

  .sample-section { margin-top: 12px; }
  .sample-block { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; font-family: 'SF Mono', Menlo, monospace; font-size: 12px;
    line-height: 1.5; overflow-x: auto; white-space: pre-wrap; color: var(--muted); max-height: 200px; overflow-y: auto; }

  .empty { text-align: center; padding: 48px; color: var(--muted); }
  .empty p { margin-top: 8px; font-size: 14px; }

  .live-banner { display: none; padding: 8px 16px; background: rgba(63,185,80,0.1);
    border: 1px solid rgba(63,185,80,0.3); border-radius: 6px; margin-bottom: 16px;
    font-size: 13px; color: var(--green); text-align: center; }
  .live-banner.show { display: block; animation: fadeIn 0.3s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

  .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .tab { padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
    color: var(--muted); background: transparent; border: 1px solid transparent; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); background: var(--surface); border-color: var(--border); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>trickle</span> dashboard</h1>
    <div class="status">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">connecting...</span>
    </div>
  </header>

  <div class="stats" id="stats"></div>

  <div class="live-banner" id="liveBanner">New types observed — view updated</div>

  <div class="search">
    <input type="text" id="searchInput" placeholder="Search routes... (e.g. /api/users, GET, POST)">
  </div>

  <div class="tabs" id="tabs">
    <div class="tab active" data-filter="all">All</div>
    <div class="tab" data-filter="GET">GET</div>
    <div class="tab" data-filter="POST">POST</div>
    <div class="tab" data-filter="PUT">PUT</div>
    <div class="tab" data-filter="DELETE">DELETE</div>
  </div>

  <div class="route-list" id="routeList"></div>
</div>

<script>
const API = window.location.origin;
let allRoutes = [];
let currentFilter = 'all';
let searchQuery = '';

async function fetchRoutes() {
  try {
    const res = await fetch(API + '/api/functions?limit=500');
    const data = await res.json();
    return data.functions || [];
  } catch { return []; }
}

async function fetchSnapshot(funcId, env) {
  try {
    const url = API + '/api/types/' + funcId + (env ? '?env=' + env : '');
    const res = await fetch(url);
    const data = await res.json();
    return data.snapshots?.[0] || null;
  } catch { return null; }
}

async function fetchMockConfig() {
  try {
    const res = await fetch(API + '/api/mock-config');
    const data = await res.json();
    return data.routes || [];
  } catch { return []; }
}

function parseRoute(name) {
  const m = name.match(/^(GET|POST|PUT|DELETE|PATCH)\\s+(.+)$/i);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2] };
}

function timeAgo(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function renderTypeNode(node, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  if (!node || !node.kind) return '<span class="type">unknown</span>';

  switch (node.kind) {
    case 'primitive':
      return '<span class="type">' + node.name + '</span>';
    case 'unknown':
      return '<span class="type">unknown</span>';
    case 'array':
      return renderTypeNode(node.element, indent) + '<span class="punct">[]</span>';
    case 'object': {
      const keys = Object.keys(node.properties || {});
      if (keys.length === 0) return '<span class="punct">{}</span>';
      let s = '<span class="punct">{</span>\\n';
      for (const k of keys) {
        s += pad + '  <span class="key">' + k + '</span><span class="punct">: </span>';
        s += renderTypeNode(node.properties[k], indent + 1);
        s += '<span class="punct">;</span>\\n';
      }
      s += pad + '<span class="punct">}</span>';
      return s;
    }
    case 'union': {
      return (node.members || []).map(m => renderTypeNode(m, indent)).join(' <span class="punct">|</span> ');
    }
    case 'tuple': {
      const els = (node.elements || []).map(e => renderTypeNode(e, indent));
      return '<span class="punct">[</span>' + els.join(', ') + '<span class="punct">]</span>';
    }
    case 'map':
      return '<span class="type">Map</span><span class="punct">&lt;</span>' +
        renderTypeNode(node.key, indent) + ', ' + renderTypeNode(node.value, indent) +
        '<span class="punct">&gt;</span>';
    case 'set':
      return '<span class="type">Set</span><span class="punct">&lt;</span>' +
        renderTypeNode(node.element, indent) + '<span class="punct">&gt;</span>';
    case 'promise':
      return '<span class="type">Promise</span><span class="punct">&lt;</span>' +
        renderTypeNode(node.resolved, indent) + '<span class="punct">&gt;</span>';
    case 'function':
      return '<span class="type">Function</span>';
    default:
      return '<span class="type">unknown</span>';
  }
}

function renderRoute(r) {
  const parsed = parseRoute(r.function_name);
  if (!parsed) return '';
  const method = parsed.method.toLowerCase();
  const ago = timeAgo(r.last_seen_at);

  return '<div class="route" data-method="' + parsed.method + '" data-id="' + r.id + '">' +
    '<div class="route-header" onclick="toggleRoute(this.parentElement)">' +
    '<span class="chevron">&#9654;</span>' +
    '<span class="method ' + method + '">' + parsed.method + '</span>' +
    '<span class="route-path">' + escHtml(parsed.path) + '</span>' +
    '<span class="route-meta">' + ago + '</span>' +
    '</div>' +
    '<div class="route-detail" id="detail-' + r.id + '"><div class="loading" style="color:var(--muted);font-size:13px;padding:8px 0">Loading types...</div></div>' +
    '</div>';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function toggleRoute(el) {
  el.classList.toggle('open');
  if (el.classList.contains('open')) {
    const id = el.dataset.id;
    const detail = document.getElementById('detail-' + id);
    if (detail.querySelector('.loading')) {
      const snap = await fetchSnapshot(id);
      const mockRoutes = await fetchMockConfig();
      const fn = allRoutes.find(r => r.id == id);
      const mockRoute = fn ? mockRoutes.find(m => m.functionName === fn.function_name) : null;

      let html = '';

      if (snap) {
        let argsType, returnType;
        try { argsType = typeof snap.args_type === 'string' ? JSON.parse(snap.args_type) : snap.args_type; } catch { argsType = null; }
        try { returnType = typeof snap.return_type === 'string' ? JSON.parse(snap.return_type) : snap.return_type; } catch { returnType = null; }

        if (returnType) {
          html += '<div class="type-section"><div class="type-label">Response Type</div>';
          html += '<div class="type-block">' + renderTypeNode(returnType, 0) + '</div></div>';
        }

        if (argsType) {
          // For routes, show body/params/query separately
          if (argsType.kind === 'object' && argsType.properties) {
            if (argsType.properties.body && argsType.properties.body.kind === 'object' &&
                Object.keys(argsType.properties.body.properties || {}).length > 0) {
              html += '<div class="type-section"><div class="type-label">Request Body</div>';
              html += '<div class="type-block">' + renderTypeNode(argsType.properties.body, 0) + '</div></div>';
            }
            if (argsType.properties.params && argsType.properties.params.kind === 'object' &&
                Object.keys(argsType.properties.params.properties || {}).length > 0) {
              html += '<div class="type-section"><div class="type-label">Path Params</div>';
              html += '<div class="type-block">' + renderTypeNode(argsType.properties.params, 0) + '</div></div>';
            }
            if (argsType.properties.query && argsType.properties.query.kind === 'object' &&
                Object.keys(argsType.properties.query.properties || {}).length > 0) {
              html += '<div class="type-section"><div class="type-label">Query Params</div>';
              html += '<div class="type-block">' + renderTypeNode(argsType.properties.query, 0) + '</div></div>';
            }
          }
        }
      }

      if (mockRoute && mockRoute.sampleOutput) {
        html += '<div class="sample-section"><div class="type-label">Sample Response</div>';
        html += '<div class="sample-block">' + escHtml(JSON.stringify(mockRoute.sampleOutput, null, 2)) + '</div></div>';
      }

      if (!html) html = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No type data available yet.</div>';
      detail.innerHTML = html;
    }
  }
}

function renderStats(routes) {
  const methods = {};
  let routeCount = 0;
  for (const r of routes) {
    const p = parseRoute(r.function_name);
    if (p) {
      routeCount++;
      methods[p.method] = (methods[p.method] || 0) + 1;
    }
  }

  let html = '<div class="stat"><div class="stat-value">' + routes.length + '</div><div class="stat-label">Functions</div></div>';
  html += '<div class="stat"><div class="stat-value">' + routeCount + '</div><div class="stat-label">API Routes</div></div>';
  for (const [m, c] of Object.entries(methods)) {
    html += '<div class="stat"><div class="stat-value">' + c + '</div><div class="stat-label">' + m + ' routes</div></div>';
  }
  document.getElementById('stats').innerHTML = html;
}

function applyFilters() {
  const cards = document.querySelectorAll('.route');
  cards.forEach(card => {
    const method = card.dataset.method;
    const text = card.textContent.toLowerCase();
    const matchFilter = currentFilter === 'all' || method === currentFilter;
    const matchSearch = !searchQuery || text.includes(searchQuery.toLowerCase());
    card.style.display = matchFilter && matchSearch ? '' : 'none';
  });
}

async function loadData() {
  allRoutes = await fetchRoutes();
  renderStats(allRoutes);

  if (allRoutes.length === 0) {
    document.getElementById('routeList').innerHTML =
      '<div class="empty"><h3>No observations yet</h3><p>Instrument your app and make some requests to see types here.</p></div>';
    return;
  }

  // Sort: routes first, then by last_seen_at descending
  const sorted = [...allRoutes].sort((a, b) => {
    const aRoute = parseRoute(a.function_name);
    const bRoute = parseRoute(b.function_name);
    if (aRoute && !bRoute) return -1;
    if (!aRoute && bRoute) return 1;
    return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime();
  });

  document.getElementById('routeList').innerHTML = sorted.map(renderRoute).join('');
  applyFilters();
}

// Search
document.getElementById('searchInput').addEventListener('input', e => {
  searchQuery = e.target.value;
  applyFilters();
});

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    applyFilters();
  });
});

// SSE for live updates
function connectSSE() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const banner = document.getElementById('liveBanner');

  try {
    const es = new EventSource(API + '/api/tail');
    es.onopen = () => {
      dot.className = 'dot live';
      text.textContent = 'live';
    };
    es.addEventListener('type_snapshot', () => {
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 3000);
      // Reload data
      loadData();
    });
    es.addEventListener('function_seen', () => {
      loadData();
    });
    es.onerror = () => {
      dot.className = 'dot off';
      text.textContent = 'disconnected';
      // Retry
      setTimeout(connectSSE, 5000);
    };
  } catch {
    dot.className = 'dot off';
    text.textContent = 'disconnected';
  }
}

// Health check
async function checkHealth() {
  try {
    const res = await fetch(API + '/api/health');
    if (res.ok) {
      document.getElementById('statusDot').className = 'dot live';
      document.getElementById('statusText').textContent = 'connected';
    }
  } catch {
    document.getElementById('statusDot').className = 'dot off';
    document.getElementById('statusText').textContent = 'disconnected';
  }
}

// Init
checkHealth();
loadData();
connectSSE();
</script>
</body>
</html>`;
}

export default router;
