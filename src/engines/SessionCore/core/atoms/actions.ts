/**
 * Session Action Atoms (Write-only)
 *
 * Compound actions for session state management.
 * Helpers are in actionsUtils.ts. Simulator-preview projection lives in
 * actions.simulatorPreview.ts, user-message reconciliation helpers in
 * actions.userMessageSync.ts, departing-session cache release in
 * actions.snapshotLifecycle.ts, event-mutation atoms in
 * actions.eventUpdates.ts, and replay-navigation atoms in
 * actions.navigation.ts — all re-exported below to keep a single import
 * surface at this path.
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
import type { SessionEvent, SessionSpec } from "../types";
import {
  buildSimulatorPreviewFields,
  isSimulatorVisibleApprox,
} from "./actions.simulatorPreview";
import { releaseDepartingSessionSnapshot } from "./actions.snapshotLifecycle";
import {
  getUserMessageContent,
  getUserMessageImages,
  hasUserMessageImages,
  syntheticMatchesQueuedMessage,
  withUserMessageImages,
} from "./actions.userMessageSync";
import {
  applyRunningArgs,
  extendRunningArgsCache,
  resetRunningArgsCache,
  resetSessionUIState,
} from "./actionsUtils";
import { derivedSnapshotAtom, eventsAtom } from "./events";
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
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./replay";

const log = createLogger("loadSession");

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
    // inflated further by any replay-loaded turn bodies). Read-only imported
    // history is released immediately; live sessions retain the normal grace
    // window and streaming guard. Rust remains the source of truth either way.
    releaseDepartingSessionSnapshot(currentSessionId);
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
  /**
   * When true and the session is already on screen, the incoming events are
   * the canonical transcript: skip the base-events merge entirely and use
   * them wholesale (the Rust EventStore is replaced too, not merged into).
   * Used by the native-transcript reconcile — the CLI's own store is the
   * transcript of record, so ephemeral in-memory turn events must not
   * survive next to their replayed counterparts.
   *
   * Synthetic-preservation still applies when the incoming replay carries no
   * backend user message (first-message recovery), and queued-synthetic
   * filtering always runs.
   */
  replace?: boolean;
}

export const loadSessionAtom = atom(
  null,
  (get, set, payload: LoadSessionPayload) => {
    const {
      sessionId,
      events,
      specs = [],
      isFromCache = false,
      replace = false,
    } = payload;

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
      clearLoadedTurnRegistry(currentSessionId);
      // Direct A→B switches come through here without clearSessionAtom —
      // apply the same imported-immediate/live-deferred release policy.
      releaseDepartingSessionSnapshot(currentSessionId);
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
    // replace: the incoming events ARE the transcript — never merge them
    // next to the existing in-memory events (whose ids never match, so the
    // id-based merge would duplicate every replayed user/assistant turn).
    const replaceForSession = replace && currentSessionId === sessionId;
    const baseEvents =
      !replaceForSession &&
      currentSessionId === sessionId &&
      existingSameSessionEvents.length > 0
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
    // Exception: replace loads (native-transcript reconcile at a terminal
    // turn status). There the Rust store still holds the ephemeral in-memory
    // turn events (synthetic user bubble, streamed placeholders) whose ids
    // never match the replayed transcript, so a merge would push a snapshot
    // that reintroduces them as duplicates. The turn is over — set() carries
    // no live-work race and is the intended "replace all" semantics.
    //
    // Explicit sessionId avoids the "active session" fallback that crashes on
    // app restart when Rust has no active session but localStorage has a stale id.
    const rustStoreWrite = replaceForSession
      ? eventStoreProxy.set(mergedEvents, sessionId)
      : eventStoreProxy.mergeEvents(mergedEvents, sessionId);
    rustStoreWrite.catch((err) => {
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

// ============================================
// Re-exports (moved to sibling modules; kept importable from this path)
// ============================================

export {
  appendEventsAtom,
  updateEventAtom,
  updateEventByIdAtom,
  updateEventByPredicateAtom,
} from "./actions.eventUpdates";
export {
  goLiveAtom,
  navigateNextAtom,
  navigatePrevAtom,
  navigateToEventAtom,
} from "./actions.navigation";
