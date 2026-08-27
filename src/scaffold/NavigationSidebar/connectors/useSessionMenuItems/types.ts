import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import type { GroupByMode } from "../types";

/**
 * Per-workspace header affordances for the Organize-by-workspace view: the
 * hover `+` (start a session in that workspace) and `…` (hide/unhide) actions,
 * plus the hidden set the builder needs to sort hidden groups last.
 *
 * Owned by `useWorkspaceGroupActions`; passed through as one object so the
 * connector chain does not grow a parameter per affordance.
 */
export interface WorkspaceGroupActions {
  /** Workspace keys the viewer pinned — sorted above every other group. */
  pinnedWorkspaceKeys: ReadonlySet<string>;
  /** Workspace keys the viewer hid — sorted last and collapsed by default. */
  hiddenWorkspaceKeys: ReadonlySet<string>;
  /** Start a new session sourced at `workspaceKey` (a repo path). */
  onCreateSession: (workspaceKey: string) => void;
  /** Open the header's `…` menu (pin / hide) for `workspaceKey`. */
  onOpenMenu: (workspaceKey: string) => void;
  /** `+` tooltip/aria label. */
  createSessionLabel: string;
  /** `…` tooltip/aria label. */
  moreActionsLabel: string;
}

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
  /**
   * Workspace header actions. Only consumed by the `byWorkspace` grouping;
   * omitted (tests, cloud scope) the headers render without hover actions.
   */
  workspaceGroupActions?: WorkspaceGroupActions;
}

export interface UseSessionMenuItemsResult {
  menuItems: NavigationMenuItem[];
  sessionMap: Map<string, Session>;
  subagentParentIds: ReadonlySet<string>;
  isLoadMoreId: (id: string) => SessionListCategory | null;
  getLoadMoreGroupId: (id: string) => string | null;
}

export type BuildSessionRow = (session: Session) => NavigationMenuItem;

export type AppendGroupSessions = (
  items: NavigationMenuItem[],
  groupId: string,
  groupSessions: readonly Session[]
) => boolean;

export type AppendPinnedSessions = (
  items: NavigationMenuItem[],
  includeBackendPager?: boolean
) => boolean;

export type AppendTrailingLoadMoreItems = (items: NavigationMenuItem[]) => void;

export type LoadMoreRowFor = (
  category: SessionListCategory
) => NavigationMenuItem | null;
