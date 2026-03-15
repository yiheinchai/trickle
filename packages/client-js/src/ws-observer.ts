/**
 * WebSocket observer — patches popular WebSocket libraries to capture
 * message events, connection lifecycle, and timing.
 *
 * Supports:
 *   - ws (most popular Node.js WebSocket library)
 *   - Native WebSocket (browser/Deno/Bun)
 *   - socket.io (real-time framework)
 *
 * Written to .trickle/websocket.jsonl as:
 *   { "kind": "ws", "event": "message", "direction": "in",
 *     "data": "...", "timestamp": 1710516000, "url": "ws://..." }
 */

import * as fs from 'fs';
import * as path from 'path';

interface WsEvent {
  kind: 'ws';
  event: 'connect' | 'message' | 'close' | 'error' | 'emit';
  direction?: 'in' | 'out';
  url?: string;
  data?: unknown;
  channel?: string;
  timestamp: number;
}

let wsFile: string | null = null;
const MAX_EVENTS = 200;
let eventCount = 0;
const MAX_DATA_LENGTH = 500;

function getWsFile(): string {
  if (wsFile) return wsFile;
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  wsFile = path.join(dir, 'websocket.jsonl');
  try { fs.writeFileSync(wsFile, ''); } catch {};
  return wsFile;
}

function writeWsEvent(event: WsEvent): void {
  if (eventCount >= MAX_EVENTS) return;
  eventCount++;
  try {
    fs.appendFileSync(getWsFile(), JSON.stringify(event) + '\n');
  } catch {}
}

function truncateData(data: unknown): unknown {
  if (data === undefined || data === null) return data;
  if (typeof data === 'string') {
    return data.length > MAX_DATA_LENGTH ? data.substring(0, MAX_DATA_LENGTH) + '...' : data;
  }
  if (Buffer.isBuffer(data)) {
    return `<Buffer(${data.length} bytes)>`;
  }
  if (typeof data === 'object') {
    try {
      const s = JSON.stringify(data);
      return s.length > MAX_DATA_LENGTH ? JSON.parse(s.substring(0, MAX_DATA_LENGTH) + '..."}}') : data;
    } catch {
      return String(data).substring(0, MAX_DATA_LENGTH);
    }
  }
  return data;
}

/**
 * Patch ws (node WebSocket library) to capture messages.
 */
export function patchWs(wsModule: any, debug: boolean): void {
  const WsClass = wsModule.WebSocket || wsModule;
  if (!WsClass?.prototype || (WsClass.prototype as any).__trickle_ws_patched) return;

  const origSend = WsClass.prototype.send;
  if (origSend) {
    WsClass.prototype.send = function patchedSend(data: any, ...args: any[]) {
      writeWsEvent({
        kind: 'ws',
        event: 'message',
        direction: 'out',
        url: this.url || this._url,
        data: truncateData(data),
        timestamp: Date.now(),
      });
      return origSend.call(this, data, ...args);
    };
  }

  // Patch 'on' to capture incoming messages
  const origOn = WsClass.prototype.on;
  if (origOn) {
    WsClass.prototype.on = function patchedOn(event: string, listener: any, ...args: any[]) {
      if (event === 'message') {
        const wrappedListener = (data: any, ...rest: any[]) => {
          writeWsEvent({
            kind: 'ws',
            event: 'message',
            direction: 'in',
            url: this.url || this._url,
            data: truncateData(data),
            timestamp: Date.now(),
          });
          return listener(data, ...rest);
        };
        return origOn.call(this, event, wrappedListener, ...args);
      }
      if (event === 'open') {
        const wrappedListener = (...rest: any[]) => {
          writeWsEvent({
            kind: 'ws',
            event: 'connect',
            url: this.url || this._url,
            timestamp: Date.now(),
          });
          return listener(...rest);
        };
        return origOn.call(this, event, wrappedListener, ...args);
      }
      if (event === 'close') {
        const wrappedListener = (code: number, reason: string, ...rest: any[]) => {
          writeWsEvent({
            kind: 'ws',
            event: 'close',
            url: this.url || this._url,
            data: { code, reason: String(reason || '').substring(0, 100) },
            timestamp: Date.now(),
          });
          return listener(code, reason, ...rest);
        };
        return origOn.call(this, event, wrappedListener, ...args);
      }
      return origOn.call(this, event, listener, ...args);
    };
  }

  (WsClass.prototype as any).__trickle_ws_patched = true;
  if (debug) console.log('[trickle/ws] WebSocket tracing enabled');
}

/**
 * Patch socket.io client to capture emit/on events.
 */
export function patchSocketIo(ioModule: any, debug: boolean): void {
  // socket.io-client: the default export is a function that returns a Socket
  const Socket = ioModule.Socket || (ioModule.io && ioModule.io.Socket);
  if (!Socket?.prototype || (Socket.prototype as any).__trickle_sio_patched) return;

  const origEmit = Socket.prototype.emit;
  if (origEmit) {
    Socket.prototype.emit = function patchedEmit(event: string, ...args: any[]) {
      if (event !== 'connect' && event !== 'disconnect' && !event.startsWith('__')) {
        writeWsEvent({
          kind: 'ws',
          event: 'emit',
          direction: 'out',
          channel: event,
          data: truncateData(args[0]),
          timestamp: Date.now(),
        });
      }
      return origEmit.call(this, event, ...args);
    };
  }

  const origOn = Socket.prototype.on;
  if (origOn) {
    Socket.prototype.on = function patchedOn(event: string, listener: any, ...rest: any[]) {
      if (event !== 'connect' && event !== 'disconnect' && !event.startsWith('__')) {
        const wrappedListener = (...args: any[]) => {
          writeWsEvent({
            kind: 'ws',
            event: 'emit',
            direction: 'in',
            channel: event,
            data: truncateData(args[0]),
            timestamp: Date.now(),
          });
          return listener(...args);
        };
        return origOn.call(this, event, wrappedListener, ...rest);
      }
      return origOn.call(this, event, listener, ...rest);
    };
  }

  (Socket.prototype as any).__trickle_sio_patched = true;
  if (debug) console.log('[trickle/ws] socket.io tracing enabled');
}
