import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/components/Placeholder";
import {
  type ManagedPrItem,
  getManagedPullRequestKey,
} from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import SplitViewLayout from "@src/modules/shared/layouts/SplitViewLayout";
import { normalizePrStatus } from "@src/shared/pr/prStatus";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { WorkItem } from "@src/types/core/workItem";

import { TeamInboxList } from "./components";
import { TeamInboxDetailPane } from "./components/TeamInboxDetailPane";
import TeamInboxSessionDropSurface from "./components/TeamInboxSessionDropSurface";
import {
  type TeamInboxDataSource,
  type TeamInboxFilter,
  type TeamInboxIssue,
  type TeamInboxItem,
  type TeamInboxNavigationIntent,
  countUnreadTeamInboxItemsByFilter,
  getTeamInboxItemKey,
  reconcileWorkItemUpdate,
  searchTeamInboxItems,
  selectTeamInboxItems,
} from "./domain";
import {
  INITIAL_TEAM_INBOX_VIEW_STATE,
  type TeamInboxItemFocusRequest,
  type TeamInboxViewState,
} from "./store";
import { useTeamInboxPagination } from "./useTeamInboxPagination";
import { useTeamInboxReadActions } from "./useTeamInboxReadActions";

export interface TeamInboxViewProps {
  dataSource?: TeamInboxDataSource;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  initialFilter?: TeamInboxFilter;
  focusRequest?: TeamInboxItemFocusRequest | null;
  /** Controlled navigation state used by the singleton connected Inbox. */
  viewState?: TeamInboxViewState;
  onViewStateChange?: (state: TeamInboxViewState) => void;
  pageSize?: number;
  viewerMemberIds?: readonly string[];
  pullRequests?: readonly ManagedPrItem[];
  pullRequestsLoading?: boolean;
  pullRequestsInitialLoading?: boolean;
  pullRequestsError?: string | null;
  onRefreshPullRequests?: () => void;
  /** Explicit header action; row selection always stays in the right pane. */
  onOpenPullRequestTab?: (pullRequest: ManagedPrItem) => void;
}

const EMPTY_TEAM_INBOX_DATA_SOURCE: TeamInboxDataSource = {
  async listPage() {
    return { items: [], nextCursor: null };
  },
};

const TeamInboxView: React.FC<TeamInboxViewProps> = ({
  dataSource = EMPTY_TEAM_INBOX_DATA_SOURCE,
  onNavigate,
  initialFilter = "all",
  focusRequest = null,
  viewState: controlledViewState,
  onViewStateChange,
  pageSize = 50,
  viewerMemberIds = [],
  pullRequests = [],
  pullRequestsLoading = false,
  pullRequestsInitialLoading = pullRequestsLoading,
  pullRequestsError = null,
  onRefreshPullRequests,
  onOpenPullRequestTab,
}) => {
  const { t } = useTranslation();
  const issueMessage = useCallback(
    (issue: TeamInboxIssue): string => {
      if (issue.code === "identity_unresolved") {
        return t("teamInbox.errors.identity");
      }
      if (issue.code === "partial_load") {
        return t("teamInbox.errors.partialLoad");
      }
      return t("teamInbox.errors.load");
    },
    [t]
  );
  const {
    items,
    setItems,
    authoritativeUnreadCounts,
    loadState,
    setLoadState,
    initialLoading: inboxInitialLoading,
    reloadRevision,
    hasMore,
    loadingMore,
    handleLoadMore,
    handleRefresh,
  } = useTeamInboxPagination({
    dataSource,
    pageSize,
    issueMessage,
    t,
    onRefreshPullRequests,
  });
  const [internalViewState, setInternalViewState] =
    useState<TeamInboxViewState>(() => ({
      ...INITIAL_TEAM_INBOX_VIEW_STATE,
      filter: initialFilter,
    }));
  const viewState = controlledViewState ?? internalViewState;
  const updateViewState = useCallback(
    (update: React.SetStateAction<TeamInboxViewState>) => {
      if (controlledViewState) {
        const nextState =
          typeof update === "function" ? update(controlledViewState) : update;
        onViewStateChange?.(nextState);
        return;
      }
      setInternalViewState(update);
    },
    [controlledViewState, onViewStateChange]
  );
  const [dismissedLoadNoticeKey, setDismissedLoadNoticeKey] = useState<
    string | null
  >(null);
  const initialCombinedLoadPending =
    inboxInitialLoading || pullRequestsInitialLoading;
  const presentedItems = useMemo(
    () => (initialCombinedLoadPending ? [] : items),
    [initialCombinedLoadPending, items]
  );
  const presentedPullRequests = useMemo(
    () => (initialCombinedLoadPending ? [] : pullRequests),
    [initialCombinedLoadPending, pullRequests]
  );

  const loadNoticeKey =
    (loadState.status === "error" || loadState.status === "warning") &&
    loadState.message
      ? `${reloadRevision}:${loadState.status}:${loadState.message}`
      : null;

  const dismissLoadNotice = useCallback(() => {
    setDismissedLoadNoticeKey(loadNoticeKey);
  }, [loadNoticeKey]);

  const focusRequestActive =
    focusRequest !== null &&
    focusRequest.requestId !== viewState.supersededFocusRequestId;
  const visibleFilter = focusRequestActive ? "all" : viewState.filter;
  const visibleQuery = focusRequestActive ? "" : viewState.query;
  const requestedItemId = focusRequestActive
    ? focusRequest.itemKey
    : viewState.selectedItemId;
  const visibleItems = useMemo(
    () =>
      searchTeamInboxItems(
        selectTeamInboxItems(presentedItems, visibleFilter),
        visibleQuery
      ),
    [presentedItems, visibleFilter, visibleQuery]
  );
  const loadedUnreadCounts = useMemo(
    () => countUnreadTeamInboxItemsByFilter(presentedItems),
    [presentedItems]
  );
  const unreadCounts = initialCombinedLoadPending
    ? loadedUnreadCounts
    : (authoritativeUnreadCounts ?? loadedUnreadCounts);
  const totalUnread = unreadCounts.all;
  const selectedPullRequest = useMemo(
    () =>
      presentedPullRequests.find(
        (pullRequest) =>
          getManagedPullRequestKey(pullRequest) ===
          viewState.selectedPullRequestKey
      ) ?? null,
    [presentedPullRequests, viewState.selectedPullRequestKey]
  );
  const selectedPullRequestIdentity = useMemo<PrIdentity | null>(
    () =>
      selectedPullRequest
        ? {
            number: selectedPullRequest.id,
            title: selectedPullRequest.title,
            url: selectedPullRequest.rawPr.url,
            status: normalizePrStatus({
              state: selectedPullRequest.state,
              merged: selectedPullRequest.state === "merged",
              draft: selectedPullRequest.rawPr.draft,
            }),
            headBranch: selectedPullRequest.sourceBranch,
            baseBranch: selectedPullRequest.targetBranch,
          }
        : null,
    [selectedPullRequest]
  );
  const selectedItem = useMemo(() => {
    if (!requestedItemId) return null;
    return (
      visibleItems.find(
        (item) => getTeamInboxItemKey(item) === requestedItemId
      ) ?? null
    );
  }, [requestedItemId, visibleItems]);
  const selectedItemId =
    !selectedPullRequest && selectedItem
      ? getTeamInboxItemKey(selectedItem)
      : null;

  const { handleMarkRead, handleMarkUnread, handleMarkAllRead } =
    useTeamInboxReadActions({
      dataSource,
      t,
      setLoadState,
      selectedItem,
      selectedPullRequest,
      visibleFilter,
      unreadCounts,
    });

  const handleSelect = (item: TeamInboxItem) => {
    updateViewState((current) => ({
      ...current,
      filter: focusRequestActive ? "all" : current.filter,
      query: focusRequestActive ? "" : current.query,
      selectedItemId: getTeamInboxItemKey(item),
      selectedPullRequestKey: null,
      supersededFocusRequestId: focusRequest?.requestId ?? null,
    }));
  };

  const handleFilterChange = (nextFilter: TeamInboxFilter) => {
    updateViewState((current) => ({
      ...current,
      filter: nextFilter,
      query: focusRequestActive ? "" : current.query,
      supersededFocusRequestId: focusRequest?.requestId ?? null,
    }));
  };

  const handleQueryChange = (nextQuery: string) => {
    updateViewState((current) => ({
      ...current,
      filter: focusRequestActive ? "all" : current.filter,
      query: nextQuery,
      supersededFocusRequestId: focusRequest?.requestId ?? null,
    }));
  };

  const handleSelectPullRequest = (pullRequest: ManagedPrItem) => {
    updateViewState((current) => ({
      ...current,
      selectedPullRequestKey: getManagedPullRequestKey(pullRequest),
      supersededFocusRequestId: focusRequest?.requestId ?? null,
    }));
  };

  const handleWorkItemUpdated = useCallback(
    (sourceItem: TeamInboxItem, workItem: WorkItem) => {
      if (sourceItem.kind !== "assigned_work_item") return;
      const sourceKey = getTeamInboxItemKey(sourceItem);
      const nextItem = reconcileWorkItemUpdate(
        sourceItem,
        workItem,
        viewerMemberIds
      );
      if (dataSource.reconcileItem) {
        dataSource.reconcileItem(sourceKey, nextItem);
        return;
      }
      setItems((current) =>
        current.flatMap((candidate) =>
          getTeamInboxItemKey(candidate) === sourceKey
            ? nextItem
              ? [nextItem]
              : []
            : [candidate]
        )
      );
    },
    [dataSource, setItems, viewerMemberIds]
  );

  const detailLoadState = initialCombinedLoadPending
    ? { status: "loading" as const, message: null }
    : loadState;
  const detail = (
    <TeamInboxDetailPane
      t={t}
      dataSource={dataSource}
      loadState={detailLoadState}
      itemCount={presentedItems.length}
      selectedItem={selectedItem}
      selectedPullRequest={selectedPullRequest}
      selectedPullRequestIdentity={selectedPullRequestIdentity}
      onOpenPullRequestTab={onOpenPullRequestTab}
      onNavigate={onNavigate}
      onMarkRead={handleMarkRead}
      onMarkUnread={handleMarkUnread}
      onRefresh={handleRefresh}
      onWorkItemUpdated={handleWorkItemUpdated}
    />
  );

  const loadNotice =
    !initialCombinedLoadPending &&
    loadNoticeKey &&
    dismissedLoadNoticeKey !== loadNoticeKey &&
    (presentedItems.length > 0 || presentedPullRequests.length > 0) ? (
      <InlineAlert
        type={loadState.status === "warning" ? "warning" : "danger"}
        hideIcon
        onClose={dismissLoadNotice}
        autoCloseMs={3000}
        role="status"
        dataTestId="team-inbox-load-notice"
        closeAriaLabel={t("common:actions.close")}
        className={`shrink-0 rounded-none! border-x-0! border-b-0! px-3! py-2! ${
          loadState.status === "warning" ? "bg-warning-6/10" : "bg-danger-1"
        }`}
      >
        {loadState.message}
      </InlineAlert>
    ) : null;

  return (
    <TeamInboxSessionDropSurface
      dataSource={dataSource}
      onNavigate={onNavigate}
    >
      <div className="flex h-full min-h-0 flex-col">
        <SplitViewLayout
          className="min-h-0 flex-1 rounded-page"
          listWidth={360}
          minListWidth={280}
          maxListWidth={480}
          resizable
          collapsible
          hideBreadcrumbWhenSidebarCollapsed
          listPanelBackgroundClassName="bg-chat-pane"
          mainContentClassName="bg-chat-pane"
          listContent={
            loadState.status === "error" &&
            !initialCombinedLoadPending &&
            presentedItems.length === 0 &&
            presentedPullRequests.length === 0 ? (
              <Placeholder
                variant="error"
                placement="sidebar"
                title={t("teamInbox.errors.loadTitle")}
                subtitle={loadState.message ?? undefined}
                action={{
                  label: t("common:actions.retry"),
                  onClick: handleRefresh,
                }}
                fillParentHeight
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <TeamInboxList
                    filter={visibleFilter}
                    items={visibleItems}
                    selectedItemId={selectedItemId}
                    totalUnread={totalUnread}
                    unreadCounts={unreadCounts}
                    query={visibleQuery}
                    loading={
                      initialCombinedLoadPending ||
                      loadState.status === "loading" ||
                      pullRequestsLoading
                    }
                    pullRequests={presentedPullRequests}
                    pullRequestsLoading={pullRequestsLoading}
                    pullRequestsError={pullRequestsError}
                    selectedPullRequestKey={viewState.selectedPullRequestKey}
                    onQueryChange={handleQueryChange}
                    onFilterChange={handleFilterChange}
                    onSelectItem={handleSelect}
                    onSelectPullRequest={handleSelectPullRequest}
                    onRefresh={handleRefresh}
                    onMarkAllRead={
                      dataSource.markAllRead ? handleMarkAllRead : undefined
                    }
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    onLoadMore={
                      dataSource.loadMore ? handleLoadMore : undefined
                    }
                  />
                </div>
                {loadNotice}
              </div>
            )
          }
          mainContent={detail}
        />
      </div>
    </TeamInboxSessionDropSurface>
  );
};

export default TeamInboxView;
