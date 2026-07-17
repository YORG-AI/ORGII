import type {
  SessionEvent,
  SimulatorEventFilterValue,
  SimulatorEventPreview,
} from "../types";
import type {
  DerivedSnapshot,
  LatestCanvasPreview,
  NormalizedSnapshotCache,
  Snapshot,
  SnapshotDelta,
  SnapshotPayload,
  StreamingSnapshot,
} from "./EventStoreProxyTypes";

export function isStreamingSnapshot(
  snapshot: Snapshot
): snapshot is StreamingSnapshot {
  return "streaming" in snapshot && snapshot.streaming === true;
}

export function isSnapshotDelta(
  payload: SnapshotPayload
): payload is SnapshotDelta {
  return "snapshotDelta" in payload && payload.snapshotDelta === true;
}

function getFallbackFilterCategory(
  event: SessionEvent
): SimulatorEventFilterValue {
  if (event.source === "user") return "key_interactions";
  if (
    event.uiCanonical === "edit_file" ||
    event.uiCanonical === "delete_file"
  ) {
    return "file_changes";
  }
  if (event.command || event.uiCanonical === "run_shell") {
    return "terminal_events";
  }
  if (
    event.uiCanonical === "read_file" ||
    event.uiCanonical === "list_dir" ||
    event.uiCanonical === "code_search" ||
    event.uiCanonical === "glob" ||
    event.uiCanonical === "find_files" ||
    event.uiCanonical === "search"
  ) {
    return "explore";
  }
  if (event.filePath) return "file_changes";
  return "other";
}

function buildSimulatorEventPreview(
  event: SessionEvent
): SimulatorEventPreview {
  return {
    id: event.id,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    functionName: event.functionName,
    uiCanonical: event.uiCanonical,
    actionType: event.actionType,
    source: event.source,
    displayText: event.displayText,
    displayStatus: event.displayStatus,
    displayVariant: event.displayVariant,
    activityStatus: event.activityStatus,
    filterCategory: getFallbackFilterCategory(event),
    threadId: event.threadId,
    processId: event.processId,
    callId: event.callId,
    filePath: event.filePath,
    command: event.command,
    isDelta: event.isDelta,
    repoId: event.repoId,
    repoPath: event.repoPath,
  };
}

/**
 * Preview objects are pure projections of their event, so they are cached by
 * event object identity: events untouched by a delta keep the same object in
 * `eventsById` and therefore reuse their preview across materializations.
 */
const simulatorPreviewCache = new WeakMap<
  SessionEvent,
  SimulatorEventPreview
>();

function previewForEvent(event: SessionEvent): SimulatorEventPreview {
  const cached = simulatorPreviewCache.get(event);
  if (cached) return cached;
  const preview = buildSimulatorEventPreview(event);
  simulatorPreviewCache.set(event, preview);
  return preview;
}

function rebuildSimulatorPreviewIndexes(
  cache: NormalizedSnapshotCache,
  simulatorEvents: SessionEvent[]
): void {
  const eventPreviewById: Record<string, SimulatorEventPreview> = {};
  const createdAtById: Record<string, string> = {};
  const threadIdById: Record<string, string> = {};
  const functionNameById: Record<string, string> = {};
  const displayStatusById: Record<string, string> = {};
  const displayVariantById: Record<string, string> = {};

  for (const event of simulatorEvents) {
    eventPreviewById[event.id] = previewForEvent(event);
    createdAtById[event.id] = event.createdAt;
    if (event.threadId) threadIdById[event.id] = event.threadId;
    functionNameById[event.id] = event.functionName;
    displayStatusById[event.id] = event.displayStatus;
    displayVariantById[event.id] = event.displayVariant;
  }

  cache.eventPreviewById = eventPreviewById;
  cache.createdAtById = createdAtById;
  cache.threadIdById = threadIdById;
  cache.functionNameById = functionNameById;
  cache.displayStatusById = displayStatusById;
  cache.displayVariantById = displayVariantById;
}

/**
 * Copy-on-write patch of the preview index Records for changed simulator
 * events: a Record whose entries are all value-identical keeps its object
 * identity (pure-render consumers bail out); a touched Record is shallow-
 * cloned exactly once. Only valid while the simulator id ordering is
 * unchanged — membership changes must go through
 * `rebuildSimulatorPreviewIndexes`.
 */
function patchSimulatorPreviewIndexes(
  cache: NormalizedSnapshotCache,
  simulatorEvents: SessionEvent[],
  changedIds: ReadonlySet<string>
): void {
  let eventPreviewById: Record<string, SimulatorEventPreview> | null = null;
  let createdAtById: Record<string, string> | null = null;
  let threadIdById: Record<string, string> | null = null;
  let functionNameById: Record<string, string> | null = null;
  let displayStatusById: Record<string, string> | null = null;
  let displayVariantById: Record<string, string> | null = null;

  for (const event of simulatorEvents) {
    if (!changedIds.has(event.id)) continue;
    const preview = previewForEvent(event);
    if (cache.eventPreviewById[event.id] !== preview) {
      eventPreviewById ??= { ...cache.eventPreviewById };
      eventPreviewById[event.id] = preview;
    }
    if (cache.createdAtById[event.id] !== event.createdAt) {
      createdAtById ??= { ...cache.createdAtById };
      createdAtById[event.id] = event.createdAt;
    }
    if (event.threadId) {
      if (cache.threadIdById[event.id] !== event.threadId) {
        threadIdById ??= { ...cache.threadIdById };
        threadIdById[event.id] = event.threadId;
      }
    } else if (event.id in cache.threadIdById) {
      threadIdById ??= { ...cache.threadIdById };
      delete threadIdById[event.id];
    }
    if (cache.functionNameById[event.id] !== event.functionName) {
      functionNameById ??= { ...cache.functionNameById };
      functionNameById[event.id] = event.functionName;
    }
    if (cache.displayStatusById[event.id] !== event.displayStatus) {
      displayStatusById ??= { ...cache.displayStatusById };
      displayStatusById[event.id] = event.displayStatus;
    }
    if (cache.displayVariantById[event.id] !== event.displayVariant) {
      displayVariantById ??= { ...cache.displayVariantById };
      displayVariantById[event.id] = event.displayVariant;
    }
  }

  if (eventPreviewById) cache.eventPreviewById = eventPreviewById;
  if (createdAtById) cache.createdAtById = createdAtById;
  if (threadIdById) cache.threadIdById = threadIdById;
  if (functionNameById) cache.functionNameById = functionNameById;
  if (displayStatusById) cache.displayStatusById = displayStatusById;
  if (displayVariantById) cache.displayVariantById = displayVariantById;
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
  lastEventId: string | null;
  /** Ids whose event object identity changed (upserted) since last flush. */
  changedEventIds: Set<string>;
  eventOrderChanged: boolean;
  chatOrderChanged: boolean;
  messagesOrderChanged: boolean;
  simulatorOrderChanged: boolean;
}

function sameIdList(previous: string[], next: string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
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
    lastEventId: delta.lastEventId,
    changedEventIds: new Set<string>(),
    eventOrderChanged: false,
    chatOrderChanged: false,
    messagesOrderChanged: false,
    simulatorOrderChanged: false,
  };

  state.eventOrderChanged =
    state.eventOrderChanged || !sameIdList(cache.eventIds, delta.eventIds);
  state.chatOrderChanged =
    state.chatOrderChanged ||
    !sameIdList(cache.chatEventIds, delta.chatEventIds);
  state.messagesOrderChanged =
    state.messagesOrderChanged ||
    !sameIdList(cache.messagesEventIds, delta.messagesEventIds);
  state.simulatorOrderChanged =
    state.simulatorOrderChanged ||
    !sameIdList(cache.sortedSimulatorEventIds, delta.sortedSimulatorEventIds);

  for (const removedId of delta.removedIds) {
    cache.eventsById.delete(removedId);
    state.changedEventIds.delete(removedId);
  }
  for (const event of delta.upserts) {
    if (!isSessionEvent(event)) continue;
    if (cache.eventsById.get(event.id) !== event) {
      state.changedEventIds.add(event.id);
    }
    cache.eventsById.set(event.id, event);
  }

  cache.eventIds = delta.eventIds;
  cache.chatEventIds = delta.chatEventIds;
  cache.messagesEventIds = delta.messagesEventIds;
  cache.sortedSimulatorEventIds = delta.sortedSimulatorEventIds;

  state.version = delta.version;
  state.eventCount = delta.eventCount;
  state.chatEventCount = delta.chatEventCount;
  state.hasRunningEvent = delta.hasRunningEvent;
  state.latestCanvasPreview = delta.latestCanvasPreview;
  state.lastEventId = delta.lastEventId;
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
