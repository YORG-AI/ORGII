/**
 * TeamInboxDetailPane
 *
 * Right pane of the Team Inbox split view: a selected pull request, the
 * load/empty placeholders, or the detail for the selected Inbox row.
 */
import type { TFunction } from "i18next";
import { Chrome, SquareArrowOutUpRight } from "lucide-react";
import React from "react";

import type { ManagedPrItem } from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import { LoadingBar, Placeholder } from "@src/modules/shared/layouts/blocks";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { WorkItem } from "@src/types/core/workItem";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { AssignedWorkItemDetail, CommentMentionDetail } from ".";
import type {
  LoadState,
  TeamInboxDataSource,
  TeamInboxItem,
  TeamInboxNavigationIntent,
} from "../domain";
import { toTeamInboxNavigationIntent } from "../domain";
import TeamInboxHeaderIconAction from "./TeamInboxHeaderIconAction";

const PullRequestDetailPanel = React.lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel").then(
    (module) => ({ default: module.PrDetailPanel })
  )
);

export interface TeamInboxDetailPaneProps {
  t: TFunction;
  dataSource: TeamInboxDataSource;
  loadState: LoadState;
  itemCount: number;
  selectedItem: TeamInboxItem | null;
  selectedPullRequest: ManagedPrItem | null;
  selectedPullRequestIdentity: PrIdentity | null;
  onOpenPullRequestTab?: (pullRequest: ManagedPrItem) => void;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead: (item: TeamInboxItem) => void;
  onMarkUnread: (item: TeamInboxItem) => void;
  onRefresh: () => void;
  onWorkItemUpdated: (sourceItem: TeamInboxItem, workItem: WorkItem) => void;
}

export const TeamInboxDetailPane: React.FC<TeamInboxDetailPaneProps> = ({
  t,
  dataSource,
  loadState,
  itemCount,
  selectedItem,
  selectedPullRequest,
  selectedPullRequestIdentity,
  onOpenPullRequestTab,
  onNavigate,
  onMarkRead,
  onMarkUnread,
  onRefresh,
  onWorkItemUpdated,
}) => {
  if (selectedPullRequest && selectedPullRequestIdentity) {
    return (
      <React.Suspense fallback={<LoadingBar />}>
        <PullRequestDetailPanel
          identity={selectedPullRequestIdentity}
          repoPath={selectedPullRequest.repoPath}
          repoId={selectedPullRequest.repoId}
          headerActions={
            <div
              className="flex items-center gap-px"
              data-testid="team-inbox-pr-detail-actions"
            >
              <TeamInboxHeaderIconAction
                label={t("previews.openInExternalBrowser")}
                icon={<Chrome size={14} strokeWidth={1.75} aria-hidden />}
                onClick={() =>
                  void openExternalLink(selectedPullRequestIdentity.url)
                }
                testId="team-inbox-open-github-pr"
              />
              {onOpenPullRequestTab ? (
                <TeamInboxHeaderIconAction
                  label={t(
                    "teamInbox.actions.openPullRequest",
                    "Open pull request"
                  )}
                  icon={
                    <SquareArrowOutUpRight
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  }
                  onClick={() => onOpenPullRequestTab(selectedPullRequest)}
                  testId="team-inbox-open-pr-tab"
                />
              ) : null}
            </div>
          }
        />
      </React.Suspense>
    );
  }
  if (loadState.status === "loading") {
    return <LoadingBar />;
  }
  if (loadState.status === "error" && itemCount === 0) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("teamInbox.errors.loadTitle")}
        subtitle={loadState.message ?? undefined}
        action={{ label: t("common:actions.retry"), onClick: onRefresh }}
        fillParentHeight
      />
    );
  }
  if (!selectedItem) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("teamInbox.empty.selectTitle")}
        subtitle={t("teamInbox.empty.selectSubtitle")}
        fillParentHeight
      />
    );
  }
  if (selectedItem.kind === "comment_mention") {
    return (
      <CommentMentionDetail
        item={selectedItem}
        onMarkRead={dataSource.markRead ? onMarkRead : undefined}
        onMarkUnread={dataSource.markUnread ? onMarkUnread : undefined}
        onNavigate={
          onNavigate
            ? () => onNavigate(toTeamInboxNavigationIntent(selectedItem))
            : undefined
        }
      />
    );
  }
  return (
    <AssignedWorkItemDetail
      item={selectedItem}
      onMarkRead={dataSource.markRead ? onMarkRead : undefined}
      onMarkUnread={dataSource.markUnread ? onMarkUnread : undefined}
      onNavigate={onNavigate}
      onWorkItemUpdated={(workItem) =>
        onWorkItemUpdated(selectedItem, workItem)
      }
    />
  );
};
