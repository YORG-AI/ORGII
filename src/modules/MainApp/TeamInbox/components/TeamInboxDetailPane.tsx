/**
 * TeamInboxDetailPane
 *
 * Right pane of the Team Inbox split view: a selected pull request, the
 * load/empty placeholders, or the detail for the selected Inbox row.
 */
import type { TFunction } from "i18next";
import React from "react";

import { HugeiconsIcon, InternetIcon, LinkSquare02Icon } from "@src/icons";
import type { ManagedPrItem } from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import DetailHeaderIconAction from "@src/modules/shared/components/DetailHeaderIconAction";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import GitHubPrDetailTabs from "@src/modules/shared/components/GitHubPrDetailTabs";
import DetailPaneLayout, {
  DetailPaneCloseAction,
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { WorkItem } from "@src/types/core/workItem";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  AssignedWorkItemDetail,
  CommentMentionDetail,
  WorkItemEventDetail,
} from ".";
import type {
  LoadState,
  TeamInboxDataSource,
  TeamInboxItem,
  TeamInboxNavigationIntent,
} from "../domain";
import { getTeamInboxItemKey, toTeamInboxNavigationIntent } from "../domain";

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
  onClose: () => void;
  onWorkItemUpdated: (sourceItem: TeamInboxItem, workItem: WorkItem) => void;
  /** Whether the pane is showing the archived list. */
  archived: boolean;
  /** Row key of the archive/unarchive mutation in flight, if any. */
  dispositionPendingKey: string | null;
  onDisposition: (item: TeamInboxItem, archived: boolean) => void;
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
  onClose,
  onWorkItemUpdated,
  archived,
  dispositionPendingKey,
  onDisposition,
}) => {
  if (selectedPullRequest && selectedPullRequestIdentity) {
    const tabActions = (
      <div
        className="flex items-center gap-px"
        data-testid="team-inbox-pr-detail-actions"
      >
        <DetailHeaderIconAction
          label={t("previews.openInExternalBrowser")}
          icon={
            <HugeiconsIcon
              icon={InternetIcon}
              data-icon="chrome"
              size={14}
              strokeWidth={1.75}
              aria-hidden
            />
          }
          onClick={() => void openExternalLink(selectedPullRequestIdentity.url)}
          testId="team-inbox-open-github-pr"
        />
        {onOpenPullRequestTab ? (
          <DetailHeaderIconAction
            label={t("common:actions.openInNewTab")}
            icon={
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                data-icon="link-square-02"
                size={14}
                strokeWidth={1.75}
                aria-hidden
              />
            }
            onClick={() => onOpenPullRequestTab(selectedPullRequest)}
            testId="team-inbox-open-pr-tab"
          />
        ) : null}
        <DetailPaneCloseAction
          onClose={onClose}
          testId="team-inbox-close-detail"
        />
      </div>
    );
    return (
      <DetailPaneLayout testId="team-inbox-pr-detail-pane">
        <React.Suspense
          fallback={
            <GitHubDetailSkeleton
              kind="pr"
              showHeader={false}
              title={selectedPullRequestIdentity.title}
              number={selectedPullRequestIdentity.number}
              tabs={<GitHubPrDetailTabs trailing={tabActions} />}
            />
          }
        >
          <PullRequestDetailPanel
            identity={selectedPullRequestIdentity}
            repoPath={selectedPullRequest.repoPath}
            repoId={selectedPullRequest.repoId}
            tabActions={tabActions}
          />
        </React.Suspense>
      </DetailPaneLayout>
    );
  }
  if (loadState.status === "loading") {
    return (
      <DetailPaneLayout>
        <DetailPanePlaceholder variant="loading" />
      </DetailPaneLayout>
    );
  }
  if (loadState.status === "error" && itemCount === 0) {
    return (
      <DetailPaneLayout>
        <DetailPanePlaceholder
          variant="error"
          title={t("teamInbox.errors.loadTitle")}
          subtitle={loadState.message ?? undefined}
          action={{ label: t("common:actions.retry"), onClick: onRefresh }}
        />
      </DetailPaneLayout>
    );
  }
  if (!selectedItem) {
    return (
      <DetailPaneLayout>
        <DetailPanePlaceholder
          variant="empty"
          title={t("teamInbox.empty.selectTitle")}
          subtitle={t("teamInbox.empty.selectSubtitle")}
        />
      </DetailPaneLayout>
    );
  }
  const dispositionPending =
    dispositionPendingKey === getTeamInboxItemKey(selectedItem);
  const onArchive = dataSource.archiveItem
    ? (item: TeamInboxItem) => onDisposition(item, true)
    : undefined;
  const onUnarchive = dataSource.unarchiveItem
    ? (item: TeamInboxItem) => onDisposition(item, false)
    : undefined;
  if (selectedItem.kind === "comment_mention") {
    return (
      <CommentMentionDetail
        item={selectedItem}
        onClose={onClose}
        onMarkRead={dataSource.markRead ? onMarkRead : undefined}
        onMarkUnread={dataSource.markUnread ? onMarkUnread : undefined}
        archived={archived}
        dispositionPending={dispositionPending}
        onArchive={selectedItem.source !== "cloud" ? onArchive : undefined}
        onUnarchive={onUnarchive}
        onNavigate={
          onNavigate
            ? () => onNavigate(toTeamInboxNavigationIntent(selectedItem))
            : undefined
        }
      />
    );
  }
  if (selectedItem.kind !== "assigned_work_item") {
    return (
      <WorkItemEventDetail
        item={selectedItem}
        onMarkRead={dataSource.markRead ? onMarkRead : undefined}
        onMarkUnread={dataSource.markUnread ? onMarkUnread : undefined}
        archived={archived}
        dispositionPending={dispositionPending}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <AssignedWorkItemDetail
      item={selectedItem}
      onClose={onClose}
      onMarkRead={dataSource.markRead ? onMarkRead : undefined}
      onMarkUnread={dataSource.markUnread ? onMarkUnread : undefined}
      archived={archived}
      dispositionPending={dispositionPending}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onNavigate={onNavigate}
      onWorkItemUpdated={(workItem) =>
        onWorkItemUpdated(selectedItem, workItem)
      }
    />
  );
};
