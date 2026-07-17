/**
 * Session Action Atoms (Write-only)
 *
 * Compound actions for session state management.
 * Helpers are in actionsUtils.ts.
 */
import { atom } from "jotai";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import { clearLoadedPayloads } from "@src/engines/SessionCore/payloads";
import { clearLoadedTurnRegistry } from "@src/engines/SessionCore/turns/loadedTurnRegistry";
import { createLogger } from "@src/hooks/logger";
import { messageQueueAtom } from "@src/store/ui/messageQueueAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { isVisibleInChat } from "../../ingestion/visibilityFilters";
import {
  isBackendUserMessageEvent,
  isSyntheticUserInputEvent,
} from "../../sync/utils/activityIds";
import { isLiveRuntimeResourceEvent } from "../runningEventGate";
import { eventStoreProxy } from "../store/EventStoreProxy";
import type {
  SessionEvent,
  SessionSpec,
  SimulatorEventPreview,
} from "../types";
import {
  applyRunningArgs,
  extendRunningArgsCache,
  navigateToEventAndUpdateBar,
  resetRunningArgsCache,
  resetSessionUIState,
} from "./actionsUtils";
import {
  derivedSnapshotAtom,
  eventIndexAtom,
  eventsAtom,
  sortedEventsAtom,
} from "./events";
import {
  isFromCacheAtom,
  lastFetchedAtom,
  loadErrorAtom,
  loadStatusAtom,
  pendingSyntheticEventAtom,
  sessionIdAtom,
  specsAtom,
} from "./metadata";
import {
  currentEventIdAtom,
  currentEventIndexAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./replay";

const log = createLogger("loadSession");

function normalizeUserText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function getUserMessageContent(event: SessionEvent): string {
  return typeof event.result?.message === "object" &&
    event.result.message !== null &&
    "content" in event.result.message
    ? String(event.result.message.content ?? "")
    : event.displayText;
}

function getUserMessageImages(event: SessionEvent): string[] | undefined {
  const images = event.result?.images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images.filter((image): image is string => typeof image === "string");
}

function hasUserMessageImages(event: SessionEvent): boolean {
  return Boolean(getUserMessageImages(event)?.length);
}

function withUserMessageImages(
  event: SessionEvent,
  images: string[]
): SessionEvent {
  return {
    ...event,
    result: {
      ...(event.result ?? {}),
      images,
    },
  };
}

/**
 * Local approximation of the Rust simulator/messages visibility rule
 * (`is_visible_in_simulator_or_messages` in `derived.rs`).
 *
 * Used ONLY for synchronous optimistic paths: seeding the local snapshot
 * before the Rust `mergeEvents` push lands, and picking a follow/display
 * target from freshly appended events. The authoritative pre-filtered arrays
 * (`sortedSimulatorEvents` / `messagesEvents`) arrive with the next Rust
 * snapshot and overwrite anything computed here.
 */
function isSimulatorVisibleApprox(event: SessionEvent): boolean {
  if (event.isDelta) return false;
  if (event.actionType === "tool_result") return false;
  if (
    isLiveRuntimeResourceEvent(event) &&
    event.displayVariant !== "tool_call"
  ) {
    return false;
  }
  return (
    event.displayVariant === "tool_call" ||
    event.displayVariant === "thinking" ||
    event.displayVariant === "message"
  );
}

function getSimulatorFilterCategory(
  event: SessionEvent
): SimulatorEventPreview["filterCategory"] {
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

function buildSimulatorPreview(event: SessionEvent): SimulatorEventPreview {
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
    filterCategory: getSimulatorFilterCategory(event),
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

function buildSimulatorPreviewFields(events: SessionEvent[]): {
  sortedSimulatorEventIds: string[];
  eventPreviewById: Record<string, SimulatorEventPreview>;
  createdAtById: Record<string, string>;
  threadIdById: Record<string, string>;
  functionNameById: Record<string, string>;
  displayStatusById: Record<string, string>;
  displayVariantById: Record<string, string>;
} {
  const sortedSimulatorEventIds: string[] = [];
  const eventPreviewById: Record<string, SimulatorEventPreview> = {};
  const createdAtById: Record<string, string> = {};
  const threadIdById: Record<string, string> = {};
  const functionNameById: Record<string, string> = {};
  const displayStatusById: Record<string, string> = {};
  const displayVariantById: Record<string, string> = {};

  for (const event of events) {
    sortedSimulatorEventIds.push(event.id);
    eventPreviewById[event.id] = buildSimulatorPreview(event);
    createdAtById[event.id] = event.createdAt;
    if (event.threadId) threadIdById[event.id] = event.threadId;
    functionNameById[event.id] = event.functionName;
    displayStatusById[event.id] = event.displayStatus;
    displayVariantById[event.id] = event.displayVariant;
  }

  return {
    sortedSimulatorEventIds,
    eventPreviewById,
    createdAtById,
    threadIdById,
    functionNameById,
    displayStatusById,
    displayVariantById,
  };
}

function syntheticMatchesQueuedMessage(
  event: SessionEvent,
  queued: { sessionId: string; content: string; displayContent: string }
): boolean {
  if (event.sessionId !== queued.sessionId) return false;
  const eventText = normalizeUserText(event.displayText);
  const resultMessage = event.result?.message;
  const eventContent = normalizeUserText(
    typeof resultMessage === "object" &&
      resultMessage !== null &&
      "content" in resultMessage
      ? String(resultMessage.content ?? "")
      : event.displayText
  );
  const queuedDisplay = normalizeUserText(queued.displayContent);
  const queuedContent = normalizeUserText(queued.content);
  return (
    eventText === queuedDisplay ||
    eventText === queuedContent ||
    eventContent === queuedDisplay ||
    eventContent === queuedContent
  );
}

// ============================================
// Compound Actions (Write-only atoms)
// ============================================

export const failSessionLoadAtom = atom(null, (_get, set, message: string) => {
  set(loadErrorAtom, message);
  set(loadStatusAtom, "error");
});
failSessionLoadAtom.debugLabel = "session/failSessionLoad";

export const clearSessionLoadErrorAtom = atom(null, (_get, set) => {
  set(loadErrorAtom, null);
});
clearSessionLoadErrorAtom.debugLabel = "session/clearSessionLoadError";

/**
 * Clear all session state.
 * Use when switching sessions.
 */
export const clearSessionAtom = atom(null, (get, set) => {
  const currentSessionId = get(sessionIdAtom);
  resetRunningArgsCache();
  clearLoadedPayloads();
  if (currentSessionId) {
    clearLoadedTurnRegistry(currentSessionId);
    // Free the departing session's JS snapshot mirror (full event arrays,
    // inflated further by any replay-loaded turn bodies) after a grace
    // window, so rapid switch-backs stay warm. Skipped while it is still
    // streaming; Rust remains the source of truth either way.
    eventStoreProxy.scheduleSessionSnapshotRelease(currentSessionId);
  }
  // NOTE: Do NOT call set(eventsAtom, []) here. eventsAtom's write handler
  // fires eventStoreProxy.set([]) which is an async fire-and-forget IPC to
  // Rust. This races with the sync hook's doSwitch() which also writes to the
  // Rust EventStore via switchSession + set(events). If the clear arrives
  // after the load, it nukes the just-loaded events while loadStatus is
  // already "loaded", causing a permanently blank chat panel.
  // The Rust EventStore handles the session transition atomically inside
  // es_switch_session. Metadata atoms below are cleared synchronously.
  resetSessionUIState(set);
  set(pendingSyntheticEventAtom, null);
  set(currentEventIdAtom, null);
  set(replayBarValueAtom, REPLAY_CONFIG.MAX_VALUE);
  set(replayTimeRangeAtom, { start: "", end: "" });
  set(replayModeAtom, "replay");
  set(sessionIdAtom, null);
  set(loadStatusAtom, "idle");
  set(loadErrorAtom, null);
  set(isFromCacheAtom, false);
  set(lastFetchedAtom, null);
  set(specsAtom, []);

  // Null out the Rust-pushed snapshot so all derived event atoms return [].
  // This is safe: derivedSnapshotAtom is a plain atom (no IPC on write).
  // loadSessionAtom will replace it atomically when a real session loads.
  set(derivedSnapshotAtom, null);
});
clearSessionAtom.debugLabel = "session/clear";

/**
 * Load session with events.
 * Sets all relevant state at once.
 */
interface LoadSessionPayload {
  sessionId: string;
  events: SessionEvent[];
  specs?: SessionSpec[];
  isFromCache?: boolean;
}

export const loadSessionAtom = atom(
  null,
  (get, set, payload: LoadSessionPayload) => {
    const { sessionId, events, specs = [], isFromCache = false } = payload;

    // Preserve synthetic user events (injected by session launch) when the
    // sync hooks reload from SQLite/API before the backend has persisted the
    // user message. Without this, the first message disappears on navigation.
    //
    // Key distinction: synthetic events are frontend user_message rows with an
    // empty uiCanonical, while backend-echoed user turns normalize to
    // functionName/uiCanonical "user". IDs are not reliable because CLI backend
    // user events can also use the user-input-* prefix.
    const currentSessionId = get(sessionIdAtom);
    const existingSameSessionEvents =
      currentSessionId === sessionId ? get(eventsAtom) : [];
    const hasRealBackendUserMessages = events.some(isBackendUserMessageEvent);
    let syntheticUserEvents: SessionEvent[] = [];

    // Source 1: existing events in the store (same session, not yet cleared)
    if (existingSameSessionEvents.length > 0 && !hasRealBackendUserMessages) {
      syntheticUserEvents = existingSameSessionEvents.filter(
        isSyntheticUserInputEvent
      );
    }

    // Source 2: pendingSyntheticEventAtom — survives clearSessionAtom so the
    // user message is recovered even after a session-switch clear.
    if (syntheticUserEvents.length === 0 && !hasRealBackendUserMessages) {
      const pending = get(pendingSyntheticEventAtom);
      if (pending && pending.sessionId === sessionId) {
        syntheticUserEvents = [pending];
      }
    }

    // Only consume the pending event when the backend has echoed the real
    // user message. Until then, keep it around so subsequent loadSessionAtom
    // calls (from sync hooks) can recover it even if the async Rust store
    // write hasn't completed yet.
    if (hasRealBackendUserMessages) {
      set(pendingSyntheticEventAtom, null);
    }

    // Atomic swap: when switching sessions, reset stale state in the same
    // Jotai write batch so there is never a render with empty events.
    // Previously, clearSessionAtom wiped everything first (causing an empty
    // flash), then loadSessionAtom populated new data asynchronously.
    if (currentSessionId !== null && currentSessionId !== sessionId) {
      // Only clear the pending synthetic event if it belongs to the OLD
      // session (or is absent). If the caller set pendingSyntheticEventAtom
      // for the NEW session in the same Jotai batch (e.g. useSessionLaunch),
      // clearing it here would drop the user's first message.
      const pendingNow = get(pendingSyntheticEventAtom);
      if (!pendingNow || pendingNow.sessionId !== sessionId) {
        set(pendingSyntheticEventAtom, null);
      }
      resetSessionUIState(set, currentSessionId);
      // Direct A→B switches come through here without clearSessionAtom —
      // schedule the outgoing session's snapshot release here too.
      eventStoreProxy.scheduleSessionSnapshotRelease(currentSessionId);
    }

    set(sessionIdAtom, sessionId);
    // Belt-and-braces for load paths that skip switchSession(): the incoming
    // session is active again, so rescue it from any pending release.
    eventStoreProxy.cancelScheduledSnapshotRelease(sessionId);

    resetRunningArgsCache();

    const incomingById = new Map(events.map((event) => [event.id, event]));
    const existingIds = new Set(
      existingSameSessionEvents.map((event) => event.id)
    );
    const baseEvents =
      currentSessionId === sessionId && existingSameSessionEvents.length > 0
        ? existingSameSessionEvents
        : [];
    // Imported transcripts are append-only and their parsed events immutable,
    // so a refresh reload keeps the EXISTING object references for events the
    // store already holds — the memoized render pipeline (sameFlatItems &co)
    // then short-circuits on identity and only genuinely new rows render.
    // The final existing event is the exception: chunk aggregation can still
    // extend it while new lines append, so it takes the incoming version.
    // Live sessions keep replace semantics: streaming events evolve in place
    // under a stable id, and stale references would freeze their content.
    const reuseExistingReferences = isImportedHistorySession(sessionId);
    const eventsForLoad =
      baseEvents.length > 0
        ? [
            ...baseEvents.map((event, index) => {
              const incoming = incomingById.get(event.id);
              if (!incoming) return event;
              if (reuseExistingReferences && index < baseEvents.length - 1) {
                return event;
              }
              return incoming;
            }),
            ...events.filter((event) => !existingIds.has(event.id)),
          ]
        : events;
    const argsMap = extendRunningArgsCache(eventsForLoad);
    const enrichedEvents = applyRunningArgs(argsMap, eventsForLoad);

    const queuedMessagesForSession = get(messageQueueAtom).filter(
      (message) => message.sessionId === sessionId
    );
    const queuedSyntheticEvents = new Set<string>();
    for (const event of enrichedEvents) {
      if (
        isSyntheticUserInputEvent(event) &&
        queuedMessagesForSession.some((message) =>
          syntheticMatchesQueuedMessage(event, message)
        )
      ) {
        queuedSyntheticEvents.add(event.id);
      }
    }
    const transcriptEvents =
      queuedSyntheticEvents.size > 0
        ? enrichedEvents.filter((event) => !queuedSyntheticEvents.has(event.id))
        : enrichedEvents;

    // Deduplicate: when events already contains the synthetic event (e.g.
    // the initial loadSessionAtom call from launchSession passes it directly),
    // don't prepend a second copy. Synthetic events that correspond to a
    // still-parked frontend queue item are not transcript turns yet; keeping
    // them here makes queued follow-ups cross the rendered round boundary
    // before dispatch.
    let mergedEvents: SessionEvent[];
    if (syntheticUserEvents.length > 0) {
      const enrichedIds = new Set(transcriptEvents.map((evt) => evt.id));
      const uniqueSynthetic = syntheticUserEvents.filter(
        (evt) =>
          !enrichedIds.has(evt.id) &&
          !queuedMessagesForSession.some((message) =>
            syntheticMatchesQueuedMessage(evt, message)
          )
      );
      mergedEvents =
        uniqueSynthetic.length > 0
          ? [...uniqueSynthetic, ...transcriptEvents]
          : transcriptEvents;
    } else {
      mergedEvents = transcriptEvents;
    }

    if (mergedEvents.some(isBackendUserMessageEvent)) {
      const syntheticDisplayTextByContent = new Map<string, string>();
      const syntheticImagesByContent = new Map<string, string[]>();
      for (const event of mergedEvents) {
        if (!isSyntheticUserInputEvent(event)) continue;
        const content = getUserMessageContent(event);
        if (content && event.displayText && content !== event.displayText) {
          syntheticDisplayTextByContent.set(content, event.displayText);
        }
        const images = getUserMessageImages(event);
        if (content && images?.length) {
          syntheticImagesByContent.set(content, images);
        }
      }

      mergedEvents = mergedEvents
        .filter((event) => !isSyntheticUserInputEvent(event))
        .map((event) => {
          if (!isBackendUserMessageEvent(event)) return event;
          const content = getUserMessageContent(event);
          const syntheticDisplayText =
            syntheticDisplayTextByContent.get(content);
          const syntheticImages = syntheticImagesByContent.get(content);
          let nextEvent = event;
          if (
            syntheticDisplayText &&
            nextEvent.displayText !== syntheticDisplayText
          ) {
            nextEvent = { ...nextEvent, displayText: syntheticDisplayText };
          }
          if (syntheticImages?.length && !hasUserMessageImages(nextEvent)) {
            nextEvent = withUserMessageImages(nextEvent, syntheticImages);
          }
          return nextEvent;
        });
    }

    const eventIndex = Object.fromEntries(
      mergedEvents.map((event, index) => [event.id, index])
    );
    const simulatorEvents = mergedEvents.filter(isSimulatorVisibleApprox);
    const simulatorPreviewFields = buildSimulatorPreviewFields(simulatorEvents);
    set(derivedSnapshotAtom, {
      version: Date.now(),
      eventCount: mergedEvents.length,
      events: mergedEvents,
      chatEvents: mergedEvents.filter(isVisibleInChat),
      messagesEvents: simulatorEvents,
      sortedSimulatorEvents: simulatorEvents,
      lastEvent: mergedEvents[mergedEvents.length - 1] ?? null,
      eventIndex,
      chatEventCount: mergedEvents.filter(isVisibleInChat).length,
      hasRunningEvent: mergedEvents.some(isLiveRuntimeResourceEvent),
      ...simulatorPreviewFields,
    });

    // Merge events into Rust EventStore with explicit sessionId.
    // Using set() would overwrite live tool_call/tool_result events that the
    // Rust agent has already pushed via push_events_to_session, causing a race
    // where the frontend load clears the agent's live work. mergeEvents() is
    // safe for both the empty-store case (first launch, equivalent to append)
    // and the cache-hit case (events come from getEvents() so they already
    // include live data — merging them back is a no-op dedup).
    //
    // Explicit sessionId avoids the "active session" fallback that crashes on
    // app restart when Rust has no active session but localStorage has a stale id.
    eventStoreProxy.mergeEvents(mergedEvents, sessionId).catch((err) => {
      log.warn("[loadSession] Failed to sync events to Rust store:", err);
    });
    set(specsAtom, specs);
    set(isFromCacheAtom, isFromCache);
    set(lastFetchedAtom, Date.now());
    set(loadErrorAtom, null);
    set(loadStatusAtom, "loaded");

    // Calculate time range from events - O(n) instead of O(n log n) sort
    if (events.length > 0) {
      let first = events[0];
      let last = events[0];
      let firstTime = new Date(first.createdAt).getTime();
      let lastTime = firstTime;

      for (let idx = 1; idx < events.length; idx++) {
        const event = events[idx];
        const time = new Date(event.createdAt).getTime();
        if (time < firstTime) {
          first = event;
          firstTime = time;
        }
        if (time > lastTime) {
          last = event;
          lastTime = time;
        }
      }

      let endTime = last.createdAt;
      if (firstTime === lastTime) {
        // Add 1 minute buffer if same time
        endTime = new Date(lastTime + 60000).toISOString();
      }

      set(replayTimeRangeAtom, { start: first.createdAt, end: endTime });

      // Find the last simulator-visible event for the initial display.
      // Non-renderable events (session_start, session_end, user messages)
      // have no simulator renderer and would leave the center blank.
      let displayTarget: SessionEvent | null = null;
      for (let idx = events.length - 1; idx >= 0; idx--) {
        if (isSimulatorVisibleApprox(events[idx])) {
          displayTarget = events[idx];
          break;
        }
      }

      // Set to latest visible event and enable follow mode so the simulator
      // auto-follows new events as they arrive via WebSocket/polling
      set(currentEventIdAtom, displayTarget ? displayTarget.id : last.id);
      set(replayBarValueAtom, REPLAY_CONFIG.MAX_VALUE);
      set(replayModeAtom, "follow");
    }
  }
);
loadSessionAtom.debugLabel = "session/load";

/**
 * Append new events (from WebSocket or incremental load).
 *
 * Also merges args from running events into their completed counterparts.
 * Backend sends tool_call as two events: running (with args) + result (args empty).
 * We match by callId and propagate args so downstream consumers (Simulator, ChatPanel)
 * can access file paths, commands, etc.
 */
export const appendEventsAtom = atom(
  null,
  (get, set, newEvents: SessionEvent[]) => {
    // Dedupe by ID — use eventIndexAtom (already-maintained Map) instead of
    // rebuilding a temporary Set on every append
    const existingIndex = get(eventIndexAtom);
    const uniqueNew = newEvents.filter((evt) => !existingIndex.has(evt.id));

    if (uniqueNew.length > 0) {
      const existingEvents = get(eventsAtom);
      const syntheticImagesByContent = new Map<string, string[]>();
      for (const event of existingEvents) {
        if (!isSyntheticUserInputEvent(event)) continue;
        const content = getUserMessageContent(event);
        const images = getUserMessageImages(event);
        if (content && images?.length) {
          syntheticImagesByContent.set(content, images);
        }
      }

      const uniqueNewWithImages = uniqueNew.map((event) => {
        if (!isBackendUserMessageEvent(event) || hasUserMessageImages(event)) {
          return event;
        }
        const images = syntheticImagesByContent.get(
          getUserMessageContent(event)
        );
        return images?.length ? withUserMessageImages(event, images) : event;
      });

      // When the backend echoes the real user message, evict the synthetic
      // placeholder so the user doesn't see a duplicate first message.
      // Use a semantic Rust-side removal instead of the getEvents→filter→set
      // pattern; events arriving between a TS-side read and write would be
      // silently dropped.
      const hasRealUserMessage = uniqueNewWithImages.some(
        isBackendUserMessageEvent
      );
      if (hasRealUserMessage) {
        eventStoreProxy.removeSyntheticUserInputEvents();
      }

      // Incrementally extend the cached running-args map with new events
      // instead of rescanning all existing events (O(newEvents) vs O(allEvents)).
      const argsMap = extendRunningArgsCache(uniqueNewWithImages);
      const enrichedNew = applyRunningArgs(argsMap, uniqueNewWithImages);

      eventStoreProxy.append(enrichedNew);

      // Update time range if needed
      const currentRange = get(replayTimeRangeAtom);
      const lastNew = uniqueNewWithImages[uniqueNewWithImages.length - 1];

      if (
        !currentRange.end ||
        new Date(lastNew.createdAt) > new Date(currentRange.end)
      ) {
        set(replayTimeRangeAtom, {
          ...currentRange,
          end: lastNew.createdAt,
        });
      }

      // Auto-follow in live mode — prefer the last visible event so
      // the simulator doesn't jump to an unrenderable session_end
      const mode = get(replayModeAtom);
      if (mode === "follow") {
        let followTarget = lastNew;
        for (let idx = uniqueNewWithImages.length - 1; idx >= 0; idx--) {
          if (isSimulatorVisibleApprox(uniqueNewWithImages[idx])) {
            followTarget = uniqueNewWithImages[idx];
            break;
          }
        }
        set(currentEventIdAtom, followTarget.id);
        set(replayBarValueAtom, REPLAY_CONFIG.MAX_VALUE);
      }
    }
  }
);
appendEventsAtom.debugLabel = "session/appendEvents";

/**
 * Update a single event (e.g., when tool_call completes).
 * Uses O(1) index lookup via EventStore._idIndex.
 */
export const updateEventAtom = atom(
  null,
  (_get, _set, updatedEvent: SessionEvent) => {
    eventStoreProxy.upsert(updatedEvent);
  }
);
updateEventAtom.debugLabel = "session/updateEvent";

/**
 * O(1) update by known event ID.
 * Preferred over updateEventByPredicateAtom when the event ID is known.
 */
export const updateEventByIdAtom = atom(
  null,
  (
    get,
    _set,
    payload: {
      id: string;
      updater: (event: SessionEvent) => SessionEvent;
    }
  ) => {
    const index = get(eventIndexAtom);
    const existing = index.get(payload.id);
    if (existing) {
      const updated = payload.updater(existing);
      eventStoreProxy.upsert(updated);
    }
  }
);
updateEventByIdAtom.debugLabel = "session/updateEventById";

/**
 * Update the first event matching a predicate with a partial update.
 * Uses O(n) scan — prefer updateEventByIdAtom when ID is known.
 */
export const updateEventByPredicateAtom = atom(
  null,
  (
    get,
    _set,
    payload: {
      predicate: (event: SessionEvent) => boolean;
      updater: (event: SessionEvent) => SessionEvent;
    }
  ) => {
    const events = get(eventsAtom);
    const found = events.find(payload.predicate);

    if (found) {
      const updated = payload.updater(found);
      eventStoreProxy.upsert(updated);
    }
  }
);
updateEventByPredicateAtom.debugLabel = "session/updateEventByPredicate";

/**
 * Navigate to a specific event by ID.
 */
export const navigateToEventAtom = atom(null, (get, set, eventId: string) => {
  const index = get(eventIndexAtom);
  const event = index.get(eventId);
  if (event) {
    navigateToEventAndUpdateBar(get, set, event);
  }
});
navigateToEventAtom.debugLabel = "session/navigateToEvent";

/**
 * Navigate to next event.
 */
export const navigateNextAtom = atom(null, (get, set) => {
  const currentIndex = get(currentEventIndexAtom);
  const sorted = get(sortedEventsAtom);

  if (currentIndex < sorted.length - 1) {
    navigateToEventAndUpdateBar(get, set, sorted[currentIndex + 1]);
  }
});
navigateNextAtom.debugLabel = "session/navigateNext";

/**
 * Navigate to previous event.
 */
export const navigatePrevAtom = atom(null, (get, set) => {
  const currentIndex = get(currentEventIndexAtom);
  const sorted = get(sortedEventsAtom);

  if (currentIndex > 0) {
    navigateToEventAndUpdateBar(get, set, sorted[currentIndex - 1]);
  }
});
navigatePrevAtom.debugLabel = "session/navigatePrev";

/**
 * Switch to live mode (follow latest).
 */
export const goLiveAtom = atom(null, (get, set) => {
  const sorted = get(sortedEventsAtom);

  set(replayModeAtom, "follow");
  set(replayBarValueAtom, REPLAY_CONFIG.MAX_VALUE);

  if (sorted.length > 0) {
    // Prefer the last simulator-visible event so the center
    // doesn't land on an unrenderable session_end
    let target = sorted[sorted.length - 1];
    for (let idx = sorted.length - 1; idx >= 0; idx--) {
      if (isSimulatorVisibleApprox(sorted[idx])) {
        target = sorted[idx];
        break;
      }
    }
    set(currentEventIdAtom, target.id);
  }
});
goLiveAtom.debugLabel = "session/goLive";
