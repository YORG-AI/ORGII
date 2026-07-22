const MAX_LOADED_PAYLOADS = 6;
const MAX_LOADED_PAYLOAD_BYTES = 8 * 1024 * 1024;
const LOADED_PAYLOAD_TTL_MS = 3 * 60 * 1000;

interface LoadedPayloadEntry {
  key: string;
  body: string;
  byteSize: number;
  lastAccessedAt: number;
}

const loadedPayloads = new Map<string, LoadedPayloadEntry>();
interface PendingPayloadLoad {
  promise: Promise<string | null>;
  registryEpoch: number;
}

const pendingLoads = new Map<string, PendingPayloadLoad>();
// Clearing on switch/close invalidates completions that are already across
// the async boundary. Without this epoch, a late range response could
// repopulate the cache after its owning replay episode was released.
let registryEpoch = 0;

function estimateStringBytes(value: string): number {
  return value.length * 2;
}

export function getPayloadRegistryKey(
  sessionId: string,
  eventId: string,
  fieldPath: string
): string {
  return `${sessionId}:${eventId}:${fieldPath}`;
}

export function getLoadedPayload(key: string): string | null {
  pruneLoadedPayloads();
  const entry = loadedPayloads.get(key);
  if (!entry) return null;
  entry.lastAccessedAt = Date.now();
  return entry.body;
}

export function getPendingPayloadLoad(
  key: string
): Promise<string | null> | null {
  return pendingLoads.get(key)?.promise ?? null;
}

export async function trackPendingPayloadLoad(
  key: string,
  load: Promise<string | null>
): Promise<string | null> {
  const pending = { promise: load, registryEpoch };
  pendingLoads.set(key, pending);
  try {
    const body = await load;
    if (
      body !== null &&
      registryEpoch === pending.registryEpoch &&
      pendingLoads.get(key) === pending
    ) {
      markPayloadLoaded(key, body);
    }
    return body;
  } finally {
    if (pendingLoads.get(key) === pending) {
      pendingLoads.delete(key);
    }
  }
}

export function markPayloadLoaded(key: string, body: string): void {
  loadedPayloads.set(key, {
    key,
    body,
    byteSize: estimateStringBytes(body),
    lastAccessedAt: Date.now(),
  });
  pruneLoadedPayloads();
}

export function unloadPayload(key: string): void {
  loadedPayloads.delete(key);
}

export function clearLoadedPayloads(): void {
  registryEpoch += 1;
  loadedPayloads.clear();
  pendingLoads.clear();
}

export function getLoadedPayloadStats(): { entries: number; bytes: number } {
  pruneLoadedPayloads();
  return {
    entries: loadedPayloads.size,
    bytes: loadedPayloadBytes(),
  };
}

function loadedPayloadBytes(): number {
  let totalBytes = 0;
  for (const entry of loadedPayloads.values()) {
    totalBytes += entry.byteSize;
  }
  return totalBytes;
}

function oldestLoadedPayloadEntry(): LoadedPayloadEntry | null {
  let oldestEntry: LoadedPayloadEntry | null = null;
  for (const entry of loadedPayloads.values()) {
    if (!oldestEntry || entry.lastAccessedAt < oldestEntry.lastAccessedAt) {
      oldestEntry = entry;
    }
  }
  return oldestEntry;
}

function pruneLoadedPayloads(): void {
  const now = Date.now();
  for (const [key, entry] of loadedPayloads) {
    if (now - entry.lastAccessedAt >= LOADED_PAYLOAD_TTL_MS) {
      loadedPayloads.delete(key);
    }
  }
  let totalBytes = loadedPayloadBytes();
  while (
    loadedPayloads.size > MAX_LOADED_PAYLOADS ||
    totalBytes > MAX_LOADED_PAYLOAD_BYTES
  ) {
    const entry = oldestLoadedPayloadEntry();
    if (!entry) return;
    loadedPayloads.delete(entry.key);
    totalBytes -= entry.byteSize;
  }
}
