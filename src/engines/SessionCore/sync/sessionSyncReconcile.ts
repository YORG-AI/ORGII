import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";

import {
  type SessionLoadStateActions,
  applyPostLoadResult,
  capturePostLoadLifecycleSnapshot,
} from "./sessionSyncStateHelpers";
import type { SessionSyncRefs } from "./sessionSyncTypes";
import {
  IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS,
  hydrateSessionStoreBeforeDisplay,
  isTerminalRunStatus,
  loadPersistedHistory,
  waitForReconcileDelay,
} from "./sessionSyncUtils";
import type { SessionAdapter } from "./types";

type PostLoadStateActions = Pick<
  SessionLoadStateActions,
  | "setSessionContextTokens"
  | "setSessionContextUsage"
  | "setSessionRuntimeStatus"
  | "setSessionRuntimeError"
>;

type ReconcileStateActions = Pick<
  SessionLoadStateActions,
  "dispatchLoadSession"
> &
  PostLoadStateActions;

export function reconcileInFlightHistory(
  sessionId: string,
  adapter: SessionAdapter,
  refs: Pick<SessionSyncRefs, "liveSessionIdRef">,
  actions: ReconcileStateActions
): void {
  const reconcile = async () => {
    const reconcileController = new AbortController();
    for (const delayMs of IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS) {
      await waitForReconcileDelay(delayMs);
      if (refs.liveSessionIdRef.current !== sessionId) return;

      const postLoadLifecycle = capturePostLoadLifecycleSnapshot(sessionId);
      const postResult = adapter.postLoad
        ? await adapter.postLoad(sessionId, reconcileController.signal)
        : null;
      if (refs.liveSessionIdRef.current !== sessionId) return;

      const persistedEvents = await loadPersistedHistory(
        adapter,
        sessionId,
        reconcileController.signal
      );
      if (
        refs.liveSessionIdRef.current !== sessionId ||
        persistedEvents.length === 0
      ) {
        continue;
      }

      // Native-transcript CLI sessions: the live turn renders from in-memory
      // events only (optimistic user bubble + streamed broadcasts). Repeated
      // replay merges here were the "~5s" duplicate-bubble source — each tick
      // parked replay rows (synthesized fallback, then the real
      // `codex-user-N` parse) next to them under never-matching ids. Only an
      // EMPTY store (switched into a still-running session after a restart or
      // eviction) is hydrated, with replace semantics so a retry tick stays
      // idempotent; the terminal reconcile owns the final canonical replace.
      if (postResult?.transcriptSource === "native") {
        const existingEvents = await eventStoreProxy.getEvents(sessionId);
        if (refs.liveSessionIdRef.current !== sessionId) return;
        if (existingEvents.length === 0) {
          await hydrateSessionStoreBeforeDisplay(
            sessionId,
            persistedEvents,
            "replace"
          );
          if (refs.liveSessionIdRef.current !== sessionId) return;
          actions.dispatchLoadSession({
            sessionId,
            events: persistedEvents,
            replace: true,
          });
        }
      } else {
        await hydrateSessionStoreBeforeDisplay(
          sessionId,
          persistedEvents,
          "merge"
        );
        if (refs.liveSessionIdRef.current !== sessionId) return;
        actions.dispatchLoadSession({ sessionId, events: persistedEvents });
      }

      applyPostLoadResult(sessionId, postResult, actions, {
        lifecycleSnapshot: postLoadLifecycle,
        acceptTerminalForUnchangedGeneration: true,
      });
      if (isTerminalRunStatus(postResult?.runStatus)) return;
    }
  };

  void reconcile();
}

export function applySwitchPostLoadResult(
  sessionId: string,
  postResult: Parameters<typeof applyPostLoadResult>[1],
  actions: PostLoadStateActions
): void {
  applyPostLoadResult(sessionId, postResult, actions);
}
