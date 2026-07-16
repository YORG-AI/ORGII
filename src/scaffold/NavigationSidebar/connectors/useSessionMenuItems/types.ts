import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import type { GroupByMode } from "../types";

export interface UseSessionMenuItemsParams {
  sortedSessions: Session[];
  visitedSessions: ReadonlySet<string>;
  repoPathToName: Map<string, string>;
  groupByMode: GroupByMode;
  untitledSession: string;
  searchQuery?: string;
  selectedOrgId?: string;
  includeExternal: boolean;
  groupVisibleCounts: ReadonlyMap<string, number>;
  expandedSubagentParentIds?: ReadonlySet<string>;
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

export type AppendPinnedSessions = (items: NavigationMenuItem[]) => boolean;

export type AppendTrailingLoadMoreItems = (items: NavigationMenuItem[]) => void;

export type LoadMoreRowFor = (
  category: SessionListCategory
) => NavigationMenuItem | null;
