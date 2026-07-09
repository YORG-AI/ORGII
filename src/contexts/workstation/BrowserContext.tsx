/**
 * Browser Context
 *
 * Provides browser session state management across Browser page and BrowserExtraSidebar
 *
 * Performance optimizations:
 * - Uses startTransition for non-urgent state updates to avoid blocking UI
 * - Defers cascading state updates with queueMicrotask
 */
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
import { v4 as uuidv4 } from "uuid";

import { useGlobalBrowserTabs } from "@src/hooks/ui/tabs/useGlobalTabs";
import { useSyncBrowserTabs } from "@src/hooks/ui/tabs/useSyncGlobalTabs";
import {
  NEW_PRIVATE_TAB_TITLE,
  NEW_TAB_TITLE,
  createBrowserSessionTabId,
  extractSessionId,
  isBrowserSessionTab as isBrowserSessionTabId,
} from "@src/store/workstation/browser/tabs";
import { LAYOUT_STORAGE_KEY } from "@src/store/workstation/tabs/storage";
import type {
  PanelState,
  WorkStationLayoutState,
  WorkStationTab,
} from "@src/store/workstation/tabs/types";
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

// Helper function to extract title from URL
const getTitleFromUrl = (url: string): string => {
  if (!url) return NEW_TAB_TITLE;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname || NEW_TAB_TITLE;
  } catch {
    return NEW_TAB_TITLE;
  }
};

// localStorage key for fallback persistence
const BROWSER_SESSIONS_STORAGE_KEY = "browser-explorer-sessions";

function isBrowserSessionTab(tab: WorkStationTab): boolean {
  return tab.type === "browser-session" && isBrowserSessionTabId(tab.id);
}

function getBrowserSessionIdFromTab(tab: WorkStationTab): string {
  const sessionId =
    typeof tab.data.sessionId === "string" ? tab.data.sessionId : "";
  return sessionId || extractSessionId(tab.id);
}

function createBrowserSessionFromTab(
  tab: WorkStationTab
): BrowserSession | null {
  const url = typeof tab.data.url === "string" ? tab.data.url : "";
  if (!url) return null;

  const id = getBrowserSessionIdFromTab(tab);
  if (!id) return null;

  return {
    id,
    title: tab.title || getTitleFromUrl(url),
    url,
    history: [url],
    historyIndex: 0,
    historyEntries: [
      { url, title: tab.title || getTitleFromUrl(url), visitedAt: Date.now() },
    ],
    isLoading: false,
    error: null,
    incognito:
      typeof tab.data.incognito === "boolean" ? tab.data.incognito : false,
  };
}

function loadBrowserTabsFromStorage(): PanelState | null {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<WorkStationLayoutState>;
    const mainPane = parsed.mainPane;
    if (!mainPane || !Array.isArray(mainPane.tabs)) return null;
    const browserTabs = mainPane.tabs.filter(isBrowserSessionTab);
    const activeId =
      mainPane.activeTabId && isBrowserSessionTabId(mainPane.activeTabId)
        ? mainPane.activeTabId
        : null;
    return { tabs: browserTabs, activeTabId: activeId };
  } catch {
    return null;
  }
}

function persistBrowserPane(nextPane: PanelState): void {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored) as WorkStationLayoutState;
    const existing = parsed.mainPane ?? { tabs: [], activeTabId: null };
    const nonBrowserTabs = existing.tabs.filter(
      (tab) => !isBrowserSessionTab(tab)
    );
    const mergedTabs: WorkStationTab[] = [...nonBrowserTabs, ...nextPane.tabs];
    const nextLayout: WorkStationLayoutState = {
      ...parsed,
      mainPane: {
        tabs: mergedTabs,
        activeTabId: nextPane.activeTabId ?? existing.activeTabId ?? null,
      },
    };
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
  } catch {
    // ignore storage write errors
  }
}

function reconcileStoredBrowserTabs(
  sessions: BrowserSession[],
  activeSessionId: string
): { sessions: BrowserSession[]; activeSessionId: string } {
  const storedTabs = loadBrowserTabsFromStorage();
  if (!storedTabs) return { sessions, activeSessionId };

  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const reconciledTabs: WorkStationTab[] = [];

  for (const tab of storedTabs.tabs) {
    if (!isBrowserSessionTab(tab)) {
      reconciledTabs.push(tab);
      continue;
    }

    const sessionId = getBrowserSessionIdFromTab(tab);
    const existingSession = sessionById.get(sessionId);
    if (existingSession) {
      reconciledTabs.push(tab);
      continue;
    }

    const restoredSession = createBrowserSessionFromTab(tab);
    if (restoredSession) {
      sessionById.set(restoredSession.id, restoredSession);
      reconciledTabs.push(tab);
    }
  }

  const nextSessions = Array.from(sessionById.values());
  const validSessionIds = new Set(nextSessions.map((session) => session.id));
  const activeTabSessionId =
    storedTabs.activeTabId && isBrowserSessionTabId(storedTabs.activeTabId)
      ? extractSessionId(storedTabs.activeTabId)
      : null;
  const nextActiveSessionId = validSessionIds.has(activeSessionId)
    ? activeSessionId
    : activeTabSessionId && validSessionIds.has(activeTabSessionId)
      ? activeTabSessionId
      : (nextSessions[0]?.id ?? "");

  const nextActiveTabId = nextActiveSessionId
    ? createBrowserSessionTabId(nextActiveSessionId)
    : (reconciledTabs[0]?.id ?? null);

  persistBrowserPane({ tabs: reconciledTabs, activeTabId: nextActiveTabId });

  return { sessions: nextSessions, activeSessionId: nextActiveSessionId };
}

// Load sessions from localStorage
const loadFromStorage = (): {
  sessions: BrowserSession[];
  activeSessionId: string;
} | null => {
  try {
    const stored = localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const activeSessionId =
      typeof parsed?.activeSessionId === "string" ? parsed.activeSessionId : "";
    const reconciled = reconcileStoredBrowserTabs(sessions, activeSessionId);
    if (reconciled.sessions.length > 0) {
      return reconciled;
    }
  } catch {
    return null;
  }
  return null;
};

// Save sessions to localStorage
const saveToStorage = (sessions: BrowserSession[], activeSessionId: string) => {
  try {
    localStorage.setItem(
      BROWSER_SESSIONS_STORAGE_KEY,
      JSON.stringify({ sessions, activeSessionId })
    );
  } catch {
    // Ignore storage errors
  }
};

// Default initial state for browser tab - starts empty like CodeEditor
const getDefaultState = (): {
  sessions: BrowserSession[];
  activeSessionId: string;
  filterValue: string;
} => {
  // Try to load from localStorage first
  const stored = loadFromStorage();
  if (stored) {
    return { ...stored, filterValue: "" };
  }

  // No default session - user clicks + to create tabs
  return {
    sessions: [],
    activeSessionId: "",
    filterValue: "",
  };
};

export const BrowserProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { removeBrowserTab } = useGlobalBrowserTabs();

  const sessionsRef = useRef<BrowserSession[]>([]);
  const removeBrowserTabRef = useRef(removeBrowserTab);

  // Keep removeBrowserTab ref up to date
  useEffect(() => {
    removeBrowserTabRef.current = removeBrowserTab;
  }, [removeBrowserTab]);

  const [sessions, setSessions] = useState<BrowserSession[]>(
    () => getDefaultState().sessions
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => getDefaultState().activeSessionId
  );
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

  // Ensure active session exists (or is empty if no sessions)
  useEffect(() => {
    const activeSessionExists = sessions.some(
      (session) => session.id === activeSessionId
    );
    if (!activeSessionExists) {
      // Use startTransition to avoid blocking UI during correction
      startTransition(() => {
        setActiveSessionId(sessions.length > 0 ? sessions[0].id : "");
      });
    }
  }, [sessions, activeSessionId]);

  // Persist state to localStorage
  useEffect(() => {
    if (sessions.length > 0) {
      saveToStorage(sessions, activeSessionId);
    } else {
      // Clear storage when all sessions are closed
      localStorage.removeItem(BROWSER_SESSIONS_STORAGE_KEY);
    }
  }, [sessions, activeSessionId]);

  // Add a new session
  const handleAddSession = useCallback((url?: string, incognito = false) => {
    const newSessionId = uuidv4();
    const newSession: BrowserSession = {
      id: newSessionId,
      title: url
        ? getTitleFromUrl(url)
        : incognito
          ? NEW_PRIVATE_TAB_TITLE
          : NEW_TAB_TITLE,
      url: url || "",
      history: url ? [url] : [],
      historyIndex: url ? 0 : -1,
      historyEntries: url
        ? [{ url, title: getTitleFromUrl(url), visitedAt: Date.now() }]
        : [],
      isLoading: false,
      error: null,
      incognito,
    };

    // Keep session list + active id in the same update. Deferring only setSessions
    // (e.g. via startTransition) while setting activeSessionId eagerly lets the
    // "ensure active session exists" effect run with the new id before the new
    // row exists and resets focus to sessions[0].
    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(newSessionId);
    return newSessionId;
  }, []);

  // Switch to a session
  const handleSessionClick = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  // Close a session
  const handleCloseSession = useCallback(
    (sessionId: string) => {
      // Use startTransition to avoid blocking UI during state update
      startTransition(() => {
        setSessions((prev) => {
          const filtered = prev.filter((session) => session.id !== sessionId);

          // If closing the active session, activate the first remaining session (or clear if none)
          if (sessionId === activeSessionId) {
            if (filtered.length > 0) {
              setActiveSessionId(filtered[0].id);
            } else {
              setActiveSessionId("");
            }
          }

          return filtered;
        });
      });
    },
    [activeSessionId]
  );

  // Update a specific session
  const updateSession = useCallback(
    (sessionId: string, updates: Partial<BrowserSession>) => {
      // Use startTransition for non-urgent updates (like URL/title changes)
      startTransition(() => {
        setSessions((prev) => {
          return prev.map((session) =>
            session.id === sessionId ? { ...session, ...updates } : session
          );
        });
      });
    },
    []
  );

  // Force save to localStorage (for when switching away from browser mode)
  const forceSave = useCallback(() => {
    saveToStorage(sessions, activeSessionId);
  }, [sessions, activeSessionId]);

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
