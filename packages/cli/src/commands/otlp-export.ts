/**
 * trickle export --otlp — export trickle data to OpenTelemetry (OTLP) format.
 *
 * Converts .trickle/ data files to OTLP JSON and sends to any OTLP-compatible
 * endpoint (Grafana, SigNoz, Jaeger, Datadog, etc.)
 *
 * Usage:
 *   trickle export --otlp http://localhost:4318    # send to OTLP HTTP endpoint
 *   trickle export --otlp --json                   # output OTLP JSON to stdout
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

function toNanos(ms: number): string {
  return String(Math.round(ms * 1_000_000));
}

function randomHexId(bytes: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < bytes * 2; i++) result += chars[Math.floor(Math.random() * 16)];
  return result;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } }>;
  status?: { code: number; message?: string };
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: Array<{ key: string; value: { stringValue: string } }>;
}

/**
 * Convert trickle call trace to OTLP spans.
 */
function calltraceToSpans(trickleDir: string, serviceName: string): OtlpSpan[] {
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  const callEvents = calltrace.filter(e => e.kind === 'call');
  if (callEvents.length === 0) return [];

  const traceId = randomHexId(16);
  const spans: OtlpSpan[] = [];

  for (const ev of callEvents) {
    const spanId = randomHexId(8);
    const startNano = String(ev.timestamp * 1_000_000);
    const endNano = String((ev.timestamp + (ev.durationMs || 0)) * 1_000_000);

    const span: OtlpSpan = {
      traceId,
      spanId,
      name: `${ev.module}.${ev.function}`,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes: [
        { key: 'code.function', value: { stringValue: ev.function } },
        { key: 'code.namespace', value: { stringValue: ev.module } },
      ],
    };

    if (ev.error) {
      span.status = { code: 2, message: ev.error }; // STATUS_CODE_ERROR
      span.attributes.push({ key: 'error.message', value: { stringValue: ev.error } });
    }

    if (ev.durationMs) {
      span.attributes.push({ key: 'duration_ms', value: { doubleValue: ev.durationMs } });
    }

    spans.push(span);
  }

  return spans;
}

/**
 * Convert trickle queries to OTLP spans.
 */
function queriesToSpans(trickleDir: string): OtlpSpan[] {
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  if (queries.length === 0) return [];

  const traceId = randomHexId(16);
  return queries.map(q => ({
    traceId,
    spanId: randomHexId(8),
    name: (q.query || '').substring(0, 100),
    kind: 3, // SPAN_KIND_CLIENT
    startTimeUnixNano: String((q.timestamp || Date.now()) * 1_000_000),
    endTimeUnixNano: String(((q.timestamp || Date.now()) + (q.durationMs || 0)) * 1_000_000),
    attributes: [
      { key: 'db.system', value: { stringValue: q.driver || 'sql' } },
      { key: 'db.statement', value: { stringValue: (q.query || '').substring(0, 500) } },
      { key: 'db.operation', value: { stringValue: (q.query || '').split(/\s+/)[0] || 'QUERY' } },
    ],
    status: q.error ? { code: 2, message: q.error } : undefined,
  }));
}

/**
 * Convert trickle logs to OTLP log records.
 */
function logsToOtlp(trickleDir: string): OtlpLogRecord[] {
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));
  const severityMap: Record<string, number> = {
    trace: 1, debug: 5, info: 9, warn: 13, warning: 13, error: 17, critical: 21, fatal: 21,
  };

  return logs.map(l => ({
    timeUnixNano: String((l.timestamp || Date.now()) * 1_000_000),
    severityNumber: severityMap[(l.level || l.levelname || 'info').toLowerCase()] || 9,
    severityText: (l.level || l.levelname || 'INFO').toUpperCase(),
    body: { stringValue: l.message || l.msg || '' },
    attributes: [
      ...(l.logger || l.name ? [{ key: 'logger.name', value: { stringValue: l.logger || l.name } }] : []),
      ...(l.file ? [{ key: 'code.filepath', value: { stringValue: l.file } }] : []),
    ],
  }));
}

export interface OtlpExportOptions {
  endpoint?: string;
  json?: boolean;
  dir?: string;
  serviceName?: string;
}

export async function exportOtlp(opts: OtlpExportOptions): Promise<void> {
  const trickleDir = opts.dir || process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  const serviceName = opts.serviceName || path.basename(process.cwd());

  if (!fs.existsSync(trickleDir)) {
    console.error(chalk.yellow('  No .trickle/ directory. Run trickle run first.'));
    return;
  }

  // Build OTLP payload
  const spans = [...calltraceToSpans(trickleDir, serviceName), ...queriesToSpans(trickleDir)];
  const logs = logsToOtlp(trickleDir);

  const tracesPayload = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'trickle' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'trickle', version: '1.0.0' },
        spans,
      }],
    }],
  };

  const logsPayload = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
        ],
      },
      scopeLogs: [{
        scope: { name: 'trickle' },
        logRecords: logs,
      }],
    }],
  };

  if (opts.json || !opts.endpoint) {
    console.log(JSON.stringify({ traces: tracesPayload, logs: logsPayload }, null, 2));
    return;
  }

  // Send to OTLP HTTP endpoint
  const endpoint = opts.endpoint.replace(/\/$/, '');

  console.log('');
  console.log(chalk.bold('  trickle export --otlp'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray(`  Endpoint: ${endpoint}`));
  console.log(chalk.gray(`  Service:  ${serviceName}`));

  let tracesOk = false;
  let logsOk = false;

  // Send traces
  if (spans.length > 0) {
    try {
      const res = await fetch(`${endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tracesPayload),
      });
      tracesOk = res.ok;
      console.log(`  Traces: ${spans.length} spans ${tracesOk ? chalk.green('✓ sent') : chalk.red('✗ ' + res.status)}`);
    } catch (err: any) {
      console.log(`  Traces: ${chalk.red('✗ ' + err.message)}`);
    }
  }

  // Send logs
  if (logs.length > 0) {
    try {
      const res = await fetch(`${endpoint}/v1/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logsPayload),
      });
      logsOk = res.ok;
      console.log(`  Logs:   ${logs.length} records ${logsOk ? chalk.green('✓ sent') : chalk.red('✗ ' + res.status)}`);
    } catch (err: any) {
      console.log(`  Logs:   ${chalk.red('✗ ' + err.message)}`);
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}
