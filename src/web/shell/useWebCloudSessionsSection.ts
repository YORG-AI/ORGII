/**
 * Web sidebar cloud session sections — reuses desktop cloud menu builders
 * (`useCloudTeamSessionMenuItems`, `useCloudSessionRowItemBuilder`) with
 * read-only row chrome and route navigation instead of desktop replay/fork.
 *
 * Desktop cloud scope splits local device sessions (My sessions) from remote
 * team rows (Team sessions). Web has no Tauri session store, so "My sessions"
 * maps to the signed-in viewer's own cloud rows (`ownerUserId === self`).
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildCloudRemoteItemId,
  parseCloudRemoteItemId,
} from "@src/features/Org2Cloud/cloudRemoteItemId";
import type { CloudSessionFilter } from "@src/features/Org2Cloud/cloudSessionFilter";
import {
  type CloudSessionThread,
  buildCloudSessionThreads,
} from "@src/features/Org2Cloud/cloudSessionThreads";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudPresenceAtom } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import type { CloudRemoteSessionsFetchState } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useRefreshSpin } from "@src/hooks/ui";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_SESSION_SECTION_PAGE_SIZE,
  CLOUD_TEAM_SESSIONS_LOAD_MORE_ID,
  buildCloudSectionLoadMoreItem,
} from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudScopedMenuItems";
import { useCloudTeamSessionMenuItems } from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudSessionsSection.menuItems";
import type { BuildCloudSessionRowItem } from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudSessionsSection.rowItemBuilder";
import { useCloudSessionRowItemBuilder } from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudSessionsSection.rowItemBuilder";
import { resetScopedSectionPagination } from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/sectionPagination";
import { separator } from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/menuItemBuilders";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { WebSessionListItem } from "../features/sessions/useWebSessionRoster";
import { webSessionPath } from "../features/sessions/webSessionLocation";

const WEB_TEAM_FILTER: CloudSessionFilter = { kind: "all" };

export function mapWebRosterStatusToCloudFetchState(
  status: "idle" | "loading" | "loaded" | "error",
  hasSessions: boolean
): CloudRemoteSessionsFetchState {
  if (status === "error" && !hasSessions) return "error";
  if (status === "loading" && !hasSessions) return "loading";
  if (status === "idle" && !hasSessions) return "idle";
  return "ready";
}

export function resolveWebCloudSessionMenuItemId(
  session: Pick<RemoteTeammateSessionMetadata, "orgId" | "id"> | null
): string | undefined {
  if (!session) return undefined;
  return buildCloudRemoteItemId(session.orgId, session.id);
}

/** Split one org's cloud roster into the viewer's rows vs teammates'. */
export function splitWebCloudSessionRows<
  T extends Pick<RemoteTeammateSessionMetadata, "ownerUserId">,
>(
  rows: readonly T[],
  selfUserId: string | null
): { ownRows: T[]; teamRows: T[] } {
  if (!selfUserId) {
    return { ownRows: [], teamRows: [...rows] };
  }
  const ownRows: T[] = [];
  const teamRows: T[] = [];
  for (const row of rows) {
    if (row.ownerUserId === selfUserId) ownRows.push(row);
    else teamRows.push(row);
  }
  return { ownRows, teamRows };
}

function buildCloudThreadRowMenuItems({
  threads,
  visibleThreads,
  buildRowItem,
  loadMoreId,
  loadMoreLabel,
}: {
  threads: readonly CloudSessionThread[];
  visibleThreads: readonly CloudSessionThread[];
  buildRowItem: BuildCloudSessionRowItem;
  loadMoreId: string;
  loadMoreLabel: string;
}): NavigationMenuItem[] {
  const items: NavigationMenuItem[] = [];
  for (const thread of visibleThreads) {
    if (thread.descendants.length === 0) {
      items.push(buildRowItem(thread.root));
    } else {
      items.push(
        buildRowItem(
          thread.root,
          thread.descendants.map((descendant) => buildRowItem(descendant))
        )
      );
    }
  }
  if (visibleThreads.length < threads.length) {
    items.push(
      buildCloudSectionLoadMoreItem({
        id: loadMoreId,
        label: loadMoreLabel,
      })
    );
  }
  return items;
}

interface UseWebCloudSessionsSectionParams {
  orgId: string | null;
  sessions: readonly WebSessionListItem[];
  rosterStatus: "idle" | "loading" | "loaded" | "error";
  refresh: () => void | Promise<void>;
}

export function useWebCloudSessionsSection({
  orgId,
  sessions,
  rosterStatus,
  refresh,
}: UseWebCloudSessionsSectionParams) {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const auth = useAtomValue(org2CloudAuthAtom);
  const presenceMap = useAtomValue(org2CloudPresenceAtom);
  const selfUserId = auth?.userId ?? null;

  const scopedRows = useMemo(
    () => (orgId ? sessions.filter((session) => session.orgId === orgId) : []),
    [orgId, sessions]
  );
  const { ownRows, teamRows } = useMemo(
    () => splitWebCloudSessionRows(scopedRows, selfUserId),
    [scopedRows, selfUserId]
  );
  const fetchState = mapWebRosterStatusToCloudFetchState(
    rosterStatus,
    scopedRows.length > 0
  );
  const isRefreshing = rosterStatus === "loading" && scopedRows.length > 0;

  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(
      () => {
        void refresh();
      },
      isRefreshing,
      orgId ? `web-cloud-team-sessions:${orgId}` : undefined
    );

  const teamThreads = useMemo(
    () =>
      orgId
        ? buildCloudSessionThreads(teamRows, {
            memberFilter: null,
            viewerUserId: selfUserId,
          })
        : [],
    [orgId, selfUserId, teamRows]
  );
  const ownThreads = useMemo(
    () =>
      orgId
        ? buildCloudSessionThreads(ownRows, {
            memberFilter: null,
            viewerUserId: selfUserId,
          })
        : [],
    [orgId, ownRows, selfUserId]
  );

  const teamPaginationScopeKey = orgId ? `${orgId}:team` : "";
  const myPaginationScopeKey = orgId ? `${orgId}:my` : "";
  const [teamPagination, setTeamPagination] = useState({
    scopeKey: "",
    visibleCount: CLOUD_SESSION_SECTION_PAGE_SIZE,
  });
  const [myPagination, setMyPagination] = useState({
    scopeKey: "",
    visibleCount: CLOUD_SESSION_SECTION_PAGE_SIZE,
  });
  const requestedTeamVisibleCount =
    teamPagination.scopeKey === teamPaginationScopeKey
      ? teamPagination.visibleCount
      : CLOUD_SESSION_SECTION_PAGE_SIZE;
  const requestedMyVisibleCount =
    myPagination.scopeKey === myPaginationScopeKey
      ? myPagination.visibleCount
      : CLOUD_SESSION_SECTION_PAGE_SIZE;
  const visibleTeamThreads = useMemo(
    () => teamThreads.slice(0, requestedTeamVisibleCount),
    [requestedTeamVisibleCount, teamThreads]
  );
  const visibleOwnThreads = useMemo(
    () => ownThreads.slice(0, requestedMyVisibleCount),
    [ownThreads, requestedMyVisibleCount]
  );

  const buildRowItem = useCloudSessionRowItemBuilder({
    presenceMap,
    selfUserId,
    t,
    tCommon,
    runFork: () => undefined,
    hideRemoteSession: () => undefined,
    busySessionRows: new Map(),
    pinnedRemoteSessionIds: new Set(),
    toggleRemoteSessionPin: () => undefined,
    readOnlySurface: true,
  });

  const teamMenuItems = useCloudTeamSessionMenuItems({
    orgId,
    threads: teamThreads,
    visibleThreads: visibleTeamThreads,
    state: fetchState,
    filter: WEB_TEAM_FILTER,
    memberMenu: null,
    setMemberMenu: () => undefined,
    refreshSpinClass,
    handleRefreshClick,
    buildRowItem,
    t,
    tCommon,
    showSessionFilter: false,
  });

  const mySessionMenuItems = useMemo<NavigationMenuItem[]>(() => {
    if (!orgId) return [];
    const items: NavigationMenuItem[] = [
      separator(CLOUD_MY_SESSIONS_SECTION_ID, t("cloud.sidebar.mySessions")),
      ...buildCloudThreadRowMenuItems({
        threads: ownThreads,
        visibleThreads: visibleOwnThreads,
        buildRowItem,
        loadMoreId: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
        loadMoreLabel: tCommon("actions.loadMore"),
      }),
    ];
    if (ownThreads.length === 0) {
      items.push({
        id: "cloud-my-sessions-empty",
        key: "cloud-my-sessions-empty",
        label: t("cloud.orgPanel.sessionsEmpty"),
        dataTestId: "cloud-my-sessions-empty",
        visualTone: "secondary",
        disabled: true,
      });
    }
    return items;
  }, [buildRowItem, orgId, ownThreads, t, tCommon, visibleOwnThreads]);

  const cloudMenuItems = useMemo(
    () => [...teamMenuItems, ...mySessionMenuItems],
    [mySessionMenuItems, teamMenuItems]
  );

  const rowById = useMemo(() => {
    const map = new Map<string, WebSessionListItem>();
    for (const session of scopedRows) {
      map.set(session.id, session);
    }
    return map;
  }, [scopedRows]);

  const resolveSessionPath = useCallback(
    (item: NavigationMenuItem): string | null => {
      const parsed = parseCloudRemoteItemId(item.id);
      if (!parsed) return null;
      const row = rowById.get(parsed.rowId);
      if (!row || row.eventsEpoch === undefined) return null;
      const openNotes = (row.unresolvedCommentCount ?? 0) > 0;
      return webSessionPath(row, { openNotes });
    },
    [rowById]
  );

  const handleMenuItemClick = useCallback(
    (item: NavigationMenuItem): boolean => {
      if (item.id === CLOUD_TEAM_SESSIONS_LOAD_MORE_ID) {
        setTeamPagination((current) => ({
          scopeKey: teamPaginationScopeKey,
          visibleCount:
            (current.scopeKey === teamPaginationScopeKey
              ? current.visibleCount
              : CLOUD_SESSION_SECTION_PAGE_SIZE) +
            CLOUD_SESSION_SECTION_PAGE_SIZE,
        }));
        return true;
      }
      if (item.id === CLOUD_MY_SESSIONS_LOAD_MORE_ID) {
        setMyPagination((current) => ({
          scopeKey: myPaginationScopeKey,
          visibleCount:
            (current.scopeKey === myPaginationScopeKey
              ? current.visibleCount
              : CLOUD_SESSION_SECTION_PAGE_SIZE) +
            CLOUD_SESSION_SECTION_PAGE_SIZE,
        }));
        return true;
      }
      const path = resolveSessionPath(item);
      if (!path) {
        return parseCloudRemoteItemId(item.id) !== null;
      }
      return false;
    },
    [myPaginationScopeKey, resolveSessionPath, teamPaginationScopeKey]
  );

  const resetTeamPagination = useCallback(() => {
    setTeamPagination((current) =>
      resetScopedSectionPagination(current, CLOUD_SESSION_SECTION_PAGE_SIZE)
    );
    setMyPagination((current) =>
      resetScopedSectionPagination(current, CLOUD_SESSION_SECTION_PAGE_SIZE)
    );
  }, []);

  return {
    cloudMenuItems,
    handleMenuItemClick,
    resolveSessionPath,
    resetTeamPagination,
  };
}
