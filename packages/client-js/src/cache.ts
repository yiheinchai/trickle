/**
 * In-memory cache to avoid sending redundant type data to the backend.
 * Keyed by function identity (name + module), stores the last type hash sent.
 * Re-sends if the hash changes or if the entry becomes stale.
 */
export class TypeCache {
  private cache: Map<string, { hash: string; lastSentAt: number }>;
  private maxStalenessMs: number;

  constructor(maxStalenessMs: number = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxStalenessMs = maxStalenessMs;
  }

  /**
   * Returns true if this type observation should be sent to the backend.
   * Returns false if we recently sent the same hash for this function.
   */
  shouldSend(functionKey: string, hash: string): boolean {
    const entry = this.cache.get(functionKey);
    if (!entry) return true;

    // Different type shape — always send
    if (entry.hash !== hash) return true;

    // Same shape but stale — re-send to confirm it's still alive
    const age = Date.now() - entry.lastSentAt;
    if (age > this.maxStalenessMs) return true;

    return false;
  }

  /**
   * Mark that we just sent data for this function with this hash.
   */
  markSent(functionKey: string, hash: string): void {
    this.cache.set(functionKey, { hash, lastSentAt: Date.now() });
  }

  /**
   * Clear the cache (useful for testing or reconfiguration).
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
