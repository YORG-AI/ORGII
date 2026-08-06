/**
 * Browser Context
 *
 * Provides browser session state management across Browser page and BrowserExtraSidebar
 *
 * Performance optimizations:
 * - Uses startTransition for non-urgent state updates to avoid blocking UI
 * - Stores session state in one Jotai source so every close path is coherent
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useGlobalBrowserTabs } from "@src/hooks/ui/tabs/useGlobalTabs";
import { useSyncBrowserTabs } from "@src/hooks/ui/tabs/useSyncGlobalTabs";
import {
  addBrowserSessionAtom,
  browserSessionStateAtom,
  closeBrowserSessionAtom,
  forceSaveBrowserSessionsAtom,
  setActiveBrowserSessionAtom,
  updateBrowserSessionAtom,
} from "@src/store/workstation/browser/sessionState";
import type { BrowserSession } from "@src/types/ui/tabs";

interface BrowserContextValue {
  sessions: BrowserSession[];
  activeSessionId: string;
  filterValue: string;
  setFilterValue: (value: string) => void;
  handleSessionClick: (sessionId: string) => void;
  handleAddSession: (url?: string, incognito?: boolean) => string;
  handleCloseSession: (sessionId: string) => void;
  updateSession: (sessionId: string, updates: Partial<BrowserSession>) => void;
  /** Force save sessions to localStorage (call when switching away from browser) */
  forceSave: () => void;
}

const BrowserContext = createContext<BrowserContextValue | null>(null);

export const BrowserProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { removeBrowserTab } = useGlobalBrowserTabs();
  const { sessions, activeSessionId } = useAtomValue(browserSessionStateAtom);
  const addBrowserSession = useSetAtom(addBrowserSessionAtom);
  const setActiveBrowserSession = useSetAtom(setActiveBrowserSessionAtom);
  const closeBrowserSession = useSetAtom(closeBrowserSessionAtom);
  const updateBrowserSession = useSetAtom(updateBrowserSessionAtom);
  const forceSaveBrowserSessions = useSetAtom(forceSaveBrowserSessionsAtom);

  const sessionsRef = useRef<BrowserSession[]>([]);
  const removeBrowserTabRef = useRef(removeBrowserTab);

  // Keep removeBrowserTab ref up to date
  useEffect(() => {
    removeBrowserTabRef.current = removeBrowserTab;
  }, [removeBrowserTab]);

  const [filterValue, setFilterValue] = useState<string>("");

  // Keep sessionsRef up to date
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Cleanup browser sessions from global atom when provider unmounts
  useEffect(() => {
    return () => {
      const currentSessions = sessionsRef.current;
      currentSessions.forEach((session) => {
        removeBrowserTabRef.current(session.id);
      });
    };
  }, []); // Empty deps - only run on unmount

  // ✨ Sync to global tabs state (for components that use navigationSidebarTabsAtom)
  useSyncBrowserTabs(sessions, activeSessionId);

  // Add a new session
  const handleAddSession = useCallback(
    (url?: string, incognito = false) => addBrowserSession({ url, incognito }),
    [addBrowserSession]
  );

  // Switch to a session
  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveBrowserSession(sessionId);
    },
    [setActiveBrowserSession]
  );

  // Close a session
  const handleCloseSession = useCallback(
    (sessionId: string) => {
      // Use startTransition to avoid blocking UI during state update
      startTransition(() => {
        closeBrowserSession(sessionId);
      });
    },
    [closeBrowserSession]
  );

  // Update a specific session
  const updateSession = useCallback(
    (sessionId: string, updates: Partial<BrowserSession>) => {
      // Use startTransition for non-urgent updates (like URL/title changes)
      startTransition(() => {
        updateBrowserSession({ sessionId, updates });
      });
    },
    [updateBrowserSession]
  );

  // Force save to localStorage (for when switching away from browser mode)
  const forceSave = useCallback(() => {
    forceSaveBrowserSessions();
  }, [forceSaveBrowserSessions]);

  const value = useMemo<BrowserContextValue>(
    () => ({
      sessions,
      activeSessionId,
      filterValue,
      setFilterValue,
      handleSessionClick,
      handleAddSession,
      handleCloseSession,
      updateSession,
      forceSave,
    }),
    [
      sessions,
      activeSessionId,
      filterValue,
      handleSessionClick,
      handleAddSession,
      handleCloseSession,
      updateSession,
      forceSave,
    ]
  );

  return (
    <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>
  );
};

export const useBrowserContext = () => {
  const context = useContext(BrowserContext);
  if (!context) {
    throw new Error("useBrowserContext must be used within BrowserProvider");
  }
  return context;
};

// Optional version that doesn't throw - for GlobalTabsSidebar
export const useBrowserContextOptional = () => {
  return useContext(BrowserContext);
};
