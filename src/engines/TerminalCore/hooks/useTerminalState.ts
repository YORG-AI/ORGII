/**
 * useTerminalState Hook
 *
 * Unified terminal state management using Jotai atoms.
 * Both this hook and TerminalService operate on the same state.
 *
 * Performance optimizations:
 * - Fine-grained atoms prevent unnecessary re-renders
 * - useAtomValue for read-only subscriptions
 * - useSetAtom for write-only operations (no re-render on state change)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  activeTerminalIdAtom,
  closeTerminalSessionAtom,
  editorActiveTerminalSessionAtom,
  editorAddTerminalSessionAtom,
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  renameTerminalSessionAtom,
  setActiveTerminalAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";

import type { AddSessionOptions, UseTerminalStateReturn } from "../types";

/**
 * Core terminal state hook
 *
 * No options needed - state is managed centrally via atoms.
 * Initial state comes from localStorage persistence in the store.
 */
export function useTerminalState(): UseTerminalStateReturn {
  // ============================================
  // Read state via atoms (fine-grained subscriptions)
  // ============================================

  const sessions = useAtomValue(terminalSessionsAtom);
  const activeSessionId = useAtomValue(activeTerminalIdAtom);
  const activeSession = useAtomValue(editorActiveTerminalSessionAtom);
  const initializedSessionIds = useAtomValue(initializedTerminalIdsAtom);

  // ============================================
  // Write actions via atoms (won't cause re-renders)
  // ============================================

  const dispatchAddSession = useSetAtom(editorAddTerminalSessionAtom);
  const dispatchCloseSession = useSetAtom(closeTerminalSessionAtom);
  const dispatchSetActive = useSetAtom(setActiveTerminalAtom);
  const dispatchMarkInitialized = useSetAtom(markTerminalInitializedAtom);
  const dispatchUpdateInfo = useSetAtom(updateTerminalSessionInfoAtom);
  const dispatchRename = useSetAtom(renameTerminalSessionAtom);

  // ============================================
  // Stable callback wrappers
  // ============================================

  const addSession = useCallback(
    (options?: AddSessionOptions): string => {
      return dispatchAddSession(options);
    },
    [dispatchAddSession]
  );

  const closeSession = useCallback(
    (sessionId: string): void => {
      dispatchCloseSession(sessionId);
    },
    [dispatchCloseSession]
  );

  const setActiveSession = useCallback(
    (sessionId: string): void => {
      dispatchSetActive(sessionId);
    },
    [dispatchSetActive]
  );

  const markSessionInitialized = useCallback(
    (sessionId: string): void => {
      dispatchMarkInitialized(sessionId);
    },
    [dispatchMarkInitialized]
  );

  const updateSessionInfo: UseTerminalStateReturn["updateSessionInfo"] =
    useCallback(
      (sessionId, info) => {
        dispatchUpdateInfo({ sessionId, info });
      },
      [dispatchUpdateInfo]
    );

  const renameSession = useCallback(
    (sessionId: string, title: string): void => {
      dispatchRename({ sessionId, title });
    },
    [dispatchRename]
  );

  // ============================================
  // Memoized return object
  // ============================================

  return useMemo(
    () => ({
      sessions,
      activeSessionId,
      activeSession,
      initializedSessions: initializedSessionIds,
      addSession,
      closeSession,
      setActiveSession,
      markSessionInitialized,
      updateSessionInfo,
      renameSession,
    }),
    [
      sessions,
      activeSessionId,
      activeSession,
      initializedSessionIds,
      addSession,
      closeSession,
      setActiveSession,
      markSessionInitialized,
      updateSessionInfo,
      renameSession,
    ]
  );
}
