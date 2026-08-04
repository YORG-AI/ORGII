import { cursorIdeComposerLastUpdatedAt } from "@src/api/tauri/externalHistory/cursorIde";
import { Message } from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import {
  finishSessionSwitchTrace,
  markSessionSwitchTrace,
} from "@src/engines/SessionCore/performance/sessionSwitchPerformance";
import type { Logger } from "@src/hooks/logger";
import {
  composerIdFromSessionId,
  isCollaborationImportedSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

import { getCursorIdeSnapshotLastUpdatedAt } from "./adapters/cursorIdeAdapter";
import { isCursorIdeSessionId } from "./sessionSyncDerivedState";
import { rehydratePendingPlanApproval } from "./sessionSyncPlanApproval";
import { reconcileInFlightHistory } from "./sessionSyncReconcile";
import {
  type SessionLoadStateActions,
  applyPostLoadResult,
} from "./sessionSyncStateHelpers";
import type { SessionSyncRefs } from "./sessionSyncTypes";
import {
  hydrateSessionStoreBeforeDisplay,
  isInFlightRunStatus,
  loadPersistedHistory,
} from "./sessionSyncUtils";
import type { SessionAdapter } from "./types";

interface SessionSwitchOrchestratorOptions {
  sessionId: string;
  adapter: SessionAdapter;
  abortController: AbortController;
  refs: Pick<SessionSyncRefs, "liveSessionIdRef">;
  actions: SessionLoadStateActions;
  setPendingPlanApprovals: Parameters<typeof rehydratePendingPlanApproval>[2];
  logger: Logger;
}

export function runSessionSwitchOrchestrator(
  options: SessionSwitchOrchestratorOptions
): void {
  const switchSession = async () => {
    const {
      sessionId,
      adapter,
      abortController,
      refs,
      actions,
      setPendingPlanApprovals,
    } = options;

    try {
      markSessionSwitchTrace(sessionId, "orchestrator-start", {
        adapterCategory: adapter.category,
      });
      const cacheHit = await eventStoreProxy.switchSession(sessionId);
      markSessionSwitchTrace(sessionId, "rust-switch-complete", {
        cacheHit,
      });
      if (abortController.signal.aborted) return;
      if (cacheHit) {
        await handleCacheHit({
          sessionId,
          adapter,
          abortController,
          refs,
          actions,
          setPendingPlanApprovals,
        });
        return;
      }

      await handleCacheMiss({
        sessionId,
        adapter,
        abortController,
        refs,
        actions,
        setPendingPlanApprovals,
      });
    } catch (error) {
      if (!options.abortController.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        finishSessionSwitchTrace(options.sessionId, "failed", {
          reason: "orchestrator-error",
        });
        options.logger.error(
          `failed to load history for ${options.sessionId}:`,
          error
        );
        options.actions.failSessionLoad(detail);
        Message.error({
          content: `Failed to load session history: ${detail}`,
          duration: 5000,
        });
      }
    }
  };

  void switchSession();
}

async function handleCacheHit(
  options: Pick<
    SessionSwitchOrchestratorOptions,
    | "sessionId"
    | "adapter"
    | "abortController"
    | "refs"
    | "actions"
    | "setPendingPlanApprovals"
  >
): Promise<void> {
  const {
    sessionId,
    adapter,
    abortController,
    refs,
    actions,
    setPendingPlanApprovals,
  } = options;

  if (isCursorIdeSessionId(sessionId)) {
    const handled = await handleCursorIdeCacheHit(
      sessionId,
      adapter,
      abortController,
      actions
    );
    if (handled) return;
  }

  actions.setLoadStatus("loading");

  const postResult = adapter.postLoad
    ? await adapter.postLoad(sessionId, abortController.signal)
    : null;
  markSessionSwitchTrace(sessionId, "post-load-complete", {
    hasPostLoad: Boolean(adapter.postLoad),
    runStatus: postResult?.runStatus,
  });
  if (abortController.signal.aborted) return;

  const cacheHitInFlight = isInFlightRunStatus(postResult?.runStatus);
  let displayEvents = await eventStoreProxy.getEvents(sessionId);
  markSessionSwitchTrace(sessionId, "memory-events-read", {
    eventCount: displayEvents.length,
  });
  if (abortController.signal.aborted) return;

  if (!cacheHitInFlight) {
    if (adapter.category === "agent") {
      await eventStoreProxy.loadInitialTurnWindow(
        sessionId,
        isCollaborationImportedSession(sessionId) ? 0 : undefined
      );
      markSessionSwitchTrace(sessionId, "turn-window-complete");
      if (abortController.signal.aborted) return;
      displayEvents = await eventStoreProxy.getEvents(sessionId);
      markSessionSwitchTrace(sessionId, "display-events-read", {
        eventCount: displayEvents.length,
      });
      // The round-window load can resolve to zero chat-visible events when
      // the turn index is mid-rebuild (e.g. switching into a session right
      // after it finished a long run), and `set_round_window` overwrites the
      // in-memory store unconditionally. Without this guard the panel renders
      // "loaded + 0 events" until the user hits Reload. Fall back to the full
      // initial load (which itself falls back to `loadEvents` when the turn
      // index is empty) and re-hydrate the store so the events actually show.
      if (displayEvents.length === 0 || !displayEvents.some(isVisibleInChat)) {
        const fallbackEvents = await loadPersistedHistory(
          adapter,
          sessionId,
          abortController.signal
        );
        markSessionSwitchTrace(sessionId, "persisted-history-complete", {
          eventCount: fallbackEvents.length,
          reason: "empty-turn-window",
        });
        if (abortController.signal.aborted) return;
        if (fallbackEvents.length > 0) {
          await hydrateSessionStoreBeforeDisplay(sessionId, fallbackEvents);
          markSessionSwitchTrace(sessionId, "rust-hydration-complete", {
            eventCount: fallbackEvents.length,
          });
          if (abortController.signal.aborted) return;
          displayEvents = fallbackEvents;
        }
      }
    } else if (
      displayEvents.length === 0 ||
      !displayEvents.some(isVisibleInChat)
    ) {
      displayEvents = await loadPersistedHistory(
        adapter,
        sessionId,
        abortController.signal
      );
      markSessionSwitchTrace(sessionId, "persisted-history-complete", {
        eventCount: displayEvents.length,
        reason: "empty-resident-store",
      });
      if (abortController.signal.aborted) return;
      await hydrateSessionStoreBeforeDisplay(sessionId, displayEvents);
      markSessionSwitchTrace(sessionId, "rust-hydration-complete", {
        eventCount: displayEvents.length,
      });
    }
    if (abortController.signal.aborted) return;
  }

  markSessionSwitchTrace(sessionId, "data-ready", {
    cacheHit: true,
    eventCount: displayEvents.length,
    inFlight: cacheHitInFlight,
  });
  actions.dispatchLoadSession({
    sessionId,
    events: displayEvents,
    isFromCache: true,
  });
  rehydratePendingPlanApproval(
    sessionId,
    abortController,
    setPendingPlanApprovals
  );
  if (
    cacheHitInFlight &&
    !isImportedHistorySession(sessionId) &&
    !isCollaborationImportedSession(sessionId)
  ) {
    reconcileInFlightHistory(sessionId, adapter, refs, actions);
  }
  applyPostLoadResult(sessionId, postResult, actions);
}

async function handleCursorIdeCacheHit(
  sessionId: string,
  adapter: SessionAdapter,
  abortController: AbortController,
  actions: Pick<
    SessionLoadStateActions,
    "dispatchLoadSession" | "setLoadStatus"
  >
): Promise<boolean> {
  actions.setLoadStatus("loading");
  const composerId = composerIdFromSessionId(sessionId);
  const currentUpdatedAt = composerId
    ? await cursorIdeComposerLastUpdatedAt(composerId)
    : null;
  if (abortController.signal.aborted) return true;
  const cachedUpdatedAt = getCursorIdeSnapshotLastUpdatedAt(sessionId);
  if (currentUpdatedAt !== null && cachedUpdatedAt === currentUpdatedAt) {
    const cachedEvents = await eventStoreProxy.getEvents();
    markSessionSwitchTrace(sessionId, "display-events-read", {
      eventCount: cachedEvents.length,
    });
    if (abortController.signal.aborted) return true;
    markSessionSwitchTrace(sessionId, "data-ready", {
      cacheHit: true,
      eventCount: cachedEvents.length,
    });
    actions.dispatchLoadSession({ sessionId, events: cachedEvents });
    return true;
  }

  const events = await adapter.loadHistory(sessionId, abortController.signal);
  markSessionSwitchTrace(sessionId, "persisted-history-complete", {
    eventCount: events.length,
  });
  if (abortController.signal.aborted) return true;
  await eventStoreProxy.set(events, sessionId);
  markSessionSwitchTrace(sessionId, "rust-hydration-complete", {
    eventCount: events.length,
  });
  if (abortController.signal.aborted) return true;
  markSessionSwitchTrace(sessionId, "data-ready", {
    cacheHit: false,
    eventCount: events.length,
  });
  actions.dispatchLoadSession({ sessionId, events });
  return true;
}

async function handleCacheMiss(
  options: Pick<
    SessionSwitchOrchestratorOptions,
    | "sessionId"
    | "adapter"
    | "abortController"
    | "refs"
    | "actions"
    | "setPendingPlanApprovals"
  >
): Promise<void> {
  const {
    sessionId,
    adapter,
    abortController,
    refs,
    actions,
    setPendingPlanApprovals,
  } = options;

  actions.setLoadStatus("loading");

  const missPostResult = adapter.postLoad
    ? await adapter.postLoad(sessionId, abortController.signal)
    : null;
  markSessionSwitchTrace(sessionId, "post-load-complete", {
    hasPostLoad: Boolean(adapter.postLoad),
    runStatus: missPostResult?.runStatus,
  });
  if (abortController.signal.aborted) return;

  const missInFlight = isInFlightRunStatus(missPostResult?.runStatus);
  const events = !missInFlight
    ? await loadPersistedHistory(adapter, sessionId, abortController.signal)
    : await adapter.loadHistory(sessionId, abortController.signal);
  markSessionSwitchTrace(sessionId, "persisted-history-complete", {
    eventCount: events.length,
    inFlight: missInFlight,
  });
  if (abortController.signal.aborted) return;
  await hydrateSessionStoreBeforeDisplay(
    sessionId,
    events,
    missInFlight ? "merge" : "replace"
  );
  markSessionSwitchTrace(sessionId, "rust-hydration-complete", {
    eventCount: events.length,
    mode: missInFlight ? "merge" : "replace",
  });
  if (abortController.signal.aborted) return;

  markSessionSwitchTrace(sessionId, "data-ready", {
    cacheHit: false,
    eventCount: events.length,
    inFlight: missInFlight,
  });
  actions.dispatchLoadSession({ sessionId, events });
  if (
    missInFlight &&
    !isImportedHistorySession(sessionId) &&
    !isCollaborationImportedSession(sessionId)
  ) {
    reconcileInFlightHistory(sessionId, adapter, refs, actions);
  }

  applyPostLoadResult(sessionId, missPostResult, actions);

  rehydratePendingPlanApproval(
    sessionId,
    abortController,
    setPendingPlanApprovals
  );
}
