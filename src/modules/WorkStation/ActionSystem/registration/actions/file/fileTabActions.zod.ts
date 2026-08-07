/**
 * File Tab Actions (Zod-based)
 *
 * Static actions for tab management (no repoPath needed).
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { EditorTabService } from "@src/services/workStation/EditorTabService";

const fileClose = defineZodAction(
  {
    id: ACTION_ID.FILE_CLOSE,
    category: "file",
    description: "Close the current file tab",
    params: z.object({}),
    shortcut: getShortcutKeys("close_file"),
    examples: ["close this file", "close current tab", "close tab"],
  },
  async () => {
    EditorTabService.closeCurrentTab();
    return { success: true, message: "Closing current tab" };
  }
);

const fileCloseAll = defineZodAction(
  {
    id: ACTION_ID.FILE_CLOSE_ALL,
    category: "file",
    description: "Close all open file tabs",
    params: z.object({}),
    examples: ["close all files", "close all tabs"],
  },
  async () => {
    EditorTabService.closeAllTabs();
    return { success: true, message: "Closing all tabs" };
  }
);

const fileSaveAll = defineZodAction(
  {
    id: ACTION_ID.FILE_SAVE_ALL,
    category: "file",
    description: "Save all open files with unsaved changes",
    params: z.object({}),
    shortcut: getShortcutKeys("save_all"),
    examples: ["save all files", "save everything", "save all"],
  },
  async () => {
    window.dispatchEvent(new CustomEvent("save-all-files"));
    return { success: true, message: "Saving all files" };
  }
);

const fileCloseTab = defineZodAction(
  {
    id: ACTION_ID.FILE_CLOSE_TAB,
    category: "file",
    description: "Close a specific file tab by ID",
    params: z.object({
      tabId: z
        .string()
        .min(1, "Tab ID cannot be empty")
        .describe("Tab ID to close"),
    }),
    examples: ["close tab"],
  },
  async ({ tabId }) => {
    EditorTabService.closeTab(tabId);
    return { success: true, message: "Tab closed" };
  }
);

const fileCloseOthers = defineZodAction(
  {
    id: ACTION_ID.FILE_CLOSE_OTHERS,
    category: "file",
    description: "Close all tabs except the specified one",
    params: z.object({
      tabId: z
        .string()
        .min(1, "Tab ID cannot be empty")
        .describe("Tab ID to keep open"),
    }),
    examples: ["close other tabs", "close others"],
  },
  async ({ tabId }) => {
    EditorTabService.closeOtherTabs(tabId);
    return { success: true, message: "Other tabs closed" };
  }
);

const fileCloseSaved = defineZodAction(
  {
    id: ACTION_ID.FILE_CLOSE_SAVED,
    category: "file",
    description: "Close all saved (non-dirty) tabs",
    params: z.object({}),
    examples: ["close saved tabs", "close clean tabs"],
  },
  async () => {
    EditorTabService.closeSavedTabs();
    return { success: true, message: "Saved tabs closed" };
  }
);

export const fileTabZodActions = [
  fileClose,
  fileCloseAll,
  fileSaveAll,
  fileCloseTab,
  fileCloseOthers,
  fileCloseSaved,
];
