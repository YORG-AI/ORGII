/**
 * useLaunchpadTab
 *
 * Keeps a single Launchpad (`start`) tab as the pool's "home base":
 *   - when the pool is empty (fresh launch, or the user closed the last tab),
 *     it opens a Launchpad tab so there's always something to land on;
 *   - once any real tab exists, it removes the Launchpad tab so the launcher
 *     never lingers alongside actual work.
 *
 * The Launchpad is therefore an ephemeral placeholder: it's present exactly
 * when nothing else is open. Regular-WorkStation only — Agent Station has its
 * own surface, so pass `enabled = false` there.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import {
  createStartTab,
  mainPaneTabsAtom,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

export function useLaunchpadTab(enabled: boolean): void {
  const tabs = useAtomValue(mainPaneTabsAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);

  const tabCount = tabs.length;
  const startTabCount = tabs.filter((tab) => tab.type === "start").length;
  const realTabCount = tabCount - startTabCount;

  useEffect(() => {
    if (!enabled) return;

    // Empty pool → seed a Launchpad tab.
    if (tabCount === 0) {
      setLayout((prev) => {
        if (!prev?.mainPane || prev.mainPane.tabs.length > 0) return prev;
        return { ...prev, mainPane: openTab(prev.mainPane, createStartTab()) };
      });
      return;
    }

    // Real tabs opened alongside the Launchpad → drop the Launchpad.
    if (realTabCount > 0 && startTabCount > 0) {
      setLayout((prev) => {
        if (!prev?.mainPane) return prev;
        const remaining = prev.mainPane.tabs.filter(
          (tab) => tab.type !== "start"
        );
        if (remaining.length === prev.mainPane.tabs.length) return prev;
        const activeStillExists = remaining.some(
          (tab) => tab.id === prev.mainPane.activeTabId
        );
        return {
          ...prev,
          mainPane: {
            tabs: remaining,
            activeTabId: activeStillExists
              ? prev.mainPane.activeTabId
              : (remaining[remaining.length - 1]?.id ?? null),
          },
        };
      });
    }
  }, [enabled, tabCount, realTabCount, startTabCount, setLayout]);
}
