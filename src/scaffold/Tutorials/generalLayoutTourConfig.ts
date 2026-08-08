export const GENERAL_LAYOUT_TOUR_EVENT = "orgii:start-general-layout-tour";

export const GENERAL_LAYOUT_TOUR_TARGETS = {
  sessionSidebar: "session-layout-session-sidebar",
  runtimeNavigation: "session-layout-runtime-navigation",
  chatPanel: "session-layout-chat-panel",
  workstation: "session-layout-workstation",
  stationModePill: "session-layout-station-mode-pill",
  dock: "session-layout-dock",
  dockAllTabs: "session-layout-dock-all-tabs",
  dockCodeEditor: "session-layout-dock-code-editor",
  dockBrowser: "session-layout-dock-browser",
  dockProjects: "session-layout-dock-projects",
} as const;

export const GENERAL_LAYOUT_TOUR_STEPS = [
  {
    id: "chat-panel",
    target: GENERAL_LAYOUT_TOUR_TARGETS.chatPanel,
  },
  {
    id: "runtime",
    target: GENERAL_LAYOUT_TOUR_TARGETS.runtimeNavigation,
  },
  {
    id: "station-mode-pill",
    target: GENERAL_LAYOUT_TOUR_TARGETS.stationModePill,
    stationMode: "my-station",
    demoStationModeSwitch: true,
  },
  {
    id: "dock",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dock,
  },
  {
    id: "all-tabs",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockAllTabs,
    switchToMyStation: true,
  },
  {
    id: "code-editor",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockCodeEditor,
    switchToMyStation: true,
  },
  {
    id: "browser",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockBrowser,
    switchToMyStation: true,
  },
  {
    id: "projects",
    target: GENERAL_LAYOUT_TOUR_TARGETS.dockProjects,
    switchToMyStation: true,
  },
] as const;
