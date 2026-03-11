/**
 * TypeScript library — uses native TS syntax.
 * NO trickle imports. Instrumented via: node --import trickle/auto-esm
 */

export interface QueryResult<T> {
  data: T[];
  total: number;
  page: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): QueryResult<T> {
  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, total: items.length, page };
}

export function groupBy(items: Record<string, unknown>[], key: string): Record<string, Record<string, unknown>[]> {
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const item of items) {
    const val = String(item[key] || 'undefined');
    if (!groups[val]) groups[val] = [];
    groups[val].push(item);
  }
  return groups;
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delayMs: number = 100,
): Promise<{ result: T; attempts: number }> {
  let lastError: Error | null = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const result = await fn();
      return { result, attempts: i };
    } catch (err) {
      lastError = err as Error;
      if (i < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}
