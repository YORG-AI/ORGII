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
import { useTranslation } from "react-i18next";

import { IssueDetailPanel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import type { QuickAction } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { sourceControlSessionFilterAtom } from "@src/store/workstation/codeEditor/sourceControlSessionFilterAtom";
import {
  workstationIssueCallbackAtom,
  workstationSelectedIssueAtom,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
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
  sourceControlAttributedFiles: GitFile[];
  sourceControlFilterMode: string;
  gitDiffLoading: boolean;
  sourceControlCollapseAllSignal?: number;
  editorQuickActions: QuickAction[];
  onForceReload?: () => void;
  onFileSelect?: (path: string) => void;
  onGitDiffUnsavedChange?: (hasUnsaved: boolean) => void;
}

const SourceControlMainPane: React.FC<SourceControlMainPaneProps> = ({
  tabData,
  repoPath,
  repoId,
  gitFilesByPath,
  sourceControlAttributedFiles,
  sourceControlFilterMode,
  gitDiffLoading,
  sourceControlCollapseAllSignal,
  editorQuickActions,
  onForceReload,
  onFileSelect,
  onGitDiffUnsavedChange,
}) => {
  const { t } = useTranslation();
  const sourceControlSessionFilter = useAtomValue(
    sourceControlSessionFilterAtom
  );
  const selectedIssueState = useAtomValue(workstationSelectedIssueAtom);
  const issueCallbacks = useAtomValue(workstationIssueCallbackAtom);

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
      sourceControlAttributedFiles,
      sourceControlFilterMode,
      sourceControlSessionFilter,
      repoPath,
    });

  if (sourceControlFilterMode === "issues") {
    if (!selectedIssueState.issue) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("previews.noIssueSelected")}
          subtitle={t("previews.selectIssueHint")}
          fillParentHeight
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Suspense fallback={<LazyFallback />}>
        <SourceControlMainContent
          mode={mode}
          focusGitFile={focusGitFile}
          hasFocus={Boolean(focusPath)}
          onForceReload={onForceReload}
          onFileSelect={onFileSelect}
          onGitDiffUnsavedChange={onGitDiffUnsavedChange}
          historySelection={historySelection}
          files={allFiles}
          loading={gitDiffLoading && allFiles.length === 0}
          staged={staged}
          repoId={repoId ?? undefined}
          repoPath={repoPath}
          collapseAllSignal={sourceControlCollapseAllSignal}
          emptyFocusActions={editorQuickActions}
        />
      </Suspense>
    </div>
  );
};

export default memo(SourceControlMainPane);
