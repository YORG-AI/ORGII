/**
 * SidebarSlot
 *
 * Resolves and renders tab-specific sidebars from `registry.ts`. The slot owns
 * default-sidebar fallback and the retained-sidebar behaviour so hosts do not
 * need one-off warm-mount branches for individual tab types.
 *
 * Which sidebars stay mounted after their tab is left is not a per-sidebar
 * flag: the host passes the tabs the shared retention policy currently keeps
 * warm (`@src/store/workstation/tabs/tabRetention`, via
 * `useRetainedTabPool`), and this slot keeps exactly those sidebars mounted —
 * hidden with `visibility:hidden` so their scroll offsets survive — in
 * lockstep with the host's main pane.
 */
import React, { memo, useMemo } from "react";

import type {
  SourceControlHistorySelection,
  WorkStationTab,
} from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import {
  type TabSidebarRuntimeContext,
  getTabSidebarDescriptor,
  hasTabSidebar,
} from "./registry";

type TabSidebarExtraContext = Partial<
  Omit<TabSidebarRuntimeContext, "repoPath" | "repoId" | "git">
>;

interface TabSidebarOptions {
  activeTab: WorkStationTab | null;
  /**
   * Tabs the retention policy keeps mounted-but-hidden (the active tab
   * included when it is retained). Their sidebars are kept warm here.
   */
  retainedTabs?: readonly WorkStationTab[];
  repoPath: string | null;
  repoId: string | null;
  isMultiRoot?: boolean;
  onGitFileSelect?: (file: GitFile) => void;
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot?: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  extraContext?: TabSidebarExtraContext;
}

interface SidebarSlotProps extends TabSidebarOptions {
  defaultSidebar: React.ReactNode;
}

interface TabSidebarRendererProps {
  tab: WorkStationTab;
  context: TabSidebarRuntimeContext;
}

const NO_RETAINED_TABS: readonly WorkStationTab[] = [];

function shouldRenderSidebar(tab: WorkStationTab): boolean {
  if (!hasTabSidebar(tab.type)) return false;

  if (tab.type === "git-diff") {
    const origin = (tab.data as { origin?: string } | undefined)?.origin;
    return origin === "source-control";
  }

  return true;
}

function buildSidebarContext({
  repoPath,
  repoId,
  isMultiRoot,
  onGitFileSelect,
  onGitFilesChange,
  onGitHistorySelectionChange,
  extraContext,
}: Omit<TabSidebarOptions, "activeTab" | "retainedTabs"> & {
  repoPath: string;
}): TabSidebarRuntimeContext {
  return {
    ...extraContext,
    isMultiRoot,
    repoPath,
    repoId: repoId ?? repoPath,
    git: {
      onFileSelect: onGitFileSelect,
      onFilesChange: onGitFilesChange,
      onHistorySelectionChange: onGitHistorySelectionChange,
    },
  };
}

const TabSidebarRenderer: React.FC<TabSidebarRendererProps> = memo(
  ({ tab, context }) => {
    const descriptor = getTabSidebarDescriptor(tab.type);
    if (!descriptor) return null;
    return React.createElement(descriptor.component, { tab, context });
  }
);
TabSidebarRenderer.displayName = "TabSidebarRenderer";

export const SidebarSlot: React.FC<SidebarSlotProps> = memo(
  ({
    activeTab,
    retainedTabs = NO_RETAINED_TABS,
    repoPath,
    repoId,
    isMultiRoot,
    onGitFileSelect,
    onGitFilesChange,
    onGitHistorySelectionChange,
    extraContext,
    defaultSidebar,
  }) => {
    const context = useMemo(() => {
      if (!repoPath) return null;
      return buildSidebarContext({
        repoPath,
        repoId,
        isMultiRoot,
        onGitFileSelect,
        onGitFilesChange,
        onGitHistorySelectionChange,
        extraContext,
      });
    }, [
      extraContext,
      isMultiRoot,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange,
      repoId,
      repoPath,
    ]);

    // Retained tabs that own a sidebar get a persistent keyed layer each.
    const warmSidebarTabs = useMemo(
      () => retainedTabs.filter((tab) => shouldRenderSidebar(tab)),
      [retainedTabs]
    );
    const activeSidebarRenderable = Boolean(
      activeTab && shouldRenderSidebar(activeTab)
    );
    const activeHasWarmLayer =
      activeTab !== null &&
      warmSidebarTabs.some((tab) => tab.id === activeTab.id);
    const shouldRenderDirectActiveSidebar =
      activeTab && context && activeSidebarRenderable && !activeHasWarmLayer;

    const activeSidebar = shouldRenderDirectActiveSidebar ? (
      <TabSidebarRenderer tab={activeTab} context={context} />
    ) : null;

    const warmSidebars = context
      ? warmSidebarTabs.map((tab) => {
          const visible = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              className="absolute inset-0 flex min-h-0 flex-col"
              style={visible ? undefined : { visibility: "hidden" }}
              aria-hidden={!visible}
            >
              <TabSidebarRenderer tab={tab} context={context} />
            </div>
          );
        })
      : [];

    if (!activeSidebar && warmSidebars.length === 0) {
      return <>{defaultSidebar}</>;
    }

    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {activeSidebar ? (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {activeSidebar}
          </div>
        ) : activeHasWarmLayer ? null : (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {defaultSidebar}
          </div>
        )}
        {warmSidebars}
      </div>
    );
  }
);
SidebarSlot.displayName = "SidebarSlot";
