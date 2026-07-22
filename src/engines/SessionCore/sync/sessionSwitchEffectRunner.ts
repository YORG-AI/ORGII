import {
  activateExternalReplaySession,
  deactivateExternalReplaySession,
} from "./externalReplayTransport";
import { runSessionSwitchOrchestrator } from "./sessionSwitchOrchestrator";
import {
  disposeCurrentHandler,
  resetReloadGuardForSession,
} from "./sessionSyncLifecycle";
import { loadSessionWithoutAdapter } from "./sessionSyncNoAdapterLoader";
import {
  type SessionEventHandlerStateActions,
  type SessionLoadStateActions,
  type SessionSwitchStateActions,
  createSessionEventHandlerCallbacks,
  resetSessionSwitchState,
} from "./sessionSyncStateHelpers";
import type { SessionSyncRefs } from "./sessionSyncTypes";
import { getAdapterForSession } from "./types";

interface RunSessionSwitchEffectOptions {
  sessionId: string;
  reloadEpoch: number;
  refs: SessionSyncRefs;
  switchActions: SessionSwitchStateActions;
  loadActions: SessionLoadStateActions;
  handlerActions: SessionEventHandlerStateActions;
  setPendingPlanApprovals: Parameters<
    typeof runSessionSwitchOrchestrator
  >[0]["setPendingPlanApprovals"];
  logStatusChange: (status: string, errorMessage?: string) => void;
  logger: Parameters<typeof runSessionSwitchOrchestrator>[0]["logger"];
}

export function runSessionSwitchEffect(
  options: RunSessionSwitchEffectOptions
): () => void {
  const {
    sessionId,
    reloadEpoch,
    refs,
    switchActions,
    loadActions,
    handlerActions,
    setPendingPlanApprovals,
    logStatusChange,
    logger,
  } = options;

  const leavingSessionId = refs.prevSessionIdRef.current;
  refs.prevSessionIdRef.current = sessionId;
  refs.prevReloadEpochRef.current = reloadEpoch;

  resetSessionSwitchState(switchActions, sessionId, leavingSessionId);
  disposeCurrentHandler(refs);

  const adapter = getAdapterForSession(sessionId);
  const abortController = new AbortController();
  if (!adapter) {
    loadSessionWithoutAdapter(sessionId, abortController, loadActions, logger);
    return () => abortController.abort();
  }

  refs.adapterRef.current = adapter;
  const replayLease =
    adapter.historyMode === "bounded-replay"
      ? activateExternalReplaySession(sessionId)
      : undefined;
  refs.handlerRef.current = adapter.createEventHandler(
    sessionId,
    createSessionEventHandlerCallbacks(
      sessionId,
      handlerActions,
      logStatusChange
    )
  );

  runSessionSwitchOrchestrator({
    sessionId,
    adapter,
    abortController,
    refs,
    actions: loadActions,
    setPendingPlanApprovals,
    logger,
    replayLease,
  });

  return () => {
    abortController.abort();
    if (replayLease) deactivateExternalReplaySession(replayLease);
    resetReloadGuardForSession(sessionId, refs);
  };
}

export function resetEmptySessionRefs(
  refs: Pick<SessionSyncRefs, "prevSessionIdRef" | "prevReloadEpochRef">
): void {
  refs.prevSessionIdRef.current = null;
  refs.prevReloadEpochRef.current = 0;
}
