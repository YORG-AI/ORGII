/**
 * Internal helper utilities for session action atoms.
 * Extracted from actions.ts to stay within the 500-line config file limit.
 */
import { type Getter, type Setter } from "jotai";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  sessionRuntimeErrorAtom,
  sessionRuntimeStatusAtom,
  streamRetryStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { clearFileReviewAtom } from "@src/store/session/fileReviewAtom";
import {
  replayDisplayValueAtom,
  replayIsDraggingAtom,
} from "@src/store/ui/chatPanelAtom";
import { selectedExecutionThreadAtom } from "@src/store/ui/sessionPaginationAtom";
import {
  simulatorEffectiveDockAppAtom,
  simulatorEventFiltersAtom,
  simulatorFollowAppLockAtom,
  simulatorSelectedAppAtom,
} from "@src/store/ui/simulatorAtom";

import { isLiveRuntimeResourceEvent } from "../runningEventGate";
import type { SessionEvent } from "../types";
import {
  editTruncationTimestampAtom,
  streamingDeltaContentAtom,
} from "./events";
import { hasMoreEventsAtom, isLoadingMoreAtom } from "./metadata";
import {
  currentEventIdAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./replay";
import { discardStreamingDeltaBuffer } from "./streamingDeltaBuffer";

// ============================================
// Running args cache
// ============================================

const RUNNING_ARGS_CACHE_MAX = 500;
let _cachedRunningArgsMap = new Map<string, Record<string, unknown>>();

export function resetRunningArgsCache(): void {
  _cachedRunningArgsMap = new Map();
}

export function extendRunningArgsCache(
  events: SessionEvent[]
): Map<string, Record<string, unknown>> {
  for (const evt of events) {
    if (
      (isLiveRuntimeResourceEvent(evt) ||
        evt.displayStatus === "awaiting_user") &&
      evt.callId &&
      evt.args &&
      Object.keys(evt.args).length > 0
    ) {
      if (_cachedRunningArgsMap.size >= RUNNING_ARGS_CACHE_MAX) {
        const oldestKey = _cachedRunningArgsMap.keys().next().value;
        if (oldestKey !== undefined) {
          _cachedRunningArgsMap.delete(oldestKey);
        }
      }
      _cachedRunningArgsMap.set(evt.callId, evt.args);
    }
  }
  return _cachedRunningArgsMap;
}

/**
 * Enrich targets with args from a running-args map.
 * Returns a new array with enriched copies — does not mutate inputs.
 */
export function applyRunningArgs(
  argsMap: Map<string, Record<string, unknown>>,
  targets: SessionEvent[]
): SessionEvent[] {
  if (argsMap.size === 0) return targets;
  let mutated = false;
  const result = targets.map((evt) => {
    if (
      evt.displayStatus !== "running" &&
      evt.callId &&
      (!evt.args || Object.keys(evt.args).length === 0)
    ) {
      const runningArgs = argsMap.get(evt.callId);
      if (runningArgs) {
        mutated = true;
        return {
          ...evt,
          args: { ...runningArgs },
          filePath:
            evt.filePath || (runningArgs.path as string) || evt.filePath,
          command:
            evt.command || (runningArgs.command as string) || evt.command,
        };
      }
    }
    return evt;
  });
  return mutated ? result : targets;
}

// ============================================
// Shared UI state reset
// ============================================

/**
 * Reset all transient UI atoms tied to a specific session.
 * Called by both clearSessionAtom and loadSessionAtom (on session switch).
 *
 * When `sessionId` is provided, only that session's streaming content is
 * removed from the per-session Map. When omitted the entire Map is cleared
 * (full reset path, e.g. logout / app teardown).
 */
export function resetSessionUIState(
  set: Setter,
  sessionId?: string | null
): void {
  set(editTruncationTimestampAtom, null);
  set(hasMoreEventsAtom, false);
  set(isLoadingMoreAtom, false);
  set(selectedExecutionThreadAtom, null);
  set(replayDisplayValueAtom, 0);
  set(replayIsDraggingAtom, false);
  set(simulatorSelectedAppAtom, null);
  set(simulatorEffectiveDockAppAtom, null);
  set(simulatorFollowAppLockAtom, null);
  set(simulatorEventFiltersAtom, []);
  set(clearFileReviewAtom);
  set(sessionRuntimeStatusAtom, "idle");
  set(sessionRuntimeErrorAtom, null);
  set(streamRetryStatusAtom, null);
  // Cancel buffered chunks BEFORE clearing the atom so a queued trailing
  // flush cannot resurrect the cleared session's streaming content.
  if (sessionId) {
    discardStreamingDeltaBuffer(sessionId);
    set(streamingDeltaContentAtom, (prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  } else {
    discardStreamingDeltaBuffer();
    set(streamingDeltaContentAtom, new Map());
  }
}

// ============================================
// Navigation helper
// ============================================

/**
 * Navigate to a specific event: set current event ID, switch to replay mode,
 * and update the replay bar position based on event time.
 */
export function navigateToEventAndUpdateBar(
  get: Getter,
  set: Setter,
  event: SessionEvent
): void {
  set(currentEventIdAtom, event.id);
  set(replayModeAtom, "replay");

  const range = get(replayTimeRangeAtom);
  if (range.start && range.end) {
    const startMs = new Date(range.start).getTime();
    const endMs = new Date(range.end).getTime();
    const eventMs = new Date(event.createdAt).getTime();
    const rangeMs = endMs - startMs;

    if (rangeMs > 0) {
      const value = ((eventMs - startMs) / rangeMs) * REPLAY_CONFIG.MAX_VALUE;
      set(
        replayBarValueAtom,
        Math.max(0, Math.min(REPLAY_CONFIG.MAX_VALUE, value))
      );
    }
  }
}
