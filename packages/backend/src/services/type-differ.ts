import { TypeNode, TypeDiff } from "../types";

export function diffTypes(from: TypeNode, to: TypeNode, basePath: string = ""): TypeDiff[] {
  const diffs: TypeDiff[] = [];

  if (from.kind !== to.kind) {
    diffs.push({ kind: "changed", path: basePath || "(root)", from, to });
    return diffs;
  }

  switch (from.kind) {
    case "primitive": {
      const toNode = to as Extract<TypeNode, { kind: "primitive" }>;
      if (from.name !== toNode.name) {
        diffs.push({ kind: "changed", path: basePath || "(root)", from, to });
      }
      break;
    }

    case "object": {
      const toNode = to as Extract<TypeNode, { kind: "object" }>;
      const fromKeys = new Set(Object.keys(from.properties));
      const toKeys = new Set(Object.keys(toNode.properties));

      for (const key of fromKeys) {
        const childPath = basePath ? `${basePath}.${key}` : key;
        if (!toKeys.has(key)) {
          diffs.push({ kind: "removed", path: childPath, type: from.properties[key] });
        } else {
          diffs.push(...diffTypes(from.properties[key], toNode.properties[key], childPath));
        }
      }

      for (const key of toKeys) {
        if (!fromKeys.has(key)) {
          const childPath = basePath ? `${basePath}.${key}` : key;
          diffs.push({ kind: "added", path: childPath, type: toNode.properties[key] });
        }
      }
      break;
    }

    case "array": {
      const toNode = to as Extract<TypeNode, { kind: "array" }>;
      diffs.push(...diffTypes(from.element, toNode.element, `${basePath || "(root)"}[]`));
      break;
    }

    case "union": {
      const toNode = to as Extract<TypeNode, { kind: "union" }>;
      const fromSerialized = from.members.map((m) => JSON.stringify(m));
      const toSerialized = toNode.members.map((m) => JSON.stringify(m));
      const fromSet = new Set(fromSerialized);
      const toSet = new Set(toSerialized);

      for (let i = 0; i < fromSerialized.length; i++) {
        if (!toSet.has(fromSerialized[i])) {
          diffs.push({
            kind: "removed",
            path: `${basePath || "(root)"}|[${i}]`,
            type: from.members[i],
          });
        }
      }
      for (let i = 0; i < toSerialized.length; i++) {
        if (!fromSet.has(toSerialized[i])) {
          diffs.push({
            kind: "added",
            path: `${basePath || "(root)"}|[${i}]`,
            type: toNode.members[i],
          });
        }
      }
      break;
    }

    case "function": {
      const toNode = to as Extract<TypeNode, { kind: "function" }>;
      const maxParams = Math.max(from.params.length, toNode.params.length);
      for (let i = 0; i < maxParams; i++) {
        const paramPath = `${basePath || "(root)"}.params[${i}]`;
        if (i >= from.params.length) {
          diffs.push({ kind: "added", path: paramPath, type: toNode.params[i] });
        } else if (i >= toNode.params.length) {
          diffs.push({ kind: "removed", path: paramPath, type: from.params[i] });
        } else {
          diffs.push(...diffTypes(from.params[i], toNode.params[i], paramPath));
        }
      }
      diffs.push(
        ...diffTypes(from.returnType, toNode.returnType, `${basePath || "(root)"}.return`)
      );
      break;
    }

    case "promise": {
      const toNode = to as Extract<TypeNode, { kind: "promise" }>;
      diffs.push(
        ...diffTypes(from.resolved, toNode.resolved, `${basePath || "(root)"}<resolved>`)
      );
      break;
    }

    case "map": {
      const toNode = to as Extract<TypeNode, { kind: "map" }>;
      diffs.push(...diffTypes(from.key, toNode.key, `${basePath || "(root)"}<key>`));
      diffs.push(...diffTypes(from.value, toNode.value, `${basePath || "(root)"}<value>`));
      break;
    }

    case "set": {
      const toNode = to as Extract<TypeNode, { kind: "set" }>;
      diffs.push(
        ...diffTypes(from.element, toNode.element, `${basePath || "(root)"}<element>`)
      );
      break;
    }

    case "tuple": {
      const toNode = to as Extract<TypeNode, { kind: "tuple" }>;
      const maxLen = Math.max(from.elements.length, toNode.elements.length);
      for (let i = 0; i < maxLen; i++) {
        const elPath = `${basePath || "(root)"}[${i}]`;
        if (i >= from.elements.length) {
          diffs.push({ kind: "added", path: elPath, type: toNode.elements[i] });
        } else if (i >= toNode.elements.length) {
          diffs.push({ kind: "removed", path: elPath, type: from.elements[i] });
        } else {
          diffs.push(...diffTypes(from.elements[i], toNode.elements[i], elPath));
        }
      }
      break;
    }

    case "unknown":
      // Both unknown — no diff
      break;
  }

  return diffs;
}
