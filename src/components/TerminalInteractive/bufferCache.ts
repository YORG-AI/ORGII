/**
 * Terminal Buffer Cache
 *
 * LRU cache for terminal buffer persistence across hot reloads and navigation.
 * Prevents memory leaks by limiting cache size and using LRU eviction.
 *
 * On app startup, call hydrateFromPersistence() to restore buffers from disk.
 */
import {
  type PersistedBuffer,
  persistTerminalBuffer,
} from "@src/services/terminal/bufferPersistence";

/** Maximum number of terminal buffers to cache (prevents memory leaks) */
const MAX_CACHE_SIZE = 10;

/** Track whether cache has been hydrated from disk */
let isHydrated = false;

/**
 * Module-level LRU cache for terminal buffers (survives hot reload).
 * Key: sessionId, Value: serialized terminal content.
 *
 * Uses Map iteration order (insertion order) for LRU eviction:
 * - First entry = oldest (least recently used)
 * - Last entry = newest (most recently used)
 * - On get: delete and re-insert to move to end
 * - On set: evict first entry if at capacity
 */
const terminalBufferCache = new Map<string, string>();

/**
 * Hydrate the in-memory cache from persisted disk storage.
 *
 * Call this once on app startup, before any terminal mounts.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function hydrateFromPersistence(
  persistedBuffers: Map<string, PersistedBuffer>
): void {
  if (isHydrated) return;
  isHydrated = true;

  // Load persisted buffers into the in-memory cache
  for (const [sessionId, buffer] of persistedBuffers) {
    // Don't exceed max cache size
    if (terminalBufferCache.size >= MAX_CACHE_SIZE) break;
    terminalBufferCache.set(sessionId, buffer.serialized);
  }
}

/**
 * Check if the cache has been hydrated from disk.
 */
export function isCacheHydrated(): boolean {
  return isHydrated;
}

/**
 * Get a cached terminal buffer (marks as recently used)
 */
export function getTerminalBuffer(sessionId: string): string | undefined {
  const buffer = terminalBufferCache.get(sessionId);
  if (buffer !== undefined) {
    // Move to end (most recently used) by deleting and re-inserting
    terminalBufferCache.delete(sessionId);
    terminalBufferCache.set(sessionId, buffer);
  }
  return buffer;
}

export function hasNonEmptyTerminalBuffer(sessionId: string): boolean {
  return Boolean(terminalBufferCache.get(sessionId)?.trim());
}

/**
 * Set a terminal buffer with LRU eviction
 */
export function setTerminalBuffer(sessionId: string, buffer: string): void {
  // If key exists, delete it first (will be re-added at end)
  if (terminalBufferCache.has(sessionId)) {
    terminalBufferCache.delete(sessionId);
  }

  // Evict oldest entry if at capacity
  if (terminalBufferCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = terminalBufferCache.keys().next().value;
    if (oldestKey !== undefined) {
      terminalBufferCache.delete(oldestKey);
    }
  }

  // Add new entry at end (most recent)
  terminalBufferCache.set(sessionId, buffer);

  // Mirror to disk (debounced 2 s) so buffers survive app restarts.
  persistTerminalBuffer(sessionId, buffer);
}

/**
 * Delete a terminal buffer from cache
 */
export function deleteTerminalBuffer(sessionId: string): void {
  terminalBufferCache.delete(sessionId);
}

/**
 * Clear a terminal buffer when session is permanently closed.
 * Call this when user explicitly closes a terminal session.
 */
export function clearTerminalBufferCache(sessionId: string): void {
  terminalBufferCache.delete(sessionId);
}

/**
 * Get current cache size (for debugging/monitoring)
 */
export interface TerminalBufferCacheStats {
  entries: number;
  bytes: number;
}

export function getTerminalBufferCacheSize(): number {
  return terminalBufferCache.size;
}

export function getTerminalBufferCacheStats(): TerminalBufferCacheStats {
  let bytes = 0;
  for (const buffer of terminalBufferCache.values()) {
    bytes += buffer.length * 2;
  }
  return {
    entries: terminalBufferCache.size,
    bytes,
  };
}
