/**
 * Library functions used by test-zerocode-app.js.
 * NOTE: This file has ZERO trickle imports — instrumentation happens
 * externally via `node -r trickle/auto`.
 */

function parseCSV(text, delimiter) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(delimiter || ',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(delimiter || ',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
  return { headers, rows, rowCount: rows.length };
}

function slugify(text, separator) {
  const sep = separator || '-';
  return {
    original: text,
    slug: text.toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^${sep}|${sep}$`, 'g'), ''),
    length: text.length,
  };
}

function mergeConfig(defaults, overrides) {
  const merged = { ...defaults };
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined && val !== null) {
      merged[key] = val;
    }
  }
  return {
    config: merged,
    overriddenKeys: Object.keys(overrides).filter(k => overrides[k] !== undefined),
    totalKeys: Object.keys(merged).length,
  };
}

module.exports = { parseCSV, slugify, mergeConfig };
