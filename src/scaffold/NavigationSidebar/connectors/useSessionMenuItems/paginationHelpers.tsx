import { MoreHorizontal } from "lucide-react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  SESSION_LIST_CATEGORIES,
  categoryCanLoadInScope,
  sessionPaginationScopeKey,
} from "@src/store/session";
import type {
  ScopedSessionPaginationMap,
  Session,
  SessionListCategory,
  SessionPaginationMap,
  SessionPaginationScope,
} from "@src/store/session";

import {
  LOAD_MORE_GROUP_PREFIX,
  LOAD_MORE_PINNED_ID,
  LOAD_MORE_PREFIX,
  LOAD_MORE_SCOPE_PREFIX,
  LOAD_MORE_WORKSPACE_FACETS_ID,
} from "../types";
import { DEFAULT_GROUP_VISIBLE_COUNT } from "./dateGroupingHelpers";
import { renderBreathingStatusDot } from "./statusIndicators";
import type { BuildSessionRow } from "./types";

export const LOAD_MORE_CATEGORIES: readonly SessionListCategory[] =
  SESSION_LIST_CATEGORIES;
export const UNIFIED_LOAD_MORE_ID = "load-more-unified";

interface UnifiedLoadMoreState {
  visible: boolean;
  loading: boolean;
  disabled: boolean;
  readyCategories: SessionListCategory[];
}

interface ScopedLoadMoreState {
  visible: boolean;
  loading: boolean;
  disabled: boolean;
}

interface LoadUnifiedReadyCategoriesParams {
  disabled?: boolean;
  pagination: SessionPaginationMap;
  loadCategory: (category: SessionListCategory) => Promise<void>;
}

export function loadMoreRow(
  category: SessionListCategory,
  loading: boolean,
  label: string
): NavigationMenuItem {
  return {
    id: `${LOAD_MORE_PREFIX}${category}`,
    key: `${LOAD_MORE_PREFIX}${category}`,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    trailingElement: loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: loading,
    dataTestId: `sidebar-category-load-more-${category.replace(/:/g, "-")}`,
  };
}

export function groupLoadMoreRow(
  groupId: string,
  label: string,
  loading = false
): NavigationMenuItem {
  return {
    id: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    key: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    trailingElement: loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: loading,
    dataTestId: `sidebar-local-group-load-more-${groupId.replace(/:/g, "-")}`,
  };
}

export function scopedLoadMoreRow(
  scope: SessionPaginationScope,
  state: ScopedLoadMoreState,
  label: string
): NavigationMenuItem {
  const scopeKey = sessionPaginationScopeKey(scope);
  return {
    id: `${LOAD_MORE_SCOPE_PREFIX}${scopeKey}`,
    key: `${LOAD_MORE_SCOPE_PREFIX}${scopeKey}`,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    trailingElement: state.loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: state.disabled,
    dataTestId: `sidebar-scope-load-more-${scope.kind}-${encodeURIComponent(scopeKey)}`,
    dataMenuItemId:
      scope.kind === "category"
        ? `${LOAD_MORE_PREFIX}${scope.category}`
        : undefined,
  };
}

function discoveryLoadMoreRow(
  id: string,
  loading: boolean,
  label: string,
  dataTestId: string
): NavigationMenuItem {
  return {
    id,
    key: id,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    trailingElement: loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: loading,
    dataTestId,
  };
}

export function pinnedLoadMoreRow(
  loading: boolean,
  label: string,
  scopeKey: string
): NavigationMenuItem {
  return discoveryLoadMoreRow(
    LOAD_MORE_PINNED_ID,
    loading,
    label,
    `sidebar-pinned-load-more-${encodeURIComponent(scopeKey)}`
  );
}

export function workspaceFacetLoadMoreRow(
  loading: boolean,
  label: string,
  scopeKey: string
): NavigationMenuItem {
  return discoveryLoadMoreRow(
    LOAD_MORE_WORKSPACE_FACETS_ID,
    loading,
    label,
    `sidebar-workspace-facets-load-more-${encodeURIComponent(scopeKey)}`
  );
}

export function isPinnedLoadMoreId(id: string): boolean {
  return id === LOAD_MORE_PINNED_ID;
}

export function isWorkspaceFacetLoadMoreId(id: string): boolean {
  return id === LOAD_MORE_WORKSPACE_FACETS_ID;
}

export function unifiedLoadMoreRow(
  state: UnifiedLoadMoreState,
  label: string
): NavigationMenuItem {
  return {
    id: UNIFIED_LOAD_MORE_ID,
    key: UNIFIED_LOAD_MORE_ID,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    trailingElement: state.loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: state.disabled,
  };
}

export function isLoadMoreId(id: string): SessionListCategory | null {
  if (!id.startsWith(LOAD_MORE_PREFIX)) return null;
  const category = id.slice(LOAD_MORE_PREFIX.length) as SessionListCategory;
  return SESSION_LIST_CATEGORIES.includes(category) ? category : null;
}

export function isUnifiedLoadMoreId(id: string): boolean {
  return id === UNIFIED_LOAD_MORE_ID;
}

export function getLoadMoreGroupId(id: string): string | null {
  if (!id.startsWith(LOAD_MORE_GROUP_PREFIX)) return null;
  return id.slice(LOAD_MORE_GROUP_PREFIX.length) || null;
}

export function getLoadMoreScopeKey(id: string): string | null {
  if (!id.startsWith(LOAD_MORE_SCOPE_PREFIX)) return null;
  return id.slice(LOAD_MORE_SCOPE_PREFIX.length) || null;
}

export function getScopedLoadMoreState(
  scope: SessionPaginationScope,
  pagination: SessionPaginationMap,
  scopedPagination: ScopedSessionPaginationMap
): ScopedLoadMoreState {
  const scopedState = scopedPagination[sessionPaginationScopeKey(scope)];
  let visible = false;
  let loading = scopedState?.loading ?? false;

  for (const category of SESSION_LIST_CATEGORIES) {
    const categoryState = scopedState?.categories[category];
    if (
      categoryCanLoadInScope(
        category,
        scope,
        pagination[category],
        categoryState
      )
    ) {
      visible = true;
    }
    if (categoryState?.loading) loading = true;
  }

  return {
    visible,
    loading,
    disabled: !visible || loading,
  };
}

export function getUnifiedLoadMoreState(
  pagination: SessionPaginationMap
): UnifiedLoadMoreState {
  let visible = false;
  let loading = false;
  const readyCategories: SessionListCategory[] = [];

  for (const category of LOAD_MORE_CATEGORIES) {
    const state = pagination[category];
    if (state.loading) {
      visible = true;
      loading = true;
      continue;
    }
    if (state.hasMore) {
      visible = true;
      readyCategories.push(category);
    }
  }

  return {
    visible,
    loading,
    disabled: readyCategories.length === 0,
    readyCategories,
  };
}

export function loadUnifiedReadyCategories({
  disabled,
  pagination,
  loadCategory,
}: LoadUnifiedReadyCategoriesParams): Promise<void[]> | null {
  if (disabled) return null;
  const { readyCategories } = getUnifiedLoadMoreState(pagination);
  if (readyCategories.length === 0) return null;
  return Promise.all(readyCategories.map((category) => loadCategory(category)));
}

interface AppendSessionGroupParams {
  items: NavigationMenuItem[];
  groupId: string;
  groupSessions: readonly Session[];
  visibleCount?: number;
  buildSessionRow: BuildSessionRow;
  loadMoreLabel: string;
}

export function appendSessionGroup({
  items,
  groupId,
  groupSessions,
  visibleCount = DEFAULT_GROUP_VISIBLE_COUNT,
  buildSessionRow,
  loadMoreLabel,
}: AppendSessionGroupParams): boolean {
  const visibleSessions = groupSessions.slice(0, visibleCount);
  items.push(...visibleSessions.map(buildSessionRow));

  const hasHiddenLocalSessions = groupSessions.length > visibleCount;
  if (hasHiddenLocalSessions) {
    items.push(groupLoadMoreRow(groupId, loadMoreLabel));
  }
  return hasHiddenLocalSessions;
}
