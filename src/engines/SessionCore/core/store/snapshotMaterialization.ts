import type {
  SessionEvent,
  SimulatorEventFilterValue,
  SimulatorEventPreview,
} from "../types";
import type {
  DerivedSnapshot,
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
    eventPreviewById[event.id] = buildSimulatorEventPreview(event);
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

export function materializeSnapshot(
  delta: SnapshotDelta,
  cache: NormalizedSnapshotCache
): DerivedSnapshot {
  const events = eventsForIds(cache, delta.eventIds);
  const sortedSimulatorEvents = eventsForIds(
    cache,
    delta.sortedSimulatorEventIds
  );
  rebuildSimulatorPreviewIndexes(cache, sortedSimulatorEvents);
  return attachSimulatorPreviewFields(
    {
      version: delta.version,
      eventCount: delta.eventCount,
      events,
      chatEvents: eventsForIds(cache, delta.chatEventIds),
      messagesEvents: eventsForIds(cache, delta.messagesEventIds),
      sortedSimulatorEvents,
      lastEvent: delta.lastEventId
        ? (cache.eventsById.get(delta.lastEventId) ?? null)
        : null,
      eventIndex: buildEventIndex(events),
      chatEventCount: delta.chatEventCount,
      hasRunningEvent: delta.hasRunningEvent,
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
