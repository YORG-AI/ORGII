import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentLiveStatus } from "@src/api/tauri/rpc/schemas/agentOrgs";
import { useFilteredItems } from "@src/hooks/search";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  type Session,
  type SessionListCategory,
  createSidebarRosterMatcher,
  sessionPaginationAtom,
  upsertSession,
} from "@src/store/session";
import { agentLiveStatusAtom } from "@src/store/session/agentLiveStatusAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  continuationLineagesForRevealedSessions,
  isRosterSiblingOfRevealedContinuation,
} from "./continuationVisibility";
import {
  DEFAULT_GROUP_VISIBLE_COUNT,
  type DateGroupKey,
} from "./dateGroupingHelpers";
import { buildSessionMenuItem, separator } from "./menuItemBuilders";
import {
  buildByAgentMenuItems,
  buildByTimeMenuItems,
  buildByWorkspaceMenuItems,
} from "./menuSectionBuilders";
import { sessionMatchesOrgFilter } from "./orgFilter";
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
import { useSessionPrStatuses } from "./useSessionPrStatuses";

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

export { getLoadMoreGroupId, isLoadMoreId } from "./paginationHelpers";

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
  extraSessionIds,
  excludedSessionIds,
  includeExternal,
  groupVisibleCounts,
  showAllLoadedGroupSessions = false,
  expandedSubagentParentIds = new Set(),
  revealedSessionIds = new Set(),
}: UseSessionMenuItemsParams): UseSessionMenuItemsResult {
  const { t: tCommon } = useTranslation();
  const pagination = useAtomValue(sessionPaginationAtom);
  const agentLiveStatuses = useAtomValue(agentLiveStatusAtom);
  // parentId → the parent's updated_at at query time. Children are re-fetched
  // only when the parent session changes, instead of re-querying every
  // visible session on every list refresh (that pattern issued 100+
  // concurrent `es_get_child_sessions` calls that queued up on SQLite).
  const [queriedSubagentParents, setQueriedSubagentParents] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [fetchedChildSessionsByParent, setFetchedChildSessionsByParent] =
    useState<ReadonlyMap<string, Session[]>>(() => new Map());

  const isInSidebarRoster = useMemo(
    () => createSidebarRosterMatcher(pagination),
    [pagination]
  );
  const revealedContinuationLineages = useMemo(
    () =>
      continuationLineagesForRevealedSessions(
        sortedSessions,
        revealedSessionIds
      ),
    [revealedSessionIds, sortedSessions]
  );

  const visibleSessions = useMemo(
    () =>
      sortedSessions.filter((session) => {
        const explicitlyRevealed = revealedSessionIds.has(session.session_id);
        const hiddenRosterSibling = isRosterSiblingOfRevealedContinuation(
          session,
          revealedSessionIds,
          revealedContinuationLineages
        );
        return (
          !hiddenRosterSibling &&
          isPrimarySessionListSession(session) &&
          (explicitlyRevealed ||
            (isInSidebarRoster(session) &&
              (includeExternal ||
                !isImportedHistorySession(session.session_id)) &&
              (sessionMatchesOrgFilter(session, selectedOrgIds) ||
                (extraSessionIds?.has(session.session_id) ?? false))))
        );
      }),
    [
      extraSessionIds,
      includeExternal,
      isInSidebarRoster,
      revealedSessionIds,
      revealedContinuationLineages,
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

  // Keyed off the listed rows, not `visibleSessions`: a repo only earns a PR
  // fetch once one of its sessions is actually on screen.
  const prForSession = useSessionPrStatuses(listedSessions);

  const buildSessionRow = useCallback(
    (session: Session): NavigationMenuItem =>
      buildSessionMenuItem({
        session,
        untitledSession,
        visitedSessions,
        liveDetail: liveDetailForSession(
          agentLiveStatuses.get(session.session_id)
        ),
        pr: prForSession(session),
      }),
    [agentLiveStatuses, prForSession, untitledSession, visitedSessions]
  );

  const loadMoreRowFor = useCallback(
    (category: SessionListCategory): NavigationMenuItem | null => {
      const state = pagination[category];
      if (state.generation === 0 || state.phase === "exhausted") return null;
      const loading = state.phase === "loading";
      const label = loading
        ? tCommon("sessions:chat.loading")
        : state.phase === "error"
          ? tCommon("common:actions.retry", "Retry")
          : tCommon("common:actions.loadMore");
      return loadMoreRow(category, loading, label);
    },
    [pagination, tCommon]
  );

  const trailingLoadMoreItems = useMemo<NavigationMenuItem[]>(() => {
    if (isFiltering) return [];
    const state = getUnifiedLoadMoreState(pagination);
    if (!state.visible) return [];
    const label = state.loading
      ? tCommon("sessions:chat.loading")
      : state.error
        ? tCommon("common:actions.retry", "Retry")
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
    (items: NavigationMenuItem[], includeBackendPager = false): boolean => {
      const backendRow = includeBackendPager
        ? loadMoreRowFor("pinned_native")
        : null;
      if (pinnedSessions.length === 0 && !backendRow) return false;
      items.push(separator("pinned", pinnedLabel));
      const hasHiddenRows =
        pinnedSessions.length > 0
          ? appendGroupSessions(items, "pinned", pinnedSessions)
          : false;
      if (!hasHiddenRows && backendRow) items.push(backendRow);
      return hasHiddenRows;
    },
    [appendGroupSessions, loadMoreRowFor, pinnedLabel, pinnedSessions]
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
