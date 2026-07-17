import type {
  DerivedSnapshot,
  NormalizedSnapshotCache,
  Snapshot,
  SnapshotDelta,
} from "./EventStoreProxyTypes";
import {
  type PendingDeltaState,
  applyDeltaToCache,
  buildNormalizedCache,
  isStreamingSnapshot,
  materializeFullSnapshot,
  materializePendingDelta,
  materializeStreamingSnapshot,
} from "./snapshotMaterialization";

/**
 * Store a materialized snapshot with most-recently-written LRU ordering.
 * Does NOT touch the session's normalized cache — callers own cache
 * consistency. Returns the sessionId evicted to honor `maxSnapshots` (if
 * any) so the owner can drop per-session bookkeeping such as pending
 * flushes.
 */
/**
 * Rough retained-size proxy for one cached snapshot: its event count. The
 * per-event object graph dominates the cache's footprint, so budgeting by
 * events keeps a few heavy transcripts OR many light ones without letting
 * "count-bounded" turn into hundreds of MB.
 */
function snapshotEventWeight(snapshot: Snapshot): number {
  if ("events" in snapshot) {
    return (snapshot as DerivedSnapshot).events.length;
  }
  return snapshot.chatEvents?.length ?? 0;
}

function storeSnapshot(
  sessionId: string,
  snapshot: Snapshot,
  latestSnapshots: Map<string, Snapshot>,
  normalizedSnapshots: Map<string, NormalizedSnapshotCache>,
  maxSnapshots: number,
  eventBudget: number
): string[] {
  latestSnapshots.delete(sessionId);
  latestSnapshots.set(sessionId, snapshot);

  const evicted: string[] = [];
  let totalWeight = 0;
  for (const cached of latestSnapshots.values()) {
    totalWeight += snapshotEventWeight(cached);
  }
  // Evict oldest-first until both bounds hold. The just-stored session is
  // the newest entry and is never evicted, even when it alone exceeds the
  // budget (a single huge transcript must stay usable).
  while (
    latestSnapshots.size > 1 &&
    (latestSnapshots.size > maxSnapshots || totalWeight > eventBudget)
  ) {
    const oldest = latestSnapshots.keys().next().value;
    if (oldest === undefined || oldest === sessionId) break;
    const oldestSnapshot = latestSnapshots.get(oldest);
    totalWeight -= oldestSnapshot ? snapshotEventWeight(oldestSnapshot) : 0;
    latestSnapshots.delete(oldest);
    normalizedSnapshots.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
}

/**
 * Apply a delta envelope to the session's normalized cache WITHOUT
 * materializing a snapshot. Returns the (new or updated) pending state on
 * success; null when the delta cannot be applied — no cache, or the delta's
 * base version does not match the newest known state (the stored snapshot,
 * or pending deltas already applied on top of it) — in which case the
 * caller must fall back to a full snapshot fetch.
 */
export function applyDeltaEnvelope(
  sessionId: string,
  delta: SnapshotDelta,
  latestSnapshots: Map<string, Snapshot>,
  normalizedSnapshots: Map<string, NormalizedSnapshotCache>,
  pending: PendingDeltaState | null
): PendingDeltaState | null {
  const cache = normalizedSnapshots.get(sessionId);
  if (!cache) return null;
  const baseVersion =
    pending?.version ?? latestSnapshots.get(sessionId)?.version;
  if (baseVersion !== delta.baseVersion) return null;
  return applyDeltaToCache(delta, cache, pending);
}

/**
 * Materialize accumulated delta state and store the result. Returns the
 * stored snapshot, or null when the session's cache is gone (released or
 * evicted between accumulation and flush). A stored snapshot at least as
 * new as the pending state wins — the pending deltas were superseded by a
 * full snapshot remembered in the meantime.
 */
export function flushPendingDelta(
  sessionId: string,
  pending: PendingDeltaState,
  latestSnapshots: Map<string, Snapshot>,
  normalizedSnapshots: Map<string, NormalizedSnapshotCache>,
  maxSnapshots: number,
  eventBudget: number,
  onEvicted?: (evictedSessionId: string) => void
): Snapshot | null {
  const cache = normalizedSnapshots.get(sessionId);
  if (!cache) return null;
  const previous = latestSnapshots.get(sessionId);
  if (previous && previous.version >= pending.version) {
    return previous;
  }
  const snapshot = materializePendingDelta(pending, cache, previous);
  const evicted = storeSnapshot(
    sessionId,
    snapshot,
    latestSnapshots,
    normalizedSnapshots,
    maxSnapshots,
    eventBudget
  );
  for (const evictedSessionId of evicted) onEvicted?.(evictedSessionId);
  return snapshot;
}

export function rememberSnapshot(
  sessionId: string,
  snapshot: Snapshot,
  latestSnapshots: Map<string, Snapshot>,
  normalizedSnapshots: Map<string, NormalizedSnapshotCache>,
  maxSnapshots: number,
  eventBudget: number,
  onEvicted?: (evictedSessionId: string) => void
): Snapshot {
  // Reject version regressions: a late-arriving older snapshot (e.g. a slow
  // getSnapshot() resolving after a newer push was already remembered) must
  // not clobber the newer cache state. Keep and return the cached snapshot.
  const cached = latestSnapshots.get(sessionId);
  if (cached && snapshot.version < cached.version) {
    return cached;
  }

  const normalized = buildNormalizedCache(snapshot);
  const snapshotToStore = normalized
    ? materializeFullSnapshot(snapshot as DerivedSnapshot, normalized)
    : isStreamingSnapshot(snapshot)
      ? materializeStreamingSnapshot(snapshot)
      : snapshot;

  if (normalized) {
    normalizedSnapshots.delete(sessionId);
    normalizedSnapshots.set(sessionId, normalized);
  }

  const evicted = storeSnapshot(
    sessionId,
    snapshotToStore,
    latestSnapshots,
    normalizedSnapshots,
    maxSnapshots,
    eventBudget
  );
  for (const evictedSessionId of evicted) onEvicted?.(evictedSessionId);

  return snapshotToStore;
}
