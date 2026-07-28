import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import SplitViewLayout from "@src/modules/shared/layouts/SplitViewLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { WorkItem } from "@src/types/core/workItem";

import {
  AssignedWorkItemDetail,
  CommentMentionDetail,
  TeamInboxList,
} from "./components";
import {
  type TeamInboxDataSource,
  type TeamInboxFilter,
  type TeamInboxIssue,
  type TeamInboxItem,
  type TeamInboxNavigationIntent,
  type TeamInboxUnreadCounts,
  countUnreadTeamInboxItemsByFilter,
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
  viewerMemberIds?: readonly string[];
}

const EMPTY_TEAM_INBOX_DATA_SOURCE: TeamInboxDataSource = {
  async listPage() {
    return { items: [], nextCursor: null };
  },
};

interface LoadState {
  status: "loading" | "ready" | "warning" | "error";
  message: string | null;
}

const TeamInboxView: React.FC<TeamInboxViewProps> = ({
  dataSource = EMPTY_TEAM_INBOX_DATA_SOURCE,
  onNavigate,
  initialFilter = "all",
  pageSize = 50,
  viewerMemberIds = [],
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<TeamInboxFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TeamInboxItem[]>([]);
  const [authoritativeUnreadCounts, setAuthoritativeUnreadCounts] =
    useState<TeamInboxUnreadCounts | null>(null);
  const [recencyAnchorMs, setRecencyAnchorMs] = useState(() => Date.now());
  const [requestedItemId, setRequestedItemId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    message: null,
  });
  const [reloadRevision, setReloadRevision] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  useEffect(() => {
    const abortController = new AbortController();

    void dataSource
      .listPage({ limit: pageSize, signal: abortController.signal })
      .then((page) => {
        if (abortController.signal.aborted) return;
        setItems(page.items);
        setAuthoritativeUnreadCounts(page.unreadCounts ?? null);
        setRecencyAnchorMs(Date.now());
        setHasMore(page.nextCursor != null);
        setLoadState(
          page.loading
            ? { status: "loading", message: null }
            : page.issue
              ? {
                  status:
                    page.issue.code === "partial_load" ? "warning" : "error",
                  message: issueMessage(page.issue),
                }
              : { status: "ready", message: null }
        );
      })
      .catch((reason: unknown) => {
        if (abortController.signal.aborted) return;
        setLoadState({
          status: "error",
          message:
            reason instanceof Error
              ? "issue" in reason &&
                reason.issue &&
                typeof reason.issue === "object" &&
                "code" in reason.issue
                ? issueMessage(reason.issue as TeamInboxIssue)
                : reason.message
              : t("teamInbox.errors.load"),
        });
      });

    return () => abortController.abort();
  }, [dataSource, issueMessage, pageSize, reloadRevision, t]);

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
  const loadedUnreadCounts = useMemo(
    () => countUnreadTeamInboxItemsByFilter(items),
    [items]
  );
  const unreadCounts = authoritativeUnreadCounts ?? loadedUnreadCounts;
  const totalUnread = unreadCounts.all;
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

  const handleLoadMore = () => {
    if (!dataSource.loadMore || loadingMore) return;
    setLoadingMore(true);
    void dataSource
      .loadMore()
      .then(() => {
        if (mountedRef.current) {
          setReloadRevision((value) => value + 1);
        }
      })
      .catch(() => {
        setLoadState({
          status: "error",
          message: t("teamInbox.errors.loadMore"),
        });
      })
      .finally(() => {
        if (mountedRef.current) setLoadingMore(false);
      });
  };

  const handleRefresh = () => {
    setLoadState({ status: "loading", message: null });
    if (!dataSource.refresh) {
      setReloadRevision((value) => value + 1);
      return;
    }
    void dataSource
      .refresh()
      .then(() => {
        if (mountedRef.current) {
          setReloadRevision((value) => value + 1);
        }
      })
      .catch(() => {
        setLoadState({
          status: "error",
          message: t("teamInbox.errors.refresh"),
        });
      });
  };

  const handleSelect = (item: TeamInboxItem) => {
    setRequestedItemId(getTeamInboxItemKey(item));
    if (item.readAt !== null) return;
    void dataSource.markRead?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markRead"),
      });
    });
  };

  const handleMarkRead = (item: TeamInboxItem) => {
    if (item.readAt !== null) return;
    void dataSource.markRead?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markRead"),
      });
    });
  };

  const handleMarkUnread = (item: TeamInboxItem) => {
    if (item.readAt === null) return;
    void dataSource.markUnread?.(item).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markUnread"),
      });
    });
  };

  const handleMarkAllRead = () => {
    const filterUnreadCount =
      filter === "all"
        ? unreadCounts.all
        : filter === "mentions"
          ? unreadCounts.mentions
          : unreadCounts.assigned;
    if (filterUnreadCount === 0) return;
    void dataSource.markAllRead?.([], filter).catch(() => {
      setLoadState({
        status: "error",
        message: t("teamInbox.errors.markAllRead"),
      });
    });
  };

  const handleWorkItemUpdated = useCallback(
    (sourceItem: TeamInboxItem, workItem: WorkItem) => {
      if (sourceItem.kind !== "assigned_work_item") return;
      const sourceKey = getTeamInboxItemKey(sourceItem);
      const assignee = workItem.assignee;
      const belongsToViewer = assignee
        ? viewerMemberIds.length > 0
          ? viewerMemberIds.includes(assignee.id)
          : assignee.id === sourceItem.payload.assigneeMemberId
        : false;
      const status =
        workItem.workItemStatus ?? workItem.status ?? sourceItem.payload.status;
      const updatedAt = workItem.updated_time || sourceItem.payload.updatedAt;
      const nextItem: TeamInboxItem | null =
        assignee && belongsToViewer
          ? {
              ...sourceItem,
              occurredAt: updatedAt,
              payload: {
                ...sourceItem.payload,
                title: workItem.name || sourceItem.payload.title,
                status,
                priority: workItem.priority ?? sourceItem.payload.priority,
                assigneeMemberId: assignee.id,
                assigneeName: assignee.name,
                summary: workItem.spec?.trim() || undefined,
                updatedAt,
              },
            }
          : null;
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
    [dataSource, viewerMemberIds]
  );

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
          action={{ label: t("common:actions.retry"), onClick: handleRefresh }}
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
        onNavigate={onNavigate}
        onWorkItemUpdated={(workItem) =>
          handleWorkItemUpdated(selectedItem, workItem)
        }
      />
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(loadState.status === "error" || loadState.status === "warning") &&
      items.length > 0 ? (
        <div
          role="status"
          className={`shrink-0 border-b px-3 py-2 text-xs ${
            loadState.status === "warning"
              ? "border-warning-3 bg-warning-6/10 text-warning-6"
              : "border-danger-3 bg-danger-1 text-danger-6"
          }`}
        >
          {loadState.message}
        </div>
      ) : null}
      <SplitViewLayout
        className="min-h-0 flex-1 rounded-page"
        listWidth={280}
        minListWidth={220}
        maxListWidth={360}
        resizable
        collapsible
        hideBreadcrumbWhenSidebarCollapsed
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
              action={{
                label: t("common:actions.retry"),
                onClick: handleRefresh,
              }}
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
