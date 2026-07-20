/**
 * Keep the active tab consistent with the host the user is viewing.
 * Selection is workspace-owned, so reconciliation focuses through the scoped
 * action instead of rewriting the compatibility layout projection directly.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  dockFilterAtom,
  focusWorkstationTabAtom,
  mainPaneActiveTabIdAtom,
  mainPaneTabsAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation";
import {
  type WorkstationTabHost,
  tabToHost,
} from "@src/store/workstation/tabHost";

export function useActiveTabHostReconciliation(
  effectiveHost: WorkstationTabHost | null
): void {
  const dockFilter = useAtomValue(dockFilterAtom);
  const tabs = useAtomValue(mainPaneTabsAtom);
  const activeTabId = useAtomValue(mainPaneActiveTabIdAtom);
  const workspace = useAtomValue(presentedWorkstationWorkspaceKeyAtom);
  const focusTab = useSetAtom(focusWorkstationTabAtom);
  const lastActiveTabIdByHostRef = useRef<
    Partial<Record<WorkstationTabHost, string>>
  >({});

  useEffect(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const activeHost = activeTab ? tabToHost(activeTab) : null;
    if (activeTab && activeHost) {
      lastActiveTabIdByHostRef.current[activeHost] = activeTab.id;
    }

    if (!effectiveHost || dockFilter === "all" || tabs.length === 0) return;
    if (activeHost === effectiveHost) return;

    const rememberedTabId = lastActiveTabIdByHostRef.current[effectiveHost];
    const rememberedTarget = rememberedTabId
      ? tabs.find(
          (tab) =>
            tab.id === rememberedTabId && tabToHost(tab) === effectiveHost
        )
      : null;
    const target =
      rememberedTarget ?? tabs.find((tab) => tabToHost(tab) === effectiveHost);
    if (!target || target.id === activeTabId) return;

    lastActiveTabIdByHostRef.current[effectiveHost] = target.id;
    focusTab({ workspace, tabId: target.id });
  }, [activeTabId, dockFilter, effectiveHost, focusTab, tabs, workspace]);
}
