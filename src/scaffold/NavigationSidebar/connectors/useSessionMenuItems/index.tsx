import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { benchmarkApi } from "@src/api/tauri/benchmark";
import type { AgentLiveStatus } from "@src/api/tauri/rpc/schemas/agentOrgs";
import { createLogger } from "@src/hooks/logger";
import { useFilteredItems } from "@src/hooks/search";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { benchmarkAgentBatchStatusAtom } from "@src/store/benchmark";
import {
  type Session,
  type SessionPaginationScope,
  scopedSessionPaginationAtom,
  sessionPaginationAtom,
  sidebarPinnedScopeKey,
  upsertSession,
} from "@src/store/session";
import { agentLiveStatusAtom } from "@src/store/session/agentLiveStatusAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  DEFAULT_GROUP_VISIBLE_COUNT,
  type DateGroupKey,
} from "./dateGroupingHelpers";
import {
  buildSessionMenuItem,
  isBenchmarkSessionRow,
  separator,
} from "./menuItemBuilders";
import {
  buildByAgentMenuItems,
  buildByTimeMenuItems,
  buildByWorkspaceMenuItems,
} from "./menuSectionBuilders";
import { sessionMatchesOrgFilter } from "./orgFilter";
import {
  appendSessionGroup,
  getLoadMoreGroupId,
  getLoadMoreScopeKey,
  getScopedLoadMoreState,
  isLoadMoreId,
  isPinnedLoadMoreId,
  isWorkspaceFacetLoadMoreId,
  pinnedLoadMoreRow,
  scopedLoadMoreRow,
  workspaceFacetLoadMoreRow,
} from "./paginationHelpers";
import type {
  UseSessionMenuItemsParams,
  UseSessionMenuItemsResult,
} from "./types";

/**
 * One-line subtitle for a session row, shown ONLY while the session is
 * blocked on the user (permission prompt / question). Running sessions keep
 * a single-line row — the breathing dot already signals activity.
 */
function liveDetailForSession(
  entry: AgentLiveStatus | undefined
): string | undefined {
  if (entry?.status !== "waiting_for_user") return undefined;
  return (
    entry.interactivePrompt ??
    (entry.toolName ? `Waiting: ${entry.toolName}` : "Waiting for input")
  );
}

export {
  getLoadMoreGroupId,
  getLoadMoreScopeKey,
  isLoadMoreId,
} from "./paginationHelpers";

const logger = createLogger("SessionSidebar");

interface ChildSessionRecord {
  sessionId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sessionType: string;
  parentSessionId: string | null;
}

const SUBAGENT_SESSION_ID_SEGMENT = ":subagent:";

/** Max concurrent `es_get_child_sessions` calls when hydrating the sidebar. */
const SUBAGENT_QUERY_CONCURRENCY = 8;

function parentSessionIdFor(session: Session): string | null {
  if (session.parentSessionId) return session.parentSessionId;
  const segmentIndex = session.session_id.indexOf(SUBAGENT_SESSION_ID_SEGMENT);
  if (segmentIndex <= 0) return null;
  return session.session_id.slice(0, segmentIndex);
}

function agentNameFromChildName(name: string): string | undefined {
  const markerIndex = name.indexOf(" (");
  const label = markerIndex >= 0 ? name.slice(0, markerIndex) : name;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function childRecordToSession(
  record: ChildSessionRecord,
  parentSessionId: string
): Session {
  const name = record.name?.trim() || record.sessionId;
  return {
    session_id: record.sessionId,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    created_time: record.createdAt,
    updated_time: record.updatedAt,
    name,
    category: "rust_agent",
    keySource: "own_key",
    parentSessionId: record.parentSessionId ?? parentSessionId,
    background: true,
    agentDisplayName: agentNameFromChildName(name),
  };
}

function buildChildSessionMenuItem(
  session: Session,
  buildSessionRow: (session: Session) => NavigationMenuItem
): NavigationMenuItem {
  const item = buildSessionRow(session);
  return {
    ...item,
    showIndentGuide: true,
    visualTone: "secondary",
    dataTestId: `sidebar-subagent-session-item-${session.session_id}`,
    // Subagent rows don't carry a meaningful read status, so drop the dot.
    workingIndicator: undefined,
    trailingElement: undefined,
  };
}

function insertExpandedSubagentRows({
  items,
  childSessionsByParent,
  expandedSubagentParentIds,
  buildSessionRow,
}: {
  items: readonly NavigationMenuItem[];
  childSessionsByParent: ReadonlyMap<string, readonly Session[]>;
  expandedSubagentParentIds: ReadonlySet<string>;
  buildSessionRow: (session: Session) => NavigationMenuItem;
}): NavigationMenuItem[] {
  if (expandedSubagentParentIds.size === 0) return items.slice();

  const nextItems: NavigationMenuItem[] = [];
  for (const item of items) {
    nextItems.push(item);
    if (!expandedSubagentParentIds.has(item.id)) continue;
    const childSessions = childSessionsByParent.get(item.id);
    if (!childSessions || childSessions.length === 0) continue;
    nextItems.push(
      ...childSessions.map((session) =>
        buildChildSessionMenuItem(session, buildSessionRow)
      )
    );
  }
  return nextItems;
}

export function useSessionMenuItems({
  sortedSessions,
  visitedSessions,
  repoPathToName,
  groupByMode,
  untitledSession,
  searchQuery = "",
  selectedOrgIds,
  sidebarOrgIds,
  extraSessionIds,
  excludedSessionIds,
  includeExternal,
  pinnedPage,
  workspaceFacetPage,
  groupVisibleCounts,
  showAllLoadedGroupSessions = false,
  expandedSubagentParentIds = new Set(),
  revealedSessionIds = new Set(),
}: UseSessionMenuItemsParams): UseSessionMenuItemsResult {
  const { t: tCommon } = useTranslation();
  const pagination = useAtomValue(sessionPaginationAtom);
  const scopedPagination = useAtomValue(scopedSessionPaginationAtom);
  const agentLiveStatuses = useAtomValue(agentLiveStatusAtom);
  const benchmarkAgentBatchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const [benchmarkHistoryChildSessionIds, setBenchmarkHistoryChildSessionIds] =
    useState<ReadonlySet<string>>(() => new Set());
  // parentId → the parent's updated_at at query time. Children are re-fetched
  // only when the parent session changes, instead of re-querying every
  // visible session on every list refresh (that pattern issued 100+
  // concurrent `es_get_child_sessions` calls that queued up on SQLite).
  const [queriedSubagentParents, setQueriedSubagentParents] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [fetchedChildSessionsByParent, setFetchedChildSessionsByParent] =
    useState<ReadonlyMap<string, Session[]>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    benchmarkApi
      .listAgentBatchHistories()
      .then((histories) => {
        if (cancelled) return;
        setBenchmarkHistoryChildSessionIds(
          new Set(
            histories.flatMap((history) =>
              history.items
                .map((item) => item.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId))
            )
          )
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("Failed to load benchmark batch histories:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const benchmarkChildSessionIds = useMemo(
    () =>
      new Set(
        benchmarkAgentBatchStatus?.items
          .map((item) => item.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId)) ?? []
      ),
    [benchmarkAgentBatchStatus?.items]
  );

  const benchmarkCoordinatorSessionIds = useMemo(
    () =>
      new Set(
        sortedSessions
          .filter(isBenchmarkSessionRow)
          .map((session) => session.session_id)
      ),
    [sortedSessions]
  );

  const visibleSessions = useMemo(
    () =>
      sortedSessions.filter((session) => {
        const explicitlyRevealed = revealedSessionIds.has(session.session_id);
        return (
          isPrimarySessionListSession(session) &&
          (explicitlyRevealed ||
            ((includeExternal ||
              !isImportedHistorySession(session.session_id)) &&
              (sessionMatchesOrgFilter(session, selectedOrgIds) ||
                (extraSessionIds?.has(session.session_id) ?? false)))) &&
          !benchmarkChildSessionIds.has(session.session_id) &&
          !benchmarkHistoryChildSessionIds.has(session.session_id) &&
          !benchmarkCoordinatorSessionIds.has(session.parentSessionId ?? "")
        );
      }),
    [
      benchmarkChildSessionIds,
      benchmarkCoordinatorSessionIds,
      benchmarkHistoryChildSessionIds,
      extraSessionIds,
      includeExternal,
      revealedSessionIds,
      selectedOrgIds,
      sortedSessions,
    ]
  );

  useEffect(() => {
    const parentsToQuery = visibleSessions.filter(
      (session) =>
        queriedSubagentParents.get(session.session_id) !==
        (session.updated_at ?? "")
    );
    if (parentsToQuery.length === 0) return;

    setQueriedSubagentParents((previous) => {
      const next = new Map(previous);
      for (const session of parentsToQuery) {
        next.set(session.session_id, session.updated_at ?? "");
      }
      return next;
    });

    let cancelled = false;
    // Bounded concurrency: a cold sidebar can have 100+ visible sessions and
    // firing them all at once queues the backend's blocking pool on SQLite
    // (observed 2.6s average per call under that contention). Batches keep
    // per-call latency flat and results paint incrementally.
    void (async () => {
      for (
        let offset = 0;
        offset < parentsToQuery.length && !cancelled;
        offset += SUBAGENT_QUERY_CONCURRENCY
      ) {
        const batch = parentsToQuery.slice(
          offset,
          offset + SUBAGENT_QUERY_CONCURRENCY
        );
        const results = await Promise.allSettled(
          batch.map(async (parent) => {
            const parentSessionId = parent.session_id;
            const records = await invoke<ChildSessionRecord[]>(
              "es_get_child_sessions",
              { parentSessionId }
            );
            const childSessions = records.map((record) =>
              childRecordToSession(record, parentSessionId)
            );
            for (const childSession of childSessions) {
              upsertSession(childSession);
            }
            return { parentSessionId, childSessions };
          })
        );
        if (cancelled) return;
        setFetchedChildSessionsByParent((previousMap) => {
          const nextMap = new Map(previousMap);
          for (const result of results) {
            if (result.status !== "fulfilled") continue;
            nextMap.set(
              result.value.parentSessionId,
              result.value.childSessions
            );
          }
          return nextMap;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queriedSubagentParents, visibleSessions]);

  const childSessionsByParent = useMemo(() => {
    const map = new Map<string, Session[]>();

    for (const session of sortedSessions) {
      const parentSessionId = parentSessionIdFor(session);
      if (!parentSessionId) continue;
      const bucket = map.get(parentSessionId);
      if (bucket) {
        bucket.push(session);
      } else {
        map.set(parentSessionId, [session]);
      }
    }

    for (const [
      parentSessionId,
      childSessions,
    ] of fetchedChildSessionsByParent) {
      const byId = new Map(
        (map.get(parentSessionId) ?? []).map(
          (session) => [session.session_id, session] as const
        )
      );
      for (const childSession of childSessions) {
        const existing = byId.get(childSession.session_id);
        byId.set(childSession.session_id, {
          ...existing,
          ...childSession,
          parentSessionId:
            childSession.parentSessionId ?? existing?.parentSessionId,
          agentOrgId: childSession.agentOrgId ?? existing?.agentOrgId,
          agentOrgName: childSession.agentOrgName ?? existing?.agentOrgName,
          agentDefinitionId:
            childSession.agentDefinitionId ?? existing?.agentDefinitionId,
          agentIconId: childSession.agentIconId ?? existing?.agentIconId,
          agentDisplayName:
            childSession.agentDisplayName ?? existing?.agentDisplayName,
        });
      }
      map.set(parentSessionId, Array.from(byId.values()));
    }

    for (const childSessions of map.values()) {
      childSessions.sort((left, right) =>
        (right.updated_at || "").localeCompare(left.updated_at || "")
      );
    }

    return map;
  }, [fetchedChildSessionsByParent, sortedSessions]);

  const subagentParentIds = useMemo(
    () =>
      new Set(
        Array.from(childSessionsByParent.entries())
          .filter(([, childSessions]) => childSessions.length > 0)
          .map(([parentSessionId]) => parentSessionId)
      ),
    [childSessionsByParent]
  );

  // Excluded ids leave the rendered list but stay in sessionMap so click
  // routing (threaded cloud rows mapping to local sessions) keeps working.
  // Subagent fetching above intentionally still covers the full visible set
  // (visibleSessions), not just the listed subset.
  const listedSessions = useMemo(
    () =>
      excludedSessionIds && excludedSessionIds.size > 0
        ? visibleSessions.filter(
            (session) => !excludedSessionIds.has(session.session_id)
          )
        : visibleSessions,
    [excludedSessionIds, visibleSessions]
  );

  const { filteredItems: searchedSessions, isFiltering } = useFilteredItems({
    items: listedSessions,
    searchQuery,
    getSearchText: (session) => getSessionSearchText(session, untitledSession),
  });

  const pinnedSessions = useMemo(
    () => searchedSessions.filter((session) => session.pinned),
    [searchedSessions]
  );

  const unpinnedSessions = useMemo(
    () => searchedSessions.filter((session) => !session.pinned),
    [searchedSessions]
  );

  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of visibleSessions) {
      map.set(session.session_id, session);
    }
    for (const childSessions of childSessionsByParent.values()) {
      for (const session of childSessions) {
        map.set(session.session_id, session);
      }
    }
    return map;
  }, [childSessionsByParent, visibleSessions]);

  const buildSessionRow = useCallback(
    (session: Session): NavigationMenuItem =>
      buildSessionMenuItem({
        session,
        untitledSession,
        visitedSessions,
        liveDetail: liveDetailForSession(
          agentLiveStatuses.get(session.session_id)
        ),
      }),
    [agentLiveStatuses, untitledSession, visitedSessions]
  );

  const appendGroupSessions = useCallback(
    (
      items: NavigationMenuItem[],
      groupId: string,
      groupSessions: readonly Session[]
    ): boolean => {
      const visibleCount =
        isFiltering || showAllLoadedGroupSessions
          ? groupSessions.length
          : (groupVisibleCounts.get(groupId) ?? DEFAULT_GROUP_VISIBLE_COUNT);
      const revealedIndex = groupSessions.reduce(
        (lastIndex, session, index) =>
          revealedSessionIds.has(session.session_id) ? index : lastIndex,
        -1
      );
      return appendSessionGroup({
        items,
        groupId,
        groupSessions,
        visibleCount: Math.max(visibleCount, revealedIndex + 1),
        buildSessionRow,
        loadMoreLabel: tCommon("common:actions.loadMore"),
      });
    },
    [
      buildSessionRow,
      groupVisibleCounts,
      isFiltering,
      revealedSessionIds,
      showAllLoadedGroupSessions,
      tCommon,
    ]
  );

  const appendAllGroupSessions = useCallback(
    (items: NavigationMenuItem[], groupSessions: readonly Session[]): void => {
      items.push(...groupSessions.map(buildSessionRow));
    },
    [buildSessionRow]
  );

  const scopedLoadMoreRowFor = useCallback(
    (scope: SessionPaginationScope): NavigationMenuItem | null => {
      if (isFiltering) return null;
      const state = getScopedLoadMoreState(scope, pagination, scopedPagination);
      if (!state.visible) return null;
      const label = state.loading
        ? tCommon("sessions:chat.loading")
        : tCommon("common:actions.loadMore");
      return scopedLoadMoreRow(scope, state, label);
    },
    [isFiltering, pagination, scopedPagination, tCommon]
  );

  const dateGroupLabels: Record<DateGroupKey, string> = useMemo(
    () => ({
      today: tCommon("sessions:chat.historyToday", "Today"),
      yesterday: tCommon("sessions:chat.historyYesterday", "Yesterday"),
      thisWeek: tCommon("sessions:chat.historyThisWeek", "This Week"),
      older: tCommon("sessions:chat.historyOlder", "Older"),
    }),
    [tCommon]
  );

  const pinnedLabel = tCommon("sessions:chat.historyPinned", "Pinned");

  const appendPinnedSessions = useCallback(
    (items: NavigationMenuItem[]): boolean => {
      const backendRow =
        !isFiltering && pinnedPage && (pinnedPage.hasMore || pinnedPage.loading)
          ? pinnedLoadMoreRow(
              pinnedPage.loading,
              pinnedPage.loading
                ? tCommon("sessions:chat.loading")
                : tCommon("common:actions.loadMore"),
              sidebarPinnedScopeKey(pinnedPage.orgIds)
            )
          : null;
      if (pinnedSessions.length === 0 && !backendRow) return false;
      items.push(separator("pinned", pinnedLabel));
      const hasHiddenLocalSessions = appendGroupSessions(
        items,
        "pinned",
        pinnedSessions
      );
      if (!hasHiddenLocalSessions && backendRow) items.push(backendRow);
      return true;
    },
    [
      appendGroupSessions,
      isFiltering,
      pinnedLabel,
      pinnedPage,
      pinnedSessions,
      tCommon,
    ]
  );

  const byTimeMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildByTimeMenuItems({
        unpinnedSessions,
        dateGroupLabels,
        appendPinnedSessions,
        appendGroupSessions,
        scopedLoadMoreRowFor,
        orgIds: sidebarOrgIds,
      }),
    [
      unpinnedSessions,
      dateGroupLabels,
      appendPinnedSessions,
      appendGroupSessions,
      scopedLoadMoreRowFor,
      sidebarOrgIds,
    ]
  );

  const byAgentMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildByAgentMenuItems({
        unpinnedSessions,
        pinnedSessions,
        appendPinnedSessions,
        appendAllGroupSessions,
        scopedLoadMoreRowFor,
        orgIds: sidebarOrgIds,
      }),
    [
      unpinnedSessions,
      pinnedSessions,
      appendPinnedSessions,
      appendAllGroupSessions,
      scopedLoadMoreRowFor,
      sidebarOrgIds,
    ]
  );

  const noWorkspaceLabel = tCommon(
    "sessions:chat.historyNoWorkspace",
    "No Workspace"
  );

  const byWorkspaceMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildByWorkspaceMenuItems({
        unpinnedSessions,
        repoPathToName,
        noWorkspaceLabel,
        appendPinnedSessions,
        appendGroupSessions,
        scopedLoadMoreRowFor,
        orgIds: sidebarOrgIds,
        workspaceFacets: isFiltering ? [] : (workspaceFacetPage?.facets ?? []),
        workspaceFacetLoadMoreRow:
          !isFiltering &&
          workspaceFacetPage &&
          (workspaceFacetPage.hasMore || workspaceFacetPage.loading)
            ? workspaceFacetLoadMoreRow(
                workspaceFacetPage.loading,
                workspaceFacetPage.loading
                  ? tCommon("sessions:chat.loading")
                  : tCommon("common:actions.loadMore"),
                workspaceFacetPage.scopeKey
              )
            : null,
      }),
    [
      unpinnedSessions,
      repoPathToName,
      noWorkspaceLabel,
      appendPinnedSessions,
      appendGroupSessions,
      scopedLoadMoreRowFor,
      sidebarOrgIds,
      isFiltering,
      workspaceFacetPage,
      tCommon,
    ]
  );
  const baseMenuItems = useMemo<NavigationMenuItem[]>(() => {
    switch (groupByMode) {
      case "byAgent":
        return byAgentMenuItems;
      case "byWorkspace":
        return byWorkspaceMenuItems;
      case "byTime":
      default:
        return byTimeMenuItems;
    }
  }, [groupByMode, byTimeMenuItems, byAgentMenuItems, byWorkspaceMenuItems]);

  const menuItems = useMemo<NavigationMenuItem[]>(
    () =>
      insertExpandedSubagentRows({
        items: baseMenuItems,
        childSessionsByParent,
        expandedSubagentParentIds,
        buildSessionRow,
      }),
    [
      baseMenuItems,
      buildSessionRow,
      childSessionsByParent,
      expandedSubagentParentIds,
    ]
  );

  return {
    menuItems,
    sessionMap,
    subagentParentIds,
    isLoadMoreId,
    getLoadMoreGroupId,
    getLoadMoreScopeKey,
    isPinnedLoadMoreId,
    isWorkspaceFacetLoadMoreId,
  };
}
