import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { benchmarkApi } from "@src/api/tauri/benchmark";
import { createLogger } from "@src/hooks/logger";
import { useFilteredItems } from "@src/hooks/search";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { benchmarkAgentBatchStatusAtom } from "@src/store/benchmark";
import {
  DEFAULT_SESSION_ORG_ID,
  type Session,
  type SessionListCategory,
  sessionLastLoadedAtom,
  sessionPaginationAtom,
  upsertSession,
} from "@src/store/session";
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
import {
  appendSessionGroup,
  getLoadMoreGroupId,
  getUnifiedLoadMoreState,
  isLoadMoreId,
  loadMoreRow,
  unifiedLoadMoreRow,
} from "./paginationHelpers";
import type {
  UseSessionMenuItemsParams,
  UseSessionMenuItemsResult,
} from "./types";

export { getLoadMoreGroupId, isLoadMoreId } from "./paginationHelpers";

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
  selectedOrgId,
  includeExternal,
  groupVisibleCounts,
  expandedSubagentParentIds = new Set(),
}: UseSessionMenuItemsParams): UseSessionMenuItemsResult {
  const { t: tCommon } = useTranslation();
  const pagination = useAtomValue(sessionPaginationAtom);
  const sessionLastLoaded = useAtomValue(sessionLastLoadedAtom);
  const benchmarkAgentBatchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const [benchmarkHistoryChildSessionIds, setBenchmarkHistoryChildSessionIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const [queriedSubagentParentIds, setQueriedSubagentParentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
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
        const sessionOrgId = session.orgId ?? DEFAULT_SESSION_ORG_ID;
        return (
          isPrimarySessionListSession(session) &&
          (includeExternal || !isImportedHistorySession(session.session_id)) &&
          (!selectedOrgId || sessionOrgId === selectedOrgId) &&
          !benchmarkChildSessionIds.has(session.session_id) &&
          !benchmarkHistoryChildSessionIds.has(session.session_id) &&
          !benchmarkCoordinatorSessionIds.has(session.parentSessionId ?? "")
        );
      }),
    [
      benchmarkChildSessionIds,
      benchmarkCoordinatorSessionIds,
      benchmarkHistoryChildSessionIds,
      includeExternal,
      selectedOrgId,
      sortedSessions,
    ]
  );

  const visibleSessionIds = useMemo(
    () => visibleSessions.map((session) => session.session_id),
    [visibleSessions]
  );

  useEffect(() => {
    setQueriedSubagentParentIds(new Set());
  }, [sessionLastLoaded]);

  useEffect(() => {
    const parentIdsToQuery = visibleSessionIds.filter(
      (sessionId) => !queriedSubagentParentIds.has(sessionId)
    );
    if (parentIdsToQuery.length === 0) return;

    setQueriedSubagentParentIds((previousIds) => {
      const nextIds = new Set(previousIds);
      for (const sessionId of parentIdsToQuery) {
        nextIds.add(sessionId);
      }
      return nextIds;
    });

    let cancelled = false;
    void Promise.allSettled(
      parentIdsToQuery.map(async (parentSessionId) => {
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
    ).then((results) => {
      if (cancelled) return;
      setFetchedChildSessionsByParent((previousMap) => {
        const nextMap = new Map(previousMap);
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          nextMap.set(result.value.parentSessionId, result.value.childSessions);
        }
        return nextMap;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [queriedSubagentParentIds, visibleSessionIds]);

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

  const { filteredItems: searchedSessions, isFiltering } = useFilteredItems({
    items: visibleSessions,
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
      buildSessionMenuItem({ session, untitledSession, visitedSessions }),
    [untitledSession, visitedSessions]
  );

  const loadMoreRowFor = useCallback(
    (category: SessionListCategory): NavigationMenuItem | null => {
      const state = pagination[category];
      if (!state.hasMore && !state.loading) return null;
      const label = state.loading
        ? tCommon("sessions:chat.loading")
        : tCommon("common:actions.loadMore");
      return loadMoreRow(category, state.loading, label);
    },
    [pagination, tCommon]
  );

  const trailingLoadMoreItems = useMemo<NavigationMenuItem[]>(() => {
    if (isFiltering) return [];
    const state = getUnifiedLoadMoreState(pagination);
    if (!state.visible) return [];
    const label = state.loading
      ? tCommon("sessions:chat.loading")
      : tCommon("common:actions.loadMore");
    return [unifiedLoadMoreRow(state, label)];
  }, [isFiltering, pagination, tCommon]);

  const appendTrailingLoadMoreItems = useCallback(
    (items: NavigationMenuItem[]) => {
      if (trailingLoadMoreItems.length === 0) return;
      items.push(separator("backend-load-more"));
      items.push(...trailingLoadMoreItems);
    },
    [trailingLoadMoreItems]
  );

  const appendGroupSessions = useCallback(
    (
      items: NavigationMenuItem[],
      groupId: string,
      groupSessions: readonly Session[]
    ): boolean => {
      const visibleCount = isFiltering
        ? groupSessions.length
        : (groupVisibleCounts.get(groupId) ?? DEFAULT_GROUP_VISIBLE_COUNT);
      return appendSessionGroup({
        items,
        groupId,
        groupSessions,
        visibleCount,
        buildSessionRow,
        loadMoreLabel: tCommon("common:actions.loadMore"),
      });
    },
    [buildSessionRow, groupVisibleCounts, isFiltering, tCommon]
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
      if (pinnedSessions.length === 0) return false;
      items.push(separator("pinned", pinnedLabel));
      return appendGroupSessions(items, "pinned", pinnedSessions);
    },
    [appendGroupSessions, pinnedLabel, pinnedSessions]
  );

  const byTimeMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildByTimeMenuItems({
        unpinnedSessions,
        dateGroupLabels,
        appendPinnedSessions,
        appendGroupSessions,
        appendTrailingLoadMoreItems,
      }),
    [
      unpinnedSessions,
      dateGroupLabels,
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
    ]
  );

  const byAgentMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildByAgentMenuItems({
        unpinnedSessions,
        appendPinnedSessions,
        appendGroupSessions,
        loadMoreRowFor: isFiltering ? () => null : loadMoreRowFor,
      }),
    [
      unpinnedSessions,
      appendPinnedSessions,
      appendGroupSessions,
      isFiltering,
      loadMoreRowFor,
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
        appendTrailingLoadMoreItems,
      }),
    [
      unpinnedSessions,
      repoPathToName,
      noWorkspaceLabel,
      appendPinnedSessions,
      appendGroupSessions,
      appendTrailingLoadMoreItems,
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
  };
}
