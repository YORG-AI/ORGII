/**
 * useSessionSync — Unified session sync hook
 *
 * Unified session sync hook replacing three divergent per-agent hooks.
 * Mounted ONCE in SessionSyncProvider (inside AppLayout).
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  clearSessionLoadErrorAtom,
  eventsAtom,
  failSessionLoadAtom,
  loadSessionAtom,
  loadStatusAtom,
  streamingDeltaContentAtom,
} from "@src/engines/SessionCore";
import { createLogger } from "@src/hooks/logger";
import {
  canvasPreviewAtom,
  clearCanvasOnSessionSwitch,
  dismissCanvasForSession,
} from "@src/store/session/canvasPreviewAtom";
import {
  type CliSessionStatus,
  isPendingCancelAtom,
  sessionContextBreakdownAtom,
  sessionContextTokensAtom,
  sessionContextUsageAtom,
  sessionRolledBackAtom,
  sessionRuntimeErrorAtom,
  setSessionRuntimeStatusAtom,
  streamRetryStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  ACTIVE_EXTERNAL_SESSION_REFRESH_INTERVAL_MS,
  activeExternalSessionRefreshFrequencyAtom,
} from "@src/store/session/dataSourceConfigAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import { wpReadOnlyAtom } from "@src/store/ui/chatPanelAtom";

import "./adapters";
import { useExternalHistoryAutoRefresh } from "./externalHistoryAutoRefresh";
import { scheduleNativeTranscriptReconcile } from "./nativeTranscriptReconcile";
import {
  resetEmptySessionRefs,
  runSessionSwitchEffect,
} from "./sessionSwitchEffectRunner";
import { routeSessionChannelEvent } from "./sessionSyncChannel";
import { isDuplicateSessionSyncInvocation } from "./sessionSyncDerivedState";
import {
  useEventStoreCacheSync,
  useSessionSyncCleanup,
} from "./sessionSyncLifecycle";
import type { SessionSyncRefs } from "./sessionSyncTypes";
import {
  type SessionAdapter,
  type SessionEventHandler,
  getAdapterForSession,
} from "./types";
import { useSessionChannel } from "./useSessionChannel";

const logger = createLogger("SessionSync");

/**
 * Unified session sync hook.
 *
 * @param sessionId - Active session ID (null = idle, no subscription)
 * @param reloadEpoch - Monotonic signal that forces a reload for the same session.
 */
export function useSessionSync(
  sessionId: string | null,
  reloadEpoch = 0
): void {
  const dispatchLoadSession = useSetAtom(loadSessionAtom);
  const clearSessionLoadError = useSetAtom(clearSessionLoadErrorAtom);
  const failSessionLoad = useSetAtom(failSessionLoadAtom);
  const setLoadStatus = useSetAtom(loadStatusAtom);
  const setEvents = useSetAtom(eventsAtom);
  const setWpReadOnly = useSetAtom(wpReadOnlyAtom);
  const setSessionContextTokens = useSetAtom(sessionContextTokensAtom);
  const setSessionContextUsage = useSetAtom(sessionContextUsageAtom);
  const setSessionContextBreakdown = useSetAtom(sessionContextBreakdownAtom);
  const setSessionRuntimeStatusAtomValue = useSetAtom(
    setSessionRuntimeStatusAtom
  );
  const setSessionRuntimeStatus = useCallback(
    (status: CliSessionStatus) => {
      // Bound to the hook's current sessionId: stale adapter callbacks from a
      // previous session carry the old id and are dropped by the setter's
      // session gate instead of clobbering the visible session's status.
      if (!sessionId) return;
      setSessionRuntimeStatusAtomValue({ sessionId, status, source: "sync" });
    },
    [sessionId, setSessionRuntimeStatusAtomValue]
  );
  const setSessionRuntimeError = useSetAtom(sessionRuntimeErrorAtom);
  const setPendingCancel = useSetAtom(isPendingCancelAtom);
  const setSessionRolledBack = useSetAtom(sessionRolledBackAtom);
  const setStreamRetryStatus = useSetAtom(streamRetryStatusAtom);
  const setStreamingDeltaContent = useSetAtom(streamingDeltaContentAtom);
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
  const setCanvasPreview = useSetAtom(canvasPreviewAtom);
  const clearCanvasPreviewOnSessionSwitch = useCallback(
    (leavingSessionId: string | null, enteringSessionId: string) => {
      setCanvasPreview((prev) =>
        clearCanvasOnSessionSwitch(prev, leavingSessionId, enteringSessionId)
      );
    },
    [setCanvasPreview]
  );
  const activeExternalSessionRefreshFrequency = useAtomValue(
    activeExternalSessionRefreshFrequencyAtom
  );
  const dismissCanvasAtNewTurn = useCallback(
    (sid: string) => {
      setCanvasPreview((prev) => {
        return dismissCanvasForSession(prev, sid);
      });
    },
    [setCanvasPreview]
  );

  const adapterRef = useRef<SessionAdapter | null>(null);
  const handlerRef = useRef<SessionEventHandler | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevReloadEpochRef = useRef<number>(0);
  const liveSessionIdRef = useRef<string | null>(null);

  const refs = useMemo<SessionSyncRefs>(
    () => ({
      adapterRef,
      handlerRef,
      prevSessionIdRef,
      prevReloadEpochRef,
      liveSessionIdRef,
    }),
    []
  );

  const switchActions = useMemo(
    () => ({
      clearSessionLoadError,
      setWpReadOnly,
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionContextBreakdown,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
      setPendingCancel,
      setStreamRetryStatus,
      clearCanvasPreviewOnSessionSwitch,
    }),
    [
      clearSessionLoadError,
      setWpReadOnly,
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionContextBreakdown,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
      setPendingCancel,
      setStreamRetryStatus,
      clearCanvasPreviewOnSessionSwitch,
    ]
  );

  const loadActions = useMemo(
    () => ({
      dispatchLoadSession,
      failSessionLoad,
      setLoadStatus,
      setEvents,
      setWpReadOnly,
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
    }),
    [
      dispatchLoadSession,
      failSessionLoad,
      setLoadStatus,
      setEvents,
      setWpReadOnly,
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
    ]
  );

  const scheduleReconcile = useCallback(
    (sid: string) => {
      scheduleNativeTranscriptReconcile(sid, {
        loadHistory: async (target) => {
          const adapter = getAdapterForSession(target);
          if (!adapter) return [];
          const controller = new AbortController();
          return adapter.loadHistory(target, controller.signal);
        },
        dispatchLoadSession,
        isSessionLive: (target) => liveSessionIdRef.current === target,
      });
    },
    [dispatchLoadSession]
  );

  const handlerActions = useMemo(
    () => ({
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionContextBreakdown,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
      setPendingCancel,
      setSessionRolledBack,
      setStreamingDeltaContent,
      dismissCanvasAtNewTurn,
      scheduleNativeTranscriptReconcile: scheduleReconcile,
    }),
    [
      setSessionContextTokens,
      setSessionContextUsage,
      setSessionContextBreakdown,
      setSessionRuntimeStatus,
      setSessionRuntimeError,
      setPendingCancel,
      setSessionRolledBack,
      setStreamingDeltaContent,
      dismissCanvasAtNewTurn,
      scheduleReconcile,
    ]
  );

  const logStatusChange = useCallback(
    (status: string, errorMessage?: string) => {
      logger.debug(
        `status → ${status}${errorMessage ? ` (${errorMessage})` : ""} for ${sessionId}`
      );
    },
    [sessionId]
  );

  useEffect(() => {
    if (sessionId) {
      adapterRef.current = getAdapterForSession(sessionId) ?? null;
    } else {
      adapterRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    liveSessionIdRef.current = sessionId;

    if (!sessionId) {
      resetEmptySessionRefs(refs);
      return;
    }

    if (
      isDuplicateSessionSyncInvocation(
        sessionId,
        reloadEpoch,
        prevSessionIdRef.current,
        prevReloadEpochRef.current
      )
    ) {
      return;
    }

    logger.info(`pipeline switching to session ${sessionId}`);
    return runSessionSwitchEffect({
      sessionId,
      reloadEpoch,
      refs,
      switchActions,
      loadActions,
      handlerActions,
      setPendingPlanApprovals,
      logStatusChange,
      logger,
    });
  }, [
    sessionId,
    reloadEpoch,
    refs,
    switchActions,
    loadActions,
    handlerActions,
    setPendingPlanApprovals,
    logStatusChange,
  ]);

  const handleChannelEvent = useCallback(
    (raw: string) => routeSessionChannelEvent(raw, refs, logger),
    [refs]
  );
  useSessionChannel(sessionId, handleChannelEvent);

  useExternalHistoryAutoRefresh({
    sessionId,
    intervalMs:
      ACTIVE_EXTERNAL_SESSION_REFRESH_INTERVAL_MS[
        activeExternalSessionRefreshFrequency
      ],
    dispatchLoadSession,
  });

  useEventStoreCacheSync(sessionId);
  useSessionSyncCleanup(refs);
}
