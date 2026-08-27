import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { updateSessionStatus } from "@src/store/session";

import { isNativeTranscriptSession } from "./nativeTranscriptReconcile";
import {
  type SessionLoadStateActions,
  applyPostLoadResult,
} from "./sessionSyncStateHelpers";
import type { SessionSyncRefs } from "./sessionSyncTypes";
import {
  IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS,
  hydrateSessionStoreBeforeDisplay,
  isTerminalRunStatus,
  loadPersistedHistory,
  toCliSessionStatus,
  toSessionListStatus,
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
      if (isNativeTranscriptSession(sessionId)) {
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

      if (postResult?.contextTokens !== undefined) {
        actions.setSessionContextTokens(postResult.contextTokens);
      }
      if (postResult?.contextUsage !== undefined) {
        actions.setSessionContextUsage(postResult.contextUsage);
      }
      if (postResult?.runStatus !== undefined) {
        // `runStatus` is the raw wire string. Narrow ONCE and feed both
        // sinks from the narrowed value — the runtime atom and the session
        // list row must never disagree, and a value outside the union must
        // not reach `Session.status`, which drives sidebar grouping, Kanban
        // lanes and every terminal-status predicate.
        const runStatus = toCliSessionStatus(postResult.runStatus);
        actions.setSessionRuntimeStatus(runStatus);
        updateSessionStatus(sessionId, toSessionListStatus(runStatus));
        if (isTerminalRunStatus(postResult.runStatus)) return;
      }
      if (postResult?.runError !== undefined) {
        actions.setSessionRuntimeError(postResult.runError);
      }
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
