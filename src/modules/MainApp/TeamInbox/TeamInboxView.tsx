import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SplitViewLayout from "@src/modules/shared/layouts/SplitViewLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  AssignedWorkItemDetail,
  CommentMentionDetail,
  TeamInboxList,
} from "./components";
import {
  type TeamInboxDataSource,
  type TeamInboxFilter,
  type TeamInboxItem,
  type TeamInboxNavigationIntent,
  countUnreadTeamInboxItems,
  countUnreadTeamInboxItemsByFilter,
  filterItemKind,
  getTeamInboxItemKey,
  searchTeamInboxItems,
  selectTeamInboxItems,
  toTeamInboxNavigationIntent,
} from "./domain";

export interface TeamInboxViewProps {
  dataSource?: TeamInboxDataSource;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  initialFilter?: TeamInboxFilter;
  pageSize?: number;
}

const EMPTY_TEAM_INBOX_DATA_SOURCE: TeamInboxDataSource = {
  async listPage() {
    return { items: [], nextCursor: null };
  },
};

interface LoadState {
  status: "loading" | "ready" | "error";
  message: string | null;
}

const TeamInboxView: React.FC<TeamInboxViewProps> = ({
  dataSource = EMPTY_TEAM_INBOX_DATA_SOURCE,
  onNavigate,
  initialFilter = "all",
  pageSize = 50,
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<TeamInboxFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TeamInboxItem[]>([]);
  const [recencyAnchorMs, setRecencyAnchorMs] = useState(() => Date.now());
  const [requestedItemId, setRequestedItemId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    message: null,
  });
  const [reloadRevision, setReloadRevision] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    void dataSource
      .listPage({ limit: pageSize, signal: abortController.signal })
      .then((page) => {
        if (abortController.signal.aborted) return;
        setItems(page.items);
        setRecencyAnchorMs(Date.now());
        setHasMore(page.nextCursor != null);
        setLoadState({ status: "ready", message: null });
      })
      .catch((reason: unknown) => {
        if (abortController.signal.aborted) return;
        setLoadState({
          status: "error",
          message:
            reason instanceof Error
              ? reason.message
              : t("teamInbox.errors.load"),
        });
      });

    return () => abortController.abort();
  }, [dataSource, pageSize, reloadRevision, t]);

  useEffect(() => {
    if (!dataSource.subscribe) return;
    return dataSource.subscribe(() => {
      setReloadRevision((value) => value + 1);
    });
  }, [dataSource]);

  const visibleItems = useMemo(
    () => searchTeamInboxItems(selectTeamInboxItems(items, filter), query),
    [filter, items, query]
  );
  const totalUnread = useMemo(() => countUnreadTeamInboxItems(items), [items]);
  const unreadCounts = useMemo(
    () => countUnreadTeamInboxItemsByFilter(items),
    [items]
  );
  const selectedItem = useMemo(() => {
    if (visibleItems.length === 0) return null;
    return (
      visibleItems.find(
        (item) => getTeamInboxItemKey(item) === requestedItemId
      ) ?? visibleItems[0]
    );
  }, [requestedItemId, visibleItems]);
  const selectedItemId = selectedItem
    ? getTeamInboxItemKey(selectedItem)
    : null;

  const retry = () => {
    setLoadState({ status: "loading", message: null });
    setReloadRevision((value) => value + 1);
  };

  const handleLoadMore = () => {
    if (!dataSource.loadMore || loadingMore) return;
    setLoadingMore(true);
    void dataSource
      .loadMore()
      .catch((reason: unknown) => {
        setLoadState({
          status: "error",
          message:
            reason instanceof Error
              ? reason.message
              : t("teamInbox.errors.load"),
        });
      })
      .finally(() => setLoadingMore(false));
  };

  const handleRefresh = () => {
    setLoadState({ status: "loading", message: null });
    if (!dataSource.refresh) {
      setReloadRevision((value) => value + 1);
      return;
    }
    void dataSource.refresh().catch((reason: unknown) => {
      setLoadState({
        status: "error",
        message:
          reason instanceof Error
            ? reason.message
            : t("teamInbox.errors.refresh"),
      });
    });
  };

  const markLocallyRead = (item: TeamInboxItem) => {
    const readAt = new Date().toISOString();
    setItems((current) =>
      current.map((candidate) =>
        getTeamInboxItemKey(candidate) === getTeamInboxItemKey(item)
          ? { ...candidate, readAt }
          : candidate
      )
    );
  };

  const handleSelect = (item: TeamInboxItem) => {
    setRequestedItemId(getTeamInboxItemKey(item));
    if (item.readAt !== null) return;
    markLocallyRead(item);
    void dataSource.markRead?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markRead"),
      });
    });
  };

  const handleMarkRead = (item: TeamInboxItem) => {
    if (item.readAt !== null) return;
    markLocallyRead(item);
    void dataSource.markRead?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markRead"),
      });
    });
  };

  const handleMarkUnread = (item: TeamInboxItem) => {
    if (item.readAt === null) return;
    setItems((current) =>
      current.map((candidate) =>
        getTeamInboxItemKey(candidate) === getTeamInboxItemKey(item)
          ? { ...candidate, readAt: null }
          : candidate
      )
    );
    void dataSource.markUnread?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markUnread"),
      });
    });
  };

  const handleMarkAllRead = () => {
    const targetKind = filterItemKind(filter);
    const unreadItems = items.filter(
      (item) =>
        item.readAt === null &&
        (targetKind === null || item.kind === targetKind)
    );
    if (unreadItems.length === 0) return;
    const readAt = new Date().toISOString();
    const markedIds = new Set(unreadItems.map((item) => item.id));
    setItems((current) =>
      current.map((item) =>
        markedIds.has(item.id) ? { ...item, readAt } : item
      )
    );
    void dataSource.markAllRead?.(unreadItems).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markAllRead"),
      });
    });
  };

  const detail = (() => {
    if (loadState.status === "loading") {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("teamInbox.loading")}
          fillParentHeight
        />
      );
    }
    if (loadState.status === "error" && items.length === 0) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("teamInbox.errors.loadTitle")}
          subtitle={loadState.message ?? undefined}
          action={{ label: t("common:actions.retry"), onClick: retry }}
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
          onMarkRead={dataSource.markRead ? handleMarkRead : undefined}
          onMarkUnread={dataSource.markUnread ? handleMarkUnread : undefined}
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
        onMarkRead={dataSource.markRead ? handleMarkRead : undefined}
        onMarkUnread={dataSource.markUnread ? handleMarkUnread : undefined}
        onNavigate={
          onNavigate
            ? () => onNavigate(toTeamInboxNavigationIntent(selectedItem))
            : undefined
        }
      />
    );
  })();

  return (
    <div className="relative h-full min-h-0">
      {loadState.status === "error" && items.length > 0 ? (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-10 border-b border-danger-3 bg-danger-1 px-3 py-2 text-xs text-danger-6"
        >
          {loadState.message}
        </div>
      ) : null}
      <SplitViewLayout
        className="h-full rounded-page"
        listWidth={200}
        minListWidth={160}
        resizable
        collapsible
        alwaysShowBreadcrumb
        listPanelBackgroundClassName="bg-bg-2"
        mainContentClassName="bg-bg-1"
        listContent={
          loadState.status === "loading" && items.length === 0 ? (
            <Placeholder
              variant="loading"
              title={t("teamInbox.loading")}
              fillParentHeight
            />
          ) : loadState.status === "error" && items.length === 0 ? (
            <Placeholder
              variant="error"
              title={t("teamInbox.errors.loadTitle")}
              subtitle={loadState.message ?? undefined}
              action={{ label: t("common:actions.retry"), onClick: retry }}
              fillParentHeight
            />
          ) : (
            <TeamInboxList
              filter={filter}
              items={visibleItems}
              recencyAnchorMs={recencyAnchorMs}
              selectedItemId={selectedItemId}
              totalUnread={totalUnread}
              unreadCounts={unreadCounts}
              query={query}
              loading={loadState.status === "loading"}
              onQueryChange={setQuery}
              onFilterChange={setFilter}
              onSelectItem={handleSelect}
              onRefresh={handleRefresh}
              onMarkAllRead={
                dataSource.markAllRead ? handleMarkAllRead : undefined
              }
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={dataSource.loadMore ? handleLoadMore : undefined}
            />
          )
        }
        mainContent={detail}
      />
    </div>
  );
};

export default TeamInboxView;
