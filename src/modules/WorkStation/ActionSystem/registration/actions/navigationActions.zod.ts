/**
 * Navigation Actions (Zod-based)
 *
 * Actions for code navigation (go to definition, find references, back/forward).
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { NavigationService } from "@src/services/navigation";

// ============================================
// Navigation Actions
// ============================================

export const navigationGoToDefinition = defineZodAction(
  {
    id: ACTION_ID.NAVIGATION_GO_TO_DEFINITION,
    category: "navigation",
    description: "Go to the definition of the symbol under cursor",
    params: z.object({}),
    shortcut: getShortcutKeys("go_to_definition"),
    examples: ["go to definition", "jump to definition"],
  },
  async () => {
    const success = await NavigationService.goToDefinition();
    return success
      ? { success: true, message: "Jumped to definition" }
      : { success: false, message: "Go to definition requires LSP" };
  }
);

export const navigationFindReferences = defineZodAction(
  {
    id: ACTION_ID.NAVIGATION_FIND_REFERENCES,
    category: "navigation",
    description: "Find all references of the symbol under cursor",
    params: z.object({}),
    shortcut: getShortcutKeys("find_references"),
    examples: ["find references", "find usages"],
  },
  async () => {
    const success = await NavigationService.findReferences();
    return success
      ? { success: true, message: "Found references" }
      : { success: false, message: "Find references requires LSP" };
  }
);

export const navigationGoBack = defineZodAction(
  {
    id: ACTION_ID.NAVIGATION_GO_BACK,
    category: "navigation",
    description: "Go back to previous location",
    params: z.object({}),
    shortcut: getShortcutKeys("go_back"),
    examples: ["go back", "previous location"],
  },
  async () => {
    const success = NavigationService.goBack();
    return success
      ? { success: true, message: "Went back" }
      : { success: false, message: "No previous location" };
  }
);

export const navigationGoForward = defineZodAction(
  {
    id: ACTION_ID.NAVIGATION_GO_FORWARD,
    category: "navigation",
    description: "Go forward to next location",
    params: z.object({}),
    shortcut: getShortcutKeys("go_forward"),
    examples: ["go forward", "next location"],
  },
  async () => {
    const success = NavigationService.goForward();
    return success
      ? { success: true, message: "Went forward" }
      : { success: false, message: "No forward location" };
  }
);

// ============================================
// Export all navigation actions
// ============================================

export const navigationZodActions = [
  navigationGoToDefinition,
  navigationFindReferences,
  navigationGoBack,
  navigationGoForward,
];
