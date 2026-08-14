import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback } from "react";

import type { ManagedPrItem } from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import { openGitHubPrInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";

import TeamInboxView from "./TeamInboxView";
import { teamInboxItemFocusRequestAtom, teamInboxViewStateAtom } from "./store";
import { useTeamInboxDataSource } from "./useTeamInboxDataSource";
import { useTeamInboxNavigation } from "./useTeamInboxNavigation";
import { useTeamInboxPullRequests } from "./useTeamInboxPullRequests";

const StableTeamInboxView = React.memo(TeamInboxView);

const ConnectedTeamInboxView: React.FC = () => {
  const { dataSource, viewerMemberIds } = useTeamInboxDataSource();
  const pullRequests = useTeamInboxPullRequests();
  const focusRequest = useAtomValue(teamInboxItemFocusRequestAtom);
  const [viewState, setViewState] = useAtom(teamInboxViewStateAtom);
  const navigate = useTeamInboxNavigation();
  const openPrInChatPanel = useSetAtom(openGitHubPrInChatPanelTabAtom);
  const openPullRequestTab = useCallback(
    (pullRequest: ManagedPrItem) => {
      openPrInChatPanel({
        prNumber: pullRequest.id,
        prTitle: pullRequest.title,
        prUrl: pullRequest.rawPr.url,
        prStatus: pullRequest.rawPr.draft ? "draft" : pullRequest.state,
        headBranch: pullRequest.sourceBranch,
        baseBranch: pullRequest.targetBranch,
        updatedAt: pullRequest.updatedAt,
        additions: pullRequest.rawPr.additions,
        deletions: pullRequest.rawPr.deletions,
        repoPath: pullRequest.repoPath,
        repoId: pullRequest.repoId,
      });
    },
    [openPrInChatPanel]
  );
  return (
    <StableTeamInboxView
      dataSource={dataSource}
      focusRequest={focusRequest}
      viewState={viewState}
      onViewStateChange={setViewState}
      viewerMemberIds={viewerMemberIds}
      onNavigate={navigate}
      pullRequests={pullRequests.items}
      pullRequestsLoading={pullRequests.loading}
      pullRequestsError={pullRequests.error}
      onRefreshPullRequests={pullRequests.refresh}
      onOpenPullRequestTab={openPullRequestTab}
    />
  );
};

export default ConnectedTeamInboxView;
