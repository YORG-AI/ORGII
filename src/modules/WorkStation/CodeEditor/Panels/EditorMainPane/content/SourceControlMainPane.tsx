/**
 * SourceControlMainPane
 *
 * Keep-alive wrapper for the Source Control main-pane view. `EditorMainPane`
 * renders this in a persistent overlay (mounted once the Source Control tab has
 * been visited, then shown/hidden instead of unmounted) so the diff view,
 * scroll position, and lazy chunk survive navigating to a file tab and back
 * (issue #16). It is driven by the persisted Source Control tab payload rather
 * than the transient active tab, so the data stays correct while hidden.
 */
import { useAtomValue } from "jotai";
import React, { Suspense, memo, useCallback } from "react";

import { IssueDetailPanel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
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
      <IssueDetailPanel
        issue={selectedIssueState.issue}
        comments={selectedIssueState.comments}
        commentsLoading={selectedIssueState.commentsLoading}
        submittingComment={selectedIssueState.submittingComment}
        showHeader={false}
        onClose={() => undefined}
        onCloseIssue={handleCloseIssue}
        onReopenIssue={handleReopenIssue}
        onAddComment={handleAddIssueComment}
      />
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
