/**
 * Spotlight View Action Builder
 *
 * `buildViewActions` — view-toggle actions whose label flips based on the
 * current collapsed state of each sidebar/panel. State-dependent, so it's a
 * function rather than a static table. Split out of
 * `spotlightActionDefinitions.ts`.
 */
import { ACTION_ID } from "@src/ActionSystem";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  BubbleChatIcon,
  DockIcon,
  ListIcon,
  PanelLeftIcon,
  RotateLeft01Icon,
  SidebarBottomIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@src/icons";

import type { SpotlightStaticActionDefinition } from "./spotlightActionDefinitions.types";

// ============================================
// View action builder (state-dependent)
// ============================================

export function buildViewActions(
  isSidebarCollapsed: boolean,
  showWorkstationSidebarAction: boolean,
  showBottomPanelAction: boolean,
  showWorkStationChatFocusAction: boolean,
  isWorkstationSidebarCollapsed: boolean,
  isBottomPanelCollapsed: boolean,
  isChatPanelMaximized: boolean,
  isChatPanelVisible: boolean
): SpotlightStaticActionDefinition[] {
  const actions: SpotlightStaticActionDefinition[] = [
    {
      id: "toggle-sidebar",
      labelKey: isSidebarCollapsed
        ? "selectors.spotlight.actions.showAppSidebar.label"
        : "selectors.spotlight.actions.hideAppSidebar.label",
      icon: PanelLeftIcon,
      keywords: [
        "show app sidebar",
        "hide app sidebar",
        "collapse app sidebar",
        "expand app sidebar",
        "app sidebar",
        "sidebar",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_sidebar"),
      actionId: ACTION_ID.SIDEBAR_TOGGLE,
      payload: {},
      fallback: "toggle-sidebar",
      closeOnSuccess: false,
    },
  ];

  if (showWorkstationSidebarAction) {
    actions.push({
      id: "toggle-workstation-sidebar",
      labelKey: isWorkstationSidebarCollapsed
        ? "selectors.spotlight.actions.showWorkstationSidebar.label"
        : "selectors.spotlight.actions.hideWorkstationSidebar.label",
      icon: ListIcon,
      keywords: [
        "show work station sidebar",
        "hide work station sidebar",
        "collapse work station sidebar",
        "expand work station sidebar",
        "tool sidebar",
        "work station sidebar",
        "primary sidebar",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_workstation_sidebar"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR,
      payload: {},
      fallback: "toggle-workstation-sidebar",
      closeOnSuccess: false,
    });
  }

  if (showBottomPanelAction) {
    actions.push({
      id: "toggle-bottom-panel",
      labelKey: isBottomPanelCollapsed
        ? "commands.showBottomPanel"
        : "commands.hideBottomPanel",
      icon: SidebarBottomIcon,
      keywords: [
        "show bottom panel",
        "hide bottom panel",
        "toggle bottom panel",
        "terminal panel",
        "bottom panel",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_bottom_panel"),
      actionId: ACTION_ID.PANEL_TOGGLE_BOTTOM,
      payload: {},
      fallback: "toggle-bottom-panel",
      closeOnSuccess: false,
    });
  }

  if (showWorkStationChatFocusAction) {
    actions.push({
      id: "toggle-workstation-chat-panel",
      labelKey: isChatPanelVisible
        ? "selectors.spotlight.actions.maximizeWorkStation.label"
        : "selectors.spotlight.actions.restoreChatPanel.label",
      icon: isChatPanelVisible ? DockIcon : BubbleChatIcon,
      keywords: [
        "maximize work station",
        "hide chat panel",
        "restore chat panel",
        "show chat panel",
        "toggle chat panel",
        "work station",
        "view",
      ],
      shortcut: getShortcutKeys("maximize_work_station"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_CHAT_PANEL_VISIBILITY,
      payload: {},
      fallback: "toggle-chat-panel",
      closeOnSuccess: false,
    });

    actions.push({
      id: "toggle-workstation-chat-focus",
      labelKey: isChatPanelMaximized
        ? "selectors.spotlight.actions.showWorkstation.label"
        : "selectors.spotlight.actions.focusChatPanel.label",
      icon: isChatPanelMaximized ? DockIcon : BubbleChatIcon,
      keywords: [
        "focus chat panel",
        "hide work station",
        "show work station",
        "restore work station",
        "chat panel",
        "workstation chat",
        "view",
      ],
      shortcut: getShortcutKeys("maximize_chat"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS,
      payload: {},
      fallback: "toggle-chat-focus",
      closeOnSuccess: false,
    });
  }

  actions.push(
    {
      id: "zoom-in",
      labelKey: "selectors.spotlight.actions.zoomIn.label",
      icon: ZoomInAreaIcon,
      keywords: ["zoom in", "increase zoom", "increase UI scale", "view"],
      shortcut: getShortcutKeys("zoom_in"),
      actionId: ACTION_ID.APP_ZOOM_IN,
      payload: {},
      fallback: "zoom-in",
      closeOnSuccess: false,
    },
    {
      id: "zoom-out",
      labelKey: "selectors.spotlight.actions.zoomOut.label",
      icon: ZoomOutAreaIcon,
      keywords: ["zoom out", "decrease zoom", "decrease UI scale", "view"],
      shortcut: getShortcutKeys("zoom_out"),
      actionId: ACTION_ID.APP_ZOOM_OUT,
      payload: {},
      fallback: "zoom-out",
      closeOnSuccess: false,
    },
    {
      id: "zoom-reset",
      labelKey: "selectors.spotlight.actions.resetZoom.label",
      icon: RotateLeft01Icon,
      keywords: ["reset zoom", "reset UI scale", "actual size", "view"],
      shortcut: getShortcutKeys("zoom_reset"),
      actionId: ACTION_ID.APP_ZOOM_RESET,
      payload: {},
      fallback: "zoom-reset",
      closeOnSuccess: false,
    }
  );

  return actions;
}
