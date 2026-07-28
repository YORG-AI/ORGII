/**
 * Core Event Store Atoms
 *
 * Snapshot-driven atoms fed from the Rust EventStore.
 *
 * The Rust backend holds the canonical event data. On every mutation
 * it pushes a DerivedSnapshot (or StreamingSnapshot) via the `es:changed`
 * Tauri event. The bridge hook (`useEventStoreBridge`) receives this and
 * writes to `derivedSnapshotAtom`, from which all consumer atoms derive.
 *
 * Performance: derived atoms depend ONLY on `derivedSnapshotAtom` (not
 * `eventStoreVersionAtom`). Since the bridge always writes a new snapshot
 * object, `derivedSnapshotAtom` already triggers recomputation. Adding
 * `eventStoreVersionAtom` would cause redundant dependency-graph traversals.
 * The version atom is kept as a public scalar for hooks that need a
 * lightweight re-fetch trigger (subagent polling, planning indicator).
 *
 * Reference stability: during streaming the bridge merges StreamingSnapshot
 * onto the last DerivedSnapshot, reusing the same `events` and
 * `sortedSimulatorEvents` array references. Derived atoms that read these
 * fields naturally return stable references, so downstream React components
 * skip re-renders even though `derivedSnapshotAtom` itself changed.
 *
 * Write paths: adapter code calls `eventStoreProxy.set/append/upsert/merge`
 * which invokes Tauri commands → Rust mutates → pushes snapshot → atoms update.
 */
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";

import {
  type DerivedSnapshot,
  type Snapshot,
  eventStoreProxy,
} from "../store/EventStoreProxy";
import type { SessionEvent } from "../types";

const log = createLogger("eventsAtom");

// ============================================
// Direct Streaming Text (bypass EventStore round-trip)
// ============================================

/**
 * Per-session live stream content.
 *
 * Provides a direct rendering path that bypasses the EventStore snapshot
 * pipeline (16ms TS throttle → IPC → 33ms Rust batch → serialization → IPC
 * back → React).
 *
 * Shape: Map<sessionId, { kind, content }> so message and thinking streams
 * cannot be confused while multiple sessions stream concurrently.
 *
 * Set by the `onStreamingDelta` callback in useSessionSync (keyed by
 * sessionId) through streamingDeltaBuffer.ts: chunks are buffered and land
 * here on a trailing ~50ms flush (≤20Hz), with immediate flushes on stream
 * start, kind change, and completion. Cleared per-session on
 * streaming_complete, session complete, and session switch — clear paths
 * must also discard the buffer (see streamingDeltaBuffer.ts).
 * Token-level live content must not be written to the durable EventStore.
 */
export type StreamingDeltaKind = "message" | "thinking";

export interface StreamingDeltaContent {
  kind: StreamingDeltaKind;
  content: string;
}

export const streamingDeltaContentAtom = atom<
  Map<string, StreamingDeltaContent>
>(new Map<string, StreamingDeltaContent>());
streamingDeltaContentAtom.debugLabel = "session/streamingDeltaContent";

// ============================================
// Edit Truncation Guard
// ============================================

/**
 * When set, the sync effects (OS Agent / SDE Agent / CLI Session)
 * must ignore any events whose createdAt >= this timestamp.
 * Set by handleEditUserMessage, cleared on session switch.
 */
export const editTruncationTimestampAtom = atom<string | null>(null);
editTruncationTimestampAtom.debugLabel = "session/editTruncationTimestamp";

// ============================================
// Snapshot Atom (set by useEventStoreBridge)
// ============================================

/**
 * Latest snapshot pushed by Rust. Updated by the bridge hook.
 * All derived atoms below read from this.
 */
export const derivedSnapshotAtom = atom<Snapshot | null>(null);
derivedSnapshotAtom.debugLabel = "session/derivedSnapshot";

// ============================================
// Core Event Store (bridged from Rust EventStore)
// ============================================

/**
 * Version counter — bumped when Rust pushes a new snapshot.
 *
 * NOT used as a dependency in derived atoms (they depend on
 * `derivedSnapshotAtom` directly). Kept as a lightweight scalar
 * for hooks that need a cheap re-trigger signal:
 * - `useSubagentSessions` — refetch child sessions on every mutation
 * - `usePlanningIndicator` — idle detection timing
 * - `useEventStoreSelector` — memo invalidation key
 */
export const eventStoreVersionAtom = atom(0);
eventStoreVersionAtom.debugLabel = "session/eventStoreVersion";

/**
 * All events for the current session.
 *
 * Reads from the Rust-pushed snapshot. During streaming, the Rust side sends
 * a StreamingSnapshot that has no `events` field (only `chatEvents` and
 * `sortedSimulatorEvents`). In that case we return the last known events array
 * so downstream consumers (messagesEventsAtom, eventIndexAtom, …) that fall
 * back to `eventsAtom` do not silently empty out.
 *
 * Writes delegate to the Rust EventStore via eventStoreProxy.
 * The Rust store mutates and pushes a new snapshot which updates this atom.
 */

/**
 * Session-keyed single-slot cache for the last full events array.
 *
 * Keyed by sessionId (derived from the snapshot's own events) so a
 * StreamingSnapshot from session B can never serve session A's cached events
 * (cross-session bleed). When the streaming snapshot's session doesn't match
 * the cached one, we return an empty array instead of stale foreign events.
 */
let _lastKnownEventsCache: {
  sessionId: string | null;
  events: SessionEvent[];
} = { sessionId: null, events: [] };

/** Best-effort sessionId extraction from a snapshot's own event payloads. */
function snapshotSessionId(snap: Snapshot): string | null {
  if ("events" in snap) {
    const derived = snap as DerivedSnapshot;
    return derived.lastEvent?.sessionId ?? derived.events[0]?.sessionId ?? null;
  }
  return snap.lastEvent?.sessionId ?? snap.chatEvents?.[0]?.sessionId ?? null;
}

export const eventsAtom = atom(
  (get) => {
    const snap = get(derivedSnapshotAtom);
    if (!snap) {
      // Session cleared (loadSessionAtom sets derivedSnapshotAtom to null on
      // session switch). Reset the cache so the new session starts fresh.
      _lastKnownEventsCache = { sessionId: null, events: [] };
      return [] as SessionEvent[];
    }
    if ("events" in snap) {
      _lastKnownEventsCache = {
        sessionId: snapshotSessionId(snap),
        events: snap.events,
      };
      return snap.events;
    }
    // StreamingSnapshot: no `events` field. Return the last DerivedSnapshot's
    // events so fallback consumers (messagesEventsAtom, eventIndexAtom, …)
    // don't see an empty array mid-stream — but only when the cached events
    // belong to the same session as this streaming snapshot.
    const streamingSessionId = snapshotSessionId(snap);
    if (
      streamingSessionId !== null &&
      _lastKnownEventsCache.sessionId !== null &&
      streamingSessionId !== _lastKnownEventsCache.sessionId
    ) {
      return [] as SessionEvent[];
    }
    return _lastKnownEventsCache.events;
  },
  (
    _get,
    _set,
    update: SessionEvent[] | ((prev: SessionEvent[]) => SessionEvent[])
  ) => {
    if (typeof update === "function") {
      eventStoreProxy
        .getEvents()
        .then((current) => {
          const next = update(current);
          return eventStoreProxy.set(next);
        })
        .catch((err) => {
          log.warn("[eventsAtom] Failed to sync to Rust EventStore:", err);
        });
    } else {
      eventStoreProxy.set(update).catch((err) => {
        log.warn("[eventsAtom] Failed to sync to Rust EventStore:", err);
      });
    }
  }
);
eventsAtom.debugLabel = "session/events";

/**
 * O(1) event lookup index.
 * Reads from the Rust-computed event_index in the snapshot.
 * Falls back to building a Map from events for backward compat.
 *
 * Reference-stable: returns the cached Map when the `events` array
 * reference hasn't changed (common during streaming merges).
 */
class EventLookupMap extends Map<string, SessionEvent> {
  constructor(
    private readonly events: SessionEvent[],
    private readonly eventIndex: Record<string, number>
  ) {
    super();
  }

  get size(): number {
    return this.events.length;
  }

  get(key: string): SessionEvent | undefined {
    const index = this.eventIndex[key];
    return index === undefined ? undefined : this.events[index];
  }

  has(key: string): boolean {
    return this.eventIndex[key] !== undefined;
  }

  *keys(): IterableIterator<string> {
    for (const event of this.events) {
      yield event.id;
    }
  }

  *values(): IterableIterator<SessionEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  *entries(): IterableIterator<[string, SessionEvent]> {
    for (const event of this.events) {
      yield [event.id, event];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, SessionEvent]> {
    return this.entries();
  }

  forEach(
    callbackfn: (
      value: SessionEvent,
      key: string,
      map: Map<string, SessionEvent>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const event of this.events) {
      callbackfn.call(thisArg, event, event.id, this);
    }
  }
}

function buildEventIndex(events: SessionEvent[]): Record<string, number> {
  const eventIndex: Record<string, number> = {};
  for (let index = 0; index < events.length; index++) {
    eventIndex[events[index].id] = index;
  }
  return eventIndex;
}

interface EventSecondaryLookup {
  chunkIdToEventId: Map<string, string>;
  callIdToEventId: Map<string, string>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resultCallId(event: SessionEvent): string | null {
  return (
    stringValue(event.result?.call_id) ?? stringValue(event.result?.callId)
  );
}

let _prevEventsForIndex: SessionEvent[] = [];
let _prevEventIndexRecord: Record<string, number> | null = null;
let _prevEventIndexMap: Map<string, SessionEvent> = new EventLookupMap([], {});

export const eventIndexAtom = atom((get) => {
  const snap = get(derivedSnapshotAtom);

  if (snap && "eventIndex" in snap) {
    const events = (snap as DerivedSnapshot).events;
    const indexMap = (snap as DerivedSnapshot).eventIndex;
    if (events === _prevEventsForIndex && indexMap === _prevEventIndexRecord) {
      return _prevEventIndexMap;
    }

    _prevEventsForIndex = events;
    _prevEventIndexRecord = indexMap;
    _prevEventIndexMap = new EventLookupMap(events, indexMap);
    return _prevEventIndexMap;
  }

  const events = get(eventsAtom);
  if (events === _prevEventsForIndex) return _prevEventIndexMap;
  _prevEventsForIndex = events;
  _prevEventIndexRecord = null;
  _prevEventIndexMap = new EventLookupMap(events, buildEventIndex(events));
  return _prevEventIndexMap;
});
eventIndexAtom.debugLabel = "session/eventIndex";

let _prevEventsForSecondaryLookup: SessionEvent[] = [];
let _prevEventSecondaryLookup: EventSecondaryLookup = {
  chunkIdToEventId: new Map<string, string>(),
  callIdToEventId: new Map<string, string>(),
};

export const eventSecondaryLookupAtom = atom((get) => {
  const events = get(eventsAtom);
  if (events === _prevEventsForSecondaryLookup) {
    return _prevEventSecondaryLookup;
  }

  const chunkIdToEventId = new Map<string, string>();
  const callIdToEventId = new Map<string, string>();
  for (const event of events) {
    const chunkId = stringValue(event.chunk_id);
    if (chunkId) {
      chunkIdToEventId.set(chunkId, event.id);
    }

    const callId = stringValue(event.callId) ?? resultCallId(event);
    if (callId) {
      callIdToEventId.set(callId, event.id);
    }
  }

  _prevEventsForSecondaryLookup = events;
  _prevEventSecondaryLookup = { chunkIdToEventId, callIdToEventId };
  return _prevEventSecondaryLookup;
});
eventSecondaryLookupAtom.debugLabel = "session/eventSecondaryLookup";

/**
 * Sorted events by creation time.
 * For DerivedSnapshot: reads from sortedSimulatorEvents (pre-sorted in Rust).
 * For streaming: falls back to eventsAtom (unsorted is acceptable during streaming).
 *
 * The Rust snapshot no longer sends a separate `sortedEvents` field —
 * `sortedSimulatorEvents` serves both roles, saving one full-array
 * clone + serialization per snapshot push.
 */
export const sortedEventsAtom = atom((get) => {
  const snap = get(derivedSnapshotAtom);

  if (snap && "sortedSimulatorEvents" in snap) {
    return (snap as DerivedSnapshot).sortedSimulatorEvents;
  }

  return get(eventsAtom);
});
sortedEventsAtom.debugLabel = "session/sortedEvents";

/**
 * O(1) index lookup within sortedEventsAtom.
 * Maps event ID → index in the sorted array.
 */
let _prevSortedForIndex: ReadonlyArray<SessionEvent> = [];
let _prevSortedIndexMap = new Map<string, number>();

export const sortedEventIndexMapAtom = atom((get) => {
  const sorted = get(sortedEventsAtom);
  if (sorted === _prevSortedForIndex) return _prevSortedIndexMap;
  _prevSortedForIndex = sorted;
  const map = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    map.set(sorted[i].id, i);
  }
  _prevSortedIndexMap = map;
  return map;
});
sortedEventIndexMapAtom.debugLabel = "session/sortedEventIndexMap";

// ============================================
// Last Event (reference-stable)
// ============================================

let _prevLastEvent: SessionEvent | null = null;

/**
 * Drop module-level memo state when the active session departs.
 *
 * These caches intentionally outlive individual atom evaluations so their
 * references stay stable while a session is active. That also means Jotai
 * cannot collect the previous transcript when the UI navigates to a surface
 * that no longer reads these atoms (for example, Launchpad): the cached
 * arrays and lookup maps would continue to root every event until another
 * session happened to recompute each selector.
 *
 * Session lifecycle actions call this eagerly before clearing or replacing
 * the active snapshot. The next atom read rebuilds the small indexes from the
 * current snapshot, preserving the hot-path behavior without retaining an
 * inactive transcript.
 */
export function resetEventAtomMemoCaches(): void {
  _lastKnownEventsCache = { sessionId: null, events: [] };
  _prevEventsForIndex = [];
  _prevEventIndexRecord = null;
  _prevEventIndexMap = new EventLookupMap([], {});
  _prevEventsForSecondaryLookup = [];
  _prevEventSecondaryLookup = {
    chunkIdToEventId: new Map<string, string>(),
    callIdToEventId: new Map<string, string>(),
  };
  _prevSortedForIndex = [];
  _prevSortedIndexMap = new Map<string, number>();
  _prevLastEvent = null;
}

export const lastEventAtom = atom<SessionEvent | null>((get) => {
  const snap = get(derivedSnapshotAtom);

  if (snap) {
    const last = snap.lastEvent ?? null;
    if (last === _prevLastEvent) return _prevLastEvent;
    if (
      last &&
      _prevLastEvent &&
      last.id === _prevLastEvent.id &&
      last.displayStatus === _prevLastEvent.displayStatus
    ) {
      return _prevLastEvent;
    }
    _prevLastEvent = last;
    return last;
  }
  return null;
});
lastEventAtom.debugLabel = "session/lastEvent";

// ============================================
// Event Count (present in both snapshot types)
// ============================================

/**
 * Total event count in the Rust EventStore for the current session.
 *
 * Unlike `eventsAtom.length`, this reads the scalar `eventCount` field
 * that Rust includes in **both** `DerivedSnapshot` and `StreamingSnapshot`.
 * During live streaming, `sortedSimulatorEvents` is omitted from snapshots
 * for performance (only raw `chatEvents` are sent), so `events.length`
 * stays at 0. Using `eventCount` instead ensures the count rises monotonically
 * as the agent writes events, which is what `useSubagentSessions` needs as a
 * re-fetch trigger to detect newly spawned child sessions.
 */
export const eventCountAtom = atom<number>((get) => {
  const snap = get(derivedSnapshotAtom);
  return snap?.eventCount ?? 0;
});
eventCountAtom.debugLabel = "session/eventCount";

/**
 * Boolean "is there anything to replay?" flag.
 *
 * Derived from `sortedEventsAtom` (NOT `eventCountAtom`) so it exactly matches
 * the legacy `sortedEvents.length > 0` semantics used for `canReplay`. The two
 * diverge during live streaming: `eventCount` rises monotonically while
 * `sortedSimulatorEvents` is omitted from streaming snapshots (so
 * `sortedEventsAtom` is empty mid-stream). Using `sortedEventsAtom` keeps
 * replay availability correct.
 *
 * Although this recomputes on every append, the boolean output only flips once
 * (empty → non-empty), so jotai's value-equality bail-out means subscribers
 * (e.g. every chat block via `useChatEventReplay`) do NOT re-render per event.
 */
export const hasReplayableEventsAtom = atom<boolean>(
  (get) => get(sortedEventsAtom).length > 0
);
hasReplayableEventsAtom.debugLabel = "session/hasReplayableEvents";
