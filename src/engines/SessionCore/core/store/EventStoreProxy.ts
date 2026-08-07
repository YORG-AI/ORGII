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
 * Components continue using Jotai atoms (eventsAtom, chatEventsAtom, etc.)
 * which are fed from the derived snapshot pushed by Rust.
 */
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";

import type { EventPayloadBody, SessionEvent } from "../types";
import type {
  DerivedSnapshot,
  EventStoreMemoryStats,
  GlobalListener,
  NormalizedSnapshotCache,
  SessionListener,
  Snapshot,
  SnapshotEnvelope,
  SnapshotPayload,
} from "./EventStoreProxyTypes";
import { inferSessionId, isRealUserEvent } from "./eventStoreEvents";
import { estimateObjectBytes } from "./memoryEstimation";
import {
  applyDeltaEnvelope,
  flushPendingDelta,
  rememberSnapshot,
} from "./snapshotCache";
import {
  type PendingDeltaState,
  isSnapshotDelta,
  isStreamingSnapshot,
} from "./snapshotMaterialization";

export type {
  DerivedSnapshot,
  EventStoreMemoryStats,
  Snapshot,
  SnapshotDelta,
  SnapshotEnvelope,
  SnapshotPayload,
  StreamingSnapshot,
} from "./EventStoreProxyTypes";
export { isStreamingSnapshot } from "./snapshotMaterialization";

const SNAPSHOT_CACHE_MAX = 5;

// Total cached events across all retained snapshots. The count cap alone let
// "20 sessions" quietly mean hundreds of MB once transcripts got long; this
// bounds the cache by its dominant cost driver instead. Switch-back to an
// evicted session refetches its snapshot from Rust (one IPC round trip).
const SNAPSHOT_CACHE_EVENT_BUDGET = 15_000;
/**
 * Grace window before a switched-away session's snapshot is released.
 * Rapid ping-ponging between sessions keeps the instant JS-cache prime and
 * the delta path; anything not revisited within the window is freed.
 */
const SNAPSHOT_RELEASE_GRACE_MS = 3 * 60 * 1000;
const log = createLogger("EventStoreProxy");

/**
 * Schedule a callback for the next animation frame; falls back to a 16ms
 * timeout in non-DOM environments (tests). Returns a canceller.
 */
function scheduleFrameCallback(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

interface PendingSessionFlush {
  /**
   * Un-materialized delta state already applied to the normalized cache;
   * null when only the notify for an already-remembered snapshot is pending.
   */
  delta: PendingDeltaState | null;
  cancelSchedule: () => void;
}

class EventStoreProxyImpl {
  private _globalListeners = new Set<GlobalListener>();
  private _sessionListeners = new Map<string, Set<SessionListener>>();
  private _latestSnapshots = new Map<string, Snapshot>();
  private _normalizedSnapshots = new Map<string, NormalizedSnapshotCache>();
  private _unlistenTauri: UnlistenFn | null = null;
  private _initialized = false;
  private _initGeneration = 0;
  /**
   * Per-session promise chains serializing envelope processing.
   * `_handleSnapshotEnvelope` awaits `getSnapshot` for delta-base misses;
   * without serialization, two envelopes for the same session can interleave
   * and apply out of order (older snapshot remembered after a newer one).
   */
  private _envelopeChains = new Map<string, Promise<void>>();
  /** Pending deferred snapshot releases, keyed by sessionId. */
  private _snapshotReleaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Per-session coalescing state: cache updates are applied per envelope
   * (ordered, lossless), while materialize + notify runs at most once per
   * animation frame per session. Pure-render consumers may therefore see
   * state up to one frame stale; every synchronous read path
   * (getLatestSessionSnapshot, latestSnapshot, getMemoryStats) and lifecycle
   * transition (switch / release / evict, streaming end) force-flushes
   * first, so no correctness-sensitive path observes the window.
   */
  private _pendingFlushes = new Map<string, PendingSessionFlush>();

  /**
   * Initialize the Tauri event listener. Call once at app startup.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    // Only short-circuit if a listener is actually registered; otherwise allow
    // re-init after a prior destroy().
    if (this._initialized && this._unlistenTauri !== null) return;
    this._initialized = true;

    // Generation token: if destroy() bumps the counter while we await
    // listen(...), the resumed init() must drop the orphaned unlisten handle
    // instead of stashing it on top of a fresh one.
    const myGen = ++this._initGeneration;

    const unlisten = await listen<SnapshotEnvelope>("es:changed", (event) => {
      void this._handleSnapshotEnvelope(event.payload);
    });

    if (myGen !== this._initGeneration) {
      unlisten();
      return;
    }
    this._unlistenTauri = unlisten;
  }

  private async _handleSnapshotEnvelope(
    envelope: SnapshotEnvelope
  ): Promise<void> {
    const { sessionId } = envelope;
    // Serialize per session: chain this envelope after the previous one so
    // async delta resolution can't interleave snapshots out of order.
    const previous = this._envelopeChains.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Previous envelope failures must not poison the chain.
      })
      .then(() => this._processSnapshotEnvelope(envelope));
    this._envelopeChains.set(sessionId, current);
    try {
      await current;
    } finally {
      // Drop the chain entry once the tail settles to avoid leaking sessions.
      if (this._envelopeChains.get(sessionId) === current) {
        this._envelopeChains.delete(sessionId);
      }
    }
  }

  private async _processSnapshotEnvelope(
    envelope: SnapshotEnvelope
  ): Promise<void> {
    const { sessionId, ...payload } = envelope;
    const snapshotPayload = payload as SnapshotPayload;

    if (isSnapshotDelta(snapshotPayload)) {
      const pendingDelta = applyDeltaEnvelope(
        sessionId,
        snapshotPayload,
        this._latestSnapshots,
        this._normalizedSnapshots,
        this._pendingFlushes.get(sessionId)?.delta ?? null
      );
      if (pendingDelta) {
        this._schedulePendingFlush(sessionId, pendingDelta);
        return;
      }
      // Delta base miss (no cache or version gap): fetch + remember the full
      // snapshot, then notify on the coalesced schedule like any envelope.
      await this.getSnapshot(sessionId);
      this._schedulePendingFlush(sessionId, null);
      return;
    }

    this._rememberSnapshot(sessionId, snapshotPayload);
    this._schedulePendingFlush(sessionId, null);
  }

  private _rememberSnapshot(sessionId: string, snapshot: Snapshot): Snapshot {
    const pending = this._pendingFlushes.get(sessionId);
    if (pending?.delta) {
      if (snapshot.version < pending.delta.version) {
        // Un-materialized deltas are already newer than this slow-resolving
        // full snapshot; surface them instead of clobbering the cache.
        return this._flushPendingSnapshot(sessionId) ?? snapshot;
      }
      // The full snapshot supersedes everything accumulated so far.
      pending.delta = null;
    }
    return rememberSnapshot(
      sessionId,
      snapshot,
      this._latestSnapshots,
      this._normalizedSnapshots,
      SNAPSHOT_CACHE_MAX,
      SNAPSHOT_CACHE_EVENT_BUDGET,
      (evicted) => this._dropPendingFlush(evicted)
    );
  }

  /**
   * Schedule the per-frame materialize + notify for a session. Passing a
   * delta records it as the (single, mutated-in-place) accumulator; passing
   * null keeps an existing accumulator and merely ensures a notify fires.
   */
  private _schedulePendingFlush(
    sessionId: string,
    delta: PendingDeltaState | null
  ): void {
    const existing = this._pendingFlushes.get(sessionId);
    if (existing) {
      if (delta) existing.delta = delta;
      return;
    }
    this._pendingFlushes.set(sessionId, {
      delta,
      cancelSchedule: scheduleFrameCallback(() => {
        this._flushPendingSnapshot(sessionId);
      }),
    });
  }

  /**
   * Force-materialize and notify a session's pending state now. Returns the
   * notified snapshot, or null when nothing was pending or the session's
   * cache is gone (released / evicted before the flush).
   */
  private _flushPendingSnapshot(sessionId: string): Snapshot | null {
    const pending = this._pendingFlushes.get(sessionId);
    if (!pending) return null;
    pending.cancelSchedule();
    this._pendingFlushes.delete(sessionId);
    const snapshot = pending.delta
      ? flushPendingDelta(
          sessionId,
          pending.delta,
          this._latestSnapshots,
          this._normalizedSnapshots,
          SNAPSHOT_CACHE_MAX,
          SNAPSHOT_CACHE_EVENT_BUDGET,
          (evicted) => this._dropPendingFlush(evicted)
        )
      : (this._latestSnapshots.get(sessionId) ?? null);
    if (snapshot) {
      this._notifyListeners(snapshot, sessionId);
    }
    return snapshot;
  }

  private _flushAllPendingSnapshots(): void {
    for (const sessionId of [...this._pendingFlushes.keys()]) {
      this._flushPendingSnapshot(sessionId);
    }
  }

  /** Drop pending state without materializing (session evicted from LRU). */
  private _dropPendingFlush(sessionId: string): void {
    const pending = this._pendingFlushes.get(sessionId);
    if (!pending) return;
    pending.cancelSchedule();
    this._pendingFlushes.delete(sessionId);
  }

  /**
   * Detach only the Tauri `es:changed` listener.
   *
   * Used by the bridge hook's unmount cleanup (StrictMode double-mount, fast
   * navigation, HMR): the IPC listener must be torn down so it isn't
   * orphaned, but per-session subscribers (`_sessionListeners`) and the
   * snapshot caches (`_latestSnapshots` / `_normalizedSnapshots`) must
   * survive so other live consumers (e.g. subagent grids) keep their data
   * and the next `init()` can resume without a cold cache.
   */
  detachTauri(): void {
    this._initGeneration++;
    if (this._unlistenTauri) {
      this._unlistenTauri();
      this._unlistenTauri = null;
    }
    this._initialized = false;
  }

  /** Full clean-up: Tauri listener, all listeners, and all snapshot caches.
   * Use on app exit or in tests; bridge unmounts should call detachTauri(). */
  destroy(): void {
    this.detachTauri();
    this._globalListeners.clear();
    this._sessionListeners.clear();
    this._latestSnapshots.clear();
    this._normalizedSnapshots.clear();
    for (const pending of this._pendingFlushes.values()) {
      pending.cancelSchedule();
    }
    this._pendingFlushes.clear();
    for (const timer of this._snapshotReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this._snapshotReleaseTimers.clear();
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
    this._globalListeners.add(listener);
    return () => {
      this._globalListeners.delete(listener);
    };
  }

  /**
   * Subscribe to snapshot changes for a specific session only.
   * Used by `useSessionEvents` for subagent nested block rendering.
   * Returns an unsubscribe function.
   */
  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    let listeners = this._sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this._sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) {
        this._sessionListeners.delete(sessionId);
      }
    };
  }

  /** Get the latest snapshot for a specific session (may be null). */
  getLatestSessionSnapshot(sessionId: string): Snapshot | null {
    // Synchronous readers must never observe the one-frame coalescing window.
    this._flushPendingSnapshot(sessionId);
    return this._latestSnapshots.get(sessionId) ?? null;
  }

  /**
   * Evict a session's cached snapshot and per-session listeners.
   *
   * Call this when Rust evicts a session from its LRU store so the JS-side
   * cache stays in sync and doesn't hold large event arrays for idle sessions.
   */
  evictSessionCache(sessionId: string): void {
    // Surface the final coalesced state to listeners before they are dropped.
    this._flushPendingSnapshot(sessionId);
    this._latestSnapshots.delete(sessionId);
    this._normalizedSnapshots.delete(sessionId);
    this._sessionListeners.delete(sessionId);
  }

  /**
   * Drop only the cached snapshot data (materialized + normalized) for a
   * session, keeping `_sessionListeners` intact so still-mounted consumers
   * keep receiving future pushes — the next envelope re-primes the cache
   * (via a full snapshot fetch if it arrives as a delta).
   *
   * Use on session switch-away and when Rust idle-evicts a session: the full
   * event arrays are the dominant per-session JS-heap cost, and without this
   * every visited session stays resident until SNAPSHOT_CACHE_MAX pushes it
   * out.
   */
  releaseSessionSnapshot(sessionId: string): void {
    this.cancelScheduledSnapshotRelease(sessionId);
    // Deliver the final coalesced state before dropping it — a delta applied
    // this frame must reach subscribers even though its cache is released.
    this._flushPendingSnapshot(sessionId);
    this._latestSnapshots.delete(sessionId);
    this._normalizedSnapshots.delete(sessionId);
  }

  /**
   * `releaseSessionSnapshot`, but skipped while the session's latest snapshot
   * is still streaming — an active background session keeps pushing
   * envelopes, so evicting it would only force a full-snapshot refetch on its
   * next delta.
   */
  releaseSessionSnapshotIfIdle(sessionId: string): void {
    this._flushPendingSnapshot(sessionId);
    const cached = this._latestSnapshots.get(sessionId);
    if (cached && isStreamingSnapshot(cached)) return;
    this.releaseSessionSnapshot(sessionId);
  }

  /**
   * Deferred `releaseSessionSnapshotIfIdle` for a session the UI just
   * switched away from. The grace window keeps rapid switch-backs warm
   * (instant cache prime, delta application stays valid); becoming active
   * again cancels the release via `cancelScheduledSnapshotRelease`.
   * Streaming is re-checked when the timer fires.
   */
  scheduleSessionSnapshotRelease(sessionId: string): void {
    this.cancelScheduledSnapshotRelease(sessionId);
    const timer = setTimeout(() => {
      this._snapshotReleaseTimers.delete(sessionId);
      this.releaseSessionSnapshotIfIdle(sessionId);
    }, SNAPSHOT_RELEASE_GRACE_MS);
    this._snapshotReleaseTimers.set(sessionId, timer);
  }

  /** Cancel a pending deferred release (the session is active again). */
  cancelScheduledSnapshotRelease(sessionId: string): void {
    const timer = this._snapshotReleaseTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._snapshotReleaseTimers.delete(sessionId);
  }

  getMemoryStats(): EventStoreMemoryStats {
    // Materialize pending state first so the reported sizes are current.
    this._flushAllPendingSnapshots();
    let cachedEvents = 0;
    let bytes = 0;
    for (const snapshot of this._latestSnapshots.values()) {
      bytes += estimateObjectBytes(snapshot);
    }
    for (const cache of this._normalizedSnapshots.values()) {
      cachedEvents += cache.eventsById.size;
      bytes += estimateObjectBytes(cache);
    }
    return {
      cachedSessions: this._latestSnapshots.size,
      normalizedSessions: this._normalizedSnapshots.size,
      cachedEvents,
      bytes,
    };
  }

  /** Get the latest snapshot (any session — last received). */
  get latestSnapshot(): Snapshot | null {
    this._flushAllPendingSnapshots();
    if (this._latestSnapshots.size === 0) return null;
    let latest: Snapshot | null = null;
    for (const snap of this._latestSnapshots.values()) {
      if (!latest || snap.version > latest.version) {
        latest = snap;
      }
    }
    return latest;
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
      this._flushPendingSnapshot(sessionId);
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
    this.cancelScheduledSnapshotRelease(sessionId);
    // The bridge primes the incoming session from the JS cache — it must not
    // read state that is stale by a frame of un-materialized deltas.
    this._flushPendingSnapshot(sessionId);
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
      return this._rememberSnapshot(sessionId, snapshot) as DerivedSnapshot;
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
      recentTurnCount,
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

  /** Update streamOutput on the last shell tool_call. Returns event ID if found. */
  async updateLastShellOutput(
    streamOutput: string,
    sessionId?: string
  ): Promise<string | null> {
    return rpc.sessionCore.eventStore.updateLastShellOutput({
      streamOutput,
      sessionId: sessionId ?? null,
    });
  }

  /**
   * Update shell process info (pid, status, exit_code, log_path) on the last shell tool_call.
   */
  updateLastShellProcess(
    pid: number,
    status: "running" | "background" | "exited" | "killed",
    exitCode?: number,
    logPath?: string,
    sessionId?: string
  ): void {
    void rpc.sessionCore.eventStore.updateLastShellProcess({
      pid,
      status,
      exitCode: exitCode ?? null,
      logPath: logPath ?? null,
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

  // =========================================================================
  // Internal
  // =========================================================================

  private _notifyListeners(snapshot: Snapshot, sessionId: string): void {
    for (const listener of this._globalListeners) {
      listener(snapshot, sessionId);
    }

    const sessionListeners = this._sessionListeners.get(sessionId);
    if (sessionListeners) {
      for (const listener of sessionListeners) {
        listener(snapshot);
      }
    }
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
