/**
 * useBrowserSessions - Browser session management
 *
 * Manages browser sessions, console/network logs, inspector, and DevTools.
 *
 * Performance optimizations:
 * - Polling hooks are delayed on initial mount to avoid IPC pressure during app switching
 * - Console/network/inspector polling only starts after POLLING_START_DELAY_MS
 */
import { useBrowserContextAdapter } from "@/src/engines/BrowserCore/hooks/useBrowserContextAdapter";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import { useWorkStationPanels } from "@src/hooks/tabHost/useWorkStationPanels";
import {
  browserDevToolsPositionAtom,
  browserDevToolsPositionPersistAtom,
  workStationBrowserSidebarCollapsedAtom,
  workStationBrowserSidebarCollapsedPersistAtom,
  workStationLayoutModeAtom,
  workStationLayoutModePersistAtom,
  workStationPrimarySidebarWidthAtom,
  workStationPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/workStationAtom";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

import { shouldEnableBrowserLogPolling } from "./browserDiagnosticsPolicy";
import { useBrowserConsole } from "./useBrowserConsole";
import { useBrowserNetworkLogs } from "./useBrowserNetworkLogs";
import { useWebviewInspector } from "./useWebviewInspector";

const log = createLogger("Browser");

// Delay before starting polling hooks to avoid IPC pressure during app switching
const POLLING_START_DELAY_MS = 150;

export interface UseBrowserSessionsReturn {
  // Browser state
  browserState: ReturnType<typeof useBrowserContextAdapter>;

  // Panel state
  layoutMode: "left" | "right";
  setLayoutMode: (value: "left" | "right") => void;
  primarySidebarCollapsed: boolean;
  setPrimarySidebarCollapsed: (value: boolean | "toggle") => void;
  togglePrimarySidebar: () => void;
  closePrimarySidebar: () => void;
  primarySidebarWidth: number;
  setPrimarySidebarWidth: (width: number) => void;
  devToolsCollapsed: boolean;
  setDevToolsCollapsed: (collapsed: boolean) => void;
  devToolsPanelWidth: number;
  setDevToolsPanelWidth: (width: number) => void;
  devToolsPosition: SecondaryPanelPosition;
  setDevToolsPosition: (value: SecondaryPanelPosition | "toggle") => void;

  // Active session info
  activeSessionId: string;
  activeWebviewLabel: string;
  currentUrl: string;
  isLoading: boolean;
  isPrivate: boolean;
  sessionCount: number;
  currentSessionIndex: number;

  // Console
  entries: ReturnType<typeof useBrowserConsole>["entries"];
  errorCount: number;
  warningCount: number;
  clearEntries: () => void;

  // Network
  networkEntries: ReturnType<typeof useBrowserNetworkLogs>["entries"];
  clearNetworkEntries: () => void;

  // Inspector
  isInspectMode: boolean;
  toggleInspectMode: () => void;
  selectedElement: ReturnType<typeof useWebviewInspector>["selectedElement"];
  clearSelection: () => void;

  // Handlers
  handlePrevSession: () => void;
  handleNextSession: () => void;
  handleToggleDevTools: () => void;
  handleOpenNativeDevTools: () => Promise<void>;
  handleSelectSession: (sessionId: string) => void;
  handleNewSession: () => void;
  handleNewPrivateSession: () => void;
  handleCloseSession: (sessionId: string) => void;
}

interface UseBrowserSessionsOptions {
  enabled?: boolean;
}

export function useBrowserSessions(
  options: UseBrowserSessionsOptions = {}
): UseBrowserSessionsReturn {
  const { enabled = true } = options;

  // Get browser state from context
  const browserState = useBrowserContextAdapter();

  // Browser-specific sidebar state — independent of the shared Code Editor / DB atom.
  const layoutMode = useAtomValue(workStationLayoutModeAtom);
  const setLayoutMode = useSetAtom(workStationLayoutModePersistAtom);
  const primarySidebarCollapsed = useAtomValue(
    workStationBrowserSidebarCollapsedAtom
  );
  const setPrimarySidebarCollapsed = useSetAtom(
    workStationBrowserSidebarCollapsedPersistAtom
  );
  const primarySidebarWidth = useAtomValue(workStationPrimarySidebarWidthAtom);
  const setPrimarySidebarWidth = useSetAtom(
    workStationPrimarySidebarWidthPersistAtom
  );

  const togglePrimarySidebar = useCallback(() => {
    setPrimarySidebarCollapsed("toggle");
  }, [setPrimarySidebarCollapsed]);

  const closePrimarySidebar = useCallback(() => {
    setPrimarySidebarCollapsed(true);
  }, [setPrimarySidebarCollapsed]);

  const { devToolsCollapsed, setDevToolsCollapsed } = useWorkStationPanels();
  const [devToolsPanelWidth, setDevToolsPanelWidth] = useState(250);
  const devToolsPosition = useAtomValue(browserDevToolsPositionAtom);
  const setDevToolsPosition = useSetAtom(browserDevToolsPositionPersistAtom);

  // Delayed polling start to avoid IPC pressure during app switching
  // This prevents the macOS spinner when switching to Browser mode
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || devToolsCollapsed) {
      return;
    }

    pollingTimerRef.current = setTimeout(() => {
      pollingTimerRef.current = null;
      setPollingEnabled(true);
    }, POLLING_START_DELAY_MS);

    return () => {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [devToolsCollapsed, enabled]);

  const effectivePollingEnabled =
    enabled && pollingEnabled && !devToolsCollapsed;
  const logPollingEnabled = shouldEnableBrowserLogPolling(
    effectivePollingEnabled,
    process.env.NODE_ENV
  );

  // Compute active session info
  const activeSessionId = browserState.activeSessionId || "";
  const activeWebviewLabel = useMemo(() => {
    if (!activeSessionId) return "";
    return `browser-session-${activeSessionId}`;
  }, [activeSessionId]);

  // Console log management - delayed start
  const {
    entries,
    errorCount,
    warningCount,
    clearEntries,
    clearSessionEntries: clearConsoleSessionEntries,
    setWebviewLabel,
    setSessionId,
  } = useBrowserConsole({
    sessionId: activeSessionId,
    webviewLabel: activeWebviewLabel,
    pollInterval: 1000,
    enabled: logPollingEnabled,
  });

  // Network log management - delayed start
  const {
    entries: networkEntries,
    clearEntries: clearNetworkEntries,
    clearSessionEntries: clearNetworkSessionEntries,
    setWebviewLabel: setNetworkWebviewLabel,
    setSessionId: setNetworkSessionId,
  } = useBrowserNetworkLogs({
    sessionId: activeSessionId,
    webviewLabel: activeWebviewLabel,
    pollInterval: 1000,
    enabled: logPollingEnabled,
  });

  // Element inspector - delayed start
  const {
    isInspectMode,
    toggleInspectMode,
    disableInspectMode,
    selectedElement,
    clearSelection,
  } = useWebviewInspector({
    webviewLabel: activeWebviewLabel,
    pollInterval: 300,
    enabled: effectivePollingEnabled && !!activeWebviewLabel,
  });

  // Update webview label and session ID when active session changes.
  // When the last tab closes, activeSessionId is empty — must clear IDs so console
  // counts and entries reset (otherwise stale error/warning totals persist in the status bar).
  useEffect(() => {
    if (activeSessionId) {
      setSessionId(activeSessionId);
      setWebviewLabel(activeWebviewLabel);
      setNetworkSessionId(activeSessionId);
      setNetworkWebviewLabel(activeWebviewLabel);
    } else {
      setSessionId("");
      setWebviewLabel("");
      setNetworkSessionId("");
      setNetworkWebviewLabel("");
    }
  }, [
    activeSessionId,
    activeWebviewLabel,
    setWebviewLabel,
    setSessionId,
    setNetworkWebviewLabel,
    setNetworkSessionId,
  ]);

  // Get current URL from active session
  const activeSession = browserState.sessions.find(
    (session) => session.id === browserState.activeSessionId
  );
  const currentUrl = activeSession?.url || "";
  const isLoading = activeSession?.isLoading || false;
  const isPrivate = activeSession?.incognito || false;

  // Session count and current index
  const sessionCount = browserState.sessions.length;
  const currentSessionIndex = useMemo(() => {
    const index = browserState.sessions.findIndex(
      (session) => session.id === browserState.activeSessionId
    );
    return index >= 0 ? index + 1 : 1;
  }, [browserState.sessions, browserState.activeSessionId]);

  // Handlers
  const handlePrevSession = useCallback(() => {
    const currentIndex = currentSessionIndex - 1;
    if (currentIndex > 0) {
      const prevSession = browserState.sessions[currentIndex - 1];
      browserState.setActiveSession(prevSession.id);
    }
  }, [currentSessionIndex, browserState]);

  const handleNextSession = useCallback(() => {
    const currentIndex = currentSessionIndex - 1;
    if (currentIndex < browserState.sessions.length - 1) {
      const nextSession = browserState.sessions[currentIndex + 1];
      browserState.setActiveSession(nextSession.id);
    }
  }, [currentSessionIndex, browserState]);

  const handleToggleDevTools = useCallback(() => {
    setDevToolsCollapsed(!devToolsCollapsed);
  }, [setDevToolsCollapsed, devToolsCollapsed]);

  const handleOpenNativeDevTools = useCallback(async () => {
    if (!activeWebviewLabel) return;
    try {
      await invoke("open_webview_devtools", { label: activeWebviewLabel });
    } catch (error) {
      log.error("[Browser] Failed to open native DevTools:", error);
    }
  }, [activeWebviewLabel]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      browserState.setActiveSession(sessionId);
    },
    [browserState]
  );

  const handleNewSession = useCallback(() => {
    browserState.addSession();
  }, [browserState]);

  const handleNewPrivateSession = useCallback(() => {
    browserState.addSession(undefined, true);
  }, [browserState]);

  const handleCloseSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) {
        await disableInspectMode();
      } else if (selectedElement) {
        await clearSelection();
      }
      clearConsoleSessionEntries(sessionId);
      clearNetworkSessionEntries(sessionId);
      browserState.closeSession(sessionId);
    },
    [
      activeSessionId,
      browserState,
      clearSelection,
      clearConsoleSessionEntries,
      clearNetworkSessionEntries,
      disableInspectMode,
      selectedElement,
    ]
  );

  return {
    browserState,
    layoutMode,
    setLayoutMode,
    primarySidebarCollapsed,
    setPrimarySidebarCollapsed,
    togglePrimarySidebar,
    closePrimarySidebar,
    primarySidebarWidth,
    setPrimarySidebarWidth,
    devToolsCollapsed,
    setDevToolsCollapsed,
    devToolsPanelWidth,
    setDevToolsPanelWidth,
    devToolsPosition,
    setDevToolsPosition,
    activeSessionId,
    activeWebviewLabel,
    currentUrl,
    isLoading,
    isPrivate,
    sessionCount,
    currentSessionIndex,
    entries,
    errorCount,
    warningCount,
    clearEntries,
    networkEntries,
    clearNetworkEntries,
    isInspectMode,
    toggleInspectMode,
    selectedElement,
    clearSelection,
    handlePrevSession,
    handleNextSession,
    handleToggleDevTools,
    handleOpenNativeDevTools,
    handleSelectSession,
    handleNewSession,
    handleNewPrivateSession,
    handleCloseSession,
  };
}
