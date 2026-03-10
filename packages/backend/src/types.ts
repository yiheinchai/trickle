export type TypeNode =
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol" }
  | { kind: "array"; element: TypeNode }
  | { kind: "object"; properties: Record<string, TypeNode> }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "function"; params: TypeNode[]; returnType: TypeNode }
  | { kind: "promise"; resolved: TypeNode }
  | { kind: "map"; key: TypeNode; value: TypeNode }
  | { kind: "set"; element: TypeNode }
  | { kind: "tuple"; elements: TypeNode[] }
  | { kind: "unknown" };

export interface IngestPayload {
  functionName: string;
  module: string;
  language: "js" | "python";
  environment: string;
  typeHash: string;
  argsType: TypeNode;
  returnType: TypeNode;
  sampleInput?: unknown;
  sampleOutput?: unknown;
  error?: {
    type: string;
    message: string;
    stackTrace?: string;
    argsSnapshot?: unknown;
  };
}

export interface TypeDiff {
  kind: "added" | "removed" | "changed";
  path: string;
  from?: TypeNode;
  to?: TypeNode;
  type?: TypeNode;
}
