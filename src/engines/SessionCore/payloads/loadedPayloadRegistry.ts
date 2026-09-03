import { registerCache } from "@src/util/memory/cacheRegistry";

const MAX_LOADED_PAYLOADS = 6;
const MAX_LOADED_PAYLOAD_BYTES = 8 * 1024 * 1024;

interface LoadedPayloadEntry {
  key: string;
  body: string;
  byteSize: number;
  lastAccessedAt: number;
}

const loadedPayloads = new Map<string, LoadedPayloadEntry>();
const pendingLoads = new Map<string, Promise<string | null>>();

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
  const entry = loadedPayloads.get(key);
  if (!entry) return null;
  entry.lastAccessedAt = Date.now();
  return entry.body;
}

export function getPendingPayloadLoad(
  key: string
): Promise<string | null> | null {
  return pendingLoads.get(key) ?? null;
}

export async function trackPendingPayloadLoad(
  key: string,
  load: Promise<string | null>
): Promise<string | null> {
  pendingLoads.set(key, load);
  try {
    const body = await load;
    if (body !== null) {
      markPayloadLoaded(key, body);
    }
    return body;
  } finally {
    pendingLoads.delete(key);
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
  loadedPayloads.clear();
  pendingLoads.clear();
}

export function getLoadedPayloadStats(): { entries: number; bytes: number } {
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

registerCache({
  id: "sessionCore.payloadBodies",
  tier: 1,
  estimate: getLoadedPayloadStats,
  // Visible payloads are refetched on demand, so only shed under critical
  // pressure; a moderate trim would just cause refetch churn.
  trim: (level) => {
    if (level === "critical") clearLoadedPayloads();
  },
});
