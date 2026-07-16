import { useCallback, useMemo, useState } from "react";

import {
  type AgentOrgMemberIntervention,
  getAgentOrgSessionInterventionState,
  returnAgentOrgSessionToWork,
} from "@src/api/tauri/agent";
import { useVisiblePolling } from "@src/hooks/async";
import {
  isCliSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

const AGENT_ORG_INTERVENTION_REFRESH_MS = 2500;
const interventionRequests = new Map<
  string,
  ReturnType<typeof getAgentOrgSessionInterventionState>
>();

function fetchInterventionShared(sessionId: string) {
  const existing = interventionRequests.get(sessionId);
  if (existing) return existing;

  const request = getAgentOrgSessionInterventionState(sessionId).finally(() => {
    if (interventionRequests.get(sessionId) === request) {
      interventionRequests.delete(sessionId);
    }
  });
  interventionRequests.set(sessionId, request);
  return request;
}

const EMPTY_RESULT = {
  intervention: null as AgentOrgMemberIntervention | null,
  error: null as string | null,
  returning: false,
  refresh: async () => {},
  returnToWork: async () => false,
} as const;

type AbortableRefresh = (signal?: AbortSignal) => Promise<void>;

interface AgentOrgInterventionState {
  sessionId: string | null;
  intervention: AgentOrgMemberIntervention | null;
  error: string | null;
  returning: boolean;
}

export function useAgentOrgIntervention(sessionId: string | null) {
  const [state, setState] = useState<AgentOrgInterventionState>({
    sessionId: null,
    intervention: null,
    error: null,
    returning: false,
  });

  const isPollingEnabled =
    !!sessionId &&
    !isCliSession(sessionId) &&
    !isImportedHistorySession(sessionId);

  const refresh = useCallback<AbortableRefresh>(
    async (signal) => {
      if (!isPollingEnabled || !sessionId) return;
      const currentSessionId = sessionId;
      try {
        const result = await fetchInterventionShared(currentSessionId);
        if (signal?.aborted) return;
        setState((previous) => ({
          sessionId: currentSessionId,
          intervention: result.intervention ?? null,
          error: null,
          returning:
            previous.sessionId === currentSessionId
              ? previous.returning
              : false,
        }));
      } catch (error: unknown) {
        if (signal?.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          sessionId: currentSessionId,
          intervention:
            previous.sessionId === currentSessionId
              ? previous.intervention
              : null,
          error: message,
          returning:
            previous.sessionId === currentSessionId
              ? previous.returning
              : false,
        }));
      }
    },
    [isPollingEnabled, sessionId]
  );

  useVisiblePolling({
    enabled: isPollingEnabled,
    intervalMs: AGENT_ORG_INTERVENTION_REFRESH_MS,
    poll: refresh,
  });

  const returnToWork = useCallback(async () => {
    if (!isPollingEnabled || !sessionId) return false;
    const currentSessionId = sessionId;
    setState((previous) => ({
      ...previous,
      sessionId: currentSessionId,
      returning: true,
    }));
    try {
      const changed = await returnAgentOrgSessionToWork(currentSessionId);
      await refresh();
      return changed;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setState((previous) => ({
        ...previous,
        sessionId: currentSessionId,
        error: message,
      }));
      return false;
    } finally {
      setState((previous) => ({
        ...previous,
        returning: false,
      }));
    }
  }, [isPollingEnabled, refresh, sessionId]);

  return useMemo(() => {
    if (!isPollingEnabled || !sessionId || state.sessionId !== sessionId) {
      return EMPTY_RESULT;
    }
    return {
      intervention: state.intervention,
      error: state.error,
      returning: state.returning,
      refresh,
      returnToWork,
    };
  }, [isPollingEnabled, refresh, returnToWork, sessionId, state]);
}
