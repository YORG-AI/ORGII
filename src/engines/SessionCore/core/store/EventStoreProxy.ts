/**
 * EventStoreProxy — Thin frontend wrapper for the Rust EventStore.
 *
 * All event storage, indexing, merging, derived computation, and session
 * caching now live in Rust. This proxy:
 *
 * 1. Calls typed Tauri RPC procedures for writes (set, append, upsert, merge, etc.)
 * 2. Listens to `es:changed` Tauri events for read notifications
 * 3. Routes snapshots by `sessionId` so per-session subscribers (e.g.
 *    subagent nested blocks) only receive updates for their session.
 * 4. Applies delta envelopes to the per-session normalized cache in arrival
 *    order (lossless), but coalesces the expensive materialize + notify to
 *    at most once per animation frame per session. Synchronous read paths
 *    and lifecycle transitions force-flush, so only pure-render consumers
 *    can observe the ≤1-frame staleness window.
 *
 * (2)–(4) — the snapshot caches, listener registry, coalescing queue and
 * release timers — live in `SnapshotCacheManager`; this file owns the RPC
 * surface and delegates every cache/notify concern to it.
 *
 * Components continue using Jotai atoms (eventsAtom, chatEventsAtom, etc.)
 * which are fed from the derived snapshot pushed by Rust.
 */
import { rpc } from "@src/api/tauri/rpc";
import { TURN_WINDOW_RECENT_BODY_COUNT } from "@src/engines/SessionCore/turns/turnWindowConfig";
import { createLogger } from "@src/hooks/logger";

import type { EventPayloadBody, SessionEvent } from "../types";
import type {
  DerivedSnapshot,
  EventStoreMemoryStats,
  GlobalListener,
  SessionListener,
  Snapshot,
} from "./EventStoreProxyTypes";
import { inferSessionId, isRealUserEvent } from "./eventStoreEvents";
import { SnapshotCacheManager } from "./snapshotCacheManager";

export type {
  DerivedSnapshot,
  EventStoreMemoryStats,
  Snapshot,
  SnapshotDelta,
  SnapshotEnvelope,
  SnapshotEventMembership,
  SnapshotPayload,
  StreamingSnapshot,
} from "./EventStoreProxyTypes";
export {
  isSnapshotActivelyStreaming,
  isStreamingSnapshot,
} from "./snapshotMaterialization";

const log = createLogger("EventStoreProxy");

class EventStoreProxyImpl {
  /**
   * JS-side snapshot cache, listener registry and coalescing queue. The
   * delta base-miss fallback routes back through `getSnapshot` so the fetch
   * takes the same RPC + remember path as a caller-initiated read.
   */
  private readonly _cache = new SnapshotCacheManager((sessionId) =>
    this.getSnapshot(sessionId)
  );

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Initialize the Tauri event listener. Call once at app startup.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    await this._cache.init();
  }

  /**
   * Detach only the Tauri `es:changed` listener, keeping subscribers and the
   * snapshot caches alive. Used by the bridge hook's unmount cleanup.
   */
  detachTauri(): void {
    this._cache.detachTauri();
  }

  /** Full clean-up: Tauri listener, all listeners, and all snapshot caches.
   * Use on app exit or in tests; bridge unmounts should call detachTauri(). */
  destroy(): void {
    this._cache.destroy();
  }

  // =========================================================================
  // Subscribe / Read
  // =========================================================================

  /**
   * Subscribe to ALL snapshot changes (any session).
   * Callback receives the snapshot and the sessionId it belongs to.
   * Returns an unsubscribe function.
   */
  subscribe(listener: GlobalListener): () => void {
    return this._cache.subscribe(listener);
  }

  /**
   * Subscribe to snapshot changes for a specific session only.
   * Used by `useSessionEvents` for subagent nested block rendering.
   * Returns an unsubscribe function.
   */
  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    return this._cache.subscribeSession(sessionId, listener);
  }

  /** Get the latest snapshot for a specific session (may be null). */
  getLatestSessionSnapshot(sessionId: string): Snapshot | null {
    return this._cache.getLatestSessionSnapshot(sessionId);
  }

  /**
   * Evict a session's cached snapshot and per-session listeners.
   *
   * Call this when Rust evicts a session from its LRU store so the JS-side
   * cache stays in sync and doesn't hold large event arrays for idle sessions.
   */
  evictSessionCache(sessionId: string): void {
    this._cache.evictSessionCache(sessionId);
  }

  /**
   * Drop only the cached snapshot data (materialized + normalized) for a
   * session, keeping per-session listeners intact so still-mounted consumers
   * keep receiving future pushes.
   */
  releaseSessionSnapshot(sessionId: string): void {
    this._cache.releaseSessionSnapshot(sessionId);
  }

  /**
   * `releaseSessionSnapshot`, but skipped while the session's latest snapshot
   * is still streaming.
   */
  releaseSessionSnapshotIfIdle(sessionId: string): void {
    this._cache.releaseSessionSnapshotIfIdle(sessionId);
  }

  /**
   * Deferred `releaseSessionSnapshotIfIdle` for a session the UI just
   * switched away from; the grace window keeps rapid switch-backs warm.
   */
  scheduleSessionSnapshotRelease(sessionId: string): void {
    this._cache.scheduleSessionSnapshotRelease(sessionId);
  }

  /** Cancel a pending deferred release (the session is active again). */
  cancelScheduledSnapshotRelease(sessionId: string): void {
    this._cache.cancelScheduledSnapshotRelease(sessionId);
  }

  getMemoryStats(): EventStoreMemoryStats {
    return this._cache.getMemoryStats();
  }

  /** Get the latest snapshot (any session — last received). */
  get latestSnapshot(): Snapshot | null {
    return this._cache.latestSnapshot;
  }

  // =========================================================================
  // Write Operations (delegate to Rust)
  // =========================================================================

  private async evictSyntheticUserEventsForRealUserEvents(
    events: SessionEvent[],
    sessionId?: string | null
  ): Promise<void> {
    if (!events.some(isRealUserEvent)) return;
    await this.removeSyntheticUserInputEvents(
      sessionId ?? inferSessionId(events)
    );
  }

  /** Replace all events (session load / clear). */
  async set(events: SessionEvent[], sessionId?: string): Promise<void> {
    await rpc.sessionCore.eventStore.set({
      events,
      sessionId: sessionId ?? inferSessionId(events),
    });
  }

  /** Append events (deduped by ID). */
  async append(events: SessionEvent[], sessionId?: string): Promise<void> {
    if (events.length === 0) return;
    const resolvedSessionId = sessionId ?? inferSessionId(events);
    await this.evictSyntheticUserEventsForRealUserEvents(
      events,
      resolvedSessionId
    );
    await rpc.sessionCore.eventStore.append({
      events,
      sessionId: resolvedSessionId,
    });
  }

  /** Upsert a single event. */
  async upsert(event: SessionEvent, sessionId?: string): Promise<void> {
    const resolvedSessionId = sessionId ?? event.sessionId ?? null;
    await this.evictSyntheticUserEventsForRealUserEvents(
      [event],
      resolvedSessionId
    );
    await rpc.sessionCore.eventStore.upsert({
      event,
      sessionId: resolvedSessionId,
    });
  }

  /** Update a single event by ID with a partial patch. */
  async updateById(
    id: string,
    patch: Partial<SessionEvent>,
    sessionId?: string
  ): Promise<boolean> {
    return rpc.sessionCore.eventStore.updateById({
      id,
      patch,
      sessionId: sessionId ?? null,
    });
  }

  /** Merge incoming events (tool_result → tool_call, dedup, append). */
  async mergeEvents(events: SessionEvent[], sessionId?: string): Promise<void> {
    if (events.length === 0) return;
    const resolvedSessionId = sessionId ?? inferSessionId(events);
    await this.evictSyntheticUserEventsForRealUserEvents(
      events,
      resolvedSessionId
    );
    await rpc.sessionCore.eventStore.mergeEvents({
      events,
      sessionId: resolvedSessionId,
    });
  }

  /** Merge lazy-loaded round body events without changing hydration mode to live. */
  async mergeRoundWindowEvents(
    events: SessionEvent[],
    sessionId?: string
  ): Promise<void> {
    if (events.length === 0) return;
    await rpc.sessionCore.eventStore.mergeRoundWindowEvents({
      events,
      sessionId: sessionId ?? inferSessionId(events),
    });
  }

  /** Set streaming mode on/off. */
  async setStreaming(streaming: boolean, sessionId?: string): Promise<void> {
    // Stream completion must surface the final coalesced state immediately —
    // completion handlers read snapshot-derived state right after this call.
    if (!streaming && sessionId) {
      this._cache.flushPendingSnapshot(sessionId);
    }
    await rpc.sessionCore.eventStore.setStreaming({
      streaming,
      sessionId: sessionId ?? null,
    });
  }

  /** Clear all events from the active store. */
  async clear(sessionId?: string): Promise<void> {
    await rpc.sessionCore.eventStore.clear({ sessionId: sessionId ?? null });
  }

  /**
   * Keep only events strictly before the event with the given ID.
   */
  async truncateBeforeId(
    eventId: string,
    sessionId?: string
  ): Promise<boolean> {
    return rpc.sessionCore.eventStore.truncateBeforeId({
      eventId,
      sessionId: sessionId ?? null,
    });
  }

  // =========================================================================
  // Session Manager Operations
  // =========================================================================

  /** Switch the active session. Returns true if cache hit. */
  async switchSession(sessionId: string): Promise<boolean> {
    // Becoming active again rescues the snapshot from a pending deferred
    // release scheduled when the user previously switched away.
    this._cache.cancelScheduledSnapshotRelease(sessionId);
    // The bridge primes the incoming session from the JS cache — it must not
    // read state that is stale by a frame of un-materialized deltas.
    this._cache.flushPendingSnapshot(sessionId);
    return rpc.sessionCore.eventStore.switchSession({ sessionId });
  }

  /** Pin a session (agent running). */
  async pinSession(sessionId: string): Promise<void> {
    await rpc.sessionCore.eventStore.pinSession({ sessionId });
  }

  /** Unpin a session (agent finished). */
  async unpinSession(sessionId: string): Promise<void> {
    await rpc.sessionCore.eventStore.unpinSession({ sessionId });
  }

  /** Evict a session from the in-memory Rust cache and purge JS-side caches. */
  async evictSession(sessionId: string): Promise<void> {
    await rpc.sessionCore.eventStore.evictSession({ sessionId });
    // Mirror the Rust-side eviction in the JS snapshot cache so large event
    // arrays are freed on the JS heap as well.
    this.evictSessionCache(sessionId);
  }

  /** Buffer events for a background session. */
  async bufferEvents(sessionId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.evictSyntheticUserEventsForRealUserEvents(events, sessionId);
    await rpc.sessionCore.eventStore.bufferEvents({ sessionId, events });
  }

  // =========================================================================
  // Snapshot / Query
  // =========================================================================

  /** Fetch the full derived snapshot from Rust. */
  async getSnapshot(sessionId?: string): Promise<DerivedSnapshot> {
    const snapshot = (await rpc.sessionCore.eventStore.getSnapshot({
      sessionId: sessionId ?? null,
    })) as DerivedSnapshot;
    if (sessionId) {
      return this._cache.rememberSnapshot(
        sessionId,
        snapshot
      ) as DerivedSnapshot;
    }
    return snapshot;
  }

  /** Fetch raw events array from Rust. */
  async getEvents(sessionId?: string): Promise<SessionEvent[]> {
    return rpc.sessionCore.eventStore.getEvents({
      sessionId: sessionId ?? null,
    }) as Promise<SessionEvent[]>;
  }

  /**
   * Read the FULL persisted event history from the SQLite cache, bypassing
   * the (possibly turn-windowed / LRU-evicted) in-memory store entirely.
   *
   * The in-memory store is a windowed view: `getEvents` on a non-resident
   * session returns `[]`, and a session hydrated via `loadInitialTurnWindow`
   * holds placeholders instead of full turn bodies. Consumers that need the
   * durable truth (e.g. the collaboration segments push, design §7.3 step 1)
   * must read here. Rust persists events on ingestion, so this lags a live
   * stream by at most one write batch.
   */
  async getPersistedEvents(sessionId: string): Promise<SessionEvent[]> {
    return rpc.sessionCore.cache.loadEvents({
      sessionId,
    }) as Promise<SessionEvent[]>;
  }

  /**
   * Count the persisted events without loading them. The cheap probe for
   * "does the durable cache still hold this replay" checks, where
   * `getPersistedEvents` on a large session costs a full-history read.
   */
  async countPersistedEvents(sessionId: string): Promise<number> {
    return rpc.sessionCore.cache.countEvents({ sessionId });
  }

  /**
   * Read the cache's durable content revision without materializing events.
   * `contentRevision` is advanced by Rust only when an event row actually
   * changes, so metadata-only session edits and the periodic cache save do
   * not make a cloud replay look dirty.
   */
  async getPersistedEventRevision(
    sessionId: string
  ): Promise<{ eventCount: number; revision: number } | null> {
    const metadata = await rpc.sessionCore.cache.getSessionMetadata({
      sessionId,
    });
    return metadata
      ? {
          eventCount: metadata.eventCount,
          revision: metadata.contentRevision,
        }
      : null;
  }

  /**
   * Persist one bounded event batch directly to SQLite without materializing
   * the session in the Rust/JS in-memory stores. Large cloud replays use this
   * while downloading, then hydrate only the initial turn window.
   */
  async persistEventsBatch(
    events: SessionEvent[],
    sessionId: string
  ): Promise<number> {
    if (events.length === 0) return 0;
    return rpc.sessionCore.cache.appendImportedEvents({ sessionId, events });
  }

  /** Publish a page-streamed replay with one final metadata/index pass. */
  async finalizePersistedImport(sessionId: string): Promise<number> {
    return rpc.sessionCore.cache.finalizeImportedEvents({ sessionId });
  }

  // =========================================================================
  // SQLite Bridge
  // =========================================================================

  /** Load events from SQLite cache into the Rust store. Returns count loaded. */
  async loadFromCache(sessionId: string): Promise<number> {
    return rpc.sessionCore.eventStore.loadFromCache({ sessionId });
  }

  /** Load a round-windowed cache view into the Rust store. */
  async loadInitialTurnWindow(
    sessionId: string,
    recentTurnCount?: number
  ): Promise<number> {
    return rpc.sessionCore.eventStore.loadInitialTurnWindow({
      sessionId,
      recentTurnCount: recentTurnCount ?? TURN_WINDOW_RECENT_BODY_COUNT,
    });
  }

  /** Remove one loaded turn body from the in-memory store and restore its placeholder. */
  async unloadTurnBody(sessionId: string, turnId: string): Promise<number> {
    return rpc.sessionCore.eventStore.unloadTurnBody({ sessionId, turnId });
  }

  async loadEventPayload(
    sessionId: string,
    eventId: string,
    fieldPath: string
  ): Promise<EventPayloadBody | null> {
    return rpc.sessionCore.cache.loadEventPayload({
      sessionId,
      eventId,
      fieldPath,
    });
  }

  /** Save current store events to SQLite cache. Returns count saved. */
  async saveToCache(sessionId: string): Promise<number> {
    try {
      return await rpc.sessionCore.eventStore.saveToCache({ sessionId });
    } catch (error) {
      log.warn("saveToCache failed; continuing with in-memory EventStore", {
        sessionId,
        error,
      });
      return 0;
    }
  }

  /** Delete a session's persisted SQLite events, keeping the session record. */
  async clearPersistedHistory(sessionId: string): Promise<void> {
    await rpc.sessionCore.cache.clearSessionHistory({ sessionId });
  }

  // =========================================================================
  // Batch Update Operations
  // =========================================================================

  /** Complete the last running event. Returns the event ID if found. */
  async completeLastRunning(sessionId?: string): Promise<string | null> {
    return rpc.sessionCore.eventStore.completeLastRunning({
      sessionId: sessionId ?? null,
    });
  }

  /** Batch-update multiple events by IDs with the same patch. Returns count updated. */
  async patchByIds(
    ids: string[],
    patch: Partial<SessionEvent>,
    sessionId?: string
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return rpc.sessionCore.eventStore.patchByIds({
      ids,
      patch,
      sessionId: sessionId ?? null,
    });
  }

  /** Remove events whose IDs start with a given prefix. Returns count removed. */
  async removeByIdPrefix(prefix: string, sessionId?: string): Promise<number> {
    return rpc.sessionCore.eventStore.removeByIdPrefix({
      prefix,
      sessionId: sessionId ?? null,
    });
  }

  /** Remove frontend-injected user placeholders after backend echo arrives. */
  async removeSyntheticUserInputEvents(
    sessionId?: string | null
  ): Promise<number> {
    return rpc.sessionCore.eventStore.removeSyntheticUserInputs({
      sessionId: sessionId ?? null,
    });
  }

  /** Atomically remove one event and upsert another (stream finalization). */
  async replaceAndRemove(
    removeId: string | null,
    newEvent: SessionEvent,
    sessionId?: string
  ): Promise<boolean> {
    const resolvedSessionId = sessionId ?? newEvent.sessionId ?? null;
    await this.evictSyntheticUserEventsForRealUserEvents(
      [newEvent],
      resolvedSessionId
    );
    return rpc.sessionCore.eventStore.replaceAndRemove({
      removeId,
      newEvent,
      sessionId: resolvedSessionId,
    });
  }

  /** Update args on the last active spawning tool_call. Returns event ID if found. */
  async updateActiveTaskArgs(
    mergeArgs: Record<string, unknown>,
    functionNames?: string[],
    sessionId?: string
  ): Promise<string | null> {
    return rpc.sessionCore.eventStore.updateActiveTaskArgs({
      mergeArgs,
      functionNames: functionNames ?? null,
      sessionId: sessionId ?? null,
    });
  }

  /** Check if there is an active spawning tool_call in the store. */
  async hasActiveTask(
    functionNames?: string[],
    sessionId?: string
  ): Promise<boolean> {
    return rpc.sessionCore.eventStore.hasActiveTask({
      functionNames: functionNames ?? null,
      sessionId: sessionId ?? null,
    });
  }
}

// ============================================================================
// Singleton
// ============================================================================

/**
 * Global event store proxy singleton.
 * All session sync hooks write here; all UI consumers read via Jotai atoms
 * that are fed from snapshot notifications.
 */
export const eventStoreProxy = new EventStoreProxyImpl();
export type { EventStoreProxyImpl as EventStoreProxy };
