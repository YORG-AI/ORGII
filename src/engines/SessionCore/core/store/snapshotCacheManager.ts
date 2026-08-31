/**
 * SnapshotCacheManager — the JS-side snapshot cache behind `EventStoreProxy`.
 *
 * Owns everything on the read/notify path so the proxy itself stays a thin
 * RPC surface:
 *
 * 1. The `es:changed` Tauri subscription and per-session envelope ordering
 * 2. The materialized + normalized snapshot caches (LRU, bounded by a total
 *    event budget)
 * 3. The rAF-coalesced flush queue: delta envelopes are applied to the
 *    normalized cache in arrival order (lossless), while the expensive
 *    materialize + notify runs at most once per animation frame per session
 * 4. The global / per-session listener registry
 * 5. Deferred snapshot release timers for switched-away sessions
 *
 * Pure-render consumers may observe state up to one frame stale; every
 * synchronous read path and lifecycle transition force-flushes first, so no
 * correctness-sensitive path observes the window.
 */
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

import type {
  EventStoreMemoryStats,
  GlobalListener,
  NormalizedSnapshotCache,
  SessionListener,
  Snapshot,
  SnapshotEnvelope,
  SnapshotPayload,
} from "./EventStoreProxyTypes";
import { estimateObjectBytes } from "./memoryEstimation";
import {
  applyDeltaEnvelope,
  flushPendingDelta,
  rememberSnapshot,
} from "./snapshotCache";
import {
  type PendingDeltaState,
  isSnapshotActivelyStreaming,
  isSnapshotDelta,
} from "./snapshotMaterialization";

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

/**
 * Fetch (and remember) the full snapshot for a session. Injected by the
 * proxy so the delta base-miss fallback can go through the same RPC path as
 * a caller-initiated `getSnapshot`, without the cache depending on `rpc`.
 */
export type FullSnapshotFetcher = (sessionId: string) => Promise<Snapshot>;

export class SnapshotCacheManager {
  private _globalListeners = new Set<GlobalListener>();
  private _sessionListeners = new Map<string, Set<SessionListener>>();
  private _latestSnapshots = new Map<string, Snapshot>();
  private _normalizedSnapshots = new Map<string, NormalizedSnapshotCache>();
  private _unlistenTauri: UnlistenFn | null = null;
  private _initialized = false;
  private _initGeneration = 0;
  /**
   * Per-session promise chains serializing envelope processing.
   * `_handleSnapshotEnvelope` awaits the full-snapshot fetch for delta-base
   * misses; without serialization, two envelopes for the same session can
   * interleave and apply out of order (older snapshot remembered after a
   * newer one).
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

  constructor(private readonly _fetchFullSnapshot: FullSnapshotFetcher) {}

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
      await this._fetchFullSnapshot(sessionId);
      this._schedulePendingFlush(sessionId, null);
      return;
    }

    this.rememberSnapshot(sessionId, snapshotPayload);
    this._schedulePendingFlush(sessionId, null);
  }

  rememberSnapshot(sessionId: string, snapshot: Snapshot): Snapshot {
    const pending = this._pendingFlushes.get(sessionId);
    if (pending?.delta) {
      if (snapshot.version < pending.delta.version) {
        // Un-materialized deltas are already newer than this slow-resolving
        // full snapshot; surface them instead of clobbering the cache.
        return this.flushPendingSnapshot(sessionId) ?? snapshot;
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
        this.flushPendingSnapshot(sessionId);
      }),
    });
  }

  /**
   * Force-materialize and notify a session's pending state now. Returns the
   * notified snapshot, or null when nothing was pending or the session's
   * cache is gone (released / evicted before the flush).
   */
  flushPendingSnapshot(sessionId: string): Snapshot | null {
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
      this.flushPendingSnapshot(sessionId);
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
    const subscribedSet = listeners;
    return () => {
      subscribedSet.delete(listener);
      // Only drop the registry entry if it is still *our* Set. After
      // `evictSessionCache` (which deletes the entry) a later subscriber may
      // have installed a fresh Set for the same session; a stale disposer
      // must not unregister that live Set.
      const current = this._sessionListeners.get(sessionId);
      if (current === subscribedSet && current.size === 0) {
        this._sessionListeners.delete(sessionId);
      }
    };
  }

  /** Get the latest snapshot for a specific session (may be null). */
  getLatestSessionSnapshot(sessionId: string): Snapshot | null {
    // Synchronous readers must never observe the one-frame coalescing window.
    this.flushPendingSnapshot(sessionId);
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
    this.flushPendingSnapshot(sessionId);
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
    this.flushPendingSnapshot(sessionId);
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
    this.flushPendingSnapshot(sessionId);
    const cached = this._latestSnapshots.get(sessionId);
    if (cached && isSnapshotActivelyStreaming(cached)) return;
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
