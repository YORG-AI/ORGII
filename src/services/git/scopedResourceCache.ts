export interface ScopedResourceSnapshot<T> {
  cachedAt: number;
  stale: boolean;
  value: T;
}

export interface ScopedResourceCacheOptions<T> {
  estimateSize?: (value: T) => number;
  maxAgeMs?: number;
  maxBytes?: number;
  maxEntries: number;
  maxEntryBytes?: number;
  maxInFlight?: number;
}

export interface ScopedResourceCacheStats {
  bytes: number;
  entries: number;
  inFlight: number;
  maxBytes: number;
  maxEntries: number;
  maxInFlight: number;
}

interface CacheEntry<T> {
  byteSize: number;
  cachedAt: number;
  value: T;
}

export interface ScopedResourceLoadOptions<T> {
  force?: boolean;
  shouldCache?: (value: T) => boolean;
}

/**
 * Small app-session cache for read-only resources that must survive a React
 * remount. Reads are stale-while-revalidate, equal requests are single-flight,
 * and both entry count and retained bytes are bounded.
 */
export class ScopedResourceCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly estimateSize: (value: T) => number;
  private readonly maxAgeMs: number | undefined;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxInFlight: number;
  private retainedBytes = 0;

  constructor(options: ScopedResourceCacheOptions<T>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }

    this.maxEntries = options.maxEntries;
    this.maxInFlight = options.maxInFlight ?? options.maxEntries;
    if (!Number.isInteger(this.maxInFlight) || this.maxInFlight <= 0) {
      throw new RangeError("maxInFlight must be a positive integer");
    }
    this.maxAgeMs = options.maxAgeMs;
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.maxEntryBytes = options.maxEntryBytes ?? this.maxBytes;
    this.estimateSize = options.estimateSize ?? (() => 1);
  }

  get(key: string): ScopedResourceSnapshot<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    this.entries.delete(key);
    this.entries.set(key, entry);

    return {
      cachedAt: entry.cachedAt,
      stale:
        this.maxAgeMs !== undefined &&
        Date.now() - entry.cachedAt >= this.maxAgeMs,
      value: entry.value,
    };
  }

  set(key: string, value: T): void {
    const byteSize = Math.max(0, this.estimateSize(value));
    if (
      !Number.isFinite(byteSize) ||
      byteSize > this.maxEntryBytes ||
      byteSize > this.maxBytes
    ) {
      return;
    }

    this.delete(key);
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + byteSize > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }

    this.entries.set(key, {
      byteSize,
      cachedAt: Date.now(),
      value,
    });
    this.retainedBytes += byteSize;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.retainedBytes -= entry.byteSize;
    return true;
  }

  load(
    key: string,
    loader: () => Promise<T>,
    options: ScopedResourceLoadOptions<T> = {}
  ): Promise<T> {
    const cached = this.get(key);
    if (cached && !options.force && !cached.stale) {
      return Promise.resolve(cached.value);
    }

    const activeRequest = this.inFlight.get(key);
    if (activeRequest) return activeRequest;

    const request = loader()
      .then((value) => {
        if (
          this.inFlight.get(key) === request &&
          options.shouldCache?.(value) !== false
        ) {
          this.set(key, value);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      });

    while (this.inFlight.size >= this.maxInFlight) {
      const oldestKey = this.inFlight.keys().next().value as string | undefined;
      if (!oldestKey) break;
      // The underlying operation cannot be cancelled generically, but removing
      // its coalescing handle keeps this app-session registry hard-bounded. The
      // identity check above also prevents its eventual value from publishing.
      this.inFlight.delete(oldestKey);
    }
    this.inFlight.set(key, request);
    return request;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.retainedBytes = 0;
  }

  getStats(): ScopedResourceCacheStats {
    return {
      bytes: this.retainedBytes,
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxInFlight: this.maxInFlight,
    };
  }
}
