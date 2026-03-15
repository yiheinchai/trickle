import { TypeNode } from './types';

const MAX_ARRAY_SAMPLE = 20;
const DEFAULT_MAX_DEPTH = 5;

/**
 * Infer the TypeNode representation of a runtime JavaScript value.
 * Uses a WeakSet to detect circular references.
 * Samples at most the first 20 elements of arrays for performance.
 */
export function inferType(value: unknown, maxDepth: number = DEFAULT_MAX_DEPTH): TypeNode {
  const seen = new WeakSet();
  return infer(value, maxDepth, seen);
}

function infer(value: unknown, depth: number, seen: WeakSet<object>): TypeNode {
  // Null
  if (value === null) {
    return { kind: 'primitive', name: 'null' };
  }

  // Undefined
  if (value === undefined) {
    return { kind: 'primitive', name: 'undefined' };
  }

  const t = typeof value;

  // Primitives
  if (t === 'string') return { kind: 'primitive', name: 'string' };
  if (t === 'number') return { kind: 'primitive', name: 'number' };
  if (t === 'boolean') return { kind: 'primitive', name: 'boolean' };
  if (t === 'bigint') return { kind: 'primitive', name: 'bigint' };
  if (t === 'symbol') return { kind: 'primitive', name: 'symbol' };

  // Functions
  if (t === 'function') {
    return {
      kind: 'function',
      params: new Array((value as Function).length).fill({ kind: 'unknown' } as TypeNode),
      returnType: { kind: 'unknown' },
    };
  }

  // Object types — check depth and circular refs
  if (t === 'object') {
    const obj = value as object;

    // Circular reference detection
    if (seen.has(obj)) {
      return { kind: 'unknown' };
    }

    if (depth <= 0) {
      return { kind: 'unknown' };
    }

    seen.add(obj);

    try {
      return inferObject(obj, depth, seen);
    } finally {
      // Don't remove from seen — keeps circular detection intact for the full traversal
    }
  }

  return { kind: 'unknown' };
}

function inferObject(obj: object, depth: number, seen: WeakSet<object>): TypeNode {
  // Promise
  if (obj instanceof Promise) {
    return { kind: 'promise', resolved: { kind: 'unknown' } };
  }

  // Map
  if (obj instanceof Map) {
    let keyType: TypeNode = { kind: 'unknown' };
    let valType: TypeNode = { kind: 'unknown' };
    let count = 0;
    const keyTypes: TypeNode[] = [];
    const valTypes: TypeNode[] = [];

    for (const [k, v] of obj) {
      if (count >= MAX_ARRAY_SAMPLE) break;
      keyTypes.push(infer(k, depth - 1, seen));
      valTypes.push(infer(v, depth - 1, seen));
      count++;
    }

    keyType = unifyTypes(keyTypes);
    valType = unifyTypes(valTypes);

    return { kind: 'map', key: keyType, value: valType };
  }

  // Set
  if (obj instanceof Set) {
    const elementTypes: TypeNode[] = [];
    let count = 0;
    for (const item of obj) {
      if (count >= MAX_ARRAY_SAMPLE) break;
      elementTypes.push(infer(item, depth - 1, seen));
      count++;
    }
    return { kind: 'set', element: unifyTypes(elementTypes) };
  }

  // Array (including TypedArrays)
  if (Array.isArray(obj)) {
    return inferArray(obj, depth, seen);
  }

  // TypedArrays (not real arrays)
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    return {
      kind: 'object',
      properties: {
        __typedArray: { kind: 'primitive', name: 'string' },
        length: { kind: 'primitive', name: 'number' },
      },
    };
  }

  // Buffer (Node.js)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) {
    return {
      kind: 'object',
      properties: {
        __buffer: { kind: 'primitive', name: 'string' },
        length: { kind: 'primitive', name: 'number' },
      },
    };
  }

  // Date
  if (obj instanceof Date) {
    return {
      kind: 'object',
      properties: {
        __date: { kind: 'primitive', name: 'string' },
      },
    };
  }

  // RegExp
  if (obj instanceof RegExp) {
    return {
      kind: 'object',
      properties: {
        __regexp: { kind: 'primitive', name: 'string' },
        source: { kind: 'primitive', name: 'string' },
        flags: { kind: 'primitive', name: 'string' },
      },
    };
  }

  // Error
  if (obj instanceof Error) {
    return {
      kind: 'object',
      properties: {
        __error: { kind: 'primitive', name: 'string' },
        name: { kind: 'primitive', name: 'string' },
        message: { kind: 'primitive', name: 'string' },
        stack: { kind: 'primitive', name: 'string' },
      },
    };
  }

  // Known complex framework objects — use class name instead of deep introspection.
  // These types have dozens of internal properties that generate unusably verbose stubs.
  const className = obj.constructor?.name;
  const OPAQUE_CLASSES = new Set([
    // Node.js HTTP internals
    'IncomingMessage', 'ServerResponse', 'Socket', 'Server',
    'ReadableState', 'WritableState',
    // Express
    'IncomingMessage', // Express req extends this
    // Streams
    'Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough',
    // EventEmitter
    'EventEmitter',
  ]);
  if (className && OPAQUE_CLASSES.has(className)) {
    return { kind: 'object', properties: {}, class_name: className };
  }

  // Plain objects
  return inferPlainObject(obj, depth, seen);
}

function inferArray(arr: unknown[], depth: number, seen: WeakSet<object>): TypeNode {
  if (arr.length === 0) {
    return { kind: 'array', element: { kind: 'unknown' } };
  }

  const sampleSize = Math.min(arr.length, MAX_ARRAY_SAMPLE);
  const elementTypes: TypeNode[] = [];

  for (let i = 0; i < sampleSize; i++) {
    elementTypes.push(infer(arr[i], depth - 1, seen));
  }

  return { kind: 'array', element: unifyTypes(elementTypes) };
}

const MAX_PROPERTIES = 12;

function inferPlainObject(obj: object, depth: number, seen: WeakSet<object>): TypeNode {
  const properties: Record<string, TypeNode> = {};
  const keys = Object.keys(obj);

  // Skip internal/private properties (common in Node.js built-in objects like
  // http.Server, streams, etc.) — they make generated types unusably verbose.
  const publicKeys = keys.filter(k => !k.startsWith('_'));
  // If filtering removed everything, use all keys (it's a plain data object with _ keys)
  const effectiveKeys = publicKeys.length > 0 ? publicKeys : keys;
  // Cap the number of properties to keep types manageable
  const cappedKeys = effectiveKeys.slice(0, MAX_PROPERTIES);

  for (const key of cappedKeys) {
    try {
      properties[key] = infer((obj as Record<string, unknown>)[key], depth - 1, seen);
    } catch {
      properties[key] = { kind: 'unknown' };
    }
  }

  return { kind: 'object', properties };
}

/**
 * Unify an array of TypeNodes into a single TypeNode.
 * If all types are structurally identical, returns that type.
 * Otherwise, returns a union of the distinct types.
 */
function unifyTypes(types: TypeNode[]): TypeNode {
  if (types.length === 0) return { kind: 'unknown' };
  if (types.length === 1) return types[0];

  // Deduplicate by serialization
  const uniqueMap = new Map<string, TypeNode>();
  for (const t of types) {
    const key = canonicalStringify(t);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, t);
    }
  }

  const unique = Array.from(uniqueMap.values());
  if (unique.length === 1) return unique[0];

  // Flatten nested unions
  const members: TypeNode[] = [];
  for (const u of unique) {
    if (u.kind === 'union') {
      members.push(...u.members);
    } else {
      members.push(u);
    }
  }

  // Deduplicate again after flattening
  const finalMap = new Map<string, TypeNode>();
  for (const m of members) {
    const key = canonicalStringify(m);
    if (!finalMap.has(key)) {
      finalMap.set(key, m);
    }
  }

  const finalMembers = Array.from(finalMap.values());
  if (finalMembers.length === 1) return finalMembers[0];

  return { kind: 'union', members: finalMembers };
}

function canonicalStringify(node: TypeNode): string {
  if (node.kind === 'object') {
    const sorted = Object.keys(node.properties).sort();
    const entries = sorted.map(k => `${JSON.stringify(k)}:${canonicalStringify(node.properties[k])}`);
    return `{object:{${entries.join(',')}}}`;
  }
  if (node.kind === 'union') {
    const sorted = node.members.map(canonicalStringify).sort();
    return `{union:[${sorted.join(',')}]}`;
  }
  if (node.kind === 'array') {
    return `{array:${canonicalStringify(node.element)}}`;
  }
  if (node.kind === 'primitive') {
    return `{prim:${node.name}}`;
  }
  if (node.kind === 'function') {
    return `{fn:[${node.params.map(canonicalStringify).join(',')}]->${canonicalStringify(node.returnType)}}`;
  }
  if (node.kind === 'promise') {
    return `{promise:${canonicalStringify(node.resolved)}}`;
  }
  if (node.kind === 'map') {
    return `{map:${canonicalStringify(node.key)},${canonicalStringify(node.value)}}`;
  }
  if (node.kind === 'set') {
    return `{set:${canonicalStringify(node.element)}}`;
  }
  if (node.kind === 'tuple') {
    return `{tuple:[${node.elements.map(canonicalStringify).join(',')}]}`;
  }
  return '{unknown}';
}

export { unifyTypes };
