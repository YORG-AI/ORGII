import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  clearSessionLoadErrorAtom,
  isExploringAtom,
  loadErrorAtom,
  loadStatusAtom,
  sessionHydrationByIdAtom,
  triggerSessionReloadAtom,
} from "@src/engines/SessionCore";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { useAgentWorkingRef } from "@src/hooks/streaming";
import { activeSessionIdAtom, sessionByIdAtom } from "@src/store/session";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRolledBackAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import { useSessionTranscriptRuntime } from "../SessionTranscriptRuntimeContext";
import { useReplyQuestion } from "../hooks/useReplyQuestion";
import type { SessionTranscriptPlatformState } from "./sessionTranscriptPlatform.types";

/** Desktop adapter for the shared transcript. Webpack replaces this module in
 * the browser entry with the Cloud/context-backed implementation. */
export function useSessionTranscriptPlatform(
  sessionId: string | null
): SessionTranscriptPlatformState {
  const runtime = useSessionTranscriptRuntime();
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const rawCursorIdeTurnSummaries = useAtomValue(
    cursorIdeTurnSummariesAtomFamily(sessionId ?? "")
  );
  const desktopIsAgentWorking = useAtomValue(isSessionActiveAtom);
  const desktopIsAgentWorkingRef = useAgentWorkingRef();
  const desktopIsExploring = useAtomValue(isExploringAtom);
  const desktopLoadStatus = useAtomValue(loadStatusAtom);
  const desktopLoadError = useAtomValue(loadErrorAtom);
  const isPendingCancel = useAtomValue(isPendingCancelAtom);
  const isRolledBack = useAtomValue(sessionRolledBackAtom);
  const hydration = useAtomValue(sessionHydrationByIdAtom(sessionId ?? ""));
  const { handleReplyQuestion, handleIgnoreQuestion } = useReplyQuestion();

  const clearSessionLoadError = useSetAtom(clearSessionLoadErrorAtom);
  const setLoadStatus = useSetAtom(loadStatusAtom);
  const triggerSessionReload = useSetAtom(triggerSessionReloadAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  const desktopReload = useCallback(() => {
    if (!sessionId) return;
    eventStoreProxy.evictSession(sessionId);
    clearSessionLoadError();
    setLoadStatus("loading");
    setActiveSessionId(sessionId);
    triggerSessionReload(sessionId);
  }, [
    clearSessionLoadError,
    sessionId,
    setActiveSessionId,
    setLoadStatus,
    triggerSessionReload,
  ]);

  const runtimeAgentWorkingRef = useRef(runtime?.isAgentWorking ?? false);
  useEffect(() => {
    runtimeAgentWorkingRef.current = runtime?.isAgentWorking ?? false;
  }, [runtime?.isAgentWorking]);

  const isCursorIde = sessionId ? isCursorIdeSession(sessionId) : false;

  return {
    session,
    cursorIdeTurnSummaries: isCursorIde ? rawCursorIdeTurnSummaries : [],
    isCursorIde,
    isAgentWorking: runtime?.isAgentWorking ?? desktopIsAgentWorking,
    isAgentWorkingRef: runtime
      ? runtimeAgentWorkingRef
      : desktopIsAgentWorkingRef,
    isExploring: runtime?.isExploring ?? desktopIsExploring,
    loadStatus: runtime?.loadStatus ?? desktopLoadStatus,
    loadError: runtime?.loadError ?? desktopLoadError,
    isPendingCancel: runtime ? false : isPendingCancel,
    isRolledBack: runtime ? false : isRolledBack,
    isHydrating: runtime ? false : (hydration?.count ?? 0) > 0,
    onReload: runtime?.onReload ?? desktopReload,
    onReplyQuestion: runtime?.onReplyQuestion ?? handleReplyQuestion,
    onIgnoreQuestion: runtime?.onIgnoreQuestion ?? handleIgnoreQuestion,
    capabilities: {
      canvasInline: runtime?.capabilities?.canvasInline !== false,
      turnMetadata: runtime?.capabilities?.turnMetadata !== false,
    },
  };
}
