import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type AgentOrgRunStatus,
  type AgentOrgRunView,
  getAgentOrgSessionRunView,
} from "@src/api/tauri/agent";
import { useVisiblePolling } from "@src/hooks/async";
import {
  isCliSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

const AGENT_ORG_RUN_VIEW_REFRESH_MS = 2500;

/** `paused` is intentionally excluded — it is non-terminal and polling must continue. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AgentOrgRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "abandoned",
]);

function isTerminalRunStatus(status: AgentOrgRunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

const EMPTY_RESULT = { view: null, error: null } as const;

interface AgentOrgRunViewState {
  sessionId: string | null;
  view: AgentOrgRunView | null;
  error: string | null;
}

interface AgentOrgRunViewSnapshot {
  view: AgentOrgRunView;
  error: string | null;
}

type AgentOrgRunViewSubscriber = (snapshot: AgentOrgRunViewSnapshot) => void;

const runViewSubscribers = new Set<AgentOrgRunViewSubscriber>();
const runViewRequests = new Map<string, Promise<AgentOrgRunView | null>>();

function fetchRunViewShared(
  sessionId: string
): Promise<AgentOrgRunView | null> {
  const existing = runViewRequests.get(sessionId);
  if (existing) return existing;

  const request = getAgentOrgSessionRunView(sessionId)
    .then((view) => {
      if (view) publishRunViewSnapshot({ view, error: null });
      return view;
    })
    .finally(() => {
      if (runViewRequests.get(sessionId) === request) {
        runViewRequests.delete(sessionId);
      }
    });
  runViewRequests.set(sessionId, request);
  return request;
}

function runViewContainsSession(
  view: AgentOrgRunView,
  sessionId: string | null
): sessionId is string {
  if (!sessionId) return false;
  if (view.context.rootSessionId === sessionId) return true;
  return view.members.some(
    (member) => member.sessionRuntime?.sessionId === sessionId
  );
}

function publishRunViewSnapshot(snapshot: AgentOrgRunViewSnapshot) {
  for (const subscriber of runViewSubscribers) {
    subscriber(snapshot);
  }
}

export function useAgentOrgRunView(sessionId: string | null) {
  const [state, setState] = useState<AgentOrgRunViewState>({
    sessionId: null,
    view: null,
    error: null,
  });

  const isRunTerminal = isTerminalRunStatus(
    state.sessionId === sessionId ? state.view?.runStatus : undefined
  );

  const canFetchRunView =
    !!sessionId &&
    !isCliSession(sessionId) &&
    !isImportedHistorySession(sessionId);

  const isPollingEnabled = canFetchRunView && !isRunTerminal;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (
        !sessionId ||
        isCliSession(sessionId) ||
        isImportedHistorySession(sessionId)
      )
        return;

      try {
        const view = await fetchRunViewShared(sessionId);
        if (signal?.aborted) return;
        setState({ sessionId, view, error: null });
      } catch (error: unknown) {
        if (signal?.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          sessionId,
          view: previous.sessionId === sessionId ? previous.view : null,
          error: message,
        }));
      }
    },
    [sessionId]
  );

  useEffect(() => {
    if (!canFetchRunView || !sessionId) return;

    const subscriber: AgentOrgRunViewSubscriber = (snapshot) => {
      if (!runViewContainsSession(snapshot.view, sessionId)) return;
      setState({ sessionId, ...snapshot });
    };

    runViewSubscribers.add(subscriber);
    return () => {
      runViewSubscribers.delete(subscriber);
    };
  }, [canFetchRunView, sessionId]);

  useVisiblePolling({
    enabled: isPollingEnabled,
    intervalMs: AGENT_ORG_RUN_VIEW_REFRESH_MS,
    poll: refresh,
  });

  return useMemo(() => {
    if (!sessionId) {
      return { ...EMPTY_RESULT, refresh };
    }
    // Terminal runs keep their last durable snapshot but stop background
    // polling. Explicit mutations still call `refresh()` so external status
    // transitions can be reconciled without a permanent 10s timer.
    if (isRunTerminal && state.sessionId === sessionId && state.view) {
      return { view: state.view, error: state.error, refresh };
    }
    if (!isPollingEnabled) {
      return { ...EMPTY_RESULT, refresh };
    }
    // While the in-flight refresh for the freshly-switched session id is
    // landing, surface the previous session's `view` if it covers the same
    // org. Without this, jumping between members of the same org briefly
    // empties the org chip's `switchableMembers` list, which collapses the
    // chip into its non-org fallback label ("SDE's Workstation"). The org
    // membership doesn't change between members of the same org, so the
    // stale view is structurally correct for the chip until the new fetch
    // returns and refines tasks / unread counts / currentMemberId.
    if (state.sessionId !== sessionId) {
      const previousMembersIncludeTarget = state.view?.members.some(
        (member) => member.sessionRuntime?.sessionId === sessionId
      );
      if (previousMembersIncludeTarget) {
        return { view: state.view, error: state.error, refresh };
      }
      return { ...EMPTY_RESULT, refresh };
    }
    return { view: state.view, error: state.error, refresh };
  }, [isRunTerminal, isPollingEnabled, refresh, sessionId, state]);
}
