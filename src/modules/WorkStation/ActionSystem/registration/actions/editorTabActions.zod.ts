/**
 * Editor Tab Actions (Zod-based)
 *
 * Actions for managing tabs in the unified single-pane workstation.
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { EditorTabService } from "@src/services/workStation/EditorTabService";

// ============================================
// Editor Tab Actions
// ============================================

export const editorTabClose = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_CLOSE,
    category: "editor",
    description: "Close the current file tab or a specific tab by ID",
    params: z.object({
      tabId: z
        .string()
        .optional()
        .describe("Tab ID to close (uses current tab if not specified)"),
    }),
    shortcut: getShortcutKeys("close_file"),
    examples: ["close tab", "close current file", "close this tab"],
  },
  async ({ tabId }) => {
    const success = tabId
      ? EditorTabService.closeTab(tabId)
      : EditorTabService.closeCurrentTab();
    return success
      ? { success: true, message: "Tab closed" }
      : { success: false, message: "No tab to close" };
  }
);

export const editorTabCloseAll = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_CLOSE_ALL,
    category: "editor",
    description: "Close all file tabs",
    params: z.object({}),
    examples: ["close all tabs", "close all files"],
  },
  async () => {
    EditorTabService.closeAllTabs();
    return { success: true, message: "All tabs closed" };
  }
);

export const editorTabCloseOthers = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_CLOSE_OTHERS,
    category: "editor",
    description: "Close all tabs except the specified one",
    params: z.object({
      tabId: z
        .string()
        .min(1, "Tab ID is required")
        .describe("Tab ID to keep open"),
    }),
    examples: ["close other tabs", "close all except this"],
  },
  async ({ tabId }) => {
    const success = EditorTabService.closeOtherTabs(tabId);
    return success
      ? { success: true, message: "Other tabs closed" }
      : { success: false, message: "Tab not found" };
  }
);

export const editorTabCloseSaved = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_CLOSE_SAVED,
    category: "editor",
    description: "Close all saved (non-dirty) tabs",
    params: z.object({}),
    examples: ["close saved tabs", "close all saved"],
  },
  async () => {
    EditorTabService.closeSavedTabs();
    return { success: true, message: "Saved tabs closed" };
  }
);

export const editorTabSwitch = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_SWITCH,
    category: "editor",
    description: "Switch to a specific file tab",
    params: z.object({
      tabId: z
        .string()
        .min(1, "Tab ID is required")
        .describe("Tab ID to switch to"),
    }),
    examples: ["switch to tab", "go to tab"],
  },
  async ({ tabId }) => {
    const success = EditorTabService.switchToTab(tabId);
    return success
      ? { success: true, message: "Switched to tab" }
      : { success: false, message: "Tab not found" };
  }
);

export const editorTabNext = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_NEXT,
    category: "editor",
    description: "Switch to the next file tab",
    params: z.object({}),
    shortcut: getShortcutKeys("next_tab"),
    examples: ["next tab", "go to next file"],
  },
  async () => {
    const success = EditorTabService.switchToNextTab();
    return success
      ? { success: true, message: "Switched to next tab" }
      : { success: false, message: "No tabs available" };
  }
);

export const editorTabPrevious = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_PREVIOUS,
    category: "editor",
    description: "Switch to the previous file tab",
    params: z.object({}),
    shortcut: getShortcutKeys("previous_tab"),
    examples: ["previous tab", "go to previous file"],
  },
  async () => {
    const success = EditorTabService.switchToPreviousTab();
    return success
      ? { success: true, message: "Switched to previous tab" }
      : { success: false, message: "No tabs available" };
  }
);

export const editorTabReorder = defineZodAction(
  {
    id: ACTION_ID.EDITOR_TAB_REORDER,
    category: "editor",
    description: "Reorder tabs by moving a tab from one position to another",
    params: z.object({
      fromIndex: z.number().int().min(0).describe("Source index (0-based)"),
      toIndex: z.number().int().min(0).describe("Target index (0-based)"),
    }),
    examples: ["move tab to position 2", "reorder tabs"],
  },
  async ({ fromIndex, toIndex }) => {
    const success = EditorTabService.reorderTabs(fromIndex, toIndex);
    return success
      ? { success: true, message: "Tab reordered" }
      : { success: false, message: "Invalid tab positions" };
  }
);

// ============================================
// Export all editor tab actions
// ============================================

export const editorTabZodActions = [
  editorTabClose,
  editorTabCloseAll,
  editorTabCloseOthers,
  editorTabCloseSaved,
  editorTabSwitch,
  editorTabNext,
  editorTabPrevious,
  editorTabReorder,
];
