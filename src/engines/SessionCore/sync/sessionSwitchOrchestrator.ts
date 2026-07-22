import { Message } from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import {
  mergeExternalReplayTurnWindow,
  startExternalReplayTurnEpisode,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";
import type { Logger } from "@src/hooks/logger";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  type ExternalReplaySessionLease,
  openExternalReplaySession,
} from "./externalReplayTransport";
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
  replayLease?: ExternalReplaySessionLease;
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
      const cacheHit = await eventStoreProxy.switchSession(sessionId);
      if (abortController.signal.aborted) return;
      if (adapter.historyMode === "bounded-replay") {
        if (!options.replayLease) {
          throw new Error(`Missing bounded replay lease for ${sessionId}`);
        }
        await handleBoundedReplaySession({
          sessionId,
          adapter,
          abortController,
          actions,
          setPendingPlanApprovals,
          replayLease: options.replayLease,
        });
        return;
      }
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

async function handleBoundedReplaySession(
  options: Pick<
    SessionSwitchOrchestratorOptions,
    | "sessionId"
    | "adapter"
    | "abortController"
    | "actions"
    | "setPendingPlanApprovals"
    | "replayLease"
  >
): Promise<void> {
  const {
    sessionId,
    adapter,
    abortController,
    actions,
    setPendingPlanApprovals,
    replayLease,
  } = options;
  if (!replayLease) return;

  actions.setLoadStatus("loading");
  const postResult = adapter.postLoad
    ? await adapter.postLoad(sessionId, abortController.signal)
    : null;
  if (abortController.signal.aborted) return;

  const window = await openExternalReplaySession(
    replayLease,
    abortController.signal
  );
  if (!window || abortController.signal.aborted) return;
  startExternalReplayTurnEpisode(sessionId, window.cursor.generation);
  mergeExternalReplayTurnWindow(sessionId, window);

  // A just-launched managed native CLI may not have emitted its vendor id
  // yet. Rust leaves the existing live EventStore untouched in that state.
  const displayEvents = window.stats.notReady
    ? await eventStoreProxy.getEvents(sessionId)
    : window.events;
  if (abortController.signal.aborted) return;

  actions.dispatchLoadSession({
    sessionId,
    events: displayEvents,
    // The replay generation is canonical. Do not retain rows from a previous
    // source generation or a wider cached window in the Jotai projection.
    replace: !window.stats.notReady,
  });
  rehydratePendingPlanApproval(
    sessionId,
    abortController,
    setPendingPlanApprovals
  );
  applyPostLoadResult(sessionId, postResult, actions);
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

  // Bounded replay is handled before this function. Keeping the assertion
  // here prevents a future caller from silently reintroducing loadHistory.
  if (adapter.historyMode !== "persisted-db") {
    throw new Error(`Unexpected bounded replay cache path for ${sessionId}`);
  }

  actions.setLoadStatus("loading");

  const postResult = adapter.postLoad
    ? await adapter.postLoad(sessionId, abortController.signal)
    : null;
  if (abortController.signal.aborted) return;

  const cacheHitInFlight = isInFlightRunStatus(postResult?.runStatus);
  let displayEvents = await eventStoreProxy.getEvents(sessionId);
  if (abortController.signal.aborted) return;

  if (!cacheHitInFlight) {
    if (adapter.category === "agent") {
      await eventStoreProxy.loadInitialTurnWindow(sessionId);
      if (abortController.signal.aborted) return;
      displayEvents = await eventStoreProxy.getEvents(sessionId);
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
        if (abortController.signal.aborted) return;
        if (fallbackEvents.length > 0) {
          await hydrateSessionStoreBeforeDisplay(sessionId, fallbackEvents);
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
      if (abortController.signal.aborted) return;
      await hydrateSessionStoreBeforeDisplay(sessionId, displayEvents);
    }
    if (abortController.signal.aborted) return;
  }

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
  if (!isImportedHistorySession(sessionId)) {
    reconcileInFlightHistory(sessionId, adapter, refs, actions);
  }
  applyPostLoadResult(sessionId, postResult, actions);
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

  if (adapter.historyMode !== "persisted-db") {
    throw new Error(`Unexpected bounded replay miss path for ${sessionId}`);
  }

  actions.setLoadStatus("loading");

  const missPostResult = adapter.postLoad
    ? await adapter.postLoad(sessionId, abortController.signal)
    : null;
  if (abortController.signal.aborted) return;

  const missInFlight = isInFlightRunStatus(missPostResult?.runStatus);
  const events = !missInFlight
    ? await loadPersistedHistory(adapter, sessionId, abortController.signal)
    : await adapter.loadHistory(sessionId, abortController.signal);
  if (abortController.signal.aborted) return;
  await hydrateSessionStoreBeforeDisplay(
    sessionId,
    events,
    missInFlight ? "merge" : "replace"
  );
  if (abortController.signal.aborted) return;

  actions.dispatchLoadSession({ sessionId, events });
  if (!isImportedHistorySession(sessionId)) {
    reconcileInFlightHistory(sessionId, adapter, refs, actions);
  }

  applyPostLoadResult(sessionId, missPostResult, actions);

  rehydratePendingPlanApproval(
    sessionId,
    abortController,
    setPendingPlanApprovals
  );
}
