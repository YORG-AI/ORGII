import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  ACTION_ID,
  type ActionId,
  useActionSystemOptional,
} from "@src/ActionSystem";
import { isWorkbenchPath } from "@src/config/routes";
import {
  createAgentSessionSearchSpotlightRequest,
  createEditorSpotlightRequest,
  openSessionCreatorSpotlight,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { AppViewService } from "@src/services/app";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { spotlightInitialQueryAtom, spotlightOpenAtom } from "@src/store";
import { openOrFocusChatPanelStartPageTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";
import {
  branchSelectorOpenAtom,
  locationSelectorOpenAtom,
  repoSelectorOpenAtom,
} from "@src/store/ui/overlayAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import { closeActiveWorkStationTabAtom } from "@src/store/workstation/tabRegistry";

/**
 * Tab navigation, sidebar, spotlight, and close-tab shortcut handlers
 */
export function useTabShortcuts() {
  const [spotlightOpen, setSpotlightOpen] = useAtom(spotlightOpenAtom);
  const setSpotlightInitialQuery = useSetAtom(spotlightInitialQueryAtom);
  const setModelSelector = useSetAtom(modelSelectorAtom);
  const setRepoSelectorOpen = useSetAtom(repoSelectorOpenAtom);
  const setBranchSelectorOpen = useSetAtom(branchSelectorOpenAtom);
  const setLocationSelectorOpen = useSetAtom(locationSelectorOpenAtom);
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom);
  const closeActiveWorkStationTab = useSetAtom(closeActiveWorkStationTabAtom);
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const actionSystem = useActionSystemOptional();

  // Refs to avoid listener re-registration
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  const spotlightOpenRef = useRef(spotlightOpen);
  useEffect(() => {
    spotlightOpenRef.current = spotlightOpen;
  }, [spotlightOpen]);

  const handleCreateNewSession = useCallback(() => {
    if (actionSystem?.isValidAction(ACTION_ID.AGENT_STATION_CREATE_SESSION)) {
      void actionSystem.dispatch(
        ACTION_ID.AGENT_STATION_CREATE_SESSION,
        {},
        "user"
      );
      return;
    }

    void AppViewService.createAgentStationSession();
  }, [actionSystem]);

  // Handle Command+N — open (or focus) the singleton Launchpad start page in
  // the chat panel. This is a global handler so it fires regardless of where
  // focus is; the chat-panel-scoped ⌘N only fires when focus is inside the
  // panel, which left ⌘N dead when the user was on another tab / surface.
  // Outside WorkStation (e.g. MainApp) there is no chat-panel launchpad tab,
  // so fall back to the session-creator spotlight.
  const handleNewSessionShortcut = useCallback(() => {
    if (isWorkbenchPath(window.location.pathname)) {
      openStartPageTab({});
      return;
    }
    openSessionCreatorSpotlight();
  }, [openStartPageTab]);

  // Handle Command+T or Command+L — Workstation: open the unified `+`
  // (TabBarPlusMenu) dropdown via the `workstation-new-tab` event. Only
  // the All-Tabs and Browser surfaces mount a TabBarPlusMenu, so this
  // event is a no-op in Code / Data / Project modes by design (per
  // host-appropriate UX). MainApp: create a chat tab.
  const handleGoToCreateSession = useCallback((_shortcut: string) => {
    if (isWorkbenchPath(window.location.pathname)) {
      window.dispatchEvent(new CustomEvent("workstation-new-tab"));
      return;
    }
    window.dispatchEvent(new CustomEvent("create-chat-tab"));
  }, []);

  // Handle Command+Shift+P - Toggle spotlight search
  const handleToggleSpotlight = useCallback(() => {
    setSpotlightOpen((prev) => !prev);
  }, [setSpotlightOpen]);

  // Handle Command+/ — open the global model selector palette
  // (UnifiedModelPalette), mirroring the chat panel ModelPill click.
  const handleOpenModelSelector = useCallback(() => {
    setModelSelector({ isOpen: true });
  }, [setModelSelector]);

  // Handle Command+. — open the global workspace (repo) selector palette.
  const handleOpenWorkspaceSelector = useCallback(() => {
    setRepoSelectorOpen(true);
  }, [setRepoSelectorOpen]);

  // Handle Option+Command+. — open the branch selector for the current
  // session creator. No-op when SessionInfoLine is not mounted (the sole
  // consumer of branchSelectorOpenAtom).
  const handleOpenBranchSelector = useCallback(() => {
    setBranchSelectorOpen(true);
  }, [setBranchSelectorOpen]);

  // Handle Shift+Command+. — open the running-location selector for the
  // current session creator. Same no-op semantics as the branch shortcut.
  const handleOpenLocationSelector = useCallback(() => {
    setLocationSelectorOpen(true);
  }, [setLocationSelectorOpen]);

  const handleOpenAgentSessionSearch = useCallback(() => {
    setSpotlightInitialQuery(createAgentSessionSearchSpotlightRequest());
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  const handleOpenSettings = useCallback(() => {
    void AppViewService.openSettings();
  }, []);

  const handleOpenWorkStationFilePalette = useCallback(() => {
    if (!isWorkbenchPath(window.location.pathname)) return;
    setSpotlightInitialQuery(createEditorSpotlightRequest("", "file"));
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  const handleOpenWorkStationSymbolPalette = useCallback(() => {
    if (!isWorkbenchPath(window.location.pathname)) return;
    setSpotlightInitialQuery(createEditorSpotlightRequest("@", "symbol"));
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  // Handle Option+Command+U / Ctrl+Alt+U - Toggle app/session sidebar
  const handleToggleSidebar = useCallback(() => {
    const newValue = !sidebarCollapsedRef.current;
    setSidebarCollapsed(newValue);
  }, [setSidebarCollapsed]);

  // Handle Command+4 - Toggle Panel API Call
  const handleToggleAPICallPanel = useCallback(() => {
    window.dispatchEvent(new CustomEvent("toggle-panel-api-call"));
  }, []);

  const dispatchWorkStationAction = useCallback(
    (type: ActionId) => {
      const navigationShortcutOptions = {
        toggleChatPanelMaximizedWhenActive: true,
      };
      if (actionSystem?.isValidAction(type)) {
        void actionSystem.dispatch(type, {}, "user");
        return;
      }

      if (type === ACTION_ID.WORKSTATION_OPEN_FILE_FOLDER_TAB) {
        void WorkStationViewService.openFileFolderTab(
          navigationShortcutOptions
        );
        return;
      }

      if (type === ACTION_ID.WORKSTATION_OPEN_SOURCE_CONTROL_TAB) {
        void WorkStationViewService.openSourceControlTab(
          navigationShortcutOptions
        );
        return;
      }

      if (type === ACTION_ID.WORKSTATION_OPEN_SEARCH_SIDEBAR) {
        void WorkStationViewService.openSearchSidebar(
          undefined,
          navigationShortcutOptions
        );
        return;
      }

      if (type === ACTION_ID.WORKSTATION_OPEN_TERMINAL_TAB) {
        void WorkStationViewService.openTerminalTab(navigationShortcutOptions);
        return;
      }

      if (type === ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS) {
        void WorkStationViewService.toggleChatPanelMaximized();
        return;
      }

      if (type === ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR) {
        void WorkStationViewService.toggleWorkstationSidebar();
      }
    },
    [actionSystem]
  );

  const handleToggleWorkstationSidebar = useCallback(() => {
    dispatchWorkStationAction(ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR);
  }, [dispatchWorkStationAction]);

  const handleOpenCodeEditorFileFolder = useCallback(() => {
    dispatchWorkStationAction(ACTION_ID.WORKSTATION_OPEN_FILE_FOLDER_TAB);
  }, [dispatchWorkStationAction]);

  const handleOpenCodeEditorSourceControl = useCallback(() => {
    dispatchWorkStationAction(ACTION_ID.WORKSTATION_OPEN_SOURCE_CONTROL_TAB);
  }, [dispatchWorkStationAction]);

  const handleOpenCodeEditorSearchSidebar = useCallback(() => {
    dispatchWorkStationAction(ACTION_ID.WORKSTATION_OPEN_SEARCH_SIDEBAR);
  }, [dispatchWorkStationAction]);

  const handleOpenCodeEditorTerminal = useCallback(() => {
    dispatchWorkStationAction(ACTION_ID.WORKSTATION_OPEN_TERMINAL_TAB);
  }, [dispatchWorkStationAction]);

  const handleNextTab = useCallback((_shortcut: string) => {
    if (isWorkbenchPath(window.location.pathname)) {
      window.dispatchEvent(new CustomEvent("switch-to-next-tab"));
    }
  }, []);

  const handlePreviousTab = useCallback((_shortcut: string) => {
    if (isWorkbenchPath(window.location.pathname)) {
      window.dispatchEvent(new CustomEvent("switch-to-previous-tab"));
    }
  }, []);

  // ⌥⌘B / Alt+Ctrl+B — focus Chat Panel or restore the Workstation.
  const handleToggleWorkStationChatFocus = useCallback(() => {
    if (!isWorkbenchPath(window.location.pathname)) return;

    dispatchWorkStationAction(ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS);
  }, [dispatchWorkStationAction]);

  const handleCloseCurrentTab = useCallback(() => {
    const pathname = window.location.pathname;
    if (!isWorkbenchPath(pathname)) return false;

    return closeActiveWorkStationTab();
  }, [closeActiveWorkStationTab]);

  return {
    spotlightOpen,
    spotlightOpenRef,
    handleCreateNewSession,
    handleNewSessionShortcut,
    handleGoToCreateSession,
    handleToggleSpotlight,
    handleOpenModelSelector,
    handleOpenWorkspaceSelector,
    handleOpenBranchSelector,
    handleOpenLocationSelector,
    handleOpenAgentSessionSearch,
    handleOpenSettings,
    handleOpenWorkStationFilePalette,
    handleOpenWorkStationSymbolPalette,
    handleToggleSidebar,
    handleToggleAPICallPanel,
    handleToggleWorkstationSidebar,
    handleOpenCodeEditorFileFolder,
    handleOpenCodeEditorSourceControl,
    handleOpenCodeEditorSearchSidebar,
    handleOpenCodeEditorTerminal,
    handleNextTab,
    handlePreviousTab,
    handleCloseCurrentTab,
    handleToggleWorkStationChatFocus,
  };
}
