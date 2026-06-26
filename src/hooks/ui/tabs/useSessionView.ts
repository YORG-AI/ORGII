/**
 * useSessionView Hook
 *
 * Manages session view state. Session identity is atom-driven, not URL-driven.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  type SessionViewState,
  closeSessionAtom,
  hasActiveSessionAtom,
  jumpToSessionAtom,
  sessionViewAtom,
  updateSessionMetadataAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  chatPanelMaximizedAtom,
  chatPanelNavigateAtom,
} from "@src/store/ui/chatPanelAtom";

// ============================================
// Types
// ============================================

export interface UseSessionViewReturn {
  // State
  state: SessionViewState;
  activeSessionId: string | null;
  hasActiveSession: boolean;
  sessionName: string | undefined;
  repoPath: string | undefined;

  // Session Operations
  openSession: (
    sessionId: string,
    sessionName?: string,
    repoPath?: string
  ) => void;
  closeSession: () => void;
  updateMetadata: (updates: {
    sessionName?: string;
    repoPath?: string;
  }) => void;
}

// ============================================
// Hook Implementation
// ============================================

export function useSessionView(): UseSessionViewReturn {
  const navigate = useNavigate();

  const [state] = useAtom(sessionViewAtom);
  // `useSessionView` describes WorkStation's selection — it's used by
  // sidebar / session-list consumers that want to
  // know "which session does WorkStation have open?". Read the
  // memory atom, not the (transient) pipeline atom.
  const [activeSessionId] = useAtom(workstationActiveSessionIdAtom);
  const hasActiveSession = useAtomValue(hasActiveSessionAtom);

  const jumpToSession = useSetAtom(jumpToSessionAtom);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const closeSessionAction = useSetAtom(closeSessionAtom);
  const updateMetadataAction = useSetAtom(updateSessionMetadataAtom);

  const openSession = useCallback(
    (sessionId: string, sessionName?: string, repoPath?: string): void => {
      // Single atom write — `jumpToSessionAtom` accepts the rich
      // payload form so we don't double-flush sessionViewAtom.
      setChatPanelMaximized(false);
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      jumpToSession({ sessionId, sessionName, repoPath });
      navigate(ROUTES.workStation.base.path);
    },
    [jumpToSession, navigate, navigateChatPanel, setChatPanelMaximized]
  );

  const closeSession = useCallback((): void => {
    setChatPanelMaximized(false);
    navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
    closeSessionAction();
    navigate(ROUTES.workStation.base.path);
  }, [closeSessionAction, navigate, navigateChatPanel, setChatPanelMaximized]);

  const updateMetadata = useCallback(
    (updates: { sessionName?: string; repoPath?: string }): void => {
      updateMetadataAction(updates);
    },
    [updateMetadataAction]
  );

  return useMemo(
    () => ({
      state,
      activeSessionId,
      hasActiveSession,
      sessionName: state.sessionName,
      repoPath: state.repoPath,
      openSession,
      closeSession,
      updateMetadata,
    }),
    [
      state,
      activeSessionId,
      hasActiveSession,
      openSession,
      closeSession,
      updateMetadata,
    ]
  );
}

export default useSessionView;
