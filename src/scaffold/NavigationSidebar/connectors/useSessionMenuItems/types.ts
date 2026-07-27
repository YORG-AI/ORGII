import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type {
  Session,
  SessionListCategory,
  SessionPaginationScope,
  SidebarPinnedPageState,
  SidebarWorkspaceFacetPageState,
} from "@src/store/session";

import type { GroupByMode } from "../types";

export interface UseSessionMenuItemsParams {
  sortedSessions: Session[];
  visitedSessions: ReadonlySet<string>;
  repoPathToName: Map<string, string>;
  groupByMode: GroupByMode;
  untitledSession: string;
  searchQuery?: string;
  /**
   * Org ids accepted by the sidebar org selector (see orgFilter.ts). A set,
   * not a single id: a collab org selection also accepts its local
   * `projectOrgId` alias so work-item-launched sessions match. Undefined or
   * empty disables org filtering.
   */
  selectedOrgIds?: ReadonlySet<string>;
  /** Canonical sorted org ids used by the matching backend cursors. */
  sidebarOrgIds: readonly string[];
  /**
   * Session ids matched INTO the scope regardless of their `orgId` — e.g.
   * sessions explicitly tagged into the active cloud org
   * (sessionOrgTagsAtom). OR-ed with the `selectedOrgIds` match.
   */
  extraSessionIds?: ReadonlySet<string>;
  /**
   * Session ids hidden from the rendered list but KEPT in `sessionMap`
   * (click routing still works). Used by the cloud scope to dedupe local
   * sessions that already render inside the threaded team-sessions section.
   */
  excludedSessionIds?: ReadonlySet<string>;
  includeExternal: boolean;
  pinnedPage?: SidebarPinnedPageState;
  workspaceFacetPage?: SidebarWorkspaceFacetPageState;
  groupVisibleCounts: ReadonlyMap<string, number>;
  /**
   * Render every session already present in each subgroup and let the caller
   * own the only visible client-side pager. Cloud scope uses this before it
   * flattens subgroup headers into the top-level "My sessions" section.
   */
  showAllLoadedGroupSessions?: boolean;
  expandedSubagentParentIds?: ReadonlySet<string>;
  /** IDs temporarily forced through view filters for cross-surface reveal. */
  revealedSessionIds?: ReadonlySet<string>;
}

export interface UseSessionMenuItemsResult {
  menuItems: NavigationMenuItem[];
  sessionMap: Map<string, Session>;
  subagentParentIds: ReadonlySet<string>;
  isLoadMoreId: (id: string) => SessionListCategory | null;
  getLoadMoreGroupId: (id: string) => string | null;
  getLoadMoreScopeKey: (id: string) => string | null;
  isPinnedLoadMoreId: (id: string) => boolean;
  isWorkspaceFacetLoadMoreId: (id: string) => boolean;
}

export type BuildSessionRow = (session: Session) => NavigationMenuItem;

export type AppendGroupSessions = (
  items: NavigationMenuItem[],
  groupId: string,
  groupSessions: readonly Session[]
) => boolean;

export type AppendAllGroupSessions = (
  items: NavigationMenuItem[],
  groupSessions: readonly Session[]
) => void;

export type AppendPinnedSessions = (items: NavigationMenuItem[]) => boolean;

export type ScopedLoadMoreRowFor = (
  scope: SessionPaginationScope
) => NavigationMenuItem | null;
