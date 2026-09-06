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

export const activeDocumentFileAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return state.files.find((f) => f.isActive);
});
activeDocumentFileAtom.debugLabel = "activeDocumentFileAtom";

export const activeWorkspaceSessionAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return state.sessions.find((s) => s.isActive);
});
activeWorkspaceSessionAtom.debugLabel = "activeWorkspaceSessionAtom";

export const activeShortcutAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return state.shortcuts.find((s) => s.isActive);
});
activeShortcutAtom.debugLabel = "activeShortcutAtom";

export const tabCountsAtom = atom((get) => {
  const state = get(navigationSidebarTabsAtom);
  return {
    browser: state.browser.length,
    terminal: state.terminal.length,
    editor: state.editor.length,
    files: state.files.length,
    sessions: state.sessions.length,
    shortcuts: state.shortcuts.length,
    total:
      state.browser.length +
      state.terminal.length +
      state.editor.length +
      state.files.length +
      state.sessions.length +
      state.shortcuts.length,
  };
});
tabCountsAtom.debugLabel = "tabCountsAtom";
