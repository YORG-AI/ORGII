/**
 * useSyncGlobalTabs
 *
 * Syncs local context state with global tabs state.
 * Use this hook in your context providers to automatically track tabs globally.
 *
 * These hooks sync local state (from contexts like BrowserContext, TerminalContext)
 * to navigationSidebarTabsAtom for consumers of the shared tab state.
 *
 * CRITICAL: Uses refs to prevent infinite loops. The sync is ONE-WAY:
 * local context state -> global tabs state
 */
import { useEffect, useRef } from "react";

import { useGlobalBrowserTabs, useGlobalTerminalTabs } from "./useGlobalTabs";

/**
 * Sync browser tabs to global state
 *
 * Used by: BrowserContext
 *
 * ONE-WAY sync: BrowserContext sessions -> navigationSidebarTabsAtom.browser
 * This hook should NOT cause re-renders when navigationSidebarTabsAtom changes.
 */
export const useSyncBrowserTabs = (
  sessions: Array<{
    id: string;
    title: string;
    url?: string;
    incognito?: boolean;
  }>,
  activeSessionId: string
) => {
  const {
    activeBrowser,
    addBrowserTab,
    setActiveBrowserTab,
    removeBrowserTab,
    updateBrowserTab,
  } = useGlobalBrowserTabs();

  // Track synced session IDs to detect additions/removals
  const syncedSessionIdsRef = useRef<Set<string>>(new Set());
  // Track synced session data to detect updates
  const syncedSessionDataRef = useRef<
    Map<string, { title: string; url?: string }>
  >(new Map());

  // Sync sessions to global state (one-way: local -> global)
  useEffect(() => {
    const currentSessionIds = new Set(sessions.map((session) => session.id));
    const syncedIds = syncedSessionIdsRef.current;
    const syncedData = syncedSessionDataRef.current;

    // Add new sessions
    sessions.forEach((session) => {
      if (!syncedIds.has(session.id)) {
        addBrowserTab({
          id: session.id,
          title: session.title,
          url: session.url,
          isActive: session.id === activeSessionId,
          isPrivate: session.incognito,
        });
        syncedIds.add(session.id);
        syncedData.set(session.id, { title: session.title, url: session.url });
      } else {
        // Check if we need to update existing tab
        const prevData = syncedData.get(session.id);
        if (
          prevData &&
          (prevData.title !== session.title || prevData.url !== session.url)
        ) {
          updateBrowserTab({
            id: session.id,
            title: session.title,
            url: session.url,
          });
          syncedData.set(session.id, {
            title: session.title,
            url: session.url,
          });
        }
      }
    });

    // Remove sessions that no longer exist
    syncedIds.forEach((id) => {
      if (!currentSessionIds.has(id)) {
        removeBrowserTab(id);
        syncedIds.delete(id);
        syncedData.delete(id);
      }
    });
  }, [
    sessions,
    activeSessionId,
    addBrowserTab,
    removeBrowserTab,
    updateBrowserTab,
  ]);

  // Sync active session (one-way: local -> global)
  // Use activeBrowser from hook instead of searching through browserTabs
  useEffect(() => {
    if (activeSessionId && activeBrowser?.id !== activeSessionId) {
      setActiveBrowserTab(activeSessionId);
    }
  }, [activeSessionId, activeBrowser?.id, setActiveBrowserTab]);
};

/**
 * Sync terminal sessions to global state
 *
 * Used by: TerminalContext
 *
 * ONE-WAY sync: TerminalContext sessions -> navigationSidebarTabsAtom.terminal
 */
export const useSyncTerminalSessions = (
  sessions: Array<{ id: string; name: string; isActive?: boolean }>,
  activeSessionId: string
) => {
  const {
    activeTerminal,
    addTerminalSession,
    setActiveTerminalSession,
    removeTerminalSession,
  } = useGlobalTerminalTabs();

  // Track synced session IDs to detect additions/removals
  const syncedSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentSessionIds = new Set(sessions.map((session) => session.id));
    const syncedIds = syncedSessionIdsRef.current;

    // Add new sessions
    sessions.forEach((session) => {
      if (!syncedIds.has(session.id)) {
        addTerminalSession({
          id: session.id,
          name: session.name,
          isActive: session.id === activeSessionId,
        });
        syncedIds.add(session.id);
      }
    });

    // Remove sessions that no longer exist
    syncedIds.forEach((id) => {
      if (!currentSessionIds.has(id)) {
        removeTerminalSession(id);
        syncedIds.delete(id);
      }
    });
  }, [sessions, activeSessionId, addTerminalSession, removeTerminalSession]);

  useEffect(() => {
    if (activeSessionId && activeTerminal?.id !== activeSessionId) {
      setActiveTerminalSession(activeSessionId);
    }
  }, [activeSessionId, activeTerminal?.id, setActiveTerminalSession]);
};
