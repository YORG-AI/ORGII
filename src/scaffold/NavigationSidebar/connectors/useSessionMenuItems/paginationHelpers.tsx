import { MoreHorizontalIcon } from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { SESSION_LIST_CATEGORIES } from "@src/store/session";
import type {
  CategoryPaginationState,
  Session,
  SessionListCategory,
  SessionPaginationMap,
} from "@src/store/session";

import {
  DEFAULT_SESSION_GROUP_VISIBLE_COUNT,
  LOAD_MORE_GROUP_PREFIX,
  LOAD_MORE_PREFIX,
} from "../types";
import { renderBreathingStatusDot } from "./statusIndicators";
import type { BuildSessionRow } from "./types";

const LOAD_MORE_CATEGORIES: readonly SessionListCategory[] =
  SESSION_LIST_CATEGORIES;
export const UNIFIED_LOAD_MORE_ID = "load-more-unified";

export type SessionPaginationPhase = "ready" | "loading" | "error";

export interface SessionPaginationTarget {
  category: SessionListCategory;
  phase: SessionPaginationPhase;
}

/**
 * The complete backend action represented by a session pagination row.
 * Rendering and click execution both consume this same value so a row can
 * never advertise one filtered scope and fetch a different set of streams.
 */
export interface SessionPaginationPlan {
  targets: readonly [SessionPaginationTarget, ...SessionPaginationTarget[]];
}

export interface SessionPaginationMenuItem extends NavigationMenuItem {
  sessionPaginationPlan: SessionPaginationPlan;
}

interface ExecuteSessionPaginationPlanParams {
  plan: SessionPaginationPlan;
  loadCategory: (category: SessionListCategory) => Promise<unknown>;
}

export function loadMoreRow(
  category: SessionListCategory,
  plan: SessionPaginationPlan,
  label: string
): SessionPaginationMenuItem {
  const phase = getSessionPaginationPhase(plan);
  return attachSessionPaginationPlan(
    {
      id: `${LOAD_MORE_PREFIX}${category}`,
      key: `${LOAD_MORE_PREFIX}${category}`,
      label,
      icon: MoreHorizontalIcon,
      iconName: "more-horizontal",
      trailingElement:
        phase === "loading" ? renderBreathingStatusDot() : undefined,
      visualTone: "secondary",
      disabled: phase === "loading",
    },
    plan
  );
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
  plan: SessionPaginationPlan,
  label: string
): SessionPaginationMenuItem {
  const phase = getSessionPaginationPhase(plan);
  return attachSessionPaginationPlan(
    {
      id: UNIFIED_LOAD_MORE_ID,
      key: UNIFIED_LOAD_MORE_ID,
      label,
      icon: MoreHorizontalIcon,
      iconName: "more-horizontal",
      trailingElement:
        phase === "loading" ? renderBreathingStatusDot() : undefined,
      visualTone: "secondary",
      disabled: phase === "loading",
    },
    plan
  );
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

export function isBackendSessionPaginationId(id: string): boolean {
  return isUnifiedLoadMoreId(id) || isLoadMoreId(id) !== null;
}

export function isSessionPaginationId(id: string): boolean {
  return isBackendSessionPaginationId(id) || getLoadMoreGroupId(id) !== null;
}

export function attachSessionPaginationPlan(
  item: NavigationMenuItem,
  plan: SessionPaginationPlan
): SessionPaginationMenuItem {
  return { ...item, sessionPaginationPlan: plan };
}

export function hasSessionPaginationPlan(
  item: NavigationMenuItem
): item is SessionPaginationMenuItem {
  const plan = (item as Partial<SessionPaginationMenuItem>)
    .sessionPaginationPlan;
  return (
    plan !== undefined &&
    Array.isArray(plan.targets) &&
    plan.targets.length > 0 &&
    plan.targets.every(
      (target) =>
        SESSION_LIST_CATEGORIES.includes(target.category) &&
        (target.phase === "ready" ||
          target.phase === "loading" ||
          target.phase === "error")
    )
  );
}

export function getSessionPaginationPhase(
  plan: SessionPaginationPlan
): SessionPaginationPhase {
  return plan.targets.some((target) => target.phase === "loading")
    ? "loading"
    : plan.targets.some((target) => target.phase === "error")
      ? "error"
      : "ready";
}

export function getCategoryPaginationPlan(
  category: SessionListCategory,
  state: CategoryPaginationState,
  hasVisibleSessionRows: boolean
): SessionPaginationPlan | null {
  if (!shouldRenderBackendPagination(state, hasVisibleSessionRows)) return null;
  if (
    state.phase === "loading" ||
    state.phase === "ready" ||
    state.phase === "error"
  ) {
    return { targets: [{ category, phase: state.phase }] };
  }
  return null;
}

export function getUnifiedPaginationPlan(
  pagination: SessionPaginationMap,
  hasVisibleSessionRows: boolean
): SessionPaginationPlan | null {
  const plans: SessionPaginationPlan[] = [];

  for (const category of LOAD_MORE_CATEGORIES) {
    const plan = getCategoryPaginationPlan(
      category,
      pagination[category],
      hasVisibleSessionRows
    );
    if (plan) plans.push(plan);
  }

  return combineSessionPaginationPlans(plans);
}

export function combineSessionPaginationPlans(
  plans: readonly SessionPaginationPlan[]
): SessionPaginationPlan | null {
  if (plans.length === 0) return null;

  const targetsByCategory = new Map<
    SessionListCategory,
    SessionPaginationTarget
  >();
  for (const plan of plans) {
    for (const target of plan.targets) {
      const existing = targetsByCategory.get(target.category);
      if (
        !existing ||
        paginationPhaseRank(target.phase) > paginationPhaseRank(existing.phase)
      ) {
        targetsByCategory.set(target.category, target);
      }
    }
  }
  const [firstTarget, ...remainingTargets] = targetsByCategory.values();
  return firstTarget ? { targets: [firstTarget, ...remainingTargets] } : null;
}

export function filterSessionPaginationPlan(
  plan: SessionPaginationPlan,
  predicate: (target: SessionPaginationTarget) => boolean
): SessionPaginationPlan | null {
  const [firstTarget, ...remainingTargets] = plan.targets.filter(predicate);
  return firstTarget ? { targets: [firstTarget, ...remainingTargets] } : null;
}

function paginationPhaseRank(phase: SessionPaginationPhase): number {
  return phase === "loading" ? 3 : phase === "error" ? 2 : 1;
}

/**
 * A ready/loading stream only offers useful pagination when the current
 * sidebar scope already contains a session row. The backend roster is global,
 * while org and visibility filters are applied afterwards; without this
 * guard, a scope whose rows were all filtered out rendered an orphaned
 * "Load more" control. Errors remain actionable even for an empty scope.
 */
export function shouldRenderBackendPagination(
  state: CategoryPaginationState,
  hasVisibleSessionRows: boolean
): boolean {
  if (state.generation === 0 || state.phase === "exhausted") return false;
  return state.phase === "error" || hasVisibleSessionRows;
}

const UNIFIED_LOAD_MORE_CONCURRENCY = 4;

export function executeSessionPaginationPlan({
  plan,
  loadCategory,
}: ExecuteSessionPaginationPlanParams): Promise<void> | null {
  if (getSessionPaginationPhase(plan) === "loading") return null;
  const targetCategories = plan.targets.map((target) => target.category);
  return (async () => {
    let nextIndex = 0;
    const workers = Array.from(
      {
        length: Math.min(
          UNIFIED_LOAD_MORE_CONCURRENCY,
          targetCategories.length
        ),
      },
      async () => {
        while (nextIndex < targetCategories.length) {
          const category = targetCategories[nextIndex];
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
  visibleCount = DEFAULT_SESSION_GROUP_VISIBLE_COUNT,
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
