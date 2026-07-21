import { useCallback, useState } from "react";

import type { GitWorktreeEntry } from "@src/api/http/git/types";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";

import { PrimarySidebarLayoutWithSections } from "../../PrimarySidebarLayout";
import type { TabSidebarProps } from "../registry";
import type { SourceControlFilterMode } from "./SourceControlFilterHeader";
import { useSourceControlSidebarModule } from "./useSourceControlSidebarModule";

interface SourceControlSidebarContext {
  filterMode?: SourceControlFilterMode;
  onFilterModeChange?: (mode: SourceControlFilterMode) => void;
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

const SourceControlTabSidebarContent: React.FC<TabSidebarProps> = ({
  context,
}) => {
  const sourceControlContext = getSourceControlSidebarContext(
    context.surface?.sourceControl
  );
  const { currentBranch } = useRepoSelection({ autoLoad: false });

  // CodeEditor owns the primary worktree request and forwards the result.
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
    onFilterModeChange: sourceControlContext?.onFilterModeChange,
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

SourceControlTabSidebarContent.displayName = "SourceControlTabSidebarContent";

export default SourceControlTabSidebarContent;
