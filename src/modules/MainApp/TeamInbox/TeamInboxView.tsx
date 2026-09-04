import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/components/Placeholder";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  type ManagedPrItem,
  getManagedPullRequestKey,
} from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";
import SplitListFullscreenButton from "@src/modules/shared/layouts/SplitListFullscreenButton";
import SplitListHeader from "@src/modules/shared/layouts/SplitListHeader";
import { normalizePrStatus } from "@src/shared/pr/prStatus";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import type { WorkItem } from "@src/types/core/workItem";

import { useWorkManagementSplitHeader } from "../WorkManagement/workManagementSplitHeaderContext";
import { TeamInboxList } from "./components";
import { TeamInboxDetailPane } from "./components/TeamInboxDetailPane";
import { TeamInboxListControls } from "./components/TeamInboxList";
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
  const { splitDatasetControl, surfaceDatasetControl } =
    useWorkManagementSplitHeader();
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
  const [listFullscreen, setListFullscreen] = useState(false);
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

  const handleSelect = useCallback(
    (item: TeamInboxItem) => {
      // A selected item must reveal its detail even if the user had expanded
      // the list into its full-width presentation.
      setListFullscreen(false);
      updateViewState((current) => ({
        ...current,
        filter: focusRequestActive ? "all" : current.filter,
        query: focusRequestActive ? "" : current.query,
        detailPaneOpen: true,
        selectedItemId: getTeamInboxItemKey(item),
        selectedPullRequestKey: null,
        supersededFocusRequestId: focusRequest?.requestId ?? null,
      }));
    },
    [focusRequest?.requestId, focusRequestActive, updateViewState]
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      updateViewState((current) => ({
        ...current,
        filter: focusRequestActive ? "all" : current.filter,
        query: nextQuery,
        supersededFocusRequestId: focusRequest?.requestId ?? null,
      }));
    },
    [focusRequest?.requestId, focusRequestActive, updateViewState]
  );

  const handleSelectPullRequest = useCallback(
    (pullRequest: ManagedPrItem) => {
      // PR rows share the same full-list presentation as Inbox items.
      setListFullscreen(false);
      updateViewState((current) => ({
        ...current,
        detailPaneOpen: true,
        selectedPullRequestKey: getManagedPullRequestKey(pullRequest),
        supersededFocusRequestId: focusRequest?.requestId ?? null,
      }));
    },
    [focusRequest?.requestId, updateViewState]
  );
  const handleCloseDetail = useCallback(() => {
    setListFullscreen(false);
    updateViewState((current) => ({
      ...current,
      detailPaneOpen: false,
      supersededFocusRequestId:
        focusRequest?.requestId ?? current.supersededFocusRequestId,
    }));
  }, [focusRequest?.requestId, updateViewState]);
  const detailPaneOpen =
    focusRequestActive || viewState.detailPaneOpen !== false;
  const isListOnly = !detailPaneOpen || listFullscreen;
  const handleToggleListPresentation = useCallback(() => {
    if (!detailPaneOpen) {
      setListFullscreen(false);
      updateViewState((current) => ({
        ...current,
        detailPaneOpen: true,
      }));
      return;
    }
    setListFullscreen((current) => !current);
  }, [detailPaneOpen, updateViewState]);
  // Every split presentation owns its controls in the left-column header.
  const useSplitListHeader = detailPaneOpen && !listFullscreen;

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
      onClose={handleCloseDetail}
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

  const listHeaderControls = useMemo(
    () => (
      <TeamInboxListControls
        filter={visibleFilter}
        unreadCounts={unreadCounts}
        query={visibleQuery}
        loading={
          initialCombinedLoadPending ||
          loadState.status === "loading" ||
          pullRequestsLoading ||
          loadingMore
        }
        placement="header"
        fillSearch={useSplitListHeader}
        trailingActions={
          <SplitListFullscreenButton
            isFullscreen={isListOnly}
            onToggle={handleToggleListPresentation}
          />
        }
        onQueryChange={handleQueryChange}
        onRefresh={handleRefresh}
        onMarkAllRead={dataSource.markAllRead ? handleMarkAllRead : undefined}
      />
    ),
    [
      dataSource.markAllRead,
      handleMarkAllRead,
      handleQueryChange,
      handleRefresh,
      handleToggleListPresentation,
      initialCombinedLoadPending,
      isListOnly,
      loadState.status,
      loadingMore,
      pullRequestsLoading,
      unreadCounts,
      useSplitListHeader,
      visibleFilter,
      visibleQuery,
    ]
  );
  const splitListHeader = useMemo(
    () =>
      useSplitListHeader ? (
        <SplitListHeader
          primary={
            <div className="flex min-w-0 flex-1 items-center gap-px">
              {splitDatasetControl}
              {listHeaderControls}
            </div>
          }
        />
      ) : null,
    [listHeaderControls, splitDatasetControl, useSplitListHeader]
  );
  const fullListHeader = useMemo(
    () =>
      !useSplitListHeader ? (
        <SplitListHeader
          fullWidth
          primary={
            <div className="flex min-w-0 flex-1 items-center gap-px">
              {surfaceDatasetControl}
              {surfaceDatasetControl ? (
                <HeaderSectionSeparator className="mx-0.5" />
              ) : null}
              <div className="ml-auto flex min-w-0 items-center gap-px">
                {listHeaderControls}
              </div>
            </div>
          }
        />
      ) : null,
    [listHeaderControls, surfaceDatasetControl, useSplitListHeader]
  );
  // Keep chat/workstation tab titles in the host row. Inbox controls always
  // render in their own local 36px surface header.
  const publishedHeader = useMemo(() => ({ hidden: true }), []);
  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: publishedHeader,
  });

  const listSurface =
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
            onSelectItem={handleSelect}
            onSelectPullRequest={handleSelectPullRequest}
            onRefresh={handleRefresh}
            onMarkAllRead={
              dataSource.markAllRead ? handleMarkAllRead : undefined
            }
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={dataSource.loadMore ? handleLoadMore : undefined}
            showControls={false}
          />
        </div>
        {loadNotice}
      </div>
    );

  return (
    <TeamInboxSessionDropSurface
      dataSource={dataSource}
      onNavigate={onNavigate}
    >
      <div className="flex h-full min-h-0 flex-col">
        <InboxListDetailLayout
          className="min-h-0 flex-1"
          testId="team-inbox-list-detail-layout"
          detailOpen={detailPaneOpen}
          listFullscreen={detailPaneOpen && listFullscreen}
          listHeader={splitListHeader}
          fullHeader={fullListHeader}
          fullContent={listSurface}
          listContent={listSurface}
          detailContent={detail}
        />
      </div>
    </TeamInboxSessionDropSurface>
  );
};

export default TeamInboxView;
