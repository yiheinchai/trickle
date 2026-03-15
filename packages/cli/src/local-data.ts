/**
 * Local data provider: reads .trickle/observations.jsonl and provides
 * data in the same shape as the backend API responses.
 *
 * Used when --local flag is passed or TRICKLE_LOCAL=1 is set.
 */

import * as fs from "fs";
import * as path from "path";
import { readObservations, FunctionTypeData, TypeNode } from "./local-codegen";
import type {
  FunctionRow,
  TypeSnapshot,
  ErrorRow,
  MockRoute,
} from "./api-client";

/** Check if local mode is requested via flag or env. */
export function isLocalMode(opts: { local?: boolean }): boolean {
  return opts.local === true || process.env.TRICKLE_LOCAL === "1";
}

/** Resolve the path to the local observations JSONL file. */
export function getLocalJsonlPath(): string {
  return path.join(process.cwd(), ".trickle", "observations.jsonl");
}

interface RawPayload {
  functionName: string;
  module: string;
  language: string;
  environment: string;
  typeHash: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
  errorType?: string;
  errorMessage?: string;
  stackTrace?: string;
}

/** Read raw JSONL lines (not merged). */
function readRawPayloads(jsonlPath: string): RawPayload[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const payloads: RawPayload[] = [];
  for (const line of lines) {
    try {
      const p = JSON.parse(line) as RawPayload;
      if (p.functionName) payloads.push(p);
    } catch {
      // skip
    }
  }
  return payloads;
}

/** Get local functions in the same shape as the backend API. */
export function getLocalFunctions(opts?: {
  env?: string;
  search?: string;
  language?: string;
  limit?: number;
}): { functions: FunctionRow[]; total: number } {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  // Deduplicate by functionName, keeping latest info
  const byName = new Map<string, RawPayload[]>();
  for (const p of payloads) {
    if (!byName.has(p.functionName)) byName.set(p.functionName, []);
    byName.get(p.functionName)!.push(p);
  }

  let functions: FunctionRow[] = [];
  let idCounter = 1;
  for (const [name, items] of byName) {
    const latest = items[items.length - 1];
    functions.push({
      id: idCounter++,
      function_name: name,
      module: latest.module || "unknown",
      language: latest.language || "js",
      environment: latest.environment || "development",
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
  }

  // Apply filters
  if (opts?.env) {
    functions = functions.filter((f) => f.environment === opts.env);
  }
  if (opts?.language) {
    functions = functions.filter((f) => f.language === opts.language);
  }
  if (opts?.search) {
    const q = opts.search.toLowerCase();
    functions = functions.filter((f) =>
      f.function_name.toLowerCase().includes(q),
    );
  }

  const total = functions.length;
  if (opts?.limit) {
    functions = functions.slice(0, opts.limit);
  }

  return { functions, total };
}

/** Get local type snapshots for a function (by function name). */
export function getLocalTypes(
  functionName: string,
  opts?: { env?: string; limit?: number },
): { snapshots: TypeSnapshot[] } {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  const matching = payloads.filter((p) => p.functionName === functionName);

  let snapshots: TypeSnapshot[] = matching.map((p, i) => ({
    id: i + 1,
    function_id: 0,
    type_hash: p.typeHash || "",
    env: p.environment || "development",
    args_type: p.argsType,
    return_type: p.returnType,
    observed_at: new Date().toISOString(),
    sample_input: p.sampleInput,
    sample_output: p.sampleOutput,
  }));

  if (opts?.env) {
    snapshots = snapshots.filter((s) => s.env === opts.env);
  }
  if (opts?.limit) {
    snapshots = snapshots.slice(0, opts.limit);
  }

  return { snapshots };
}

/** Generate a local OpenAPI spec from observations. */
export function getLocalOpenApiSpec(opts?: {
  env?: string;
  title?: string;
  version?: string;
  serverUrl?: string;
}): object {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  const title = opts?.title || "API";
  const version = opts?.version || "1.0.0";

  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title, version },
    paths: {} as Record<string, unknown>,
  };

  if (opts?.serverUrl) {
    spec.servers = [{ url: opts.serverUrl }];
  }

  const paths = spec.paths as Record<string, Record<string, unknown>>;

  // Deduplicate by functionName, collect all type variants
  const byName = new Map<string, RawPayload[]>();
  for (const p of payloads) {
    if (opts?.env && p.environment !== opts.env) continue;
    if (!byName.has(p.functionName)) byName.set(p.functionName, []);
    byName.get(p.functionName)!.push(p);
  }

  for (const [name, items] of byName) {
    const spaceIdx = name.indexOf(" ");
    if (spaceIdx <= 0) continue; // skip non-route functions

    const method = name.slice(0, spaceIdx).toLowerCase();
    const routePath = name.slice(spaceIdx + 1);

    // Convert Express-style :param to OpenAPI {param}
    const openApiPath = routePath.replace(/:(\w+)/g, "{$1}");

    if (!paths[openApiPath]) paths[openApiPath] = {};

    // Merge all observations for this route
    const latest = items[items.length - 1];
    const operation: Record<string, unknown> = {
      operationId: name.replace(/[^a-zA-Z0-9]/g, "_"),
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: typeNodeToJsonSchema(latest.returnType),
            },
          },
        },
      },
    };

    // Extract path parameters
    const paramMatches = routePath.match(/:(\w+)/g);
    if (paramMatches) {
      operation.parameters = paramMatches.map((p) => ({
        name: p.slice(1),
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }

    // Extract query parameters from argsType
    if (latest.argsType?.kind === "object" && latest.argsType.properties) {
      const queryProps =
        (latest.argsType.properties as Record<string, TypeNode>).query;
      if (
        queryProps?.kind === "object" &&
        queryProps.properties
      ) {
        const existingParams = (operation.parameters as unknown[]) || [];
        for (const [qName, qType] of Object.entries(
          queryProps.properties as Record<string, TypeNode>,
        )) {
          existingParams.push({
            name: qName,
            in: "query",
            schema: typeNodeToJsonSchema(qType),
          });
        }
        operation.parameters = existingParams;
      }
    }

    // Request body for POST/PUT/PATCH
    if (["post", "put", "patch"].includes(method)) {
      const bodyProps =
        latest.argsType?.kind === "object" && latest.argsType.properties
          ? (latest.argsType.properties as Record<string, TypeNode>).body
          : null;
      if (bodyProps) {
        operation.requestBody = {
          content: {
            "application/json": {
              schema: typeNodeToJsonSchema(bodyProps),
            },
          },
        };
      }
    }

    // Sample response as example
    if (latest.sampleOutput) {
      const resp = operation.responses as Record<string, Record<string, unknown>>;
      const content = resp["200"].content as Record<string, Record<string, unknown>>;
      content["application/json"].example = latest.sampleOutput;
    }

    paths[openApiPath][method] = operation;
  }

  return spec;
}

/** Get local mock routes from observations. */
export function getLocalMockRoutes(): { routes: MockRoute[] } {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  const routes: MockRoute[] = [];
  const seen = new Set<string>();

  for (const p of payloads) {
    const spaceIdx = p.functionName.indexOf(" ");
    if (spaceIdx <= 0) continue;

    const method = p.functionName.slice(0, spaceIdx);
    const routePath = p.functionName.slice(spaceIdx + 1);
    const key = `${method} ${routePath}`;

    if (seen.has(key)) continue;
    seen.add(key);

    routes.push({
      method,
      path: routePath,
      functionName: p.functionName,
      module: p.module || "unknown",
      sampleInput: p.sampleInput,
      sampleOutput: p.sampleOutput,
      observedAt: new Date().toISOString(),
    });
  }

  return { routes };
}

/** Search local observations by query string. */
export function searchLocalObservations(
  query: string,
  opts?: { env?: string },
): {
  query: string;
  total: number;
  results: Array<{
    functionName: string;
    module: string;
    environment: string;
    lastSeen: string;
    matches: Array<{ path: string; kind: string; typeName?: string }>;
  }>;
} {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  const q = query.toLowerCase();
  const resultMap = new Map<
    string,
    {
      functionName: string;
      module: string;
      environment: string;
      lastSeen: string;
      matches: Array<{ path: string; kind: string; typeName?: string }>;
    }
  >();

  for (const p of payloads) {
    if (opts?.env && p.environment !== opts.env) continue;

    const matches: Array<{ path: string; kind: string; typeName?: string }> =
      [];

    // Match function name
    if (p.functionName.toLowerCase().includes(q)) {
      matches.push({ path: p.functionName, kind: "name" });
    }

    // Match field names in types
    searchTypeNode(p.argsType, "args", q, matches);
    searchTypeNode(p.returnType, "return", q, matches);

    if (matches.length > 0) {
      if (!resultMap.has(p.functionName)) {
        resultMap.set(p.functionName, {
          functionName: p.functionName,
          module: p.module || "unknown",
          environment: p.environment || "development",
          lastSeen: new Date().toISOString(),
          matches: [],
        });
      }
      const entry = resultMap.get(p.functionName)!;
      // Deduplicate matches
      for (const m of matches) {
        if (
          !entry.matches.some(
            (e) => e.path === m.path && e.kind === m.kind,
          )
        ) {
          entry.matches.push(m);
        }
      }
    }
  }

  const results = Array.from(resultMap.values());
  return { query, total: results.length, results };
}

function searchTypeNode(
  node: TypeNode | undefined,
  prefix: string,
  query: string,
  matches: Array<{ path: string; kind: string; typeName?: string }>,
): void {
  if (!node) return;
  if (node.kind === "object" && node.properties) {
    for (const [key, val] of Object.entries(
      node.properties as Record<string, TypeNode>,
    )) {
      const fullPath = `${prefix}.${key}`;
      if (key.toLowerCase().includes(query)) {
        matches.push({
          path: fullPath,
          kind: "field",
          typeName: val.kind === "primitive" ? (val.name as string) : val.kind,
        });
      }
      searchTypeNode(val, fullPath, query, matches);
    }
  } else if (node.kind === "array" && node.element) {
    searchTypeNode(node.element, `${prefix}[]`, query, matches);
  }
}

/** Get local errors (observations with error fields). */
export function getLocalErrors(opts?: {
  env?: string;
  functionName?: string;
  limit?: number;
}): { errors: ErrorRow[]; total: number } {
  const jsonlPath = getLocalJsonlPath();
  const payloads = readRawPayloads(jsonlPath);

  let errors: ErrorRow[] = [];
  let idCounter = 1;

  for (const p of payloads) {
    if (!p.errorType && !p.errorMessage) continue;

    if (opts?.env && p.environment !== opts.env) continue;
    if (opts?.functionName && !p.functionName.includes(opts.functionName))
      continue;

    errors.push({
      id: idCounter++,
      function_id: 0,
      function_name: p.functionName,
      module: p.module || "unknown",
      language: p.language || "js",
      env: p.environment || "development",
      error_type: p.errorType || "Error",
      error_message: p.errorMessage || "Unknown error",
      stack_trace: p.stackTrace,
      args_type: p.argsType,
      return_type: p.returnType,
      args_snapshot: p.sampleInput,
      occurred_at: new Date().toISOString(),
    });
  }

  const total = errors.length;
  if (opts?.limit) {
    errors = errors.slice(0, opts.limit);
  }

  return { errors, total };
}

/** Convert TypeNode to JSON Schema (simple version). */
function typeNodeToJsonSchema(node: TypeNode): Record<string, unknown> {
  if (!node || !node.kind) return { type: "object" };

  switch (node.kind) {
    case "primitive": {
      const name = node.name || "string";
      if (name === "number" || name === "integer")
        return { type: name === "integer" ? "integer" : "number" };
      if (name === "boolean") return { type: "boolean" };
      if (name === "null") return { type: "null" };
      return { type: "string" };
    }
    case "array":
      return {
        type: "array",
        items: node.element ? typeNodeToJsonSchema(node.element) : {},
      };
    case "object": {
      const props = node.properties as Record<string, TypeNode> | undefined;
      if (!props || Object.keys(props).length === 0)
        return { type: "object" };
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(props)) {
        properties[key] = typeNodeToJsonSchema(val);
        required.push(key);
      }
      return { type: "object", properties, required };
    }
    case "union": {
      const members = node.members as TypeNode[] | undefined;
      if (!members) return {};
      return { oneOf: members.map(typeNodeToJsonSchema) };
    }
    default:
      return {};
  }
}
