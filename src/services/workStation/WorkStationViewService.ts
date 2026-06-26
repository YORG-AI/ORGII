import { getViewModeForRoute } from "@src/config/routeViewModeConfig";
import { ROUTES } from "@src/config/routes";
import type { StationMode } from "@src/store/ui/simulatorAtom";
import type { WorkStationTabType } from "@src/store/workstation/tabs/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const getStore = () => getInstrumentedStore();

function isWorkStationRoute() {
  return getViewModeForRoute(window.location.pathname) === "workStation";
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
    if (!isWorkStationRoute()) return false;

    const [{ toggleChatPanelMaximizedAtom }] = await Promise.all([
      import("@src/store/ui/chatPanelAtom"),
    ]);

    const store = getStore();
    store.set(toggleChatPanelMaximizedAtom);
    return true;
  },

  async showWorkStation(): Promise<boolean> {
    if (!isWorkStationRoute()) return false;

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

  async openStationMode(mode: StationMode): Promise<boolean> {
    const [
      { activeStationChatVisibleAtom },
      { stationModeAtom },
      { opsControlFocusedTabAtom, opsControlPeekHostAtom },
    ] = await Promise.all([
      import("@src/store/ui/chatPanelAtom"),
      import("@src/store/ui/simulatorAtom"),
      import("@src/store/workstation"),
    ]);

    const store = getStore();
    store.set(stationModeAtom, mode);

    if (mode === "my-station" || mode === "agent-station") {
      await unmaximizeChatPanel();
      store.set(activeStationChatVisibleAtom, mode, true);
      store.set(opsControlPeekHostAtom, null);
      store.set(opsControlFocusedTabAtom, null);
      if (
        !isWorkStationRoute() ||
        window.location.pathname === ROUTES.workStation.opsControl.path
      ) {
        dispatchNavigate(ROUTES.workStation.base.path);
      }
      return true;
    }

    dispatchNavigate(ROUTES.workStation.opsControl.path);
    return true;
  },

  async toggleStationMode(): Promise<boolean> {
    if (!isWorkStationRoute()) return false;

    const { stationModeAtom } = await import("@src/store/ui/simulatorAtom");

    const store = getStore();
    const current = store.get(stationModeAtom);
    const nextMode =
      current === "agent-station" ? "my-station" : "agent-station";
    return this.openStationMode(nextMode);
  },

  async toggleWorkstationSidebar(): Promise<boolean> {
    if (!isWorkStationRoute()) return false;

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
    const [{ stationModeAtom }, { queuePendingCodeEditorTab }] =
      await Promise.all([
        import("@src/store/ui/simulatorAtom"),
        import("@src/store/workstation/tabs"),
      ]);

    const store = getStore();
    const isAlreadyOnCodeEditorRoute = isCodeEditorRoute();
    await unmaximizeChatPanel();
    store.set(stationModeAtom, "my-station");
    queuePendingCodeEditorTab(tabId);
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
    return this.openCodeEditorTab(targetTabId);
  },

  async openSourceControlTab(options?: NavigationOptions): Promise<boolean> {
    const { SOURCE_CONTROL_CHANGES_TAB_ID } =
      await import("@src/store/workstation/tabs");
    return this.openCodeEditorTabOrToggleChatPanelMaximized(
      SOURCE_CONTROL_CHANGES_TAB_ID,
      { ...options, activeTabType: "source-control" }
    );
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
      { CODE_EDITOR_MAIN_TERMINAL_TAB_ID },
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
      isWorkStationRoute() &&
      store.get(stationModeAtom) === "agent-station"
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

    return this.openCodeEditorTabOrToggleChatPanelMaximized(
      CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
      { ...options, activeTabType: "terminal" }
    );
  },
};
