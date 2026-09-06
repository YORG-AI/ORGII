/**
 * Navigation Sidebar Tabs State — Core atom + derived read atoms
 *
 * Manages sidebar session memory: terminals, browser tabs, editor repos,
 * and other items displayed in the NavigationSidebar.
 *
 * The full module is split into:
 * - globalTabsTypes.ts — interfaces, utilities
 * - navigationSidebarTabsAtom.ts — core atom, read-only derived atoms (this file)
 * - globalTabsActions.ts — write action atoms
 *
 * Action atoms are NOT re-exported here. Importing them from this module
 * would create a circular dependency with `globalTabsActions.ts` (which
 * imports `navigationSidebarTabsAtom` from this file). Consumers must import action
 * atoms directly from `./globalTabsActions` (or via `store/ui` barrel).
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { GlobalTabsState } from "./globalTabsTypes";

export type { TerminalSession, GlobalTabsState } from "./globalTabsTypes";

export { getFaviconUrl, getSiteNameFromUrl } from "./globalTabsTypes";

// ============================================
// Core Atom — persisted to localStorage
// ============================================

export const navigationSidebarTabsAtom = atomWithStorage<GlobalTabsState>(
  "orgii-global-tabs",
  {
    browser: [],
    terminal: [],
    editor: [],
    files: [],
    sessions: [],
    shortcuts: [],
  }
);
navigationSidebarTabsAtom.debugLabel = "navigationSidebarTabsAtom";

// ============================================
// Read-only derived atoms
// ============================================

export const activeBrowserTabAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return state.browser.find((b) => b.isActive);
});
activeBrowserTabAtom.debugLabel = "activeBrowserTabAtom";

export const activeTerminalSessionAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return state.terminal.find((t) => t.isActive);
});
activeTerminalSessionAtom.debugLabel = "activeTerminalSessionAtom";
