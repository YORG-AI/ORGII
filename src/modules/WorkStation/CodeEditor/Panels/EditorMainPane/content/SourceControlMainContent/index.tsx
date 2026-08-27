/**
 * SourceControlMainContent
 *
 * Main-pane renderer for the unified Source Control tab. The Focus / All
 * Changes pill lives in the global 40px workstation tab-header strip as the
 * primary mode selector for the tab.
 *
 * In Focus mode with a loaded file, the file breadcrumb renders in its own
 * 40px header inside the main pane directly above the diff editor.
 */
import React, { Suspense, memo, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import AllChangesView from "./AllChangesView";
import FocusView from "./FocusView";

const GitCommitDetailContent = React.lazy(
  () => import("../GitCommitDetailContent")
);
const IssueDetailPanel = React.lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel").then(
    (module) => ({ default: module.IssueDetailPanel })
  )
);
const PrDetailPanel = React.lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel").then(
    (module) => ({ default: module.PrDetailPanel })
  )
);

const DetailFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

export type SourceControlPillMode = "focus" | "all-changes";

export interface SourceControlMainContentProps {
  /** Current pill mode */
  mode: SourceControlPillMode;
  // Focus mode
  /** Resolved git diff record for the focused file (null until loaded) */
  focusGitFile: GitFile | null;
  /** Whether a focus path is currently selected */
  hasFocus: boolean;
  /** Force-reload the focused file's diff */
  onForceReload?: () => void;
  /** Open the focused file as a regular file tab */
  onFileSelect?: (path: string) => void;
  /** Clear the focused file without closing Source Control. */
  onCloseFocus?: () => void;
  /** Sync git-diff local edits to tab bar unsaved indicator */
  onGitDiffUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Selected commit/stash rendered in the Source Control right pane. */
  historySelection?: SourceControlHistorySelection | null;

  // All Changes mode
  files: GitFile[];
  loading: boolean;
  staged: boolean;
  repoId?: string;
  repoPath?: string;
  collapseAllSignal?: number;
  /** Source Control navigation shown when no detail is selected. */
  emptyFocusActions: QuickAction[];
}

const SourceControlMainContent: React.FC<SourceControlMainContentProps> = ({
  mode,
  focusGitFile,
  hasFocus,
  onForceReload,
  onFileSelect,
  onCloseFocus,
  onGitDiffUnsavedChange,
  historySelection,
  files,
  loading,
  staged,
  repoId,
  repoPath,
  collapseAllSignal,
  emptyFocusActions,
}) => {
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const {
    selectedState: selectedIssueState,
    interaction,
    assigneeConfig,
  } = useGitHubIssueDetailState({
    repoPath: repoPath ?? "",
    repoId,
    stateScopeKey: scopeKey,
  });

  // `historySelection` keeps a stable reference across renders (it comes from
  // the persisted tab payload), so memoizing on it directly gives a stable
  // `prIdentity` — which keeps `useWorkstationPrDetail` from re-fetching.
  const prSelection = historySelection?.type === "pr" ? historySelection : null;
  const prIdentity = useMemo<PrIdentity | null>(
    () =>
      prSelection
        ? {
            number: prSelection.prNumber,
            title: prSelection.prTitle,
            url: prSelection.prUrl,
            status: prSelection.prStatus,
            headBranch: prSelection.headBranch,
          }
        : null,
    [prSelection]
  );

  if (prIdentity) {
    return (
      <Suspense fallback={<DetailFallback />}>
        <PrDetailPanel
          identity={prIdentity}
          repoPath={repoPath ?? ""}
          repoId={repoId}
          onFileSelect={onFileSelect}
        />
      </Suspense>
    );
  }

  if (historySelection?.type === "issue") {
    if (!selectedIssueState.issue) {
      return (
        <NoTabsPlaceholder icon="source-control" actions={emptyFocusActions} />
      );
    }

    return (
      <Suspense fallback={<DetailFallback />}>
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

  // Commit / stash selections render the single-commit diff. (PR and issue
  // selections are handled by their dedicated panels above; the issue return
  // already narrowed `"issue"` out of the type here.)
  if (historySelection && historySelection.type !== "pr") {
    const resolvedRepoId = repoId ?? repoPath;
    const repoReady = Boolean(repoPath && resolvedRepoId);

    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          }
        >
          <GitCommitDetailContent
            commitSha={historySelection.commitSha}
            shortSha={historySelection.shortSha}
            commitMessage={historySelection.commitMessage}
            repoPath={repoPath ?? ""}
            repoId={resolvedRepoId ?? ""}
            isRepoReady={repoReady}
            onFileSelect={onFileSelect}
            headerVariant={
              historySelection.type === "stash" ? "stash" : "commit"
            }
            headerRootLabel={
              historySelection.type === "stash"
                ? historySelection.stashRef
                : undefined
            }
            publishHeaderToWorkstation={false}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {mode === "focus" ? (
        <FocusView
          gitFile={focusGitFile}
          loading={loading}
          repoPath={repoPath}
          hasFocus={hasFocus}
          onReload={onForceReload}
          onFileSelect={onFileSelect}
          onClose={onCloseFocus}
          onUnsavedChange={onGitDiffUnsavedChange}
        />
      ) : (
        <AllChangesView
          files={files}
          loading={loading}
          staged={staged}
          repoId={repoId}
          repoPath={repoPath}
          onFileSelect={onFileSelect}
          collapseAllSignal={collapseAllSignal}
        />
      )}
    </div>
  );
};

SourceControlMainContent.displayName = "SourceControlMainContent";

export default memo(SourceControlMainContent);
export { AllChangesView };
export type { AllChangesViewProps } from "./AllChangesView";
