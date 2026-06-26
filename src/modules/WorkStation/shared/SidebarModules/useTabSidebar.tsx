/**
 * SidebarSlot
 *
 * Resolves and renders tab-specific sidebars from `registry.ts`. The slot owns
 * default-sidebar fallback and descriptor-level keep-alive behavior so hosts do
 * not need one-off warm-mount branches for individual tab types.
 */
import React, { memo, useEffect, useMemo, useState } from "react";

import type {
  SourceControlHistorySelection,
  WorkStationTab,
  WorkStationTabType,
} from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import {
  type TabSidebarRuntimeContext,
  getInitialKeepAliveTabsByType,
  getTabSidebarDescriptor,
  hasTabSidebar,
} from "./registry";

type TabSidebarExtraContext = Partial<
  Omit<TabSidebarRuntimeContext, "repoPath" | "repoId" | "git">
>;

interface UseTabSidebarOptions {
  activeTab: WorkStationTab | null;
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

interface SidebarSlotProps extends UseTabSidebarOptions {
  defaultSidebar: React.ReactNode;
}

interface TabSidebarRendererProps {
  tab: WorkStationTab;
  context: TabSidebarRuntimeContext;
}

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
}: Omit<UseTabSidebarOptions, "activeTab"> & {
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

export function useTabSidebar({
  activeTab,
  repoPath,
  repoId,
  isMultiRoot,
  onGitFileSelect,
  onGitFilesChange,
  onGitHistorySelectionChange,
  extraContext,
}: UseTabSidebarOptions): React.ReactElement | null {
  if (!activeTab || !repoPath || !shouldRenderSidebar(activeTab)) return null;

  const context = buildSidebarContext({
    repoPath,
    repoId,
    isMultiRoot,
    onGitFileSelect,
    onGitFilesChange,
    onGitHistorySelectionChange,
    extraContext,
  });

  return <TabSidebarRenderer tab={activeTab} context={context} />;
}

export const SidebarSlot: React.FC<SidebarSlotProps> = memo(
  ({
    activeTab,
    repoPath,
    repoId,
    isMultiRoot,
    onGitFileSelect,
    onGitFilesChange,
    onGitHistorySelectionChange,
    extraContext,
    defaultSidebar,
  }) => {
    const initialWarmTabsByType = useMemo(() => {
      const entries = Object.entries(getInitialKeepAliveTabsByType()) as Array<
        [WorkStationTabType, WorkStationTab]
      >;

      return entries.reduce<
        Partial<Record<WorkStationTabType, WorkStationTab>>
      >((accumulator, [tabType, tab]) => {
        if (shouldRenderSidebar(tab)) {
          accumulator[tabType] = tab;
        }
        return accumulator;
      }, {});
    }, []);

    const [warmTabsByType, setWarmTabsByType] = useState<
      Partial<Record<WorkStationTabType, WorkStationTab>>
    >(initialWarmTabsByType);

    const activeDescriptor = activeTab
      ? getTabSidebarDescriptor(activeTab.type)
      : undefined;
    const activeSidebarRenderable = Boolean(
      activeTab && shouldRenderSidebar(activeTab)
    );
    const activeKeepAlive = Boolean(
      activeTab && activeDescriptor?.keepAlive && activeSidebarRenderable
    );

    useEffect(() => {
      if (
        !activeTab ||
        !activeDescriptor?.keepAlive ||
        !activeSidebarRenderable
      ) {
        return;
      }

      const frameId = window.requestAnimationFrame(() => {
        setWarmTabsByType((prev) => {
          if (prev[activeTab.type] === activeTab) return prev;
          return { ...prev, [activeTab.type]: activeTab };
        });
      });

      return () => window.cancelAnimationFrame(frameId);
    }, [activeDescriptor?.keepAlive, activeSidebarRenderable, activeTab]);

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

    const activeWarmTab =
      activeTab && activeKeepAlive ? warmTabsByType[activeTab.type] : undefined;
    const shouldRenderDirectActiveSidebar =
      activeTab && context && activeSidebarRenderable && !activeWarmTab;

    const activeSidebar = shouldRenderDirectActiveSidebar ? (
      <TabSidebarRenderer tab={activeTab} context={context} />
    ) : null;

    const warmSidebars = context
      ? Object.entries(warmTabsByType).flatMap(([tabType, warmTab]) => {
          if (!warmTab) return [];
          const descriptor = getTabSidebarDescriptor(warmTab.type);
          if (!descriptor?.keepAlive) return [];
          const isActiveWarmSidebar =
            activeKeepAlive && activeTab?.type === tabType;
          return [
            <div
              key={warmTab.type}
              className="absolute inset-0 flex min-h-0 flex-col"
              style={{ display: isActiveWarmSidebar ? undefined : "none" }}
            >
              <TabSidebarRenderer tab={warmTab} context={context} />
            </div>,
          ];
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
        ) : activeWarmTab ? null : (
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
