import type { ReactNode } from "react";

import { MoreHorizontalIcon } from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import { sortSessionsByActivity } from "../workstationSidebarData";

export const CLOUD_MY_SESSIONS_SECTION_ID = "cloud-my-sessions";
export const CLOUD_PINNED_SECTION_ID = "cloud-pinned";
export const CLOUD_TEAM_SESSIONS_SECTION_ID = "cloud-team-sessions";
export const CLOUD_SESSION_SECTION_PAGE_SIZE = 10;
export const CLOUD_TEAM_SESSIONS_LOAD_MORE_ID = "cloud-team-sessions-next-page";
export const CLOUD_MY_SESSIONS_LOAD_MORE_ID = "cloud-my-sessions-next-page";

interface BuildCloudScopedMenuItemsParams {
  cloudMenuItems: readonly NavigationMenuItem[];
  sessionMenuItems: readonly NavigationMenuItem[];
  sessionById: ReadonlyMap<string, Session>;
  mySessionsLabel: string;
  pinnedLabel?: string;
  mySessionsVisibleCount?: number;
  loadMoreLabel?: string;
}

const LOCAL_GROUP_PAGER_PREFIX = "load-more-group-";

export function isSessionPaginationMenuItem(item: NavigationMenuItem): boolean {
  return item.id.startsWith("load-more-");
}

/**
 * A backend stream pager (`load-more-<category>`), as opposed to a local
 * "show more of this group" pager (`load-more-group-<group>`), whose id also
 * begins with `load-more-`. Only the former speaks for a stream that can fetch
 * another page from Rust.
 */
function isBackendStreamPager(item: NavigationMenuItem): boolean {
  return (
    isSessionPaginationMenuItem(item) &&
    !item.id.startsWith(LOCAL_GROUP_PAGER_PREFIX)
  );
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
    icon: MoreHorizontalIcon,
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
 * Cloud scope has three top-level sections: the pinned rows the viewer lifted
 * out, shared team sessions, and everything else of theirs. Date grouping is
 * removed and unpinned local rows form one canonical newest-activity-first
 * queue before pagination. Pinned remains a distinct user-intent section for
 * both local and team sessions.
 */
export function buildCloudScopedMenuItems({
  cloudMenuItems,
  sessionMenuItems,
  sessionById,
  mySessionsLabel,
  pinnedLabel = "Pinned",
  mySessionsVisibleCount = CLOUD_SESSION_SECTION_PAGE_SIZE,
  loadMoreLabel = "Load more",
}: BuildCloudScopedMenuItemsParams): NavigationMenuItem[] {
  if (cloudMenuItems.length === 0) return [...sessionMenuItems];

  // Rows carry their own `pinned` flag, so the pinned block is lifted by
  // identity rather than by which separator happens to precede a row — and
  // the same rule then works for a teammate's row, which lives in a
  // different section entirely.
  const pinnedItems: NavigationMenuItem[] = [];
  const unsortedLocalRows: NavigationMenuItem[] = [];
  const backendPaginationItems: NavigationMenuItem[] = [];
  for (const item of sessionMenuItems) {
    if (item.id.startsWith("separator-")) continue;
    if (isBackendStreamPager(item)) {
      backendPaginationItems.push(item);
      continue;
    }
    // A date group's own "show more" pager is meaningless once that group is
    // flattened into My sessions — the section's own pager governs from here.
    if (item.id.startsWith(LOCAL_GROUP_PAGER_PREFIX)) continue;
    (item.pinned ? pinnedItems : unsortedLocalRows).push(item);
  }
  const localRows = orderSessionMenuRowsByActivity(
    unsortedLocalRows,
    sessionById
  );
  // Team rows keep their section, except the ones the viewer pinned: pinning
  // means "keep this where I can see it", which is not a per-section promise.
  const teamItems: NavigationMenuItem[] = [];
  for (const item of cloudMenuItems) {
    if (item.pinned) pinnedItems.push(item);
    else teamItems.push(item);
  }
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
    ...(pinnedItems.length > 0
      ? [separator(CLOUD_PINNED_SECTION_ID, pinnedLabel), ...pinnedItems]
      : []),
    ...teamItems,
    separator(CLOUD_MY_SESSIONS_SECTION_ID, mySessionsLabel),
    ...mySessionsItems,
  ];
}
