import * as http from "http";
import * as https from "https";
import { URL } from "url";
import chalk from "chalk";
import { getBackendUrl } from "./config";

// ── Types matching backend responses ──

export interface FunctionRow {
  id: number;
  function_name: string;
  module: string;
  language: string;
  environment: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface FunctionDetail {
  function: FunctionRow;
  latestSnapshots: Record<string, TypeSnapshot>;
}

export interface TypeSnapshot {
  id: number;
  function_id: number;
  type_hash: string;
  env: string;
  args_type: unknown;
  return_type: unknown;
  observed_at: string;
  sample_input?: unknown;
  sample_output?: unknown;
}

export interface ErrorRow {
  id: number;
  function_id: number;
  function_name: string;
  module: string;
  language: string;
  env: string;
  error_type: string;
  error_message: string;
  stack_trace?: string;
  type_hash?: string;
  args_type?: unknown;
  return_type?: unknown;
  variables_type?: unknown;
  args_snapshot?: unknown;
  occurred_at: string;
}

export interface ErrorDetail {
  error: ErrorRow;
  snapshot: TypeSnapshot | null;
}

export interface TypeDiff {
  kind: "added" | "removed" | "changed";
  path: string;
  from?: unknown;
  to?: unknown;
  type?: unknown;
}

export interface DiffResponse {
  from: { id: number; env: string; observed_at: string };
  to: { id: number; env: string; observed_at: string };
  diffs: TypeDiff[];
}

export interface TailEvent {
  event: string;
  data: Record<string, unknown>;
}

// ── Helpers ──

function backendUrl(): string {
  return getBackendUrl();
}

function connectionError(): never {
  const url = backendUrl();
  console.error(
    chalk.red(`\nCannot connect to trickle backend at ${chalk.bold(url)}.`)
  );
  console.error(chalk.red("Is the backend running?\n"));
  process.exit(1);
}

async function fetchJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  const base = backendUrl();
  const url = new URL(path, base);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("HTTP ")) {
      throw err;
    }
    connectionError();
  }
}

// ── API Functions ──

export interface ListFunctionsOpts {
  env?: string;
  language?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listFunctions(opts?: ListFunctionsOpts): Promise<{ functions: FunctionRow[]; total: number }> {
  return fetchJson("/api/functions", {
    env: opts?.env,
    language: opts?.language,
    q: opts?.search,
    limit: opts?.limit?.toString(),
    offset: opts?.offset?.toString(),
  });
}

export async function getFunction(id: number): Promise<FunctionDetail> {
  return fetchJson(`/api/functions/${id}`);
}

export interface ListErrorsOpts {
  env?: string;
  functionName?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export async function listErrors(opts?: ListErrorsOpts): Promise<{ errors: ErrorRow[]; total: number }> {
  return fetchJson("/api/errors", {
    env: opts?.env,
    functionName: opts?.functionName,
    since: opts?.since,
    limit: opts?.limit?.toString(),
    offset: opts?.offset?.toString(),
  });
}

export async function getError(id: number): Promise<ErrorDetail> {
  return fetchJson(`/api/errors/${id}`);
}

export interface ListTypesOpts {
  env?: string;
  limit?: number;
}

export async function listTypes(functionId: number, opts?: ListTypesOpts): Promise<{ snapshots: TypeSnapshot[] }> {
  return fetchJson(`/api/types/${functionId}`, {
    env: opts?.env,
    limit: opts?.limit?.toString(),
  });
}

export interface GetTypeDiffOpts {
  from?: number;
  to?: number;
  fromEnv?: string;
  toEnv?: string;
}

export async function getTypeDiff(functionId: number, opts?: GetTypeDiffOpts): Promise<DiffResponse> {
  return fetchJson(`/api/types/${functionId}/diff`, {
    from: opts?.from?.toString(),
    to: opts?.to?.toString(),
    fromEnv: opts?.fromEnv,
    toEnv: opts?.toEnv,
  });
}

export function tailEvents(
  onEvent: (event: TailEvent) => void,
  filter?: string
): () => void {
  const base = backendUrl();
  const url = new URL("/api/tail", base);
  if (filter) {
    url.searchParams.set("filter", filter);
  }

  const mod = url.protocol === "https:" ? https : http;
  let destroyed = false;
  let currentReq: http.ClientRequest | null = null;

  function connect() {
    if (destroyed) return;

    const req = mod.get(url.toString(), (res) => {
      let buffer = "";

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            try {
              const data = JSON.parse(dataStr);
              onEvent({ event: currentEvent, data });
            } catch {
              // Ignore invalid JSON
            }
            currentEvent = "";
          }
        }
      });

      res.on("end", () => {
        if (!destroyed) {
          // Reconnect after a delay
          setTimeout(connect, 2000);
        }
      });
    });

    req.on("error", () => {
      if (!destroyed) {
        setTimeout(connect, 3000);
      }
    });

    currentReq = req;
  }

  connect();

  return () => {
    destroyed = true;
    if (currentReq) {
      currentReq.destroy();
    }
  };
}
