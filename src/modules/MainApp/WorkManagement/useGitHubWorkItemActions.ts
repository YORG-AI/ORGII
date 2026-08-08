import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import { fetchIssueTimeline } from "@src/services/git/operations/githubIssues";
import {
  openGitHubIssueInChatPanelTabAtom,
  openGitHubPrInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import {
  workstationIssueDetailScopeKey,
  workstationSelectedIssueAtomFamily,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
import {
  createGitHubIssueDetailTab,
  createGitHubPrDetailTab,
} from "@src/store/workstation/tabs";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import type { ManagedIssueItem, ManagedPrItem } from "./githubManagedItemModel";
import type { WorkManagementDetailHost } from "./workManagementDetailHost";

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

export function useGitHubWorkItemActions({
  detailHost,
}: {
  detailHost: WorkManagementDetailHost;
}) {
  const { t } = useTranslation(["sessions", "common"]);
  const store = useStore();
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const openIssueInChatPanel = useSetAtom(openGitHubIssueInChatPanelTabAtom);
  const openPrInChatPanel = useSetAtom(openGitHubPrInChatPanelTabAtom);
  const { openTab } = useWorkStationTabs();

  const openIssueInBrowser = useCallback((issue: ManagedIssueItem) => {
    void openExternalLink(issue.rawIssue.html_url);
  }, []);

  const openIssueInTab = useCallback(
    (issue: ManagedIssueItem) => {
      const stateScopeKey = workstationIssueDetailScopeKey(
        issue.repoPath,
        issue.id
      );
      const selectedIssueAtom =
        workstationSelectedIssueAtomFamily(stateScopeKey);
      store.set(selectedIssueAtom, {
        issue: issue.rawIssue,
        timeline: [],
        loading: false,
        timelineLoading: true,
        error: null,
        submittingComment: false,
      });
      if (detailHost === "chat") {
        openIssueInChatPanel({
          issueNumber: issue.id,
          issueTitle: issue.title,
          repoPath: issue.repoPath,
          remoteUrl: issue.remoteUrl,
          stateScopeKey,
        });
      } else {
        openTab(
          createGitHubIssueDetailTab(
            issue.id,
            issue.title,
            issue.repoPath,
            issue.remoteUrl,
            stateScopeKey
          )
        );
      }
      void fetchIssueTimeline({
        remoteUrl: issue.remoteUrl,
        issueNumber: issue.id,
      }).then((result) => {
        store.set(selectedIssueAtom, (current) => {
          if (current.issue?.html_url !== issue.rawIssue.html_url)
            return current;
          return {
            ...current,
            timeline: result.data ?? [],
            timelineLoading: false,
            error: result.error ?? null,
          };
        });
      });
    },
    [detailHost, openIssueInChatPanel, openTab, store]
  );

  const openPrInTab = useCallback(
    (pr: ManagedPrItem) => {
      const detail = {
        prNumber: pr.id,
        prTitle: pr.title,
        prUrl: pr.rawPr.url,
        prStatus: pr.rawPr.draft ? "draft" : pr.state,
        headBranch: pr.sourceBranch,
        baseBranch: pr.targetBranch,
        repoPath: pr.repoPath,
        repoId: pr.repoId,
      };
      if (detailHost === "chat") {
        openPrInChatPanel(detail);
      } else {
        openTab(createGitHubPrDetailTab(detail));
      }
    },
    [detailHost, openPrInChatPanel, openTab]
  );

  const addIssue = useCallback(
    (issue: ManagedIssueItem) => {
      setAddToAgent(toIssueContext(issue.rawIssue));
      Message.success(
        t("common:toasts.addedAsContext", { name: `#${issue.id}` })
      );
    },
    [setAddToAgent, t]
  );

  const addCreatedIssue = useCallback(
    (issue: GitHubIssue) => {
      Message.success(
        t("common:toasts.addedAsContext", { name: `#${issue.number}` })
      );
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
      Message.success(
        t("common:toasts.addedAsContext", { name: `PR #${pr.id}` })
      );
    },
    [setAddToAgent, t]
  );

  return {
    openIssueInBrowser,
    openIssueInTab,
    openPrInTab,
    addIssue,
    addCreatedIssue,
    addPr,
  };
}
