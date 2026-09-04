/**
 * useBrowserContextAdapter
 *
 * Adapter hook to convert BrowserContext to the BrowserState interface.
 * Allows BrowserCore to work seamlessly with the existing BrowserContext.
 */
import { useMemo } from "react";

import { useBrowserContext } from "@src/contexts/workstation";

import type { BrowserState } from "../types";

/**
 * Adapter hook that converts BrowserContext to BrowserState
 */
export function useBrowserContextAdapter(): BrowserState {
  const {
    sessions,
    activeSessionId,
    handleSessionClick,
    handleAddSession,
    handleCloseSession,
    updateSession,
    forceSave,
  } = useBrowserContext();

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return useMemo<BrowserState>(
    () => ({
      sessions,
      activeSessionId,
      activeSession,
      addSession: (url?: string, incognito = false) =>
        handleAddSession(url, incognito),
      closeSession: handleCloseSession,
      setActiveSession: handleSessionClick,
      updateSession,
      forceSave,
    }),
    [
      sessions,
      activeSessionId,
      activeSession,
      handleAddSession,
      handleCloseSession,
      handleSessionClick,
      updateSession,
      forceSave,
    ]
  );
}
