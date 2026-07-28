/**
 * diffSessionReplay.useSidebarTab
 *
 * Builds the Diff replay app's `PrimarySidebarTab` — the file-list (Diff
 * tab) or commit/PR-list (Submissions tab) master pane shown alongside the
 * detail pane. Split out of `index.tsx` to keep the host component focused
 * on top-level layout/state wiring.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type DiffFileNavigationItem,
  DiffFileNavigationList,
  type DiffFileSectionData,
} from "@src/modules/WorkStation/shared";
import {
  type PanelSection,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";

import {
  type PullRequestSubmission,
  type SubmissionCommit,
  SubmissionCommitsContent,
  SubmissionPullRequestsContent,
} from "./SubmissionsContent";
import type { DiffReplayTab } from "./types";

export interface UseDiffSidebarTabParams {
  activeTab: DiffReplayTab;
  submissionCommits: SubmissionCommit[];
  pullRequestsWithStatus: PullRequestSubmission[];
  handleSubmissionCommitSelect: (commit: SubmissionCommit) => void;
  sidebarItems: DiffFileNavigationItem<DiffFileSectionData>[];
  historySelection: SourceControlHistorySelection | null;
  focusedDiffPath: string | null;
  setHistorySelection: Dispatch<
    SetStateAction<SourceControlHistorySelection | null>
  >;
  setHistoryRepoContext: Dispatch<
    SetStateAction<{ repoId?: string; repoPath?: string } | null>
  >;
  setFocusedDiffPath: Dispatch<SetStateAction<string | null>>;
  setFocusedDiffNonce: Dispatch<SetStateAction<number>>;
}

export function useDiffSidebarTab({
  activeTab,
  submissionCommits,
  pullRequestsWithStatus,
  handleSubmissionCommitSelect,
  sidebarItems,
  historySelection,
  focusedDiffPath,
  setHistorySelection,
  setHistoryRepoContext,
  setFocusedDiffPath,
  setFocusedDiffNonce,
}: UseDiffSidebarTabParams): PrimarySidebarTab {
  const { t } = useTranslation("sessions");

  const handleSidebarItemSelect = useCallback(
    (item: DiffFileNavigationItem<DiffFileSectionData>) => {
      setHistorySelection(null);
      setHistoryRepoContext(null);
      setFocusedDiffPath(item.file.path);
      setFocusedDiffNonce((prev) => prev + 1);
    },
    [
      setFocusedDiffNonce,
      setFocusedDiffPath,
      setHistoryRepoContext,
      setHistorySelection,
    ]
  );

  return useMemo<PrimarySidebarTab>(() => {
    // Submissions tab: the sidebar lists what the agent shipped (commits +
    // pull requests) and the main pane renders the selected commit's detail,
    // mirroring the Diff tab's file-list ↔ diff master-detail layout.
    if (activeTab === "submissions") {
      const sections: PanelSection[] = [
        {
          key: "submission-commits",
          title: t("simulator.replay.diffApp.submissions.commits", "Commits"),
          content: (
            <SubmissionCommitsContent
              commits={submissionCommits}
              selectedCommitSha={
                historySelection?.type === "commit"
                  ? historySelection.commitSha
                  : null
              }
              onCommitSelect={handleSubmissionCommitSelect}
              emptyLabel={t(
                "simulator.replay.diffApp.submissions.noCommits",
                "No Commits yet"
              )}
            />
          ),
          defaultFlexGrow: 2,
          collapsible: true,
          resizable: pullRequestsWithStatus.length > 0,
        },
      ];

      if (pullRequestsWithStatus.length > 0) {
        sections.push({
          key: "submission-prs",
          title: t("simulator.replay.diffApp.submissions.pr", "PR"),
          content: (
            <SubmissionPullRequestsContent
              pullRequests={pullRequestsWithStatus}
              emptyLabel={t(
                "simulator.replay.diffApp.submissions.noPullRequests",
                "No Pull Requests yet"
              )}
            />
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        });
      }

      return {
        key: "submissions-sidebar",
        label: t(
          "simulator.replay.diffApp.submissions.tabLabel",
          "Submissions"
        ),
        sections,
      };
    }

    return {
      key: "diff-sidebar",
      label: t("simulator.replay.diffApp.tabLabel", "Diff"),
      sections: [
        {
          key: "diff-list",
          title: t("simulator.replay.diffApp.tabLabel", "Diff"),
          content: (
            <DiffFileNavigationList
              items={sidebarItems}
              selectedEntryId={null}
              selectedPath={historySelection ? null : focusedDiffPath}
              onSelectItem={handleSidebarItemSelect}
              enableDragToInput
            />
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        },
      ],
    };
  }, [
    activeTab,
    submissionCommits,
    pullRequestsWithStatus,
    handleSubmissionCommitSelect,
    sidebarItems,
    historySelection,
    focusedDiffPath,
    handleSidebarItemSelect,
    t,
  ]);
}
