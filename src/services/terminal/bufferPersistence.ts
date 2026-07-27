/**
 * Terminal Buffer Persistence
 *
 * Persists terminal buffer content to disk using Tauri's plugin-fs.
 * Supports LRU eviction, staleness filtering, and event-driven persistence.
 *
 * Storage format:
 * {
 *   version: 1,
 *   buffers: PersistedBuffer[]
 * }
 *
 * Location: {appDataDir}/terminal-buffers.json
 */
import { appDataDir } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import { createLogger } from "@src/hooks/logger";
import { isTauriReady } from "@src/util/platform/tauri/init";

const log = createLogger("bufferPersistence");

// ============================================
// Types
// ============================================

export interface PersistedBuffer {
  sessionId: string;
  serialized: string;
  timestamp: number;
  shellLaunchConfig?: {
    shell?: string;
    cwd?: string;
    args?: string[];
  };
}

interface StoredData {
  version: number;
  buffers: PersistedBuffer[];
}

// ============================================
// Constants
// ============================================

const STORAGE_VERSION = 1;
const STORAGE_FILENAME = "terminal-buffers.json";
const MAX_BUFFERS = 10;
const MAX_BUFFER_SIZE_CHARS = 500_000; // ~500KB
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 2000;

// ============================================
// State
// ============================================

let storagePath: string | null = null;
const pendingWrites = new Map<string, PersistedBuffer>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================
// Private Helpers
// ============================================

async function getStoragePath(): Promise<string> {
  if (storagePath) return storagePath;
  const baseDir = await appDataDir();
  storagePath = `${baseDir}${STORAGE_FILENAME}`;
  return storagePath;
}

async function ensureStorageDir(): Promise<void> {
  const baseDir = await appDataDir();
  if (!(await exists(baseDir))) {
    await mkdir(baseDir, { recursive: true });
  }
}

async function readStoredData(): Promise<StoredData> {
  try {
    const path = await getStoragePath();
    if (!(await exists(path))) {
      return { version: STORAGE_VERSION, buffers: [] };
    }

    const content = await readTextFile(path);
    const data = JSON.parse(content) as StoredData;

    if (data.version !== STORAGE_VERSION) {
      // Incompatible version, start fresh
      return { version: STORAGE_VERSION, buffers: [] };
    }

    return data;
  } catch {
    // Invalid JSON or read error, start fresh
    return { version: STORAGE_VERSION, buffers: [] };
  }
}

async function writeStoredData(data: StoredData): Promise<void> {
  await ensureStorageDir();
  const path = await getStoragePath();
  await writeTextFile(path, JSON.stringify(data, null, 2));
}

function filterStaleBuffers(buffers: PersistedBuffer[]): PersistedBuffer[] {
  const now = Date.now();
  return buffers.filter((buf) => now - buf.timestamp < STALE_THRESHOLD_MS);
}

function truncateBuffer(serialized: string): string {
  if (serialized.length <= MAX_BUFFER_SIZE_CHARS) return serialized;
  return serialized.slice(-MAX_BUFFER_SIZE_CHARS);
}

// ============================================
// Public API
// ============================================

/**
 * Persist a terminal buffer to disk (debounced).
 * Call this on unmount, snapshot, or periodically.
 */
export function persistTerminalBuffer(
  sessionId: string,
  serialized: string,
  shellLaunchConfig?: PersistedBuffer["shellLaunchConfig"]
): void {
  if (!isTauriReady()) return;

  const truncated = truncateBuffer(serialized);
  pendingWrites.set(sessionId, {
    sessionId,
    serialized: truncated,
    timestamp: Date.now(),
    shellLaunchConfig,
  });

  // Debounce write
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flushPendingWrites();
  }, DEBOUNCE_MS);
}

/**
 * Flush all pending writes to disk immediately.
 * Call this on beforeunload.
 */
export async function flushPendingWrites(): Promise<void> {
  if (!isTauriReady() || pendingWrites.size === 0) return;

  // Clear debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  try {
    // Read current stored data
    const stored = await readStoredData();

    // Merge pending writes
    const bufferMap = new Map<string, PersistedBuffer>();
    for (const buffer of stored.buffers) {
      bufferMap.set(buffer.sessionId, buffer);
    }
    for (const [sessionId, buffer] of pendingWrites) {
      bufferMap.set(sessionId, buffer);
    }

    // Clear pending writes
    pendingWrites.clear();

    // Filter stale and sort by timestamp (newest first)
    let buffers = filterStaleBuffers([...bufferMap.values()]);
    buffers.sort((a, b) => b.timestamp - a.timestamp);

    // Cap at MAX_BUFFERS
    if (buffers.length > MAX_BUFFERS) {
      buffers = buffers.slice(0, MAX_BUFFERS);
    }

    await writeStoredData({ version: STORAGE_VERSION, buffers });
  } catch (error) {
    log.error("[bufferPersistence] Failed to flush:", error);
  }
}

/**
 * Load persisted buffers from disk.
 * Call this on app startup.
 */
export async function loadPersistedBuffers(): Promise<
  Map<string, PersistedBuffer>
> {
  if (!isTauriReady()) return new Map();

  try {
    const stored = await readStoredData();
    const freshBuffers = filterStaleBuffers(stored.buffers);

    const result = new Map<string, PersistedBuffer>();
    for (const buffer of freshBuffers) {
      result.set(buffer.sessionId, buffer);
    }

    return result;
  } catch (error) {
    log.error("[bufferPersistence] Failed to load:", error);
    return new Map();
  }
}

/**
 * Clear a specific buffer from persistence.
 * Call this when user explicitly closes a terminal.
 */
export async function clearPersistedBuffer(sessionId: string): Promise<void> {
  if (!isTauriReady()) return;

  // Remove from pending writes
  pendingWrites.delete(sessionId);

  try {
    const stored = await readStoredData();
    const buffers = stored.buffers.filter((buf) => buf.sessionId !== sessionId);
    await writeStoredData({ version: STORAGE_VERSION, buffers });
  } catch (error) {
    log.error("[bufferPersistence] Failed to clear buffer:", error);
  }
}

/**
 * Clear all persisted buffers.
 */
export async function clearAllPersistedBuffers(): Promise<void> {
  if (!isTauriReady()) return;

  pendingWrites.clear();

  try {
    await writeStoredData({ version: STORAGE_VERSION, buffers: [] });
  } catch (error) {
    log.error("[bufferPersistence] Failed to clear all buffers:", error);
  }
}
