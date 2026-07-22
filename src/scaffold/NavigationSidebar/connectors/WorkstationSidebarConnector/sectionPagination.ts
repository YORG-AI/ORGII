import type { GroupByMode } from "../types";

export interface ScopedSectionPagination {
  scopeKey: string;
  visibleCount: number;
}

type VisibleCountKeyResolver = (sectionId: string) => string;

export function getSessionSectionVisibleCountKey(
  sectionId: string,
  groupByMode: GroupByMode
): string {
  if (sectionId === "pinned") return sectionId;

  switch (groupByMode) {
    case "byAgent":
      return sectionId.startsWith("agent-org:")
        ? sectionId
        : `agent:${sectionId}`;
    case "byWorkspace":
      return `workspace:${sectionId}`;
    case "byTime":
    default:
      return `time:${sectionId}`;
  }
}

export function getProjectsSectionVisibleCountKey(sectionId: string): string {
  return sectionId;
}

export function resetNewlyCollapsedSectionVisibleCounts({
  currentVisibleCounts,
  previousCollapsedSectionIds,
  nextCollapsedSectionIds,
  resolveVisibleCountKey,
}: {
  currentVisibleCounts: Map<string, number>;
  previousCollapsedSectionIds: ReadonlySet<string>;
  nextCollapsedSectionIds: ReadonlySet<string>;
  resolveVisibleCountKey: VisibleCountKeyResolver;
}): Map<string, number> {
  let nextVisibleCounts: Map<string, number> | null = null;

  for (const sectionId of nextCollapsedSectionIds) {
    if (previousCollapsedSectionIds.has(sectionId)) continue;
    const visibleCountKey = resolveVisibleCountKey(sectionId);
    if (!currentVisibleCounts.has(visibleCountKey)) continue;

    nextVisibleCounts ??= new Map(currentVisibleCounts);
    nextVisibleCounts.delete(visibleCountKey);
  }

  return nextVisibleCounts ?? currentVisibleCounts;
}

export function resetScopedSectionPagination(
  current: ScopedSectionPagination,
  defaultVisibleCount: number
): ScopedSectionPagination {
  if (current.scopeKey === "" && current.visibleCount === defaultVisibleCount) {
    return current;
  }
  return { scopeKey: "", visibleCount: defaultVisibleCount };
}
