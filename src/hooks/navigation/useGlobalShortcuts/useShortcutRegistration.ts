import { type MutableRefObject, useEffect } from "react";

import { shortcutRegistry } from "@src/hooks/keyboard";
import { openAgentControlSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isTauriDesktop } from "@src/util/platform/tauri";

import { useGlobalKeydownShortcuts } from "./useGlobalKeydownShortcuts";

interface ShortcutRegistrationOptions {
  // Inspect mode
  inspectModeRef: MutableRefObject<boolean>;
  handleInspectMoveUpLevel: () => Promise<boolean | undefined>;
  handleInspectMoveDownLevel: () => Promise<boolean | undefined>;
  handleInspectToggleLabels: () => Promise<boolean>;
  handleInspectHideLabels: () => Promise<boolean>;
  handleToggleInspectMode: () => Promise<void>;
  handleShowComponentIssue: () => Promise<void>;
  // Zoom
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleZoomReset: () => boolean;
  // Window
  openQuitConfirmation: () => void;
  closeQuitConfirmation: () => void;
  handleHideWindow: () => Promise<void>;
  // Tabs & navigation
  spotlightOpenRef: MutableRefObject<boolean>;
  handleCreateNewSession: () => void;
  handleNewSessionShortcut: () => void;
  handleGoToCreateSession: (shortcut: string) => void;
  handleToggleSpotlight: () => void;
  handleOpenModelSelector: () => void;
  handleOpenWorkspaceSelector: () => void;
  handleOpenBranchSelector: () => void;
  handleOpenLocationSelector: () => void;
  handleOpenAgentSessionSearch: () => void;
  handleOpenSettings: () => void;
  handleToggleSidebar: () => void;
  handleOpenWorkStationFilePalette: () => void;
  handleOpenWorkStationSymbolPalette: () => void;
  handleToggleAPICallPanel: () => void;
  handleToggleWorkstationSidebar: () => void;
  handleOpenCodeEditorFileFolder: () => void;
  handleOpenCodeEditorSourceControl: () => void;
  handleOpenCodeEditorSearchSidebar: () => void;
  handleOpenCodeEditorTerminal: () => void;
  handleNextTab: (shortcut: string) => void;
  handlePreviousTab: (shortcut: string) => void;
  handleCloseCurrentTab: () => boolean;
  handleToggleWorkStationChatFocus: () => void;
}

/**
 * Registers the global keydown listener, shortcutRegistry subscriptions,
 * Tauri native menu listeners, and parent-shortcut forwarding.
 */
export function useShortcutRegistration(options: ShortcutRegistrationOptions) {
  const {
    inspectModeRef,
    handleInspectMoveUpLevel,
    handleInspectMoveDownLevel,
    handleInspectToggleLabels,
    handleInspectHideLabels,
    handleToggleInspectMode,
    handleShowComponentIssue,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    openQuitConfirmation,
    closeQuitConfirmation,
    handleHideWindow,
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
    handleToggleSidebar,
    handleOpenWorkStationFilePalette,
    handleOpenWorkStationSymbolPalette,
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
  } = options;

  // ── Global keydown listener (capture phase) ──
  useGlobalKeydownShortcuts({
    inspectModeRef,
    handleInspectMoveUpLevel,
    handleInspectMoveDownLevel,
    handleInspectToggleLabels,
    handleInspectHideLabels,
    openQuitConfirmation,
    closeQuitConfirmation,
    spotlightOpenRef,
    handleOpenWorkStationFilePalette,
    handleOpenWorkStationSymbolPalette,
    handleOpenAgentSessionSearch,
    handleOpenSettings,
    handleToggleSidebar,
    handleToggleWorkstationSidebar,
    handleOpenCodeEditorFileFolder,
    handleOpenCodeEditorSourceControl,
    handleOpenCodeEditorSearchSidebar,
    handleOpenCodeEditorTerminal,
    handleCloseCurrentTab,
    handleToggleWorkStationChatFocus,
  });

  // ── ShortcutRegistry subscriptions ──
  useEffect(() => {
    const unsubscribers = [
      shortcutRegistry.on("zoom_in", handleZoomIn),
      shortcutRegistry.on("zoom_out", handleZoomOut),
      shortcutRegistry.on("zoom_reset", handleZoomReset),
      shortcutRegistry.on("quit_app", openQuitConfirmation),
      shortcutRegistry.on("close_tab", handleCloseCurrentTab),
      shortcutRegistry.on("hide_window", handleHideWindow),
      shortcutRegistry.on(
        "maximize_work_station",
        () => void WorkStationViewService.showWorkStation()
      ),
      shortcutRegistry.on("new_session", handleNewSessionShortcut),
      shortcutRegistry.on("new_tab", () => handleGoToCreateSession("Cmd+T")),
      shortcutRegistry.on("new_tab_alt", () =>
        handleGoToCreateSession("Cmd+L")
      ),
      shortcutRegistry.on("open_settings", handleOpenSettings),
      shortcutRegistry.on("toggle_sidebar", handleToggleSidebar),
      shortcutRegistry.on("toggle_spotlight", handleToggleSpotlight),
      shortcutRegistry.on("open_model_selector", handleOpenModelSelector),
      shortcutRegistry.on(
        "open_workspace_selector",
        handleOpenWorkspaceSelector
      ),
      shortcutRegistry.on("open_branch_selector", handleOpenBranchSelector),
      shortcutRegistry.on("open_location_selector", handleOpenLocationSelector),
      shortcutRegistry.on("agent_session_search", handleOpenAgentSessionSearch),
      shortcutRegistry.on("next_tab", () => handleNextTab("Ctrl+Tab")),
      shortcutRegistry.on("previous_tab", () =>
        handlePreviousTab("Ctrl+Shift+Tab")
      ),
      shortcutRegistry.on("next_tab_mac", () => handleNextTab("Cmd+Option+→")),
      shortcutRegistry.on("previous_tab_mac", () =>
        handlePreviousTab("Cmd+Option+←")
      ),
      shortcutRegistry.on("toggle_api_panel", handleToggleAPICallPanel),
      shortcutRegistry.on("toggle_ade_manager", () => {
        const store = getInstrumentedStore();
        if (store.get(spotlightOpenAtom)) {
          store.set(spotlightOpenAtom, false);
          return;
        }
        openAgentControlSpotlight();
      }),
      shortcutRegistry.on("open_my_station", () => {
        void WorkStationViewService.openStationMode("my-station");
      }),
      shortcutRegistry.on("open_agent_station", () => {
        void WorkStationViewService.openStationMode("agent-station");
      }),
      shortcutRegistry.on("open_kanban", () => {
        void WorkStationViewService.openKanbanTab();
      }),
      shortcutRegistry.on(
        "open_file_folder_tab",
        handleOpenCodeEditorFileFolder
      ),
      shortcutRegistry.on("maximize_chat", handleToggleWorkStationChatFocus),
      shortcutRegistry.on("toggle_inspect_mode", handleToggleInspectMode),
      shortcutRegistry.on("capture_component", handleShowComponentIssue),
    ];

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    openQuitConfirmation,
    handleCloseCurrentTab,
    handleHideWindow,
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
    handleToggleSidebar,
    handleNextTab,
    handlePreviousTab,
    handleToggleAPICallPanel,
    handleOpenCodeEditorFileFolder,
    handleToggleWorkStationChatFocus,
    handleToggleInspectMode,
    handleShowComponentIssue,
  ]);

  // ── Tauri native menu listeners ──
  useEffect(() => {
    if (!isTauriDesktop()) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const setupListeners = async () => {
      const { listen } = await import("@tauri-apps/api/event");

      const menuHandlers: Record<string, () => void> = {
        "menu-new-session": handleCreateNewSession,
        "tray-new-session": handleCreateNewSession,
        "menu-zoom-in": handleZoomIn,
        "menu-zoom-out": handleZoomOut,
        "menu-zoom-reset": handleZoomReset,
        "menu-toggle-spotlight": handleToggleSpotlight,
        "menu-open-file-palette": handleOpenWorkStationFilePalette,
        // ⌘. is captured by AppKit (cancelOperation:) before WKWebView
        // can deliver it as a keydown, so we route it via a native menu
        // accelerator that emits this event. See `app_menu.rs`. The
        // sibling shortcuts (⌥⌘., ⇧⌘., ⌘/) are also wired through the
        // menu for discoverability and to keep a single dispatch path
        // for every workspace/branch/location/model selector.
        "menu-open-workspace-selector": handleOpenWorkspaceSelector,
        "menu-open-branch-selector": handleOpenBranchSelector,
        "menu-open-location-selector": handleOpenLocationSelector,
        "menu-open-model-selector": handleOpenModelSelector,
        "menu-open-settings": handleOpenSettings,
        "menu-maximize-work-station": () =>
          void WorkStationViewService.showWorkStation(),
        "menu-select-all": () => {
          const terminalEl = document.querySelector(".terminal-core");
          if (
            terminalEl?.contains(document.activeElement) ||
            terminalEl === document.activeElement
          ) {
            window.dispatchEvent(new CustomEvent("terminal-select-all"));
            return;
          }
          const activeElement = document.activeElement;
          if (
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement
          ) {
            activeElement.select();
            return;
          }
          document.execCommand("selectAll");
        },
      };

      const inlineShortcutHandlers: Record<string, () => void> = {
        openFilePalette: handleOpenWorkStationFilePalette,
        toggleSpotlight: handleToggleSpotlight,
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        zoomReset: handleZoomReset,
      };

      for (const [event, handler] of Object.entries(menuHandlers)) {
        const unlisten = await listen(event, () => {
          if (!cancelled) handler();
        });
        unlisteners.push(unlisten);
      }

      const unlistenInlineShortcut = await listen<{
        shortcut: string;
        keys: string;
      }>("inline-webview-shortcut", (event) => {
        if (cancelled) return;
        const handler = inlineShortcutHandlers[event.payload.shortcut];
        handler?.();
      });
      unlisteners.push(unlistenInlineShortcut);
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [
    handleCreateNewSession,
    handleOpenBranchSelector,
    handleOpenLocationSelector,
    handleOpenModelSelector,
    handleOpenSettings,
    handleOpenWorkStationFilePalette,
    handleOpenWorkspaceSelector,
    handleToggleSpotlight,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
  ]);

  // ── Shortcuts dispatched from embedded previews (parent-shortcut-forwarded) ──
  useEffect(() => {
    const PARENT_SHORTCUT_MAP: Record<string, string> = {
      toggleApiCallsPanel: "toggle_api_panel",
      toggleInspectMode: "toggle_inspect_mode",
      showComponentIssue: "capture_component",
      zoomIn: "zoom_in",
      zoomOut: "zoom_out",
      zoomReset: "zoom_reset",
    };

    const handleParentShortcut = (event: Event) => {
      const customEvent = event as CustomEvent<{
        shortcut: string;
        keys: string;
      }>;
      const { shortcut } = customEvent.detail;
      const registryId = PARENT_SHORTCUT_MAP[shortcut];
      if (registryId) {
        shortcutRegistry.dispatch(registryId);
      }
    };

    window.addEventListener("parent-shortcut-forwarded", handleParentShortcut);
    return () => {
      window.removeEventListener(
        "parent-shortcut-forwarded",
        handleParentShortcut
      );
    };
  }, []);
}
