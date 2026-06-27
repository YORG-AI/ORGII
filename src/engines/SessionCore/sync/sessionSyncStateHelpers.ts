import type { SetStateAction } from "react";

import { wasRecentlyOptimisticallyStarted } from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  markTurnRunning,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type {
  SessionEvent,
  SessionLoadStatus,
} from "@src/engines/SessionCore/core/types";
import { type SessionStatus, updateSessionStatus } from "@src/store/session";
import type {
  ContextBreakdown,
  ContextUsageSnapshot,
  StreamRetryStatus,
} from "@src/store/session/cliSessionStatusAtom";
import type { CliSessionStatus } from "@src/types/session/session";

import { toCliSessionStatus } from "./sessionSyncUtils";
import type {
  EventHandlerCallbacks,
  PostLoadResult,
  StreamingDeltaInfo,
} from "./types";

type LoadSessionPayload = {
  sessionId: string;
  events: SessionEvent[];
  isFromCache?: boolean;
};

export interface SessionSwitchStateActions {
  clearSessionLoadError: () => void;
  setWpReadOnly: (value: boolean) => void;
  setSessionContextTokens: (value: number) => void;
  setSessionContextUsage: (value: ContextUsageSnapshot | null) => void;
  setSessionContextBreakdown: (value: ContextBreakdown | null) => void;
  setSessionRuntimeStatus: (value: CliSessionStatus) => void;
  setSessionRuntimeError: (value: string | null) => void;
  setPendingCancel: (value: boolean) => void;
  setStreamRetryStatus: (value: StreamRetryStatus | null) => void;
}

export interface SessionLoadStateActions {
  dispatchLoadSession: (payload: LoadSessionPayload) => void;
  failSessionLoad: (message: string) => void;
  setLoadStatus: (status: SessionLoadStatus) => void;
  setEvents: (update: SetStateAction<SessionEvent[]>) => void;
  setWpReadOnly: (value: boolean) => void;
  setSessionContextTokens: (value: number) => void;
  setSessionContextUsage: (value: ContextUsageSnapshot | null) => void;
  setSessionRuntimeStatus: (value: CliSessionStatus) => void;
  setSessionRuntimeError: (value: string | null) => void;
}

export interface SessionEventHandlerStateActions {
  setSessionContextTokens: (value: number) => void;
  setSessionContextUsage: (value: ContextUsageSnapshot | null) => void;
  setSessionContextBreakdown: (value: ContextBreakdown | null) => void;
  setSessionRuntimeStatus: (value: CliSessionStatus) => void;
  setSessionRuntimeError: (value: string | null) => void;
  setPendingCancel: (value: boolean) => void;
  setSessionRolledBack: (value: boolean) => void;
  setStreamingDeltaContent: (
    update: SetStateAction<Map<string, string>>
  ) => void;
}

const TERMINAL_HANDLER_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
]);

const RUNNING_HANDLER_STATUSES = new Set<string>([
  "running",
  "installing",
  "waiting_for_user",
  "waiting_for_funds",
]);
export function resetSessionSwitchState(
  actions: SessionSwitchStateActions,
  sessionId?: string
): void {
  actions.setWpReadOnly(false);
  actions.clearSessionLoadError();
  // Preserve an optimistic running that a just-completed launch/dispatch set
  // on the EXACT session we are switching into. The switch effect fires right
  // after `setActiveSessionId`, so an unconditional idle reset here erases the
  // launch's `running` before the provider's first event re-asserts it —
  // invisible on fast providers (Claude), a multi-second "frozen, no footer,
  // Send-not-Stop" gap on slow ones (deepseek). The marker is session-scoped
  // so a stale `running` from a different (background) session is NOT
  // preserved. The authoritative backend status event still overwrites it.
  if (!sessionId || !wasRecentlyOptimisticallyStarted(sessionId)) {
    actions.setSessionRuntimeStatus("idle");
  }
  actions.setSessionRuntimeError(null);
  actions.setPendingCancel(false);
  actions.setStreamRetryStatus(null);
  actions.setSessionContextTokens(0);
  actions.setSessionContextUsage(null);
  actions.setSessionContextBreakdown(null);
}

export function applyPostLoadResult(
  sessionId: string,
  postResult: PostLoadResult | null | undefined,
  actions: Pick<
    SessionLoadStateActions,
    | "setSessionContextTokens"
    | "setSessionContextUsage"
    | "setSessionRuntimeStatus"
    | "setSessionRuntimeError"
  >
): void {
  if (!postResult) return;
  if (postResult.contextTokens !== undefined) {
    actions.setSessionContextTokens(postResult.contextTokens);
  }
  if (postResult.contextUsage !== undefined) {
    actions.setSessionContextUsage(postResult.contextUsage);
  }
  if (postResult.runStatus !== undefined) {
    actions.setSessionRuntimeStatus(toCliSessionStatus(postResult.runStatus));
    if (TERMINAL_HANDLER_STATUSES.has(postResult.runStatus)) {
      markTurnTerminal(sessionId, toTurnTerminalStatus(postResult.runStatus));
    } else if (RUNNING_HANDLER_STATUSES.has(postResult.runStatus)) {
      // Restored a session whose turn is still in flight — open the turn so
      // queueing decisions see it as active until the provider terminal lands.
      markTurnRunning(sessionId);
    }
    updateSessionStatus(sessionId, postResult.runStatus as SessionStatus);
  }
  if (postResult.runError !== undefined) {
    actions.setSessionRuntimeError(postResult.runError);
  }
}

export function updateStreamingDeltaContent(
  sessionId: string,
  info: StreamingDeltaInfo,
  setStreamingDeltaContent: SessionEventHandlerStateActions["setStreamingDeltaContent"]
): void {
  if (info.isThinking) return;

  setStreamingDeltaContent((prev) => {
    const next = new Map(prev);
    if (info.isStreaming) {
      next.set(sessionId, info.content);
    } else {
      next.delete(sessionId);
    }
    return next;
  });
}

export function createSessionEventHandlerCallbacks(
  sessionId: string,
  actions: SessionEventHandlerStateActions,
  logStatusChange: (status: string, errorMessage?: string) => void
): EventHandlerCallbacks {
  return {
    onAgentComplete: (tokenUsage) => {
      eventStoreProxy.unpinSession(sessionId);
      if (tokenUsage && tokenUsage.contextTokens > 0) {
        actions.setSessionContextTokens(tokenUsage.contextTokens);
      }
      if (tokenUsage?.contextUsage) {
        actions.setSessionContextUsage(tokenUsage.contextUsage);
      }
      if (tokenUsage?.contextBreakdown) {
        actions.setSessionContextBreakdown(tokenUsage.contextBreakdown);
      }
    },
    onContextUsage: (contextUsage) => {
      actions.setSessionContextTokens(contextUsage.usedTokens);
      actions.setSessionContextUsage(contextUsage);
    },
    onStatusChange: (status, errorMessage, meta) => {
      logStatusChange(status, errorMessage);
      // Intermediate signals (e.g. per-message streaming_complete inside a
      // multi-step turn) are stream bookkeeping, NOT session-status
      // transitions. They must not touch ANY session-level state: writing
      // "completed" into the runtime-status mirror mid-turn flips the
      // composer's Stop button back to Send until the next agent:tool_call
      // re-signals "running" (the "agent still working but button not
      // stoppable" bug, 2026-06-10). The FSM guard alone was not enough —
      // the UI mirror, pendingCancel, pin state, and the session row all
      // leaked the phantom terminal.
      if (meta?.intermediate) return;
      actions.setSessionRuntimeStatus(toCliSessionStatus(status));
      if (status === "failed" && errorMessage) {
        actions.setSessionRuntimeError(errorMessage);
      }
      if (TERMINAL_HANDLER_STATUSES.has(status)) {
        // Turn finality has exactly one ingestion point: a terminal status
        // here. Intermediate signals already returned above.
        markTurnTerminal(
          sessionId,
          toTurnTerminalStatus(meta?.turnStatus ?? status)
        );
        actions.setPendingCancel(false);
        eventStoreProxy.unpinSession(sessionId);
        updateSessionStatus(sessionId, status as SessionStatus);
      }
      if (status === "running") {
        markTurnRunning(sessionId);
        actions.setSessionRuntimeError(null);
        eventStoreProxy.pinSession(sessionId);
        actions.setSessionRolledBack(false);
      }
    },
    onTokenUpdate: (tokens) => {
      actions.setSessionContextTokens(tokens);
    },
    onStreamingDelta: (info) => {
      updateStreamingDeltaContent(
        sessionId,
        info,
        actions.setStreamingDeltaContent
      );
    },
  };
}
