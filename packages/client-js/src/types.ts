export type TypeNode =
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "null" | "undefined" | "bigint" | "symbol" }
  | { kind: "array"; element: TypeNode }
  | { kind: "object"; properties: Record<string, TypeNode>; class_name?: string }
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
  isAsync?: boolean;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
  durationMs?: number;
  error?: {
    type: string;
    message: string;
    stackTrace?: string;
    argsSnapshot?: unknown;
  };
}

export interface GlobalOpts {
  backendUrl: string;
  batchIntervalMs: number;
  enabled: boolean;
  environment: string | undefined;
  maxBatchSize?: number;
  debug?: boolean;
}

export interface TrickleOpts {
  name?: string;
  module?: string;
  trackArgs?: boolean;
  trackReturn?: boolean;
  sampleRate?: number;
  maxDepth?: number;
}

export interface WrapOptions {
  functionName: string;
  module: string;
  trackArgs: boolean;
  trackReturn: boolean;
  sampleRate: number;
  maxDepth: number;
  environment: string;
  enabled: boolean;
  paramNames?: string[];
}
