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
  SnapshotEventMembership,
  SnapshotPayload,
  StreamingSnapshot,
} from "./EventStoreProxyTypes";

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

function sameIdList(previous: string[], next: string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

const ORDER_MEMBER_CHAT = 1;
const ORDER_MEMBER_MESSAGES = 2;
const ORDER_MEMBER_SIMULATOR = 4;

function buildOrderMembership(
  chatEventIds: string[],
  messagesEventIds: string[],
  simulatorEventIds: string[]
): Map<string, number> {
  const result = new Map<string, number>();
  const add = (ids: string[], flag: number) => {
    for (const id of ids) result.set(id, (result.get(id) ?? 0) | flag);
  };
  add(chatEventIds, ORDER_MEMBER_CHAT);
  add(messagesEventIds, ORDER_MEMBER_MESSAGES);
  add(simulatorEventIds, ORDER_MEMBER_SIMULATOR);
  return result;
}

function membershipBits(membership: SnapshotEventMembership): number {
  return (
    (membership.chat ? ORDER_MEMBER_CHAT : 0) |
    (membership.messages ? ORDER_MEMBER_MESSAGES : 0) |
    (membership.simulator ? ORDER_MEMBER_SIMULATOR : 0)
  );
}

function removeId(ids: string[], id: string): number {
  const index = ids.indexOf(id);
  if (index >= 0) ids.splice(index, 1);
  return index;
}

function placeIdAtIndex(
  ids: string[],
  id: string,
  targetIndex: number
): boolean {
  if (ids[targetIndex] === id) return false;
  const previousIndex = removeId(ids, id);
  const nextIndex = Math.max(0, Math.min(targetIndex, ids.length));
  ids.splice(nextIndex, 0, id);
  return previousIndex !== nextIndex;
}

function chatSortRank(event: SessionEvent): number {
  return event.displayVariant === "summary" ||
    event.functionName === "turn_summary" ||
    event.uiCanonical === "turn_summary"
    ? 1
    : 0;
}

function compareChatEvents(left: SessionEvent, right: SessionEvent): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    chatSortRank(left) - chatSortRank(right) ||
    left.id.localeCompare(right.id)
  );
}

function compareSimulatorEvents(
  left: SessionEvent,
  right: SessionEvent
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function placeSortedId(
  ids: string[],
  id: string,
  visible: boolean,
  eventsById: Map<string, SessionEvent>,
  compare: (left: SessionEvent, right: SessionEvent) => number
): boolean {
  const previousIndex = removeId(ids, id);
  if (!visible) return previousIndex >= 0;
  const event = eventsById.get(id);
  if (!event) return previousIndex >= 0;
  const nextIndex = ids.findIndex((otherId) => {
    const other = eventsById.get(otherId);
    return other ? compare(event, other) < 0 : false;
  });
  const insertionIndex = nextIndex < 0 ? ids.length : nextIndex;
  ids.splice(insertionIndex, 0, id);
  return previousIndex !== insertionIndex;
}

function placeMessageId(
  cache: NormalizedSnapshotCache,
  id: string,
  visible: boolean,
  eventIndex: number
): boolean {
  const previousIndex = removeId(cache.messagesEventIds, id);
  if (!visible) return previousIndex >= 0;
  const eventPositionById = new Map(
    cache.eventIds.map((eventId, index) => [eventId, index])
  );
  const nextIndex = cache.messagesEventIds.findIndex((otherId) => {
    const otherIndex = eventPositionById.get(otherId);
    return otherIndex !== undefined && otherIndex > eventIndex;
  });
  const insertionIndex =
    nextIndex < 0 ? cache.messagesEventIds.length : nextIndex;
  cache.messagesEventIds.splice(insertionIndex, 0, id);
  return previousIndex !== insertionIndex;
}

function isCanvasEvent(event: SessionEvent | undefined): boolean {
  return Boolean(
    event &&
    (event.uiCanonical === "canvas_inline" ||
      event.functionName === "render_inline_canvas")
  );
}

function canvasPreviewForEvent(
  event: SessionEvent | undefined
): LatestCanvasPreview | undefined {
  if (!event || !isCanvasEvent(event)) return undefined;
  const args = event.args as Record<string, unknown>;
  return {
    eventId: event.id,
    mode: typeof args.mode === "string" ? args.mode : "html",
    url: typeof args.url === "string" ? args.url : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    streaming: typeof args.streaming === "boolean" ? args.streaming : undefined,
  } as LatestCanvasPreview;
}

function recomputeLatestCanvasPreview(cache: NormalizedSnapshotCache): void {
  cache.latestCanvasPreview = undefined;
  for (let index = cache.eventIds.length - 1; index >= 0; index--) {
    const preview = canvasPreviewForEvent(
      cache.eventsById.get(cache.eventIds[index])
    );
    if (preview) {
      cache.latestCanvasPreview = preview;
      return;
    }
  }
}

function applyIncrementalOrders(
  delta: SnapshotDelta,
  cache: NormalizedSnapshotCache,
  sortKeyChangedIds: Set<string>
): {
  eventOrderChanged: boolean;
  chatOrderChanged: boolean;
  messagesOrderChanged: boolean;
  simulatorOrderChanged: boolean;
} {
  let eventOrderChanged = false;
  let chatOrderChanged = false;
  let messagesOrderChanged = false;
  let simulatorOrderChanged = false;

  for (const id of delta.removedIds) {
    const currentMembership = cache.orderMembershipById.get(id) ?? 0;
    eventOrderChanged = removeId(cache.eventIds, id) >= 0 || eventOrderChanged;
    if (currentMembership & ORDER_MEMBER_CHAT) {
      chatOrderChanged =
        removeId(cache.chatEventIds, id) >= 0 || chatOrderChanged;
    }
    if (currentMembership & ORDER_MEMBER_MESSAGES) {
      messagesOrderChanged =
        removeId(cache.messagesEventIds, id) >= 0 || messagesOrderChanged;
    }
    if (currentMembership & ORDER_MEMBER_SIMULATOR) {
      simulatorOrderChanged =
        removeId(cache.sortedSimulatorEventIds, id) >= 0 ||
        simulatorOrderChanged;
    }
    cache.orderMembershipById.delete(id);
  }

  for (const membership of delta.memberships ?? []) {
    const previousMembership =
      cache.orderMembershipById.get(membership.id) ?? 0;
    const nextMembership = membershipBits(membership);
    const sortKeyChanged = sortKeyChangedIds.has(membership.id);
    eventOrderChanged =
      placeIdAtIndex(cache.eventIds, membership.id, membership.eventIndex) ||
      eventOrderChanged;
    if (
      Boolean(previousMembership & ORDER_MEMBER_CHAT) !== membership.chat ||
      (membership.chat && sortKeyChanged)
    ) {
      chatOrderChanged =
        placeSortedId(
          cache.chatEventIds,
          membership.id,
          membership.chat,
          cache.eventsById,
          compareChatEvents
        ) || chatOrderChanged;
    }
    if (
      Boolean(previousMembership & ORDER_MEMBER_SIMULATOR) !==
        membership.simulator ||
      (membership.simulator && sortKeyChanged)
    ) {
      simulatorOrderChanged =
        placeSortedId(
          cache.sortedSimulatorEventIds,
          membership.id,
          membership.simulator,
          cache.eventsById,
          compareSimulatorEvents
        ) || simulatorOrderChanged;
    }
    if (
      Boolean(previousMembership & ORDER_MEMBER_MESSAGES) !==
      membership.messages
    ) {
      messagesOrderChanged =
        placeMessageId(
          cache,
          membership.id,
          membership.messages,
          membership.eventIndex
        ) || messagesOrderChanged;
    }
    if (nextMembership === 0) {
      cache.orderMembershipById.delete(membership.id);
    } else {
      cache.orderMembershipById.set(membership.id, nextMembership);
    }
  }

  return {
    eventOrderChanged,
    chatOrderChanged,
    messagesOrderChanged,
    simulatorOrderChanged,
  };
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
