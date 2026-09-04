/**
 * SourceControlMainPane
 *
 * Active-only wrapper for the Source Control main-pane view. `EditorMainPane`
 * unmounts it when the user leaves Source Control so diff editors, file
 * content, and subscriptions are released.
 */
import React, { Suspense, memo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import type { GitFile } from "@src/types/git/types";

import {
  type SourceControlMainTabData,
  deriveSourceControlMainProps,
} from "./sourceControlMainProps";

const SourceControlMainContent = React.lazy(
  () => import("./SourceControlMainContent")
);
const IssueDetailPanel = React.lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel").then(
    (module) => ({ default: module.IssueDetailPanel })
  )
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

export interface SourceControlMainPaneProps {
  tabData: SourceControlMainTabData;
  repoPath: string;
  repoId: string | null;
  gitFilesByPath: Map<string, GitFile>;
  sourceControlFiles: GitFile[];
  sourceControlFilterMode: string;
  activeRepoRoot: string;
  gitDiffLoading: boolean;
  sourceControlCollapseAllSignal?: number;
  sourceControlQuickActions: QuickAction[];
  onForceReload?: () => void;
  onFileSelect?: (path: string) => void;
  onCloseFocus?: () => void;
  onGitDiffUnsavedChange?: (hasUnsaved: boolean) => void;
}

const SourceControlMainPane: React.FC<SourceControlMainPaneProps> = ({
  tabData,
  repoPath,
  repoId,
  gitFilesByPath,
  sourceControlFiles,
  sourceControlFilterMode,
  activeRepoRoot,
  gitDiffLoading,
  sourceControlCollapseAllSignal,
  sourceControlQuickActions,
  onForceReload,
  onFileSelect,
  onCloseFocus,
  onGitDiffUnsavedChange,
}) => {
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const {
    selectedState: selectedIssueState,
    interaction,
    assigneeConfig,
  } = useGitHubIssueDetailState({
    repoPath,
    repoId: repoId ?? undefined,
    stateScopeKey: scopeKey,
  });

  const { mode, staged, historySelection, allFiles, focusGitFile, hasFocus } =
    deriveSourceControlMainProps({
      tabData,
      gitFilesByPath,
      sourceControlFiles,
      sourceControlFilterMode,
      repoPath,
      activeRepoRoot,
    });

  if (sourceControlFilterMode === "issues") {
    if (!selectedIssueState.issue) {
      return (
        <NoTabsPlaceholder
          icon="source-control"
          actions={sourceControlQuickActions}
        />
      );
    }

    return (
      <Suspense
        fallback={
          <GitHubDetailSkeleton
            kind="issue"
            showHeader={false}
            title={selectedIssueState.issue.title}
            number={selectedIssueState.issue.number}
          />
        }
      >
        <IssueDetailPanel
          issue={selectedIssueState.issue}
          timeline={selectedIssueState.timeline}
          timelineLoading={selectedIssueState.timelineLoading}
          interaction={interaction}
          assigneeConfig={assigneeConfig}
        />
      </Suspense>
    );
  }

  if (
    sourceControlFilterMode === "pr" &&
    (!historySelection || historySelection.type !== "pr")
  ) {
    return (
      <NoTabsPlaceholder
        icon="source-control"
        actions={sourceControlQuickActions}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Suspense fallback={<LazyFallback />}>
        <SourceControlMainContent
          mode={mode}
          focusGitFile={focusGitFile}
          hasFocus={hasFocus}
          onForceReload={onForceReload}
          onFileSelect={onFileSelect}
          onCloseFocus={onCloseFocus}
          onGitDiffUnsavedChange={onGitDiffUnsavedChange}
          historySelection={historySelection}
          files={allFiles}
          loading={gitDiffLoading && allFiles.length === 0}
          staged={staged}
          repoId={repoId ?? undefined}
          repoPath={repoPath}
          collapseAllSignal={sourceControlCollapseAllSignal}
          emptyFocusActions={sourceControlQuickActions}
        />
      </Suspense>
    </div>
  );
};

export default memo(SourceControlMainPane);
