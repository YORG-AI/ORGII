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
/** Maximum retained UTF-16 bytes for a single terminal buffer. */
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;
/** Maximum retained UTF-16 bytes across all terminal buffers. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

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
let terminalBufferCacheBytes = 0;

function estimateStringBytes(value: string): number {
  return value.length * 2;
}

function truncateBufferForCache(buffer: string): string {
  const maxChars = Math.floor(MAX_BUFFER_BYTES / 2);
  return buffer.length <= maxChars ? buffer : buffer.slice(-maxChars);
}

function removeCacheEntry(sessionId: string): boolean {
  const existing = terminalBufferCache.get(sessionId);
  if (existing === undefined) return false;

  terminalBufferCache.delete(sessionId);
  terminalBufferCacheBytes -= estimateStringBytes(existing);
  return true;
}

function evictOldestEntry(): boolean {
  const oldestKey = terminalBufferCache.keys().next().value;
  return oldestKey === undefined ? false : removeCacheEntry(oldestKey);
}

function insertBoundedEntry(sessionId: string, buffer: string): void {
  const boundedBuffer = truncateBufferForCache(buffer);
  removeCacheEntry(sessionId);

  while (
    terminalBufferCache.size >= MAX_CACHE_SIZE ||
    terminalBufferCacheBytes + estimateStringBytes(boundedBuffer) >
      MAX_CACHE_BYTES
  ) {
    if (!evictOldestEntry()) break;
  }

  terminalBufferCache.set(sessionId, boundedBuffer);
  terminalBufferCacheBytes += estimateStringBytes(boundedBuffer);
}

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
    insertBoundedEntry(sessionId, buffer.serialized);
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
  const boundedBuffer = truncateBufferForCache(buffer);
  insertBoundedEntry(sessionId, boundedBuffer);

  // Mirror to disk (debounced 2 s) so buffers survive app restarts.
  persistTerminalBuffer(sessionId, boundedBuffer);
}

/**
 * Delete a terminal buffer from cache
 */
export function deleteTerminalBuffer(sessionId: string): void {
  removeCacheEntry(sessionId);
}

/**
 * Clear a terminal buffer when session is permanently closed.
 * Call this when user explicitly closes a terminal session.
 */
export function clearTerminalBufferCache(sessionId: string): void {
  removeCacheEntry(sessionId);
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
  return {
    entries: terminalBufferCache.size,
    bytes: terminalBufferCacheBytes,
  };
}
