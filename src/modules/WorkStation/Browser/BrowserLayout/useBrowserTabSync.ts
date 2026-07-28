/**
 * useBrowserTabSync
 *
 * Bidirectional synchronisation between the live browser sessions held in
 * BrowserContext and the WorkStation tab strip stored in browserTabsAtom.
 *
 * Three effects:
 *   1. sessions → tabs  (new/removed sessions drive tab creation/removal)
 *   2. tab ↔ session    (active tab and active session stay aligned)
 *   3. tabs → sessions  (closed tabs tear down the live session)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { BrowserSession } from "@src/engines/BrowserCore/types";
import {
  browserTabsAtom,
  createBrowserSessionTab,
  createBrowserSessionTabId,
  extractSessionId,
  getBrowserSessionDisplayTitle,
  isBrowserSessionTab,
  sharedBrowserTabsAtom,
  translatePlaceholderBrowserSessionTitle,
} from "@src/store/workstation/browser/tabs";

interface BrowserStateRef {
  sessions: BrowserSession[];
  activeSessionId: string;
  setActiveSession: (id: string) => void;
  closeSession: (id: string) => void;
  addSession: (url?: string) => string;
}

interface UseBrowserTabSyncOptions {
  isActive: boolean;
  browserState: BrowserStateRef;
  /** Mutable ref to prevent stale closures on the teardown side */
  browserStateRef: MutableRefObject<BrowserStateRef>;
  /** IDs of sessions currently being torn down (avoids double-close) */
  closingSessionIdsRef: MutableRefObject<Set<string>>;
}

export function useBrowserTabSync({
  isActive,
  browserState,
  browserStateRef,
  closingSessionIdsRef,
}: UseBrowserTabSyncOptions): void {
  const { t } = useTranslation();
  const setBrowserTabs = useSetAtom(browserTabsAtom);
  const browserTabsState = useAtomValue(browserTabsAtom);
  const sharedBrowserTabs = useAtomValue(sharedBrowserTabsAtom);

  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionSyncInitializedRef = useRef(false);
  const prevActiveBrowserTabIdRef = useRef<string | null>(null);
  const prevActiveBrowserSessionIdRef = useRef<string>("");
  const prevBrowserLayoutActiveRef = useRef(false);
  const prevTabbedSessionIdsRef = useRef<Set<string>>(new Set());

  // ----------------------------------------------------------------
  // Effect 1: sessions → tabs
  // ----------------------------------------------------------------
  useEffect(() => {
    const sessions = browserState.sessions;
    const activeSessionId = browserState.activeSessionId;

    const currentSessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of closingSessionIdsRef.current) {
      if (!currentSessionIds.has(sessionId)) {
        closingSessionIdsRef.current.delete(sessionId);
      }
    }
    const prevSessionIds = prevSessionIdsRef.current;
    const sessionSyncInitialized = sessionSyncInitializedRef.current;
    const newSessionIds = sessionSyncInitialized
      ? [...currentSessionIds].filter((id) => !prevSessionIds.has(id))
      : [];
    const shouldAllowBootstrapSessionTabs =
      !sessionSyncInitialized && currentSessionIds.size > 0;
    sessionSyncInitializedRef.current = true;
    prevSessionIdsRef.current = currentSessionIds;

    setBrowserTabs((prev) => {
      const otherTabs = prev.tabs.filter((tab) => !isBrowserSessionTab(tab.id));
      const currentTabbedSessionIds = new Set(
        prev.tabs
          .filter((tab) => isBrowserSessionTab(tab.id))
          .map((tab) => extractSessionId(tab.id))
      );
      const closingSessionIds = closingSessionIdsRef.current;
      const shouldBootstrapSessionTabs =
        shouldAllowBootstrapSessionTabs && currentTabbedSessionIds.size === 0;

      const sessionTabs = sessions
        .filter(
          (session) =>
            shouldBootstrapSessionTabs ||
            currentTabbedSessionIds.has(session.id) ||
            (newSessionIds.includes(session.id) &&
              !closingSessionIds.has(session.id))
        )
        .map((session) => {
          const displayTitle = getBrowserSessionDisplayTitle(session);
          return createBrowserSessionTab(
            session.id,
            translatePlaceholderBrowserSessionTitle(displayTitle, t),
            {
              url: session.url,
              incognito: session.incognito,
              isLoading: session.isLoading,
            }
          );
        });

      const newTabs = [...sessionTabs, ...otherTabs];

      let newActiveTabId = prev.activeTabId;

      if (shouldBootstrapSessionTabs && activeSessionId) {
        newActiveTabId = `browser:${activeSessionId}`;
      } else if (newSessionIds.length > 0 && activeSessionId) {
        const isNewSession = newSessionIds.includes(activeSessionId);
        if (isNewSession) {
          newActiveTabId = `browser:${activeSessionId}`;
        }
      }

      if (!newActiveTabId && newTabs.length > 0) {
        newActiveTabId = newTabs[0].id;
      }

      if (
        newActiveTabId &&
        !newTabs.find((tabItem) => tabItem.id === newActiveTabId)
      ) {
        newActiveTabId = newTabs[0]?.id ?? null;
      }

      return { tabs: newTabs, activeTabId: newActiveTabId };
    });
  }, [
    browserState.sessions,
    browserState.activeSessionId,
    closingSessionIdsRef,
    setBrowserTabs,
    t,
  ]);

  // ----------------------------------------------------------------
  // Effect 2: active tab ↔ active session alignment
  // ----------------------------------------------------------------
  useEffect(() => {
    const activeTabId = browserTabsState.activeTabId;
    const activeSessionId = browserState.activeSessionId;
    const previousTabId = prevActiveBrowserTabIdRef.current;
    const previousSessionId = prevActiveBrowserSessionIdRef.current;
    const wasActive = prevBrowserLayoutActiveRef.current;
    const becameActive = isActive && !wasActive;
    const tabChanged = activeTabId !== previousTabId;
    const sessionChanged = activeSessionId !== previousSessionId;

    prevActiveBrowserTabIdRef.current = activeTabId;
    prevActiveBrowserSessionIdRef.current = activeSessionId;
    prevBrowserLayoutActiveRef.current = isActive;

    if (!isActive) return;
    if (!becameActive && !tabChanged && !sessionChanged) return;

    if (
      !becameActive &&
      tabChanged &&
      activeTabId &&
      isBrowserSessionTab(activeTabId)
    ) {
      const tabSessionId = extractSessionId(activeTabId);
      const tabSessionExists = browserState.sessions.some(
        (session) => session.id === tabSessionId
      );
      if (tabSessionExists && tabSessionId !== activeSessionId) {
        browserState.setActiveSession(tabSessionId);
      }
      return;
    }

    if (!sessionChanged || !activeSessionId) return;
    const activeSession = browserState.sessions.find(
      (session) => session.id === activeSessionId
    );
    if (!activeSession) return;

    const nextActiveTabId = createBrowserSessionTabId(activeSessionId);
    setBrowserTabs((prev) => {
      const hasActiveSessionTab = prev.tabs.some(
        (tab) => tab.id === nextActiveTabId
      );
      const nextTabs = hasActiveSessionTab
        ? prev.tabs
        : [
            createBrowserSessionTab(
              activeSession.id,
              translatePlaceholderBrowserSessionTitle(
                getBrowserSessionDisplayTitle(activeSession),
                t
              ),
              {
                url: activeSession.url,
                incognito: activeSession.incognito,
                isLoading: activeSession.isLoading,
              }
            ),
            ...prev.tabs,
          ];

      if (hasActiveSessionTab && prev.activeTabId === nextActiveTabId) {
        return prev;
      }

      return {
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
      };
    });
  }, [
    isActive,
    browserTabsState.activeTabId,
    browserState,
    browserState.activeSessionId,
    browserState.sessions,
    setBrowserTabs,
    t,
  ]);

  // ----------------------------------------------------------------
  // Effect 3: tabs → sessions teardown
  // ----------------------------------------------------------------
  useEffect(() => {
    const tabbedSessionIds = new Set(
      sharedBrowserTabs.map((tab) => extractSessionId(tab.id))
    );
    const removed: string[] = [];
    for (const sessionId of prevTabbedSessionIdsRef.current) {
      if (!tabbedSessionIds.has(sessionId)) removed.push(sessionId);
    }
    prevTabbedSessionIdsRef.current = tabbedSessionIds;
    if (removed.length === 0) return;
    const state = browserStateRef.current;
    for (const sessionId of removed) {
      if (state.sessions.some((session) => session.id === sessionId)) {
        closingSessionIdsRef.current.add(sessionId);
        state.closeSession(sessionId);
      }
    }
  }, [sharedBrowserTabs, browserStateRef, closingSessionIdsRef]);
}
