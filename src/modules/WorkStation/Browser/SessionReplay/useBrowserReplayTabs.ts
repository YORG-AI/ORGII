/**
 * useBrowserReplayTabs
 *
 * Manages the three browser replay tabs (My Tabs, Agent Browser, Search/Fetch),
 * their counts, labels, active state, and session handlers.
 * Extracted from SessionReplayBrowser to keep index.tsx under 600 lines.
 */
import { useSetAtom } from "jotai";
import { Compass, Search } from "lucide-react";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { TimestampedReplayTab } from "@src/modules/WorkStation/shared";
import {
  closeBrowserTabAtom,
  createBrowserSessionTabId,
  switchBrowserTabAtom,
} from "@src/store/workstation/browser/tabs";

import type { BrowserReplaySidebarCategory } from "./BrowserSidebar";
import {
  AGENT_BROWSER_TAB_ID,
  BROWSER_CATEGORY_BY_TAB_ID,
  MY_TABS_BROWSER_TAB_ID,
  SEARCH_FETCH_TAB_ID,
  TAB_ICON_CLASS,
  TAB_ICON_SIZE,
  TAB_ID_BY_ENTRY_CATEGORY,
  getNewestAgentBrowserTimestamp,
  getNewestSearchFetchTimestamp,
  labelWithCount,
} from "./browserReplayUtils";
import { categorizeBrowserEntry } from "./entryUtils";
import type { BrowserEntry, InternalBrowserEntry } from "./types";

// ============================================
// Types
// ============================================

export interface UseBrowserReplayTabsOptions {
  browserEntries: BrowserEntry[];
  internalBrowserEntries: InternalBrowserEntry[];
  activeEntry: BrowserEntry | null;
  activeInternalEntry: InternalBrowserEntry | null;
  activeSubtool: "browser" | "internal_browser" | null;
  myTabsBrowserState: {
    sessions: unknown[];
    activeSessionId: string | null;
    addSession: (url?: string, isPrivate?: boolean) => string;
    setActiveSession: (id: string) => void;
    closeSession: (id: string) => void;
  };
}

export interface UseBrowserReplayTabsResult {
  activeBrowserTabId: string;
  visibleActiveTabId: string;
  activeBrowserCategory: BrowserReplaySidebarCategory | null;
  showMyTabsBrowser: boolean;
  showAgentBrowserCategory: boolean;
  browserTabs: TimestampedReplayTab[];
  handleBrowserTabClick: (tabId: string) => void;
  handleNewMyTabsSession: () => void;
  handleNewPrivateMyTabsSession: () => void;
  handleSelectMyTabsSession: (sessionId: string) => void;
  handleCloseMyTabsSession: (sessionId: string) => void;
  handleOpenMyTabsHistoryUrl: (url: string) => void;
}

// ============================================
// Hook
// ============================================

export function useBrowserReplayTabs({
  browserEntries,
  internalBrowserEntries,
  activeEntry,
  activeInternalEntry,
  activeSubtool,
  myTabsBrowserState,
}: UseBrowserReplayTabsOptions): UseBrowserReplayTabsResult {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const [manualBrowserTabId, setManualBrowserTabId] = useState(
    MY_TABS_BROWSER_TAB_ID
  );
  const switchBrowserTab = useSetAtom(switchBrowserTabAtom);
  const closeBrowserTab = useSetAtom(closeBrowserTabAtom);

  const browserCategoryCounts = useMemo(() => {
    const counts: Record<BrowserReplaySidebarCategory, number> = {
      agent_browser: internalBrowserEntries.length,
      search_fetch: 0,
    };

    for (const entry of browserEntries) {
      const category = categorizeBrowserEntry(entry);
      if (category === "browser") {
        counts.agent_browser += 1;
      } else {
        counts.search_fetch += 1;
      }
    }

    return counts;
  }, [browserEntries, internalBrowserEntries.length]);

  const eventBrowserTab = useMemo(() => {
    const currentInternalEntry =
      internalBrowserEntries.find((entry) => entry.isCurrent) ??
      activeInternalEntry;
    if (activeSubtool === "internal_browser" && currentInternalEntry) {
      return {
        id: AGENT_BROWSER_TAB_ID,
        eventId: currentInternalEntry.entryId,
      };
    }

    const currentEntry =
      browserEntries.find((entry) => entry.isCurrent) ?? activeEntry;
    if (activeSubtool !== "browser" || !currentEntry) return null;

    const category = categorizeBrowserEntry(currentEntry);
    const tabId = TAB_ID_BY_ENTRY_CATEGORY.get(category) ?? null;
    return tabId ? { id: tabId, eventId: currentEntry.entryId } : null;
  }, [
    activeEntry,
    activeInternalEntry,
    activeSubtool,
    browserEntries,
    internalBrowserEntries,
  ]);

  const latestSessionBrowserTabId = useMemo(() => {
    const latestInternalEntry =
      activeInternalEntry ?? internalBrowserEntries.at(-1);
    const latestEntry = activeEntry ?? browserEntries.at(-1);

    if (!latestInternalEntry && !latestEntry) return null;
    if (latestInternalEntry && latestEntry) {
      return new Date(latestInternalEntry.timestamp) >
        new Date(latestEntry.timestamp)
        ? AGENT_BROWSER_TAB_ID
        : (TAB_ID_BY_ENTRY_CATEGORY.get(categorizeBrowserEntry(latestEntry)) ??
            null);
    }
    if (latestInternalEntry) return AGENT_BROWSER_TAB_ID;
    if (!latestEntry) return null;
    return (
      TAB_ID_BY_ENTRY_CATEGORY.get(categorizeBrowserEntry(latestEntry)) ?? null
    );
  }, [
    activeEntry,
    activeInternalEntry,
    browserEntries,
    internalBrowserEntries,
  ]);

  const preferredBrowserTabId =
    latestSessionBrowserTabId ?? MY_TABS_BROWSER_TAB_ID;

  useEffect(() => {
    setManualBrowserTabId(preferredBrowserTabId);
  }, [preferredBrowserTabId]);

  const activeBrowserTabId = eventBrowserTab?.id ?? manualBrowserTabId;

  const browserTabs = useMemo<TimestampedReplayTab[]>(() => {
    const myTabsLabel = tCommon("tabs.myTabs", {
      count: myTabsBrowserState.sessions.length,
    });
    const agentBrowserLabel = t("simulator.replay.browser.tabs.agentBrowser");
    const searchFetchLabel = t("simulator.replay.browser.tabs.searchFetch");

    return [
      {
        eventId: MY_TABS_BROWSER_TAB_ID,
        kind: "browser" as const,
        label: myTabsLabel,
        title: myTabsLabel,
        createdAt: "",
      },
      {
        eventId: AGENT_BROWSER_TAB_ID,
        kind: "browser" as const,
        label: labelWithCount(
          agentBrowserLabel,
          browserCategoryCounts.agent_browser
        ),
        title: agentBrowserLabel,
        icon: createElement(Compass, {
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
        createdAt: getNewestAgentBrowserTimestamp(
          browserEntries,
          internalBrowserEntries
        ),
      },
      {
        eventId: SEARCH_FETCH_TAB_ID,
        kind: "browser" as const,
        label: labelWithCount(
          searchFetchLabel,
          browserCategoryCounts.search_fetch
        ),
        title: searchFetchLabel,
        icon: createElement(Search, {
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
        createdAt: getNewestSearchFetchTimestamp(browserEntries),
      },
    ];
  }, [
    browserCategoryCounts,
    browserEntries,
    internalBrowserEntries,
    myTabsBrowserState.sessions.length,
    t,
    tCommon,
  ]);

  const activeBrowserCategory =
    BROWSER_CATEGORY_BY_TAB_ID.get(activeBrowserTabId) ?? null;
  const showMyTabsBrowser = activeBrowserTabId === MY_TABS_BROWSER_TAB_ID;
  const showAgentBrowserCategory = activeBrowserCategory !== null;

  const handleNewMyTabsSession = useCallback(() => {
    setManualBrowserTabId(MY_TABS_BROWSER_TAB_ID);
    const sessionId = myTabsBrowserState.addSession();
    switchBrowserTab(createBrowserSessionTabId(sessionId));
  }, [myTabsBrowserState, switchBrowserTab]);

  const handleNewPrivateMyTabsSession = useCallback(() => {
    const sessionId = myTabsBrowserState.addSession(undefined, true);
    switchBrowserTab(createBrowserSessionTabId(sessionId));
  }, [myTabsBrowserState, switchBrowserTab]);

  const handleSelectMyTabsSession = useCallback(
    (sessionId: string) => {
      switchBrowserTab(createBrowserSessionTabId(sessionId));
      myTabsBrowserState.setActiveSession(sessionId);
    },
    [myTabsBrowserState, switchBrowserTab]
  );

  const handleCloseMyTabsSession = useCallback(
    (sessionId: string) => {
      closeBrowserTab(createBrowserSessionTabId(sessionId));
      myTabsBrowserState.closeSession(sessionId);
    },
    [closeBrowserTab, myTabsBrowserState]
  );

  const handleOpenMyTabsHistoryUrl = useCallback(
    (url: string) => {
      const sessionId = myTabsBrowserState.addSession(url);
      switchBrowserTab(createBrowserSessionTabId(sessionId));
    },
    [myTabsBrowserState, switchBrowserTab]
  );

  const handleBrowserTabClick = useCallback((tabId: string) => {
    if (
      tabId === MY_TABS_BROWSER_TAB_ID ||
      BROWSER_CATEGORY_BY_TAB_ID.has(tabId)
    ) {
      setManualBrowserTabId(tabId);
    }
  }, []);

  return {
    activeBrowserTabId,
    visibleActiveTabId: activeBrowserTabId,
    activeBrowserCategory,
    showMyTabsBrowser,
    showAgentBrowserCategory,
    browserTabs,
    handleBrowserTabClick,
    handleNewMyTabsSession,
    handleNewPrivateMyTabsSession,
    handleSelectMyTabsSession,
    handleCloseMyTabsSession,
    handleOpenMyTabsHistoryUrl,
  };
}
