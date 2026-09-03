import { useCallback, useMemo, useRef, useState } from "react";

import {
  type AgentOrgMemberIntervention,
  type AgentOrgRunView,
  CANCEL_REASON,
  type ReturnToWorkResult,
  cancelSession,
  returnAgentOrgSessionToWork,
} from "@src/api/tauri/agent";
import {
  isCliSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

const EMPTY_RESULT = {
  intervention: null as AgentOrgMemberIntervention | null,
  error: null as string | null,
  returning: false,
  stopping: false,
  refresh: async () => {},
  returnToWork: async () => null as ReturnToWorkResult | null,
  stopUserDirectedWork: async () => false,
} as const;

interface AgentOrgInterventionActionState {
  sessionId: string | null;
  error: string | null;
  returning: boolean;
  stopping: boolean;
}

export function interventionForSession(
  view: AgentOrgRunView | null,
  sessionId: string | null
): AgentOrgMemberIntervention | null {
  if (!view || !sessionId) return null;
  const member = view.members.find(
    (candidate) =>
      candidate.sessionRuntime?.sessionId === sessionId ||
      (view.context.rootSessionId === sessionId && candidate.isCoordinator)
  );
  return member?.intervention ?? member?.sessionRuntime?.intervention ?? null;
}

/**
 * Derives intervention state from the canonical run view. The old hook polled
 * a second endpoint every 2.5 seconds even though this data is already part of
 * each run-view member projection.
 */
export function useAgentOrgIntervention(
  sessionId: string | null,
  runView: AgentOrgRunView | null,
  refreshRunView: () => Promise<void>
) {
  const [actionState, setActionState] =
    useState<AgentOrgInterventionActionState>({
      sessionId: null,
      error: null,
      returning: false,
      stopping: false,
    });
  const returnRequestRef = useRef<{
    receiptId: string;
    requestId: string;
  } | null>(null);
  const eligible =
    !!sessionId &&
    !isCliSession(sessionId) &&
    !isImportedHistorySession(sessionId);
  const intervention = interventionForSession(runView, sessionId);

  const returnToWork = useCallback(async () => {
    if (!eligible || !sessionId) return null;
    const currentSessionId = sessionId;
    setActionState({
      sessionId: currentSessionId,
      error: null,
      returning: true,
      stopping: false,
    });
    try {
      if (!intervention) return null;
      if (
        returnRequestRef.current?.receiptId !==
        intervention.interventionReceiptId
      ) {
        returnRequestRef.current = {
          receiptId: intervention.interventionReceiptId,
          requestId: crypto.randomUUID(),
        };
      }
      const result = await returnAgentOrgSessionToWork(
        currentSessionId,
        intervention.interventionReceiptId,
        returnRequestRef.current.requestId
      );
      // The durable Return has already succeeded. Do not hold its exact
      // business result (and the one-shot Toast that consumes it) behind a
      // follow-up projection refresh: a busy continuation may replace the
      // Member view before that refresh settles. Native invalidation already
      // reconciles the view; this remains one additional bounded refresh.
      void refreshRunView().catch(() => {});
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setActionState((previous) =>
        previous.sessionId === currentSessionId
          ? { ...previous, error: message }
          : previous
      );
      return null;
    } finally {
      setActionState((previous) =>
        previous.sessionId === currentSessionId
          ? { ...previous, returning: false }
          : previous
      );
    }
  }, [eligible, intervention, refreshRunView, sessionId]);

  const stopUserDirectedWork = useCallback(async () => {
    if (!eligible || !sessionId) return false;
    const currentSessionId = sessionId;
    setActionState({
      sessionId: currentSessionId,
      error: null,
      returning: false,
      stopping: true,
    });
    try {
      const cancelled = await cancelSession(
        currentSessionId,
        CANCEL_REASON.USER_STOP
      );
      await refreshRunView();
      return cancelled;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setActionState((previous) =>
        previous.sessionId === currentSessionId
          ? { ...previous, error: message }
          : previous
      );
      return false;
    } finally {
      setActionState((previous) =>
        previous.sessionId === currentSessionId
          ? { ...previous, stopping: false }
          : previous
      );
    }
  }, [eligible, refreshRunView, sessionId]);

  return useMemo(() => {
    if (!eligible || !sessionId || !runView) return EMPTY_RESULT;
    const stateMatches = actionState.sessionId === sessionId;
    return {
      intervention,
      error: stateMatches ? actionState.error : null,
      returning: stateMatches ? actionState.returning : false,
      stopping: stateMatches ? actionState.stopping : false,
      refresh: refreshRunView,
      returnToWork,
      stopUserDirectedWork,
    };
  }, [
    actionState,
    eligible,
    intervention,
    refreshRunView,
    returnToWork,
    runView,
    sessionId,
    stopUserDirectedWork,
  ]);
}
