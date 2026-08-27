/**
 * diffSessionReplay.useDetailContent
 *
 * Builds the Diff replay app's main detail pane: a selected commit's detail
 * view, the Submissions empty/placeholder states, or the cumulative diff
 * section list. Split out of `index.tsx` to keep the host component focused
 * on top-level layout/state wiring.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import {
  type DiffFileNavigationItem,
  type DiffFileSectionData,
  DiffSectionList,
} from "@src/modules/WorkStation/shared";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { DiffViewMode } from "@src/types/git/types";

import type { DiffReplayTab } from "./types";
import type { SubmissionRepoContext } from "./useSubmissionsData";

const GitCommitDetailContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent")
);

export interface UseDiffDetailContentParams {
  activeTab: DiffReplayTab;
  historySelection: SourceControlHistorySelection | null;
  historyRepoContext: { repoId?: string; repoPath?: string } | null;
  fallbackRepoContext: SubmissionRepoContext;
  hasSubmissions: boolean;
  consolidatedSections: DiffFileNavigationItem<DiffFileSectionData>[];
  orgtrackFinalDiffsLoading: boolean;
  focusedDiffPath: string | null;
  focusedDiffNonce: number;
  collapseAllSignal: number;
  diffViewMode: DiffViewMode;
}

export function useDiffDetailContent({
  activeTab,
  historySelection,
  historyRepoContext,
  fallbackRepoContext,
  hasSubmissions,
  consolidatedSections,
  orgtrackFinalDiffsLoading,
  focusedDiffPath,
  focusedDiffNonce,
  collapseAllSignal,
  diffViewMode,
}: UseDiffDetailContentParams): React.ReactNode {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");

  return useMemo(() => {
    if (historySelection?.type === "commit") {
      const detailRepoPath =
        historyRepoContext?.repoPath ?? fallbackRepoContext.repoPath;
      const detailRepoId =
        historyRepoContext?.repoId ??
        fallbackRepoContext.repoId ??
        detailRepoPath;
      const repoReady = Boolean(detailRepoPath && detailRepoId);
      if (!repoReady) {
        return (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={historySelection.commitMessage}
            subtitle={historySelection.shortSha}
            fillParentHeight
          />
        );
      }

      return (
        <React.Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              title={tCommon("actions.loading")}
              fillParentHeight
            />
          }
        >
          <GitCommitDetailContent
            repoId={detailRepoId ?? ""}
            repoPath={detailRepoPath ?? ""}
            commitSha={historySelection.commitSha}
            shortSha={historySelection.shortSha}
            commitMessage={historySelection.commitMessage}
            isRepoReady={repoReady}
            publishHeaderToWorkstation={false}
          />
        </React.Suspense>
      );
    }

    if (activeTab === "submissions") {
      // The commits/PR list lives in the sidebar now (master-detail). A
      // selected commit is rendered by the `historySelection` branch above;
      // here we only need the "nothing selected" / "nothing shipped" states.
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t(
            hasSubmissions
              ? "simulator.replay.diffApp.submissions.selectSubmission"
              : "simulator.replay.diffApp.submissions.empty",
            hasSubmissions
              ? "Select a submission to view details"
              : "No submissions yet"
          )}
          fillParentHeight
        />
      );
    }

    return (
      <DiffSectionList
        sections={consolidatedSections}
        viewMode={diffViewMode}
        loading={orgtrackFinalDiffsLoading}
        emptyTitle={t(
          "simulator.replay.diffApp.emptyForFilter",
          "No diffs yet"
        )}
        focusedPath={focusedDiffPath}
        focusedNonce={focusedDiffNonce}
        collapseSignal={collapseAllSignal}
        collapseThreshold={3}
        hideBottomPadding
      />
    );
  }, [
    historySelection,
    historyRepoContext,
    fallbackRepoContext,
    tCommon,
    activeTab,
    hasSubmissions,
    consolidatedSections,
    orgtrackFinalDiffsLoading,
    focusedDiffPath,
    focusedDiffNonce,
    collapseAllSignal,
    diffViewMode,
    t,
  ]);
}
