import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import type { StationMode } from "@src/store/ui/simulatorAtom";
import type {
  WorkStationTab,
  WorkStationTabType,
} from "@src/store/workstation/tabs/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const getStore = () => getInstrumentedStore();

function isWorkbenchRoute() {
  return isWorkbenchPath(window.location.pathname);
}

function isCodeEditorRoute() {
  return window.location.pathname === ROUTES.workStation.code.path;
}

function dispatchNavigate(path: string) {
  window.dispatchEvent(
    new CustomEvent("action-system-navigate", {
      detail: { path },
    })
  );
}

function dispatchOpenCodeTab(tabId: string) {
  window.dispatchEvent(
    new CustomEvent("workstation-open-code-tab", {
      detail: { tabId },
    })
  );
}

async function unmaximizeChatPanel(): Promise<void> {
  const { chatPanelMaximizedAtom } =
    await import("@src/store/ui/chatPanelAtom");
  const store = getStore();
  store.set(chatPanelMaximizedAtom, false);
}

/**
 * Prepare the Code Editor surface for opening a `mainPane` tab: unmaximize
 * the chat panel and snap into My Station. The unified content host follows
 * the active tab, so opening the tab itself reveals the Code Editor.
 */
async function revealCodeSurface(): Promise<void> {
  const { stationModeAtom } = await import("@src/store/ui/simulatorAtom");
  const store = getStore();
  await unmaximizeChatPanel();
  store.set(stationModeAtom, "my-station");
}

/**
 * Activate an existing `mainPane` tab, or open it when absent. Activating
 * (rather than re-opening) an existing tab avoids clobbering live tab data —
 * e.g. a populated Source Control tab's file count.
 */
async function openOrActivateCodeTab(tab: WorkStationTab): Promise<void> {
  const { EditorTabService } =
    await import("@src/services/workStation/EditorTabService");
  if (EditorTabService.hasTab(tab.id)) {
    EditorTabService.switchToTab(tab.id);
  } else {
    EditorTabService.openTab(tab);
  }
}

interface NavigationOptions {
  /**
   * If true, calling the navigation action while the user is *already* on the
   * target tab toggles the chat panel's maximized state instead of being a
   * no-op. Lets the same shortcut both "go to terminal" and "give terminal
   * the full pane back" when it's already focused.
   */
  toggleChatPanelMaximizedWhenActive?: boolean;
  /** Match active tab by type (e.g. any `source-control` pinned tab id). */
  activeTabType?: WorkStationTabType;
  /** Interactive setup flows that create a managed PTY must use the Code
   * Editor terminal even when invoked from Agent Station. */
  forceCodeEditorSurface?: boolean;
}

async function shouldToggleMaximizedForActiveTab(
  tabId: string,
  options?: NavigationOptions
): Promise<boolean> {
  if (!options?.toggleChatPanelMaximizedWhenActive || !isCodeEditorRoute()) {
    return false;
  }
  const { EditorTabService } =
    await import("@src/services/workStation/EditorTabService");
  const activeTab = EditorTabService.getActiveTab();
  if (!activeTab) return false;
  if (activeTab.id === tabId) return true;
  if (options.activeTabType && activeTab.type === options.activeTabType) {
    return true;
  }
  return false;
}

export const WorkStationViewService = {
  /**
   * Toggle the chat-panel slot's maximized state. Slot mode (session vs.
   * settings) is left untouched — un-maximize returns the user to whatever
   * the underlying workbench was showing, without a "previous mode" round-trip.
   */
  async toggleChatPanelMaximized(): Promise<boolean> {
    if (!isWorkbenchRoute()) return false;

    const [{ toggleChatPanelMaximizedAtom }] = await Promise.all([
      import("@src/store/ui/chatPanelAtom"),
    ]);

    const store = getStore();
    store.set(toggleChatPanelMaximizedAtom);
    return true;
  },

  async showWorkStation(): Promise<boolean> {
    if (!isWorkbenchRoute()) return false;

    const [
      { stationModeAtom },
      {
        activeStationChatVisibleAtom,
        chatPanelMaximizedAtom,
        stationChatVisibilityAtom,
      },
    ] = await Promise.all([
      import("@src/store/ui/simulatorAtom"),
      import("@src/store/ui/chatPanelAtom"),
    ]);

    const store = getStore();
    if (store.get(chatPanelMaximizedAtom)) {
      store.set(chatPanelMaximizedAtom, false);
    }
    const mode = store.get(stationModeAtom);
    if (mode === "my-station" || mode === "agent-station") {
      const visibility = store.get(stationChatVisibilityAtom);
      store.set(activeStationChatVisibleAtom, mode, !visibility[mode]);
    }
    return true;
  },

  async openKanbanTab(): Promise<boolean> {
    const [{ activeStationChatVisibleAtom }, { stationModeAtom }] =
      await Promise.all([
        import("@src/store/ui/chatPanelAtom"),
        import("@src/store/ui/simulatorAtom"),
      ]);

    const store = getStore();
    const { openWorkManagementChatPanelTabAtom } =
      await import("@src/store/chatPanel/chatPanelTabsAtom");
    const currentMode = store.get(stationModeAtom);
    const chatStationMode =
      currentMode === "agent-station" ? "agent-station" : "my-station";
    store.set(stationModeAtom, chatStationMode);
    store.set(activeStationChatVisibleAtom, chatStationMode, true);
    store.set(openWorkManagementChatPanelTabAtom, {});
    if (!isWorkbenchRoute()) {
      dispatchNavigate(ROUTES.workStation.base.path);
    }
    return true;
  },

  async openStationMode(mode: StationMode): Promise<boolean> {
    const [{ activeStationChatVisibleAtom }, { stationModeAtom }] =
      await Promise.all([
        import("@src/store/ui/chatPanelAtom"),
        import("@src/store/ui/simulatorAtom"),
      ]);

    const store = getStore();

    store.set(stationModeAtom, mode);

    await unmaximizeChatPanel();
    store.set(activeStationChatVisibleAtom, mode, true);
    if (!isWorkbenchRoute()) {
      dispatchNavigate(ROUTES.workStation.base.path);
    }
    return true;
  },

  async toggleStationMode(): Promise<boolean> {
    if (!isWorkbenchRoute()) return false;

    const { stationModeAtom } = await import("@src/store/ui/simulatorAtom");

    const store = getStore();
    const current = store.get(stationModeAtom);
    const nextMode =
      current === "agent-station" ? "my-station" : "agent-station";
    return this.openStationMode(nextMode);
  },

  async toggleWorkstationSidebar(): Promise<boolean> {
    if (!isWorkbenchRoute()) return false;

    const [
      { activeStatusBarCallbacksAtom },
      { workStationPrimarySidebarCollapsedPersistAtom },
    ] = await Promise.all([
      import("@src/store/ui/workStationLayout/statusBarAtoms"),
      import("@src/store/ui/workStationAtom"),
    ]);

    const store = getStore();
    const callbacks = store.get(activeStatusBarCallbacksAtom);
    if (callbacks.onTogglePrimaryPanel) {
      callbacks.onTogglePrimaryPanel();
      return true;
    }

    store.set(workStationPrimarySidebarCollapsedPersistAtom, "toggle");
    return true;
  },

  async openCodeEditorTab(tabId: string): Promise<boolean> {
    const [
      { stationModeAtom },
      { presentedWorkstationWorkspaceKeyAtom, queuePendingCodeEditorTab },
    ] = await Promise.all([
      import("@src/store/ui/simulatorAtom"),
      import("@src/store/workstation/tabs"),
    ]);

    const store = getStore();
    const isAlreadyOnCodeEditorRoute = isCodeEditorRoute();
    await unmaximizeChatPanel();
    store.set(stationModeAtom, "my-station");
    const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
    queuePendingCodeEditorTab(workspace, tabId);
    dispatchNavigate(ROUTES.workStation.code.path);
    if (isAlreadyOnCodeEditorRoute) {
      dispatchOpenCodeTab(tabId);
    }
    return true;
  },

  async openCodeEditorTabOrToggleChatPanelMaximized(
    tabId: string,
    options?: NavigationOptions
  ): Promise<boolean> {
    if (await shouldToggleMaximizedForActiveTab(tabId, options)) {
      return this.toggleChatPanelMaximized();
    }
    return this.openCodeEditorTab(tabId);
  },

  async openFileFolderTab(options?: NavigationOptions): Promise<boolean> {
    const { EditorTabService } =
      await import("@src/services/workStation/EditorTabService");
    const targetTabId = EditorTabService.getLastFileOrExplorerTabId();
    if (options?.toggleChatPanelMaximizedWhenActive && isCodeEditorRoute()) {
      const activeTab = EditorTabService.getActiveTab();
      if (
        activeTab &&
        (activeTab.id === targetTabId || activeTab.type === "explorer")
      ) {
        return this.toggleChatPanelMaximized();
      }
    }
    await revealCodeSurface();
    // Re-focus the last file if one is open, otherwise open the Explorer tab.
    EditorTabService.switchToLastFileOrExplorer();
    dispatchNavigate(ROUTES.workStation.code.path);
    return true;
  },

  async openSourceControlTab(options?: NavigationOptions): Promise<boolean> {
    const { SOURCE_CONTROL_CHANGES_TAB_ID, createSourceControlTab } =
      await import("@src/store/workstation/tabs");
    if (
      await shouldToggleMaximizedForActiveTab(SOURCE_CONTROL_CHANGES_TAB_ID, {
        ...options,
        activeTabType: "source-control",
      })
    ) {
      return this.toggleChatPanelMaximized();
    }
    await revealCodeSurface();
    await openOrActivateCodeTab(
      createSourceControlTab(0, { mode: "all-changes" })
    );
    dispatchNavigate(ROUTES.workStation.code.path);
    return true;
  },

  async openSearchSidebar(
    query?: string,
    options?: NavigationOptions
  ): Promise<boolean> {
    const [
      { stationModeAtom },
      {
        PRIMARY_SIDEBAR_TABS,
        workStationPrimarySidebarCollapsedPersistAtom,
        workStationPrimarySidebarTabAtom,
        workStationSearchFocusSignalAtom,
      },
      { searchQueryAtom },
    ] = await Promise.all([
      import("@src/store/ui/simulatorAtom"),
      import("@src/store/ui/workStationAtom"),
      import("@src/store/workstation/codeEditor/search"),
    ]);

    const store = getStore();
    if (
      options?.toggleChatPanelMaximizedWhenActive &&
      query === undefined &&
      isCodeEditorRoute() &&
      store.get(workStationPrimarySidebarTabAtom) ===
        PRIMARY_SIDEBAR_TABS.SEARCH
    ) {
      return this.toggleChatPanelMaximized();
    }
    await unmaximizeChatPanel();
    store.set(stationModeAtom, "my-station");
    store.set(workStationPrimarySidebarTabAtom, PRIMARY_SIDEBAR_TABS.SEARCH);
    if (query !== undefined) {
      store.set(searchQueryAtom, query);
    }
    store.set(workStationPrimarySidebarCollapsedPersistAtom, false);
    store.set(workStationSearchFocusSignalAtom, (value) => value + 1);
    dispatchNavigate(ROUTES.workStation.code.path);
    return true;
  },

  async openTerminalTab(options?: NavigationOptions): Promise<boolean> {
    const store = getStore();
    const [
      {
        CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
        CODE_EDITOR_MAIN_TERMINAL_SESSION_ID,
        createTerminalTab,
      },
      { AppType },
      {
        simulatorIdeTerminalRevealRequestAtom,
        simulatorSelectedAppAtom,
        stationModeAtom,
      },
      { chatPanelMaximizedAtom },
    ] = await Promise.all([
      import("@src/store/workstation/tabs"),
      import("@src/engines/Simulator/types/appTypes"),
      import("@src/store/ui/simulatorAtom"),
      import("@src/store/ui/chatPanelAtom"),
    ]);

    if (
      isWorkbenchRoute() &&
      store.get(stationModeAtom) === "agent-station" &&
      !options?.forceCodeEditorSurface
    ) {
      store.set(chatPanelMaximizedAtom, false);
      store.set(simulatorSelectedAppAtom, AppType.CODE_EDITOR);
      store.set(
        simulatorIdeTerminalRevealRequestAtom,
        (current: number) => current + 1
      );
      dispatchNavigate(ROUTES.workStation.base.path);
      return true;
    }

    if (
      await shouldToggleMaximizedForActiveTab(
        CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
        {
          ...options,
          activeTabType: "terminal",
        }
      )
    ) {
      return this.toggleChatPanelMaximized();
    }
    await revealCodeSurface();
    await openOrActivateCodeTab(
      createTerminalTab(CODE_EDITOR_MAIN_TERMINAL_SESSION_ID, "Terminal")
    );
    dispatchNavigate(ROUTES.workStation.code.path);
    return true;
  },
};
