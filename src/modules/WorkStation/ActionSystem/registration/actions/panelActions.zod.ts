/**
 * Panel Actions (Zod-based)
 *
 * Actions for showing/hiding panels.
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { PanelService } from "@src/services/panel";
import type { PrimarySidebarTabKey } from "@src/store/ui/workStationAtom";

// Source Control is no longer a regular sidebar tab — it lives in the
// tab-specific Diff sidebar — so it's not exposed as a panel.show target.
const primarySidebarTabs = ["files", "search"] as const;

export const panelShowPrimary = defineZodAction(
  {
    id: ACTION_ID.PANEL_SHOW_PRIMARY,
    category: "panel",
    description: "Show a specific primary sidebar tab",
    params: z.object({
      panel: z
        .enum(primarySidebarTabs)
        .describe("Panel to show (files, search)"),
    }),
    examples: ["show files panel", "open search panel"],
  },
  async ({ panel }) => {
    PanelService.showPrimarySidebar(panel as PrimarySidebarTabKey);
    return { success: true, message: `Showing ${panel} panel` };
  }
);

export const panelTogglePrimary = defineZodAction(
  {
    id: ACTION_ID.PANEL_TOGGLE_PRIMARY,
    category: "panel",
    description: "Toggle the Workstation sidebar visibility",
    params: z.object({}),
    shortcut: getShortcutKeys("toggle_workstation_sidebar"),
    examples: [
      "toggle work station sidebar",
      "hide work station sidebar",
      "show work station sidebar",
    ],
  },
  async () => {
    PanelService.togglePrimarySidebar();
    return { success: true, message: "Toggled Workstation sidebar" };
  }
);

export const panelToggleBottom = defineZodAction(
  {
    id: ACTION_ID.PANEL_TOGGLE_BOTTOM,
    category: "panel",
    description: "Toggle the bottom panel visibility",
    params: z.object({}),
    shortcut: getShortcutKeys("toggle_bottom_panel"),
    examples: ["toggle bottom panel", "hide bottom panel"],
  },
  async () => {
    PanelService.toggleBottomPanel();
    return { success: true, message: "Toggled bottom panel" };
  }
);

export const panelZodActions = [
  panelShowPrimary,
  panelTogglePrimary,
  panelToggleBottom,
];
