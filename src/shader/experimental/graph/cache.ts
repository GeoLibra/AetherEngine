/**
 * @file Bounded LRU cache for lowered ShaderGraph node expressions.
 */

import type { CachedNodeExpression } from './types';

/**
 * Bounded LRU cache preventing unbounded memory growth in long-running editor sessions.
 */
export class BoundedNodeCache {
  private readonly maxCapacity: number;
  private readonly cache = new Map<string, CachedNodeExpression>();

  constructor(maxCapacity = 1024) {
    this.maxCapacity = Math.max(1, maxCapacity);
  }

  get(key: string): CachedNodeExpression | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: CachedNodeExpression): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
