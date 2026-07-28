import type { SessionEvent } from "../types";
import type {
  DerivedSnapshot,
  LatestCanvasPreview,
  NormalizedSnapshotCache,
  Snapshot,
  SnapshotDelta,
  SnapshotPayload,
  StreamingSnapshot,
} from "./EventStoreProxyTypes";
import {
  isCanvasEvent,
  recomputeLatestCanvasPreview,
} from "./snapshotMaterialization.canvasPreview";
import { applyIncrementalOrders } from "./snapshotMaterialization.deltaOrders";
import {
  buildOrderMembership,
  chatSortRank,
  sameIdList,
} from "./snapshotMaterialization.orderMembership";
import {
  patchSimulatorPreviewIndexes,
  rebuildSimulatorPreviewIndexes,
} from "./snapshotMaterialization.simulatorPreview";

export function isStreamingSnapshot(
  snapshot: Snapshot
): snapshot is StreamingSnapshot {
  return (
    "streaming" in snapshot &&
    snapshot.streaming === true &&
    !("events" in snapshot)
  );
}

/** Active turn state, independent of the legacy StreamingSnapshot wire shape. */
export function isSnapshotActivelyStreaming(snapshot: Snapshot): boolean {
  return "streaming" in snapshot && snapshot.streaming === true;
}

export function isSnapshotDelta(
  payload: SnapshotPayload
): payload is SnapshotDelta {
  return "snapshotDelta" in payload && payload.snapshotDelta === true;
}

export function attachSimulatorPreviewFields<TSnapshot extends Snapshot>(
  snapshot: TSnapshot,
  cache: NormalizedSnapshotCache
): TSnapshot {
  return {
    ...snapshot,
    sortedSimulatorEventIds: cache.sortedSimulatorEventIds,
    eventPreviewById: cache.eventPreviewById,
    createdAtById: cache.createdAtById,
    threadIdById: cache.threadIdById,
    functionNameById: cache.functionNameById,
    displayStatusById: cache.displayStatusById,
    displayVariantById: cache.displayVariantById,
  };
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as SessionEvent).id === "string"
  );
}

export function buildNormalizedCache(
  snapshot: Snapshot
): NormalizedSnapshotCache | null {
  if (!("events" in snapshot)) return null;
  const events = snapshot.events.filter(isSessionEvent);
  const chatEvents = snapshot.chatEvents.filter(isSessionEvent);
  const messagesEvents = snapshot.messagesEvents.filter(isSessionEvent);
  const sortedSimulatorEvents =
    snapshot.sortedSimulatorEvents.filter(isSessionEvent);
  const eventsById = new Map<string, SessionEvent>();
  for (const event of events) {
    eventsById.set(event.id, event);
  }
  const orderMembershipById = buildOrderMembership(
    chatEvents.map((event) => event.id),
    messagesEvents.map((event) => event.id),
    sortedSimulatorEvents.map((event) => event.id)
  );
  const cache: NormalizedSnapshotCache = {
    eventsById,
    eventIds: events.map((event) => event.id),
    chatEventIds: chatEvents.map((event) => event.id),
    messagesEventIds: messagesEvents.map((event) => event.id),
    sortedSimulatorEventIds: sortedSimulatorEvents.map((event) => event.id),
    eventPreviewById: {},
    createdAtById: {},
    threadIdById: {},
    functionNameById: {},
    displayStatusById: {},
    displayVariantById: {},
    orderMembershipById,
    runningEventIds: new Set(
      events
        .filter((event) => event.displayStatus === "running")
        .map((event) => event.id)
    ),
    latestCanvasPreview: snapshot.latestCanvasPreview,
  };
  rebuildSimulatorPreviewIndexes(cache, sortedSimulatorEvents);
  return cache;
}

function eventsForIds(
  cache: NormalizedSnapshotCache,
  ids: string[]
): SessionEvent[] {
  return ids
    .map((id) => cache.eventsById.get(id))
    .filter((event): event is SessionEvent => Boolean(event));
}

function buildEventIndex(events: SessionEvent[]): Record<string, number> {
  const eventIndex: Record<string, number> = {};
  for (let index = 0; index < events.length; index++) {
    eventIndex[events[index].id] = index;
  }
  return eventIndex;
}

export function materializeFullSnapshot(
  snapshot: DerivedSnapshot,
  cache: NormalizedSnapshotCache
): DerivedSnapshot {
  const events = eventsForIds(cache, cache.eventIds);
  const sortedSimulatorEvents = eventsForIds(
    cache,
    cache.sortedSimulatorEventIds
  );
  rebuildSimulatorPreviewIndexes(cache, sortedSimulatorEvents);
  return attachSimulatorPreviewFields(
    {
      ...snapshot,
      events,
      chatEvents: eventsForIds(cache, cache.chatEventIds),
      messagesEvents: eventsForIds(cache, cache.messagesEventIds),
      sortedSimulatorEvents,
      lastEvent: snapshot.lastEvent?.id
        ? (cache.eventsById.get(snapshot.lastEvent.id) ?? null)
        : null,
      eventIndex: buildEventIndex(events),
    },
    cache
  );
}

/**
 * Accumulated effect of delta envelopes applied to a session's normalized
 * cache since its last materialization. Scalars mirror the newest applied
 * delta; `changedEventIds` and the order-changed flags accumulate so a
 * single flush reconciles any number of envelopes without dropping one.
 */
export interface PendingDeltaState {
  version: number;
  eventCount: number;
  chatEventCount: number;
  hasRunningEvent: boolean;
  latestCanvasPreview?: LatestCanvasPreview;
  streaming: boolean;
  lastEventId: string | null;
  /** Ids whose event object identity changed (upserted) since last flush. */
  changedEventIds: Set<string>;
  eventOrderChanged: boolean;
  chatOrderChanged: boolean;
  messagesOrderChanged: boolean;
  simulatorOrderChanged: boolean;
}

/**
 * Apply one delta envelope to the cache. Must be called exactly once per
 * envelope, in arrival order — envelopes are never dropped; only their
 * materialization is coalesced (see EventStoreProxy).
 */
export function applyDeltaToCache(
  delta: SnapshotDelta,
  cache: NormalizedSnapshotCache,
  pending: PendingDeltaState | null
): PendingDeltaState {
  const state: PendingDeltaState = pending ?? {
    version: delta.version,
    eventCount: delta.eventCount,
    chatEventCount: delta.chatEventCount,
    hasRunningEvent: delta.hasRunningEvent,
    latestCanvasPreview: delta.latestCanvasPreview,
    streaming: delta.streaming === true,
    lastEventId: delta.lastEventId,
    changedEventIds: new Set<string>(),
    eventOrderChanged: false,
    chatOrderChanged: false,
    messagesOrderChanged: false,
    simulatorOrderChanged: false,
  };

  let canvasMayHaveChanged = delta.removedIds.some(
    (id) => id === cache.latestCanvasPreview?.eventId
  );
  const sortKeyChangedIds = new Set<string>();

  for (const removedId of delta.removedIds) {
    cache.eventsById.delete(removedId);
    cache.runningEventIds.delete(removedId);
    state.changedEventIds.delete(removedId);
  }
  for (const event of delta.upserts) {
    if (!isSessionEvent(event)) continue;
    const previousEvent = cache.eventsById.get(event.id);
    canvasMayHaveChanged ||=
      isCanvasEvent(previousEvent) || isCanvasEvent(event);
    if (previousEvent !== event) {
      state.changedEventIds.add(event.id);
    }
    if (
      !previousEvent ||
      previousEvent.createdAt !== event.createdAt ||
      chatSortRank(previousEvent) !== chatSortRank(event)
    ) {
      sortKeyChangedIds.add(event.id);
    }
    cache.eventsById.set(event.id, event);
    if (event.displayStatus === "running") {
      cache.runningEventIds.add(event.id);
    } else {
      cache.runningEventIds.delete(event.id);
    }
  }

  if (delta.incrementalOrders) {
    const changes = applyIncrementalOrders(delta, cache, sortKeyChangedIds);
    state.eventOrderChanged ||= changes.eventOrderChanged;
    state.chatOrderChanged ||= changes.chatOrderChanged;
    state.messagesOrderChanged ||= changes.messagesOrderChanged;
    state.simulatorOrderChanged ||= changes.simulatorOrderChanged;
    if (canvasMayHaveChanged) recomputeLatestCanvasPreview(cache);
  } else {
    state.eventOrderChanged ||= !sameIdList(cache.eventIds, delta.eventIds);
    state.chatOrderChanged ||= !sameIdList(
      cache.chatEventIds,
      delta.chatEventIds
    );
    state.messagesOrderChanged ||= !sameIdList(
      cache.messagesEventIds,
      delta.messagesEventIds
    );
    state.simulatorOrderChanged ||= !sameIdList(
      cache.sortedSimulatorEventIds,
      delta.sortedSimulatorEventIds
    );
    cache.eventIds = delta.eventIds;
    cache.chatEventIds = delta.chatEventIds;
    cache.messagesEventIds = delta.messagesEventIds;
    cache.sortedSimulatorEventIds = delta.sortedSimulatorEventIds;
    cache.orderMembershipById = buildOrderMembership(
      delta.chatEventIds,
      delta.messagesEventIds,
      delta.sortedSimulatorEventIds
    );
    cache.latestCanvasPreview = delta.latestCanvasPreview;
  }

  state.version = delta.version;
  state.eventCount = delta.eventCount;
  state.chatEventCount = delta.incrementalOrders
    ? cache.chatEventIds.length
    : delta.chatEventCount;
  state.hasRunningEvent = delta.incrementalOrders
    ? cache.runningEventIds.size > 0
    : delta.hasRunningEvent;
  state.latestCanvasPreview = cache.latestCanvasPreview;
  state.lastEventId = delta.lastEventId;
  state.streaming = delta.streaming === true;
  return state;
}

/**
 * Pointer-copy `previousEvents`, swapping only the slots whose event object
 * identity changed. Returns `previousEvents` untouched when no referenced
 * event changed — zero allocation on the no-op path, zero per-event object
 * construction on every path.
 */
function swapChangedEvents(
  previousEvents: SessionEvent[],
  cache: NormalizedSnapshotCache,
  changedIds: ReadonlySet<string>
): SessionEvent[] {
  if (changedIds.size === 0) return previousEvents;
  let next: SessionEvent[] | null = null;
  for (let index = 0; index < previousEvents.length; index++) {
    const current = previousEvents[index];
    if (!changedIds.has(current.id)) continue;
    const updated = cache.eventsById.get(current.id);
    if (!updated || updated === current) continue;
    next ??= previousEvents.slice();
    next[index] = updated;
  }
  return next ?? previousEvents;
}

/**
 * Materialize accumulated delta state into a DerivedSnapshot, reusing every
 * structure of `previous` whose inputs did not change: arrays are pointer-
 * copied with only changed slots swapped, `eventIndex` survives unchanged
 * orderings, and the preview Records are patched copy-on-write. Falls back
 * to a full rebuild from the cache when no reusable DerivedSnapshot exists
 * (e.g. the last remembered snapshot was a StreamingSnapshot).
 */
export function materializePendingDelta(
  pending: PendingDeltaState,
  cache: NormalizedSnapshotCache,
  previous: Snapshot | null | undefined
): DerivedSnapshot {
  const prev =
    previous && !isStreamingSnapshot(previous)
      ? (previous as DerivedSnapshot)
      : null;
  const changed = pending.changedEventIds;

  const events =
    prev && !pending.eventOrderChanged
      ? swapChangedEvents(prev.events, cache, changed)
      : eventsForIds(cache, cache.eventIds);
  const eventIndex =
    prev && !pending.eventOrderChanged
      ? prev.eventIndex
      : buildEventIndex(events);
  const chatEvents =
    prev && !pending.chatOrderChanged
      ? swapChangedEvents(prev.chatEvents, cache, changed)
      : eventsForIds(cache, cache.chatEventIds);
  const messagesEvents =
    prev && !pending.messagesOrderChanged
      ? swapChangedEvents(prev.messagesEvents, cache, changed)
      : eventsForIds(cache, cache.messagesEventIds);

  let sortedSimulatorEvents: SessionEvent[];
  if (prev && !pending.simulatorOrderChanged) {
    sortedSimulatorEvents = swapChangedEvents(
      prev.sortedSimulatorEvents,
      cache,
      changed
    );
    if (sortedSimulatorEvents !== prev.sortedSimulatorEvents) {
      patchSimulatorPreviewIndexes(cache, sortedSimulatorEvents, changed);
    }
  } else {
    sortedSimulatorEvents = eventsForIds(cache, cache.sortedSimulatorEventIds);
    rebuildSimulatorPreviewIndexes(cache, sortedSimulatorEvents);
  }

  return attachSimulatorPreviewFields(
    {
      version: pending.version,
      eventCount: pending.eventCount,
      events,
      chatEvents,
      messagesEvents,
      sortedSimulatorEvents,
      lastEvent: pending.lastEventId
        ? (cache.eventsById.get(pending.lastEventId) ?? null)
        : null,
      eventIndex,
      chatEventCount: pending.chatEventCount,
      hasRunningEvent: pending.hasRunningEvent,
      latestCanvasPreview: pending.latestCanvasPreview,
      streaming: pending.streaming,
    },
    cache
  );
}

export function materializeStreamingSnapshot(
  snapshot: StreamingSnapshot
): StreamingSnapshot {
  const chatEvents = snapshot.chatEvents.filter(isSessionEvent);
  const sortedSimulatorEvents =
    snapshot.sortedSimulatorEvents.filter(isSessionEvent);

  if (snapshot.sortedSimulatorEventIds && snapshot.eventPreviewById) {
    return {
      ...snapshot,
      chatEvents,
      sortedSimulatorEvents,
      sortedSimulatorEventIds: snapshot.sortedSimulatorEventIds,
      eventPreviewById: snapshot.eventPreviewById,
      createdAtById: snapshot.createdAtById ?? {},
      threadIdById: snapshot.threadIdById ?? {},
      functionNameById: snapshot.functionNameById ?? {},
      displayStatusById: snapshot.displayStatusById ?? {},
      displayVariantById: snapshot.displayVariantById ?? {},
    };
  }

  const cache: NormalizedSnapshotCache = {
    eventsById: new Map(),
    eventIds: [],
    chatEventIds: chatEvents.map((event) => event.id),
    messagesEventIds: [],
    sortedSimulatorEventIds: sortedSimulatorEvents.map((event) => event.id),
    eventPreviewById: {},
    createdAtById: {},
    threadIdById: {},
    functionNameById: {},
    displayStatusById: {},
    displayVariantById: {},
    orderMembershipById: buildOrderMembership(
      chatEvents.map((event) => event.id),
      [],
      sortedSimulatorEvents.map((event) => event.id)
    ),
    runningEventIds: new Set(
      [...chatEvents, ...sortedSimulatorEvents]
        .filter((event) => event.displayStatus === "running")
        .map((event) => event.id)
    ),
    latestCanvasPreview: snapshot.latestCanvasPreview,
  };
  rebuildSimulatorPreviewIndexes(cache, sortedSimulatorEvents);
  return attachSimulatorPreviewFields(
    {
      ...snapshot,
      chatEvents,
      sortedSimulatorEvents,
    },
    cache
  );
}
