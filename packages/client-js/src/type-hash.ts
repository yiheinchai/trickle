import { createHash } from 'crypto';
import { TypeNode } from './types';

/**
 * Canonicalize a TypeNode for deterministic hashing.
 * - Object properties are sorted alphabetically by key at all levels.
 * - Union members are sorted by their canonical string representation.
 */
function canonicalize(node: TypeNode): unknown {
  switch (node.kind) {
    case 'primitive':
      return { kind: 'primitive', name: node.name };

    case 'array':
      return { kind: 'array', element: canonicalize(node.element) };

    case 'object': {
      const sortedKeys = Object.keys(node.properties).sort();
      const properties: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        properties[key] = canonicalize(node.properties[key]);
      }
      return { kind: 'object', properties };
    }

    case 'union': {
      const members = node.members
        .map(m => canonicalize(m))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { kind: 'union', members };
    }

    case 'function': {
      return {
        kind: 'function',
        params: node.params.map(canonicalize),
        returnType: canonicalize(node.returnType),
      };
    }

    case 'promise':
      return { kind: 'promise', resolved: canonicalize(node.resolved) };

    case 'map':
      return { kind: 'map', key: canonicalize(node.key), value: canonicalize(node.value) };

    case 'set':
      return { kind: 'set', element: canonicalize(node.element) };

    case 'tuple':
      return { kind: 'tuple', elements: node.elements.map(canonicalize) };

    case 'unknown':
      return { kind: 'unknown' };

    default:
      return { kind: 'unknown' };
  }
}

/**
 * Hash the combined args + return type into a deterministic 16-hex-char string.
 */
export function hashType(argsType: TypeNode, returnType: TypeNode): string {
  const canonical = JSON.stringify({
    args: canonicalize(argsType),
    ret: canonicalize(returnType),
  });

  return createHash('sha256').update(canonical).digest('hex').substring(0, 16);
}
