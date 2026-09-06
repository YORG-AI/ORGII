/**
 * useTeamInboxPagination
 *
 * Owns the Inbox page snapshot: initial hydration, revalidation against the
 * data source, source-driven reloads, and the load-more / refresh commands.
 * The active list pages through the data source's live feed; the archived
 * list pages by cursor through `listArchivedPage`.
 */
import { useEffect, useRef, useState } from "react";

import {
  type LoadState,
  type TeamInboxDataSource,
  type TeamInboxIssue,
  type TeamInboxItem,
  type TeamInboxPage,
  type TeamInboxUnreadCounts,
  loadStateForPage,
} from "./domain";

export type TeamInboxListMode = "active" | "archived";

export interface UseTeamInboxPaginationOptions {
  dataSource: TeamInboxDataSource;
  listMode: TeamInboxListMode;
  pageSize: number;
  issueMessage: (issue: TeamInboxIssue) => string;
  t: (key: string) => string;
  onRefreshPullRequests?: () => void;
}

export function useTeamInboxPagination({
  dataSource,
  listMode,
  pageSize,
  issueMessage,
  t,
  onRefreshPullRequests,
}: UseTeamInboxPaginationOptions) {
  const [initialPage] = useState<TeamInboxPage | null>(
    () => dataSource.getSnapshot?.() ?? null
  );
  const [items, setItems] = useState<TeamInboxItem[]>(
    () => initialPage?.items ?? []
  );
  const [itemsMode, setItemsMode] = useState<TeamInboxListMode>("active");
  const [authoritativeUnreadCounts, setAuthoritativeUnreadCounts] =
    useState<TeamInboxUnreadCounts | null>(
      () => initialPage?.unreadCounts ?? null
    );
  const [loadState, setLoadState] = useState<LoadState>(() =>
    initialPage
      ? loadStateForPage(initialPage, issueMessage)
      : { status: "loading", message: null }
  );
  const dataSourceScopeKey = dataSource.scopeKey ?? dataSource;
  const [completedDataSourceScopeKey, setCompletedDataSourceScopeKey] =
    useState<string | TeamInboxDataSource | null>(() =>
      initialPage &&
      loadStateForPage(initialPage, issueMessage).status !== "loading"
        ? dataSourceScopeKey
        : null
    );
  const [reloadRevision, setReloadRevision] = useState(0);
  const [hasMore, setHasMore] = useState(() => initialPage?.nextCursor != null);
  const [nextCursor, setNextCursor] = useState(
    () => initialPage?.nextCursor ?? null
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const mountedRef = useRef(true);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    const listPage =
      listMode === "archived"
        ? (dataSource.listArchivedPage ??
          (async (): Promise<TeamInboxPage> => ({
            items: [],
            nextCursor: null,
          })))
        : dataSource.listPage;
    void listPage({ limit: pageSize, signal: abortController.signal })
      .then((page) => {
        if (abortController.signal.aborted) return;
        setItems(page.items);
        setItemsMode(listMode);
        if (listMode === "active") {
          setAuthoritativeUnreadCounts(page.unreadCounts ?? null);
        }
        setHasMore(page.nextCursor != null);
        setNextCursor(page.nextCursor);
        const nextLoadState = loadStateForPage(page, issueMessage);
        if (nextLoadState.status !== "loading") {
          setCompletedDataSourceScopeKey(dataSourceScopeKey);
        }
        setLoadState((current) =>
          current.status === nextLoadState.status &&
          current.message === nextLoadState.message
            ? current
            : nextLoadState
        );
      })
      .catch((reason: unknown) => {
        if (abortController.signal.aborted) return;
        setCompletedDataSourceScopeKey(dataSourceScopeKey);
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
  }, [
    dataSource,
    dataSourceScopeKey,
    issueMessage,
    listMode,
    pageSize,
    reloadRevision,
    t,
  ]);

  useEffect(() => {
    if (!dataSource.subscribe) return;
    return dataSource.subscribe(() => {
      setReloadRevision((value) => value + 1);
    });
  }, [dataSource]);

  const handleLoadMore = () => {
    if (loadingMore) return;
    if (listMode === "archived") {
      if (!dataSource.listArchivedPage || !nextCursor) return;
      const abortController = new AbortController();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = abortController;
      setLoadingMore(true);
      void dataSource
        .listArchivedPage({
          cursor: nextCursor,
          limit: pageSize,
          signal: abortController.signal,
        })
        .then((page) => {
          if (abortController.signal.aborted || !mountedRef.current) return;
          setItems((current) => [...current, ...page.items]);
          setNextCursor(page.nextCursor);
          setHasMore(page.nextCursor != null);
        })
        .catch(() => {
          if (abortController.signal.aborted) return;
          setLoadState({
            status: "error",
            message: t("teamInbox.errors.loadMore"),
          });
        })
        .finally(() => {
          if (loadMoreAbortRef.current === abortController) {
            loadMoreAbortRef.current = null;
          }
          if (mountedRef.current && !abortController.signal.aborted) {
            setLoadingMore(false);
          }
        });
      return;
    }
    if (!dataSource.loadMore) return;
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
    if (listMode === "active") onRefreshPullRequests?.();
    setLoadState({ status: "loading", message: null });
    if (listMode === "archived" || !dataSource.refresh) {
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

  /** Crossing the active/archived boundary invalidates in-flight paging. */
  const resetForModeSwitch = () => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    setLoadingMore(false);
    setLoadState({ status: "loading", message: null });
  };

  return {
    items,
    setItems,
    itemsMode,
    authoritativeUnreadCounts,
    loadState,
    setLoadState,
    initialLoading: completedDataSourceScopeKey !== dataSourceScopeKey,
    reloadRevision,
    hasMore,
    loadingMore,
    handleLoadMore,
    handleRefresh,
    resetForModeSwitch,
  };
}
