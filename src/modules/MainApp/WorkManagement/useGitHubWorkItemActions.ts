import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import { fetchIssueComments } from "@src/services/git/operations/githubIssues";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { workstationSelectedIssueAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import {
  createGitHubIssueDetailTab,
  createGitHubPrDetailTab,
} from "@src/store/workstation/tabs";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import type { ManagedIssueItem, ManagedPrItem } from "./githubManagedItemModel";

function toIssueContext(issue: GitHubIssue) {
  return {
    type: "issue" as const,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    issueState: issue.state,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
    comments: issue.comments,
  };
}

export function useGitHubWorkItemActions() {
  const { t } = useTranslation(["sessions", "common"]);
  const store = useStore();
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const { openTab } = useWorkStationTabs();

  const openIssueInBrowser = useCallback((issue: ManagedIssueItem) => {
    void openExternalLink(issue.rawIssue.html_url);
  }, []);

  const openIssueInMyStation = useCallback(
    (issue: ManagedIssueItem) => {
      const selectedIssueAtom = workstationSelectedIssueAtomFamily(
        workstationRepoScopeKey(undefined, issue.repoPath)
      );
      store.set(selectedIssueAtom, {
        issue: issue.rawIssue,
        comments: [],
        loading: false,
        commentsLoading: true,
        error: null,
        submittingComment: false,
      });
      openTab(
        createGitHubIssueDetailTab(
          issue.id,
          issue.title,
          issue.repoPath,
          issue.remoteUrl
        )
      );
      void fetchIssueComments({
        remoteUrl: issue.remoteUrl,
        issueNumber: issue.id,
      }).then((result) => {
        store.set(selectedIssueAtom, (current) => {
          if (current.issue?.html_url !== issue.rawIssue.html_url)
            return current;
          return {
            ...current,
            comments: result.data ?? [],
            commentsLoading: false,
            error: result.error ?? null,
          };
        });
      });
    },
    [openTab, store]
  );

  const addIssue = useCallback(
    (issue: ManagedIssueItem) => {
      setAddToAgent(toIssueContext(issue.rawIssue));
      Message.success(t("toasts.addedAsContext", { name: `#${issue.id}` }));
    },
    [setAddToAgent, t]
  );

  const addCreatedIssue = useCallback(
    (issue: GitHubIssue) => {
      Message.success(t("toasts.addedAsContext", { name: `#${issue.number}` }));
      setAddToAgent(toIssueContext(issue));
    },
    [setAddToAgent, t]
  );

  const addPr = useCallback(
    (pr: ManagedPrItem) => {
      setAddToAgent({
        type: "pr",
        prNumber: pr.id,
        prTitle: pr.title,
        prUrl: pr.rawPr.url,
        prStatus: pr.state,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      Message.success(t("toasts.addedAsContext", { name: `PR #${pr.id}` }));
    },
    [setAddToAgent, t]
  );

  const openPr = useCallback(
    (pr: ManagedPrItem) => {
      openTab(
        createGitHubPrDetailTab({
          prNumber: pr.id,
          prTitle: pr.title,
          prUrl: pr.rawPr.url,
          prStatus: pr.state,
          headBranch: pr.sourceBranch,
          baseBranch: pr.targetBranch,
          repoPath: pr.repoPath,
          repoId: pr.repoId,
        })
      );
      void WorkStationViewService.openStationMode("my-station");
    },
    [openTab]
  );

  return {
    openIssueInBrowser,
    openIssueInMyStation,
    addIssue,
    addCreatedIssue,
    addPr,
    openPr,
  };
}
