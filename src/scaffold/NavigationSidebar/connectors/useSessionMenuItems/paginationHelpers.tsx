import { MoreHorizontalIcon } from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { SESSION_LIST_CATEGORIES } from "@src/store/session";
import type {
  Session,
  SessionListCategory,
  SessionPaginationMap,
} from "@src/store/session";

import { LOAD_MORE_GROUP_PREFIX, LOAD_MORE_PREFIX } from "../types";
import { DEFAULT_GROUP_VISIBLE_COUNT } from "./dateGroupingHelpers";
import { renderBreathingStatusDot } from "./statusIndicators";
import type { BuildSessionRow } from "./types";

const LOAD_MORE_CATEGORIES: readonly SessionListCategory[] =
  SESSION_LIST_CATEGORIES;
export const UNIFIED_LOAD_MORE_ID = "load-more-unified";

interface UnifiedLoadMoreState {
  visible: boolean;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  readyCategories: SessionListCategory[];
}

interface LoadUnifiedReadyCategoriesParams {
  disabled?: boolean;
  pagination: SessionPaginationMap;
  loadCategory: (category: SessionListCategory) => Promise<unknown>;
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
    icon: MoreHorizontalIcon,
    iconName: "more-horizontal",
    trailingElement: loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: loading,
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
    icon: MoreHorizontalIcon,
    iconName: "more-horizontal",
    trailingElement: loading ? renderBreathingStatusDot() : undefined,
    visualTone: "secondary",
    disabled: loading,
  };
}

export function unifiedLoadMoreRow(
  state: UnifiedLoadMoreState,
  label: string
): NavigationMenuItem {
  return {
    id: UNIFIED_LOAD_MORE_ID,
    key: UNIFIED_LOAD_MORE_ID,
    label,
    icon: MoreHorizontalIcon,
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

export function getUnifiedLoadMoreState(
  pagination: SessionPaginationMap
): UnifiedLoadMoreState {
  let visible = false;
  let loading = false;
  let error = false;
  const readyCategories: SessionListCategory[] = [];

  for (const category of LOAD_MORE_CATEGORIES) {
    const state = pagination[category];
    if (state.generation === 0) continue;
    if (state.phase === "loading") {
      visible = true;
      loading = true;
      continue;
    }
    if (state.phase === "error") {
      visible = true;
      error = true;
      readyCategories.push(category);
      continue;
    }
    if (state.phase === "ready") {
      visible = true;
      readyCategories.push(category);
    }
  }

  return {
    visible,
    loading,
    error,
    disabled: loading || readyCategories.length === 0,
    readyCategories,
  };
}

const UNIFIED_LOAD_MORE_CONCURRENCY = 4;

export function loadUnifiedReadyCategories({
  disabled,
  pagination,
  loadCategory,
}: LoadUnifiedReadyCategoriesParams): Promise<void> | null {
  const state = getUnifiedLoadMoreState(pagination);
  if (disabled || state.disabled) return null;
  const { readyCategories } = state;
  return (async () => {
    let nextIndex = 0;
    const workers = Array.from(
      {
        length: Math.min(UNIFIED_LOAD_MORE_CONCURRENCY, readyCategories.length),
      },
      async () => {
        while (nextIndex < readyCategories.length) {
          const category = readyCategories[nextIndex];
          nextIndex += 1;
          await loadCategory(category);
        }
      }
    );
    await Promise.all(workers);
  })();
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
