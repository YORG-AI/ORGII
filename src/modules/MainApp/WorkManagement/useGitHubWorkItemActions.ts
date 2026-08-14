import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import {
  githubIssueResourceKey,
  loadGitHubIssueTimeline,
  primeGitHubIssueDetailBundle,
} from "@src/modules/shared/githubIssueDetailCoordinator";
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
      const resourceKey = issue.authScope
        ? githubIssueResourceKey(issue.authScope, issue.repo, issue.id)
        : null;
      const selectedIssueAtom =
        workstationSelectedIssueAtomFamily(stateScopeKey);
      store.set(selectedIssueAtom, {
        resourceKey,
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
          authScope: issue.authScope ?? undefined,
          viewerLogin: issue.viewerLogin,
          repoPermissions: issue.repoPermissions,
        });
      } else {
        openTab(
          createGitHubIssueDetailTab(
            issue.id,
            issue.title,
            issue.repoPath,
            issue.remoteUrl,
            stateScopeKey,
            issue.authScope ?? undefined,
            issue.viewerLogin,
            issue.repoPermissions
          )
        );
      }
      if (!resourceKey) return;
      void loadGitHubIssueTimeline(store, resourceKey, async () => {
        const result = await fetchIssueTimeline({
          remoteUrl: issue.remoteUrl,
          issueNumber: issue.id,
        });
        if (result.error) throw new Error(result.error);
        return result.data ?? [];
      })
        .then((timeline) => {
          store.set(selectedIssueAtom, (current) => {
            if (current.issue?.html_url !== issue.rawIssue.html_url)
              return current;
            return {
              ...current,
              timeline,
              timelineLoading: false,
              error: null,
            };
          });
          primeGitHubIssueDetailBundle(store, resourceKey, {
            issue: issue.rawIssue,
            timeline,
            error: null,
          });
        })
        .catch((error: unknown) => {
          store.set(selectedIssueAtom, (current) =>
            current.resourceKey === resourceKey
              ? {
                  ...current,
                  timelineLoading: false,
                  error: error instanceof Error ? error.message : String(error),
                }
              : current
          );
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
        updatedAt: pr.updatedAt,
        additions: pr.rawPr.additions,
        deletions: pr.rawPr.deletions,
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
