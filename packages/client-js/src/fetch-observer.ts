/**
 * Fetch observer — patches global.fetch to automatically capture
 * request/response types from HTTP calls made by user code.
 *
 * When your app does:
 *   const data = await fetch('https://api.example.com/users').then(r => r.json());
 *
 * Trickle captures:
 *   - Function name: "GET /users" (method + path)
 *   - Module: "api.example.com" (hostname)
 *   - Input type: request body (for POST/PUT/PATCH)
 *   - Return type: inferred from JSON response
 *   - Sample data: actual response payload
 *
 * The observer only intercepts when .json() is called, so:
 *   - Non-JSON responses (HTML, binary) are ignored
 *   - The original response is never modified
 *   - No extra network requests are made
 */

import { TypeNode, IngestPayload } from './types';
import { inferType } from './type-inference';
import { hashType } from './type-hash';
import { enqueue } from './transport';

// Track which type hashes we've already sent to avoid duplicates
const sentHashes = new Set<string>();

/**
 * Patch global.fetch to observe JSON responses.
 * Safe to call multiple times (idempotent).
 */
export function patchFetch(environment: string, debugMode: boolean): void {
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch;

  // Guard against double-patching
  if ((originalFetch as any).__trickle_patched) return;

  globalThis.fetch = async function trickleObservedFetch(
    input: any,
    init?: any,
  ): Promise<Response> {
    // Extract URL and method before the request
    let url: string;
    let method: string;

    if (typeof input === 'string') {
      url = input;
      method = init?.method?.toUpperCase() || 'GET';
    } else if (input instanceof URL) {
      url = input.href;
      method = init?.method?.toUpperCase() || 'GET';
    } else if (typeof input === 'object' && input !== null && 'url' in input) {
      // Request object
      url = (input as any).url;
      method = (init?.method || (input as any).method || 'GET').toUpperCase();
    } else {
      url = String(input);
      method = init?.method?.toUpperCase() || 'GET';
    }

    // Skip trickle's own backend calls
    if (url.includes('/api/ingest') || url.includes('/api/functions') || url.includes('/api/health')) {
      return originalFetch.call(globalThis, input, init);
    }

    // Inject distributed trace headers
    if (!init) init = {};
    if (!init.headers) init.headers = {};
    const traceId = (globalThis as any).__trickle_trace_id || require('crypto').randomBytes(8).toString('hex');
    (globalThis as any).__trickle_trace_id = traceId;
    if (typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      (init.headers as any)['X-Trickle-Trace-Id'] = traceId;
      (init.headers as any)['X-Trickle-Service'] = process.env.TRICKLE_SERVICE_NAME || require('path').basename(process.cwd());
    }

    // Make the actual request with timing
    const startTime = performance.now();
    const response = await originalFetch.call(globalThis, input, init);
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    const statusCode = response.status;

    // Only observe JSON responses
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      return response;
    }

    // Write distributed trace span
    try {
      const tracesDir = process.env.TRICKLE_LOCAL_DIR || require('path').join(process.cwd(), '.trickle');
      const tracesFile = require('path').join(tracesDir, 'traces.jsonl');
      const span = {
        kind: 'trace', traceId, spanId: require('crypto').randomBytes(4).toString('hex'),
        parentSpanId: '0', service: process.env.TRICKLE_SERVICE_NAME || require('path').basename(process.cwd()),
        operation: `${method} ${url}`, durationMs, status: String(statusCode), timestamp: Date.now(),
        metadata: { direction: 'outgoing' },
      };
      require('fs').appendFileSync(tracesFile, JSON.stringify(span) + '\n');
    } catch {}

    // Clone and intercept: read the clone's JSON in background
    try {
      const cloned = response.clone();
      cloned.json().then((data: any) => {
        try {
          captureHttpResponse(method, url, init?.body, data, environment, debugMode, statusCode, durationMs);
        } catch {
          // Never interfere
        }
      }).catch(() => {});
    } catch {
      // Clone/read failed — ignore
    }

    return response;
  } as typeof fetch;

  // Mark as patched
  (globalThis.fetch as any).__trickle_patched = true;
}

/**
 * Parse a URL into a clean function name and module name.
 *   "https://api.example.com/v1/users?limit=10"
 *   → functionName: "GET /v1/users", module: "api.example.com"
 */
function parseUrl(method: string, rawUrl: string): { functionName: string; module: string } {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || '/';
    return {
      functionName: `${method} ${pathname}`,
      module: parsed.hostname || 'http',
    };
  } catch {
    // Relative URL or invalid — use as-is
    return {
      functionName: `${method} ${rawUrl}`,
      module: 'http',
    };
  }
}

/**
 * Capture the HTTP response type and enqueue it to the backend.
 */
function captureHttpResponse(
  method: string,
  url: string,
  requestBody: any,
  responseData: unknown,
  environment: string,
  debugMode: boolean,
  statusCode?: number,
  durationMs?: number,
): void {
  const { functionName, module: moduleName } = parseUrl(method, url);

  // Infer types
  const returnType = inferType(responseData, 5);

  // Infer request body type (for POST/PUT/PATCH)
  let argsType: TypeNode;
  if (requestBody && typeof requestBody === 'string') {
    try {
      const parsed = JSON.parse(requestBody);
      argsType = { kind: 'tuple', elements: [inferType(parsed, 5)] };
    } catch {
      argsType = { kind: 'tuple', elements: [] };
    }
  } else {
    argsType = { kind: 'tuple', elements: [] };
  }

  const hash = hashType(argsType, returnType);

  // Dedup — only send each unique type shape once
  const key = `${functionName}::${hash}`;
  if (sentHashes.has(key)) return;
  sentHashes.add(key);

  // Build sample input from request body
  let sampleInput: unknown = undefined;
  if (requestBody && typeof requestBody === 'string') {
    try {
      sampleInput = JSON.parse(requestBody);
    } catch {
      sampleInput = undefined;
    }
  }

  const payload: IngestPayload & { statusCode?: number } = {
    functionName: statusCode ? `${functionName} [${statusCode}]` : functionName,
    module: moduleName,
    language: 'js',
    environment,
    typeHash: hash,
    argsType,
    returnType,
    sampleInput: sampleInput ? [sampleInput] : undefined,
    sampleOutput: sanitizeSample(responseData),
    durationMs,
  };

  enqueue(payload as IngestPayload);

  if (debugMode) {
    console.log(`[trickle/fetch] Captured ${functionName} → ${describeType(returnType)}`);
  }
}

/**
 * Brief description of a type for debug logging.
 */
function describeType(type: TypeNode): string {
  if (type.kind === 'object') {
    const props = Object.keys(type.properties || {});
    if (props.length <= 4) return `{ ${props.join(', ')} }`;
    return `{ ${props.slice(0, 3).join(', ')}, ... } (${props.length} props)`;
  }
  if (type.kind === 'array') return `${describeType(type.element)}[]`;
  if (type.kind === 'primitive') return type.name;
  return type.kind;
}

/**
 * Sanitize sample data for storage (truncate large values).
 */
function sanitizeSample(value: unknown, depth: number = 3): unknown {
  if (depth <= 0) return '[truncated]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > 200 ? s.substring(0, 200) + '...' : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'function') return '[Function]';
  if (Array.isArray(value)) {
    return value.slice(0, 5).map(item => sanitizeSample(item, depth - 1));
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = Object.keys(obj).slice(0, 20);
    for (const key of keys) {
      try { result[key] = sanitizeSample(obj[key], depth - 1); } catch { result[key] = '[unreadable]'; }
    }
    return result;
  }
  return String(value);
}
