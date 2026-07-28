/**
 * Event mutation atoms (append/update) for session state (Write-only).
 *
 * Extracted from actions.ts.
 */
import { atom } from "jotai";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";

import {
  isBackendUserMessageEvent,
  isSyntheticUserInputEvent,
} from "../../sync/utils/activityIds";
import { eventStoreProxy } from "../store/EventStoreProxy";
import type { SessionEvent } from "../types";
import { isSimulatorVisibleApprox } from "./actions.simulatorPreview";
import {
  getUserMessageContent,
  getUserMessageImages,
  hasUserMessageImages,
  withUserMessageImages,
} from "./actions.userMessageSync";
import { applyRunningArgs, extendRunningArgsCache } from "./actionsUtils";
import { eventIndexAtom, eventsAtom } from "./events";
import {
  currentEventIdAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./replay";

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
