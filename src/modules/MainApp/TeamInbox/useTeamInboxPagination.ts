/**
 * useTeamInboxPagination
 *
 * Owns the Inbox page snapshot: initial hydration, revalidation against the
 * data source, source-driven reloads, and the load-more / refresh commands.
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

export interface UseTeamInboxPaginationOptions {
  dataSource: TeamInboxDataSource;
  pageSize: number;
  issueMessage: (issue: TeamInboxIssue) => string;
  t: (key: string) => string;
  onRefreshPullRequests?: () => void;
}

export function useTeamInboxPagination({
  dataSource,
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
  const [authoritativeUnreadCounts, setAuthoritativeUnreadCounts] =
    useState<TeamInboxUnreadCounts | null>(
      () => initialPage?.unreadCounts ?? null
    );
  const [loadState, setLoadState] = useState<LoadState>(() =>
    initialPage
      ? loadStateForPage(initialPage, issueMessage)
      : { status: "loading", message: null }
  );
  const [reloadRevision, setReloadRevision] = useState(0);
  const [hasMore, setHasMore] = useState(() => initialPage?.nextCursor != null);
  const [loadingMore, setLoadingMore] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void dataSource
      .listPage({ limit: pageSize, signal: abortController.signal })
      .then((page) => {
        if (abortController.signal.aborted) return;
        setItems(page.items);
        setAuthoritativeUnreadCounts(page.unreadCounts ?? null);
        setHasMore(page.nextCursor != null);
        const nextLoadState = loadStateForPage(page, issueMessage);
        setLoadState((current) =>
          current.status === nextLoadState.status &&
          current.message === nextLoadState.message
            ? current
            : nextLoadState
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
    onRefreshPullRequests?.();
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

  return {
    items,
    setItems,
    authoritativeUnreadCounts,
    loadState,
    setLoadState,
    reloadRevision,
    hasMore,
    loadingMore,
    handleLoadMore,
    handleRefresh,
  };
}
