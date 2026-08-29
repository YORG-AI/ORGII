import type { OptimizedChatItem } from "./chatItemPipeline/types";
import type { ChatTurnPage } from "./hooks/useChatTurnPagination";

function itemContainsEventId(
  item: OptimizedChatItem,
  eventId: string
): boolean {
  if (item.event?.id === eventId) return true;
  if (item.consolidatedEvents?.some((event) => event.id === eventId)) {
    return true;
  }
  if (item.readFileEvents?.some((event) => event.id === eventId)) return true;
  if (
    item.actionSummaryEntries?.some((entry) =>
      entry.events.some((event) => event.id === eventId)
    )
  ) {
    return true;
  }
  if (item.actionSummaryItems?.some(({ event }) => event.id === eventId)) {
    return true;
  }
  return (
    item.activityStackGroup?.events.some((event) => event.id === eventId) ??
    false
  );
}

/**
 * Resolves a durable event id to the global display flat index. Grouped pipeline
 * items own their nested events, so their optimized-history index is the only
 * valid input to the groups projection's original-to-flat mapping.
 */
export function resolveExactHistoryTargetFlatIndex(
  optimizedChatHistory: readonly OptimizedChatItem[],
  originalToFlatIndex: ReadonlyMap<number, number>,
  targetEventId: string | undefined
): number | null {
  if (!targetEventId) return null;
  const originalIndex = optimizedChatHistory.findIndex((item) =>
    itemContainsEventId(item, targetEventId)
  );
  if (originalIndex < 0) return null;
  return originalToFlatIndex.get(originalIndex) ?? null;
}

export type ExactHistoryTarget =
  | { kind: "header"; groupIndex: number; groupId: string | null }
  | { kind: "body"; flatIndex: number; groupIndex: number };

/**
 * A user turn header is intentionally absent from flatItems. Keep it distinct
 * from body targets so a fork parent anchor cannot be painted on the first
 * assistant/tool row in that turn.
 */
export function resolveExactHistoryTarget(
  optimizedChatHistory: readonly OptimizedChatItem[],
  groupHeaders: readonly (OptimizedChatItem | null)[],
  groupCounts: readonly number[],
  originalToFlatIndex: ReadonlyMap<number, number>,
  targetEventId: string | undefined
): ExactHistoryTarget | null {
  if (!targetEventId) return null;
  const headerGroupIndex = groupHeaders.findIndex(
    (header) => header?.event?.id === targetEventId
  );
  if (headerGroupIndex >= 0) {
    return {
      kind: "header",
      groupIndex: headerGroupIndex,
      groupId: groupHeaders[headerGroupIndex]?.event?.id ?? null,
    };
  }
  const flatIndex = resolveExactHistoryTargetFlatIndex(
    optimizedChatHistory,
    originalToFlatIndex,
    targetEventId
  );
  if (flatIndex === null) return null;
  let remaining = flatIndex;
  for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex++) {
    remaining -= groupCounts[groupIndex] ?? 0;
    if (remaining < 0) return { kind: "body", flatIndex, groupIndex };
  }
  return null;
}

/** Returns the currently rendered page-local row index for an exact target. */
export function resolveExactHistoryTargetDisplayIndex(
  globalFlatIndex: number | null,
  pages: readonly ChatTurnPage[],
  currentPageIndex: number,
  paginationEnabled: boolean
): number | null {
  if (globalFlatIndex === null) return null;
  if (!paginationEnabled) return globalFlatIndex;
  const page = pages[currentPageIndex];
  if (
    !page ||
    globalFlatIndex < page.flatStartIndex ||
    globalFlatIndex >= page.flatEndIndex
  ) {
    return null;
  }
  return globalFlatIndex - page.flatStartIndex;
}
