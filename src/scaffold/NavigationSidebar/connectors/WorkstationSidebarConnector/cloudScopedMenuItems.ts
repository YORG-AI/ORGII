import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import { sortSessionsByActivity } from "../workstationSidebarData";

export const CLOUD_MY_SESSIONS_SECTION_ID = "cloud-my-sessions";
export const CLOUD_TEAM_SESSIONS_SECTION_ID = "cloud-team-sessions";
export const CLOUD_SESSION_SECTION_PAGE_SIZE = 10;
export const CLOUD_TEAM_SESSIONS_LOAD_MORE_ID = "cloud-team-sessions-next-page";
export const CLOUD_MY_SESSIONS_LOAD_MORE_ID = "cloud-my-sessions-next-page";

interface BuildCloudScopedMenuItemsParams {
  cloudMenuItems: readonly NavigationMenuItem[];
  sessionMenuItems: readonly NavigationMenuItem[];
  sessionById: ReadonlyMap<string, Session>;
  mySessionsLabel: string;
  mySessionsVisibleCount?: number;
  loadMoreLabel?: string;
}

export function isSessionPaginationMenuItem(item: NavigationMenuItem): boolean {
  return item.id.startsWith("load-more-");
}

export function isCloudScopedLocalRow(item: NavigationMenuItem): boolean {
  return (
    !item.id.startsWith("separator-") && !isSessionPaginationMenuItem(item)
  );
}

export function buildCloudSectionLoadMoreItem({
  id,
  label,
  disabled = false,
  trailingElement,
}: {
  id: string;
  label: string;
  disabled?: boolean;
  trailingElement?: ReactNode;
}): NavigationMenuItem {
  return {
    id,
    key: id,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    visualTone: "secondary",
    disabled,
    trailingElement,
  };
}

export function orderSessionMenuRowsByActivity(
  rows: readonly NavigationMenuItem[],
  sessionById: ReadonlyMap<string, Session>
): NavigationMenuItem[] {
  const rowBySessionId = new Map<string, NavigationMenuItem>();
  const unmatchedRows: NavigationMenuItem[] = [];

  for (const row of rows) {
    if (sessionById.has(row.id)) rowBySessionId.set(row.id, row);
    else unmatchedRows.push(row);
  }

  const matchedSessions = Array.from(rowBySessionId.keys())
    .map((sessionId) => sessionById.get(sessionId))
    .filter((session): session is Session => session !== undefined);

  return [
    ...sortSessionsByActivity(matchedSessions).flatMap((session) => {
      const row = rowBySessionId.get(session.session_id);
      return row ? [row] : [];
    }),
    ...unmatchedRows,
  ];
}

/**
 * Cloud scope has two top-level sections: shared team sessions and the
 * viewer's own sessions. Local grouping separators are removed and local rows
 * form one canonical newest-activity-first queue before pagination.
 */
export function buildCloudScopedMenuItems({
  cloudMenuItems,
  sessionMenuItems,
  sessionById,
  mySessionsLabel,
  mySessionsVisibleCount = CLOUD_SESSION_SECTION_PAGE_SIZE,
  loadMoreLabel = "Load more",
}: BuildCloudScopedMenuItemsParams): NavigationMenuItem[] {
  if (cloudMenuItems.length === 0) return [...sessionMenuItems];

  const backendPaginationItems = sessionMenuItems.filter(
    isSessionPaginationMenuItem
  );
  const localRows = orderSessionMenuRowsByActivity(
    sessionMenuItems.filter(isCloudScopedLocalRow),
    sessionById
  );
  const visibleLocalRows = localRows.slice(0, mySessionsVisibleCount);
  const hasHiddenLoadedRows = localRows.length > visibleLocalRows.length;
  const readyBackendPaginationItem = backendPaginationItems.find(
    (item) => !item.disabled
  );
  const loadingBackendPaginationItem = backendPaginationItems.find(
    (item) => item.disabled
  );
  const hasMore = hasHiddenLoadedRows || backendPaginationItems.length > 0;
  const mySessionsItems = hasMore
    ? [
        ...visibleLocalRows,
        buildCloudSectionLoadMoreItem({
          id: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
          label:
            !hasHiddenLoadedRows && !readyBackendPaginationItem
              ? (loadingBackendPaginationItem?.label ?? loadMoreLabel)
              : loadMoreLabel,
          disabled:
            !hasHiddenLoadedRows && readyBackendPaginationItem === undefined,
          trailingElement:
            !hasHiddenLoadedRows && readyBackendPaginationItem === undefined
              ? loadingBackendPaginationItem?.trailingElement
              : undefined,
        }),
      ]
    : visibleLocalRows;

  return [
    ...cloudMenuItems,
    separator(CLOUD_MY_SESSIONS_SECTION_ID, mySessionsLabel),
    ...mySessionsItems,
  ];
}
