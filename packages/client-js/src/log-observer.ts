/**
 * Structured log observer — patches popular Node.js logging libraries
 * to capture structured log entries with context.
 *
 * Supports:
 *   - winston (most popular Node.js logger, 13M weekly downloads)
 *   - pino (fastest Node.js logger, 5M weekly downloads)
 *   - bunyan (legacy but still used, 1M weekly downloads)
 *
 * Writes to .trickle/logs.jsonl as:
 *   { "kind": "log", "level": "error", "logger": "winston",
 *     "message": "User not found", "timestamp": 1710516000,
 *     "meta": { "userId": 123 } }
 */

import * as fs from 'fs';
import * as path from 'path';

interface LogRecord {
  kind: 'log';
  level: string;
  logger: string;
  message: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

let logsFile: string | null = null;
let debugMode = false;
const MAX_LOGS = 1000;
let logCount = 0;
const buffer: string[] = [];

function getLogsFile(): string {
  if (logsFile) return logsFile;
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  logsFile = path.join(dir, 'logs.jsonl');
  try { fs.writeFileSync(logsFile, ''); } catch {}
  return logsFile;
}

function writeLog(record: LogRecord): void {
  if (logCount >= MAX_LOGS) return;
  logCount++;
  buffer.push(JSON.stringify(record));
  if (buffer.length >= 20) {
    flushLogs();
  }
}

function flushLogs(): void {
  if (buffer.length === 0) return;
  try {
    fs.appendFileSync(getLogsFile(), buffer.join('\n') + '\n');
  } catch {}
  buffer.length = 0;
}

// Flush on exit
process.on('exit', flushLogs);

/**
 * Patch winston to capture structured log entries.
 * Winston uses transports — we add a custom transport that writes to logs.jsonl.
 */
export function patchWinston(winstonModule: any, debug: boolean): void {
  debugMode = debug;

  if ((winstonModule as any).__trickle_patched) return;
  (winstonModule as any).__trickle_patched = true;

  getLogsFile(); // Initialize file

  // Create a custom transport
  const Transport = winstonModule.Transport;
  if (!Transport) return;

  class TrickleTransport extends Transport {
    constructor(opts?: any) {
      super(opts);
    }

    log(info: any, callback: () => void): void {
      const level = info.level || info[Symbol.for('level')] || 'info';
      const message = info.message || info[Symbol.for('message')] || '';

      // Extract metadata (everything except level, message, and internal symbols)
      const meta: Record<string, unknown> = {};
      for (const key of Object.keys(info)) {
        if (key !== 'level' && key !== 'message' && key !== 'timestamp' && key !== 'splat') {
          const val = info[key];
          if (val !== undefined && typeof val !== 'symbol' && typeof val !== 'function') {
            try {
              JSON.stringify(val);
              meta[key] = val;
            } catch {}
          }
        }
      }

      writeLog({
        kind: 'log',
        level: String(level),
        logger: 'winston',
        message: String(message).substring(0, 500),
        timestamp: Date.now(),
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });

      if (callback) callback();
    }
  }

  // Patch createLogger to auto-add our transport
  const origCreateLogger = winstonModule.createLogger;
  if (origCreateLogger && !(origCreateLogger as any).__trickle_patched) {
    winstonModule.createLogger = function patchedCreateLogger(opts: any = {}) {
      const logger = origCreateLogger(opts);
      try {
        logger.add(new TrickleTransport({ level: 'silly' }));
      } catch {}
      return logger;
    };
    (winstonModule.createLogger as any).__trickle_patched = true;
  }

  // Also patch the default logger if it exists
  if (winstonModule.add && winstonModule.transports) {
    try {
      winstonModule.add(new TrickleTransport({ level: 'silly' }));
    } catch {}
  }

  if (debug) console.log('[trickle/log] Winston log tracing enabled');
}

/**
 * Patch pino to capture structured log entries.
 * Pino uses a destination stream — we wrap the pino factory to intercept log calls.
 */
export function patchPino(pinoModule: any, debug: boolean): void {
  debugMode = debug;

  const pinoFn = pinoModule.default || pinoModule;
  if (typeof pinoFn !== 'function' || (pinoFn as any).__trickle_patched) return;

  getLogsFile(); // Initialize file

  const PINO_LEVELS: Record<number, string> = {
    10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
  };

  const wrappedPino = function patchedPino(this: any, ...args: any[]): any {
    const logger = pinoFn.apply(this, args);

    // Wrap the logger's write method to intercept log entries
    const origWrite = logger[Symbol.for('pino.write')] || logger.write;
    if (origWrite && typeof origWrite === 'function') {
      const interceptWrite = function (this: any, obj: any, ...rest: any[]): any {
        try {
          const parsed = typeof obj === 'string' ? JSON.parse(obj) : obj;
          const level = PINO_LEVELS[parsed.level] || String(parsed.level || 'info');
          const message = parsed.msg || parsed.message || '';

          const meta: Record<string, unknown> = {};
          for (const key of Object.keys(parsed)) {
            if (!['level', 'time', 'pid', 'hostname', 'msg', 'message', 'v'].includes(key)) {
              meta[key] = parsed[key];
            }
          }

          writeLog({
            kind: 'log',
            level,
            logger: 'pino',
            message: String(message).substring(0, 500),
            timestamp: parsed.time || Date.now(),
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          });
        } catch {}
        return origWrite.apply(this, [obj, ...rest]);
      };

      if (logger[Symbol.for('pino.write')]) {
        logger[Symbol.for('pino.write')] = interceptWrite;
      }
    }

    // Also wrap individual level methods as fallback
    for (const levelName of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const orig = logger[levelName];
      if (orig && typeof orig === 'function' && !(orig as any).__trickle_patched) {
        logger[levelName] = function (this: any, ...logArgs: any[]) {
          try {
            let message = '';
            let meta: Record<string, unknown> | undefined;

            if (typeof logArgs[0] === 'object' && logArgs[0] !== null && !(logArgs[0] instanceof Error)) {
              meta = {};
              for (const [k, v] of Object.entries(logArgs[0])) {
                try { JSON.stringify(v); meta[k] = v; } catch {}
              }
              message = logArgs.length > 1 ? String(logArgs[1]).substring(0, 500) : '';
            } else if (logArgs[0] instanceof Error) {
              message = logArgs[0].message.substring(0, 500);
              meta = { errorType: logArgs[0].name, stack: logArgs[0].stack?.substring(0, 200) };
            } else {
              message = String(logArgs[0] || '').substring(0, 500);
            }

            writeLog({
              kind: 'log',
              level: levelName,
              logger: 'pino',
              message,
              timestamp: Date.now(),
              meta,
            });
          } catch {}
          return orig.apply(this, logArgs);
        };
        (logger[levelName] as any).__trickle_patched = true;
      }
    }

    return logger;
  };

  // Copy properties
  Object.setPrototypeOf(wrappedPino, pinoFn);
  for (const key of Object.getOwnPropertyNames(pinoFn)) {
    if (key !== 'length' && key !== 'name' && key !== 'prototype') {
      try { Object.defineProperty(wrappedPino, key, Object.getOwnPropertyDescriptor(pinoFn, key)!); } catch {}
    }
  }

  if (pinoModule.default) {
    pinoModule.default = wrappedPino;
  } else {
    // pino exports the function as module.exports — observe-register handles replacement
  }
  (wrappedPino as any).__trickle_patched = true;

  if (debug) console.log('[trickle/log] Pino log tracing enabled');

  return wrappedPino as any; // Return for observe-register to use
}

/**
 * Patch bunyan to capture structured log entries.
 * Bunyan loggers have addStream() — we add a custom stream.
 */
export function patchBunyan(bunyanModule: any, debug: boolean): void {
  debugMode = debug;

  if ((bunyanModule as any).__trickle_patched) return;
  (bunyanModule as any).__trickle_patched = true;

  getLogsFile(); // Initialize file

  const BUNYAN_LEVELS: Record<number, string> = {
    10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
  };

  const origCreateLogger = bunyanModule.createLogger;
  if (!origCreateLogger) return;

  bunyanModule.createLogger = function patchedCreateLogger(opts: any) {
    const logger = origCreateLogger(opts);

    // Add a trickle stream
    try {
      logger.addStream({
        level: 'trace',
        type: 'raw',
        stream: {
          write(rec: any): void {
            try {
              const level = BUNYAN_LEVELS[rec.level] || String(rec.level || 'info');
              const message = rec.msg || '';

              const meta: Record<string, unknown> = {};
              for (const key of Object.keys(rec)) {
                if (!['v', 'level', 'name', 'hostname', 'pid', 'time', 'msg', 'src'].includes(key)) {
                  try { JSON.stringify(rec[key]); meta[key] = rec[key]; } catch {}
                }
              }

              writeLog({
                kind: 'log',
                level,
                logger: `bunyan:${rec.name || 'default'}`,
                message: String(message).substring(0, 500),
                timestamp: rec.time ? new Date(rec.time).getTime() : Date.now(),
                meta: Object.keys(meta).length > 0 ? meta : undefined,
              });
            } catch {}
          },
        },
      });
    } catch {}

    return logger;
  };

  if (debug) console.log('[trickle/log] Bunyan log tracing enabled');
}
