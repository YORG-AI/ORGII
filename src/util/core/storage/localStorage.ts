/**
 * localStorage Cache Utility
 *
 * PERFORMANCE: Batches localStorage reads to avoid blocking startup.
 * All critical settings are read once and cached in memory.
 *
 * Features:
 * - Pre-populated cache during idle time
 * - Fast synchronous access via memory cache
 * - Fallback to direct read if not cached
 * - Write-through cache (writes update both cache and storage)
 */
import { createLogger } from "@src/hooks/logger";

const log = createLogger("localStorageCache");

// ============================================
// Cache State
// ============================================

const cache = new Map<string, string | null>();
const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_SINGLE_CACHE_VALUE_BYTES = 1024 * 1024;
let cacheBytes = 0;
let isPreloaded = false;
let preloadPromise: Promise<void> | null = null;

function estimatedEntryBytes(key: string, value: string | null): number {
  return (key.length + (value?.length ?? 0)) * 2;
}

function deleteCacheEntry(key: string): void {
  const existing = cache.get(key);
  if (!cache.has(key)) return;
  cacheBytes -= estimatedEntryBytes(key, existing ?? null);
  cache.delete(key);
}

function cacheValue(key: string, value: string | null): void {
  deleteCacheEntry(key);
  const bytes = estimatedEntryBytes(key, value);
  if (bytes > MAX_SINGLE_CACHE_VALUE_BYTES) return;

  cache.set(key, value);
  cacheBytes += bytes;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    deleteCacheEntry(oldestKey);
  }
}

function touchCacheEntry(key: string): string | null {
  const value = cache.get(key) ?? null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

// Keys that should be preloaded at startup (most accessed)
const PRIORITY_KEYS = [
  // Theme & UI
  "theme",
  "orgii_ui_scale",
  "orgii_background_config",

  // User settings
  "orgii_user_display_name",
  "orgii_timezone",

  // Terminal settings
  "orgii_terminal_font_size",
  "orgii_terminal_letter_spacing",

  // Repo & session state
  "orgii_selected_repo_id",
  "orgii_selected_branch",

  // Tab persistence
  "opcode_tabs_v4",
  "opcode_active_tab_v4",
  "opcode_tab_persistence_enabled",

  // Sidebar state
  "orgii_sidebar_width",
  "orgii_sidebar_collapsed",

  // Config
  "orgii_prefer_ide",
  "orgii_auto_commit",
];

// ============================================
// Core API
// ============================================

/**
 * Get a value from cache or localStorage
 * Fast path: returns from memory cache
 * Slow path: falls back to localStorage read
 */
export function getCached(key: string): string | null {
  // Fast path: return from cache
  if (cache.has(key)) {
    return touchCacheEntry(key);
  }

  // Slow path: read from localStorage and cache
  try {
    const value = localStorage.getItem(key);
    cacheValue(key, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Get a value with JSON parsing
 */
export function getCachedJSON<T>(key: string, defaultValue: T): T {
  const raw = getCached(key);
  if (!raw) return defaultValue;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Set a value in both cache and localStorage (write-through)
 */
export function setCached(key: string, value: string): void {
  cacheValue(key, value);
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    log.error(`[localStorageCache] Failed to write ${key}:`, error);
  }
}

/**
 * Set a JSON value
 */
export function setCachedJSON<T>(key: string, value: T): void {
  setCached(key, JSON.stringify(value));
}

/**
 * Remove a value from both cache and localStorage
 */
export function removeCached(key: string): void {
  deleteCacheEntry(key);
  try {
    localStorage.removeItem(key);
  } catch (error) {
    log.error(`[localStorageCache] Failed to remove ${key}:`, error);
  }
}

/**
 * Check if cache is preloaded
 */
export function isCachePreloaded(): boolean {
  return isPreloaded;
}

// ============================================
// Preloading
// ============================================

/**
 * Preload priority keys into cache
 * Call this during app initialization (after first paint)
 */
export function preloadCache(): Promise<void> {
  if (isPreloaded) return Promise.resolve();
  if (preloadPromise) return preloadPromise;

  preloadPromise = new Promise((resolve) => {
    const preload = () => {
      const _start = performance.now();

      // Batch read all priority keys
      for (const key of PRIORITY_KEYS) {
        try {
          const value = localStorage.getItem(key);
          cacheValue(key, value);
        } catch {
          cacheValue(key, null);
        }
      }

      isPreloaded = true;
      resolve();
    };

    // Use requestIdleCallback if available for non-blocking preload
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(preload, { timeout: 500 });
    } else {
      setTimeout(preload, 50);
    }
  });

  return preloadPromise;
}

/**
 * Preload specific keys (for components that need specific settings)
 */
export function preloadKeys(keys: string[]): void {
  for (const key of keys) {
    if (!cache.has(key)) {
      try {
        cacheValue(key, localStorage.getItem(key));
      } catch {
        cacheValue(key, null);
      }
    }
  }
}

// ============================================
// Helpers for Common Patterns
// ============================================

/**
 * Get boolean value with default
 */
export function getCachedBoolean(key: string, defaultValue: boolean): boolean {
  const raw = getCached(key);
  if (raw === null) return defaultValue;
  return raw === "true";
}

/**
 * Get number value with default and optional bounds
 */
export function getCachedNumber(
  key: string,
  defaultValue: number,
  options?: { min?: number; max?: number }
): number {
  const raw = getCached(key);
  if (raw === null) return defaultValue;

  const num = parseFloat(raw);
  if (isNaN(num)) return defaultValue;

  if (options?.min !== undefined && num < options.min) return defaultValue;
  if (options?.max !== undefined && num > options.max) return defaultValue;

  return num;
}

// ============================================
// Debug
// ============================================

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats(): {
  size: number;
  bytes: number;
  keys: string[];
  isPreloaded: boolean;
} {
  return {
    size: cache.size,
    bytes: cacheBytes,
    keys: Array.from(cache.keys()),
    isPreloaded,
  };
}

/**
 * Clear the cache (mainly for testing)
 */
export function clearCache(): void {
  cache.clear();
  cacheBytes = 0;
  isPreloaded = false;
  preloadPromise = null;
}
