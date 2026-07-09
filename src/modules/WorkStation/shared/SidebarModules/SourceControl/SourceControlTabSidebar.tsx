/**
 * SourceControlTabSidebar
 *
 * Tab-specific sidebar for the pinned `source-control` tab. Wraps
 * `useSourceControlSidebarModule` in a single-tab
 * `PrimarySidebarLayoutWithSections` shell so it renders with the same
 * chrome (header, sections, resizable stacks) as the host's default
 * sidebar.
 *
 * Registers itself in `TAB_SIDEBAR_REGISTRY` at module-init so any host
 * that uses `useTabSidebar()` will pick it up automatically when the
 * Source Control tab becomes active.
 */
import { useCallback, useState } from "react";

import type { GitWorktreeEntry } from "@src/api/http/git/types";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { sourceControlTabFactory } from "@src/store/workstation/tabs";

import { PrimarySidebarLayoutWithSections } from "../../PrimarySidebarLayout";
import {
  type TabSidebarComponent,
  type TabSidebarProps,
  registerTabSidebar,
} from "../registry";
import type { SourceControlFilterMode } from "./SourceControlFilterHeader";
import { useSourceControlSidebarModule } from "./useSourceControlSidebarModule";

interface SourceControlSidebarContext {
  filterMode?: SourceControlFilterMode;
  navigateWithoutSelecting?: boolean;
  worktrees?: GitWorktreeEntry[];
  hasWorktrees?: boolean;
  worktreesLoading?: boolean;
  refreshWorktrees?: () => Promise<void>;
}

function getSourceControlSidebarContext(
  value: unknown
): SourceControlSidebarContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as SourceControlSidebarContext;
}

const SourceControlTabSidebar: TabSidebarComponent = ({
  context,
}: TabSidebarProps) => {
  const sourceControlContext = getSourceControlSidebarContext(
    context.surface?.sourceControl
  );
  const { currentBranch } = useRepoSelection({ autoLoad: false });

  // When this sidebar runs inside CodeEditor, `useSourceControlSetup` already
  // owns the single `useGitWorktrees` mount and forwards its result via
  // `context.surface.sourceControl`. Passing the host-provided array (even `[]`)
  // ensures the `enabled` guard inside `useSourceControlTabConfig` stays false,
  // preventing a duplicate fetch. Fall back to `undefined` only when this
  // component is rendered outside CodeEditor (standalone/test usage).
  const hostWorktrees = context.surface?.sourceControl
    ? (sourceControlContext?.worktrees ?? [])
    : undefined;
  const hostHasWorktrees = context.surface?.sourceControl
    ? (sourceControlContext?.hasWorktrees ?? false)
    : undefined;

  const { tab } = useSourceControlSidebarModule({
    repoPath: context.repoPath,
    repoId: context.repoId,
    branchName: currentBranch,
    onGitFileSelect: context.git?.onFileSelect,
    onGitHistorySelectionChange: context.git?.onHistorySelectionChange,
    onGitFilesChange: context.git?.onFilesChange,
    isMultiRoot: context.isMultiRoot,
    filterMode: sourceControlContext?.filterMode,
    navigateWithoutSelecting:
      sourceControlContext?.navigateWithoutSelecting ?? false,
    worktrees: hostWorktrees,
    hasWorktrees: hostHasWorktrees,
    worktreesLoading: sourceControlContext?.worktreesLoading,
    refreshWorktrees: sourceControlContext?.refreshWorktrees,
  });

  const [activeTab] = useState(tab.key);
  const handleTabChange = useCallback(() => {
    // No-op: only one tab in this shell.
  }, []);

  return (
    <PrimarySidebarLayoutWithSections
      tabs={[tab]}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      hideTabs
    />
  );
};

SourceControlTabSidebar.displayName = "SourceControlTabSidebar";

registerTabSidebar("source-control", {
  component: SourceControlTabSidebar,
  keepAlive: true,
  keepAliveInitialTab: sourceControlTabFactory({
    mode: "focus",
    staged: false,
    fileCount: 0,
    focusPath: null,
    historySelection: null,
  }),
});

export { SourceControlTabSidebar };
