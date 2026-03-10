import { TypeNode } from './types';
import { inferType } from './type-inference';

/**
 * Creates a deep Proxy around a value to track property accesses.
 * Returns the proxy and a function to retrieve all accessed paths with their inferred types.
 *
 * The proxy is designed to be fully transparent:
 * - Array.isArray() returns true for proxied arrays
 * - JSON.stringify works correctly
 * - typeof, ===, iteration, spread, Object.keys all work identically
 * - Symbol.toPrimitive, Symbol.iterator, Symbol.toStringTag are forwarded
 */
export function createTracker(value: unknown): {
  proxy: unknown;
  getAccessedPaths: () => Map<string, TypeNode>;
} {
  const accessedPaths = new Map<string, TypeNode>();
  const proxyCache = new WeakMap<object, unknown>();

  function wrap(val: unknown, path: string): unknown {
    // Only proxy objects and arrays (not primitives or functions at top level)
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object' && typeof val !== 'function') return val;

    const obj = val as object;

    // Check cache to prevent double-wrapping
    if (proxyCache.has(obj)) {
      return proxyCache.get(obj);
    }

    // For arrays, the proxy target must be an array so Array.isArray() works
    const target = Array.isArray(obj) ? obj : obj;

    const proxy = new Proxy(target, {
      get(target: any, prop: string | symbol, receiver: any): any {
        // Forward well-known symbols transparently
        if (typeof prop === 'symbol') {
          // Forward Symbol.toPrimitive, Symbol.iterator, Symbol.toStringTag, Symbol.hasInstance
          const raw = Reflect.get(target, prop, target);
          // For iterator, bind to target so iteration works on original
          if (prop === Symbol.iterator && typeof raw === 'function') {
            return raw.bind(target);
          }
          return raw;
        }

        const raw = Reflect.get(target, prop, target);

        // Don't track internal/meta properties
        if (prop === 'constructor' || prop === 'prototype' || prop === '__proto__') {
          return raw;
        }

        // toJSON: return original value's toJSON or the target itself for JSON.stringify
        if (prop === 'toJSON') {
          if (typeof raw === 'function') {
            return raw.bind(target);
          }
          return raw;
        }

        // For arrays, forward array methods transparently
        if (Array.isArray(target)) {
          if (prop === 'length') {
            // Record that length was accessed
            const fullPath = path ? `${path}.length` : 'length';
            accessedPaths.set(fullPath, { kind: 'primitive', name: 'number' });
            return raw;
          }

          // Array index access
          if (isArrayIndex(prop)) {
            const fullPath = path ? `${path}[${prop}]` : `[${prop}]`;
            const val = raw;
            if (val !== undefined) {
              accessedPaths.set(fullPath, inferType(val, 3));
            }
            // Recursively wrap object elements
            if (val !== null && val !== undefined && typeof val === 'object') {
              return wrap(val, fullPath);
            }
            return val;
          }

          // Array methods that take callbacks - wrap to track callback args
          if (typeof raw === 'function') {
            if (isCallbackMethod(prop)) {
              return createTrackedArrayMethod(target, prop, path, raw, accessedPaths, wrap);
            }
            // Other array methods: bind to original
            return raw.bind(target);
          }
        }

        // Record the access path and type
        const fullPath = path ? `${path}.${prop}` : prop;
        if (raw !== undefined) {
          accessedPaths.set(fullPath, inferType(raw, 3));
        }

        // Recursively wrap sub-objects
        if (raw !== null && raw !== undefined && typeof raw === 'object') {
          return wrap(raw, fullPath);
        }

        // Bind functions to original target
        if (typeof raw === 'function') {
          return raw.bind(target);
        }

        return raw;
      },

      set(target: any, prop: string | symbol, value: any, receiver: any): boolean {
        return Reflect.set(target, prop, value, target);
      },

      has(target: any, prop: string | symbol): boolean {
        return Reflect.has(target, prop);
      },

      ownKeys(target: any): (string | symbol)[] {
        return Reflect.ownKeys(target);
      },

      getOwnPropertyDescriptor(target: any, prop: string | symbol): PropertyDescriptor | undefined {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },

      getPrototypeOf(target: any): object | null {
        return Reflect.getPrototypeOf(target);
      },

      isExtensible(target: any): boolean {
        return Reflect.isExtensible(target);
      },

      preventExtensions(target: any): boolean {
        return Reflect.preventExtensions(target);
      },

      defineProperty(target: any, prop: string | symbol, descriptor: PropertyDescriptor): boolean {
        return Reflect.defineProperty(target, prop, descriptor);
      },

      deleteProperty(target: any, prop: string | symbol): boolean {
        return Reflect.deleteProperty(target, prop);
      },
    });

    proxyCache.set(obj, proxy);
    return proxy;
  }

  const proxy = wrap(value, '');
  return {
    proxy,
    getAccessedPaths: () => new Map(accessedPaths),
  };
}

function isArrayIndex(prop: string): boolean {
  const num = Number(prop);
  return Number.isInteger(num) && num >= 0 && String(num) === prop;
}

const CALLBACK_METHODS = new Set([
  'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every',
  'reduce', 'reduceRight', 'flatMap', 'sort',
]);

function isCallbackMethod(prop: string): boolean {
  return CALLBACK_METHODS.has(prop);
}

/**
 * Creates a tracked version of an array method that takes a callback.
 * Wraps callback arguments (the element) in proxies so property accesses within
 * the callback are also tracked.
 */
function createTrackedArrayMethod(
  target: any[],
  method: string,
  basePath: string,
  rawFn: Function,
  accessedPaths: Map<string, TypeNode>,
  wrap: (val: unknown, path: string) => unknown,
): Function {
  return function (this: any, ...args: any[]) {
    if (args.length > 0 && typeof args[0] === 'function') {
      const originalCb = args[0];
      args[0] = function (element: any, index: number, array: any[]) {
        const elementPath = basePath ? `${basePath}[${index}]` : `[${index}]`;
        // Wrap the element so accesses inside the callback are tracked
        let wrappedElement = element;
        if (element !== null && element !== undefined && typeof element === 'object') {
          wrappedElement = wrap(element, elementPath);
        } else if (element !== undefined) {
          accessedPaths.set(elementPath, inferType(element, 3));
        }
        return originalCb.call(this, wrappedElement, index, array);
      };
    }
    return rawFn.apply(target, args);
  };
}
