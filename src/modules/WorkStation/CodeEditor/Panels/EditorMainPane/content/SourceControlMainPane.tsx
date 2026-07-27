/**
 * SourceControlMainPane
 *
 * Active-only wrapper for the Source Control main-pane view. `EditorMainPane`
 * unmounts it when the user leaves Source Control so diff editors, file
 * content, and subscriptions are released.
 */
import { useAtomValue } from "jotai";
import React, { Suspense, memo, useCallback } from "react";

import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  workstationIssueCallbackAtomFamily,
  workstationSelectedIssueAtomFamily,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
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
  gitDiffLoading,
  sourceControlCollapseAllSignal,
  sourceControlQuickActions,
  onForceReload,
  onFileSelect,
  onCloseFocus,
  onGitDiffUnsavedChange,
}) => {
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const selectedIssueState = useAtomValue(
    workstationSelectedIssueAtomFamily(scopeKey)
  );
  const issueCallbacks = useAtomValue(
    workstationIssueCallbackAtomFamily(scopeKey)
  );

  const handleCloseIssue = useCallback(() => {
    if (selectedIssueState.issue && issueCallbacks.closeIssue) {
      void issueCallbacks.closeIssue(selectedIssueState.issue.number);
    }
  }, [selectedIssueState.issue, issueCallbacks]);

  const handleReopenIssue = useCallback(() => {
    if (selectedIssueState.issue && issueCallbacks.reopenIssue) {
      void issueCallbacks.reopenIssue(selectedIssueState.issue.number);
    }
  }, [selectedIssueState.issue, issueCallbacks]);

  const handleAddIssueComment = useCallback(
    async (body: string) => {
      if (selectedIssueState.issue && issueCallbacks.addComment) {
        await issueCallbacks.addComment(selectedIssueState.issue.number, body);
      }
    },
    [selectedIssueState.issue, issueCallbacks]
  );

  const { mode, staged, focusPath, historySelection, allFiles, focusGitFile } =
    deriveSourceControlMainProps({
      tabData,
      gitFilesByPath,
      sourceControlFiles,
      sourceControlFilterMode,
      repoPath,
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
      <Suspense fallback={<LazyFallback />}>
        <IssueDetailPanel
          issue={selectedIssueState.issue}
          timeline={selectedIssueState.timeline}
          timelineLoading={selectedIssueState.timelineLoading}
          submittingComment={selectedIssueState.submittingComment}
          showHeader={false}
          onClose={() => undefined}
          onCloseIssue={handleCloseIssue}
          onReopenIssue={handleReopenIssue}
          onAddComment={handleAddIssueComment}
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
          hasFocus={Boolean(focusPath)}
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
