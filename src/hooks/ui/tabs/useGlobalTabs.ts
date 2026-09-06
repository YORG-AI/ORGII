/**
 * useGlobalTabs Hooks
 *
 * Focused hooks for accessing specific categories of global tabs.
 * Each hook subscribes to its category and active tab.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";

import {
  addBrowserTabAtom,
  addTerminalSessionAtom,
  removeBrowserTabAtom,
  removeTerminalSessionAtom,
  setActiveBrowserTabAtom,
  setActiveTerminalSessionAtom,
  updateBrowserTabAtom,
} from "@src/store/ui/globalTabsActions";
import {
  activeBrowserTabAtom,
  activeTerminalSessionAtom,
  navigationSidebarTabsAtom,
} from "@src/store/ui/navigationSidebarTabsAtom";

// ============================================
// Selector Atoms (created once, reused)
// ============================================

const browserTabsAtom = selectAtom(
  navigationSidebarTabsAtom,
  (tabs) => tabs.browser
);
const terminalTabsAtom = selectAtom(
  navigationSidebarTabsAtom,
  (tabs) => tabs.terminal
);

// ============================================
// Focused Hooks - Use these for better performance
// ============================================

/**
 * Hook for browser tabs only.
 * Only re-renders when browser tabs change.
 */
export const useGlobalBrowserTabs = () => {
  const browserTabs = useAtomValue(browserTabsAtom);
  const activeBrowser = useAtomValue(activeBrowserTabAtom);
  const addBrowserTab = useSetAtom(addBrowserTabAtom);
  const removeBrowserTab = useSetAtom(removeBrowserTabAtom);
  const setActiveBrowserTab = useSetAtom(setActiveBrowserTabAtom);
  const updateBrowserTab = useSetAtom(updateBrowserTabAtom);

  return {
    browserTabs,
    activeBrowser,
    addBrowserTab,
    removeBrowserTab,
    setActiveBrowserTab,
    updateBrowserTab,
  };
};

/**
 * Hook for terminal sessions only.
 * Only re-renders when terminal sessions change.
 */
export const useGlobalTerminalTabs = () => {
  const terminalTabs = useAtomValue(terminalTabsAtom);
  const activeTerminal = useAtomValue(activeTerminalSessionAtom);
  const addTerminalSession = useSetAtom(addTerminalSessionAtom);
  const removeTerminalSession = useSetAtom(removeTerminalSessionAtom);
  const setActiveTerminalSession = useSetAtom(setActiveTerminalSessionAtom);

  return {
    terminalTabs,
    activeTerminal,
    addTerminalSession,
    removeTerminalSession,
    setActiveTerminalSession,
  };
};
