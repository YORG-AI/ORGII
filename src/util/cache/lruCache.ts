/**
 * LRU Cache Utility
 *
 * Implements Least Recently Used (LRU) cache eviction strategy.
 * Useful for managing memory in caches that grow over time.
 *
 * Features:
 * - Automatic eviction when max size is reached
 * - Access tracking (updates order on get)
 * - TTL support for entries
 * - Memory-efficient implementation
 *
 * @example
 * ```typescript
 * const cache = new LRUCache<string, BranchData>(10, 5 * 60 * 1000);
 * cache.set('repo-1', branchData);
 * const data = cache.get('repo-1'); // Updates access order
 * ```
 */

// ============================================
// Types
// ============================================

export interface LRUCacheEntry<T> {
  value: T;
  fetchedAt: number;
  lastAccessed: number;
}

// ============================================
// LRU Cache Implementation
// ============================================

/**
 * LRU Cache class
 *
 * Uses a Map to maintain insertion order.
 * When an item is accessed, it's moved to the end (most recent).
 * When capacity is reached, the first item (least recent) is removed.
 */
export class LRUCache<K, V> {
  private cache: Map<K, LRUCacheEntry<V>>;
  private readonly maxSize: number;
  private readonly ttl?: number;

  constructor(maxSize: number, ttl?: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  /**
   * Get value from cache
   * Updates access time and moves entry to end (most recent)
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (this.ttl && Date.now() - entry.fetchedAt > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Update last accessed time
    entry.lastAccessed = Date.now();

    // Move to end (most recent) by deleting and re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set value in cache
   * Evicts least recently used entry if max size is reached
   */
  set(key: K, value: V): void {
    // If key exists, delete it first to re-insert at end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // If at capacity, evict least recently used (first entry)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // Add new entry at end (most recent)
    this.cache.set(key, {
      value,
      fetchedAt: Date.now(),
      lastAccessed: Date.now(),
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check if expired
    if (this.ttl && Date.now() - entry.fetchedAt > this.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get entry with metadata (without updating access time)
   */
  peek(key: K): LRUCacheEntry<V> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (this.ttl && Date.now() - entry.fetchedAt > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  /**
   * Delete entry from cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys (ordered by least to most recent)
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Get all entries (ordered by least to most recent)
   */
  entries(): IterableIterator<[K, LRUCacheEntry<V>]> {
    return this.cache.entries();
  }

  /**
   * Check if value is fresh (not expired)
   */
  isFresh(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (!this.ttl) return true;
    return Date.now() - entry.fetchedAt < this.ttl;
  }

  /**
   * Get all valid (non-expired) keys
   */
  getValidKeys(): K[] {
    const validKeys: K[] = [];
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (!this.ttl || now - entry.fetchedAt < this.ttl) {
        validKeys.push(key);
      }
    }

    return validKeys;
  }

  /**
   * Remove all expired entries
   */
  pruneExpired(): number {
    if (!this.ttl) return 0;

    let pruned = 0;
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.fetchedAt > this.ttl) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    utilizationPercent: number;
    oldestEntryAge: number | null;
    newestEntryAge: number | null;
  } {
    const now = Date.now();
    let oldestEntryAge: number | null = null;
    let newestEntryAge: number | null = null;

    if (this.cache.size > 0) {
      const entries = Array.from(this.cache.values());
      oldestEntryAge = now - entries[0].fetchedAt;
      newestEntryAge = now - entries[entries.length - 1].fetchedAt;
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilizationPercent: (this.cache.size / this.maxSize) * 100,
      oldestEntryAge,
      newestEntryAge,
    };
  }
}

export default LRUCache;
