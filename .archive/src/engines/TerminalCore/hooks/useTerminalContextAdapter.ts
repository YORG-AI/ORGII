/**
 * useTerminalContextAdapter
 *
 * Adapter hook to convert TerminalContext to UseTerminalStateReturn interface.
 * Allows TerminalCore to work seamlessly with the existing TerminalContext.
 */
import { useMemo } from "react";

import { useTerminalContext } from "@src/contexts/workstation";

import type { UseTerminalStateReturn } from "../types";

/**
 * Adapter hook that converts TerminalContext to UseTerminalStateReturn
 */
export function useTerminalContextAdapter(): UseTerminalStateReturn {
  const {
    sessions,
    activeSessionId,
    initializedSessions,
    handleSessionClick,
    handleAddSession,
    handleCloseSession,
  } = useTerminalContext();

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return useMemo<UseTerminalStateReturn>(
    () => ({
      sessions,
      activeSessionId,
      activeSession,
      initializedSessions,
      addSession: () => {
        handleAddSession();
        // Return the next ID (will be max + 1)
        const maxId = sessions.reduce((max, session) => {
          const sessionIdNum = Number.parseInt(session.id, 10);
          return Number.isNaN(sessionIdNum) ? max : Math.max(max, sessionIdNum);
        }, 0);
        return String(maxId + 1);
      },
      closeSession: (sessionId: string) => {
        handleCloseSession(sessionId);
      },
      setActiveSession: handleSessionClick,
      markSessionInitialized: () => {
        // Context manages initialization internally, no-op here
      },
      updateSessionInfo: () => {
        // Context does not track PID/shell/cwd, no-op here
      },
      renameSession: () => {
        // Context does not support rename, no-op here
      },
    }),
    [
      sessions,
      activeSessionId,
      activeSession,
      initializedSessions,
      handleAddSession,
      handleCloseSession,
      handleSessionClick,
    ]
  );
}
