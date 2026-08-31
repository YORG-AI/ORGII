import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { ChatGroupMeta } from "./useChatGroups";
import type { ChatTurnPage } from "./useChatTurnPagination";

interface ChatSearchProjectionTarget {
  globalFlatIndex: number;
  groupIndex: number;
  turnId: string | null;
  itemChunkId: string;
}

export function collectChatItemEventIds(item: OptimizedChatItem): string[] {
  const ids = new Set<string>();
  if (item.chunk_id) ids.add(item.chunk_id);
  if (item.event?.id) ids.add(item.event.id);
  if (item.event?.chunk_id) ids.add(item.event.chunk_id);

  for (const event of item.readFileEvents ?? []) {
    if (event.id) ids.add(event.id);
    if (event.chunk_id) ids.add(event.chunk_id);
  }
  for (const entry of item.actionSummaryEntries ?? []) {
    for (const event of entry.events) {
      if (event.id) ids.add(event.id);
      if (event.chunk_id) ids.add(event.chunk_id);
    }
  }
  for (const entry of item.actionSummaryItems ?? []) {
    if (entry.event.id) ids.add(entry.event.id);
    if (entry.event.chunk_id) ids.add(entry.event.chunk_id);
  }
  for (const event of item.activityStackGroup?.events ?? []) {
    if (event.id) ids.add(event.id);
    if (event.chunk_id) ids.add(event.chunk_id);
  }

  return [...ids];
}

function buildFlatIndexToGroupIndex(groupCounts: readonly number[]): number[] {
  const map: number[] = [];
  for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex++) {
    const count = groupCounts[groupIndex] ?? 0;
    for (let i = 0; i < count; i++) {
      map.push(groupIndex);
    }
  }
  return map;
}

export function buildEventIdProjectionIndex(
  flatItems: readonly OptimizedChatItem[],
  groupCounts: readonly number[],
  groupMeta: readonly Pick<ChatGroupMeta, "turnId">[]
): Map<string, ChatSearchProjectionTarget> {
  const flatToGroup = buildFlatIndexToGroupIndex(groupCounts);
  const index = new Map<string, ChatSearchProjectionTarget>();

  flatItems.forEach((item, globalFlatIndex) => {
    const groupIndex = flatToGroup[globalFlatIndex] ?? 0;
    const target: ChatSearchProjectionTarget = {
      globalFlatIndex,
      groupIndex,
      turnId: groupMeta[groupIndex]?.turnId ?? null,
      itemChunkId: item.chunk_id,
    };
    for (const eventId of collectChatItemEventIds(item)) {
      index.set(eventId, target);
    }
  });

  return index;
}

export function resolvePageIndexForFlatIndex(
  globalFlatIndex: number,
  pages: readonly Pick<ChatTurnPage, "flatStartIndex" | "flatEndIndex">[]
): number | null {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (
      globalFlatIndex >= page.flatStartIndex &&
      globalFlatIndex < page.flatEndIndex
    ) {
      return pageIndex;
    }
  }
  return null;
}

export function toDisplayFlatIndex(
  globalFlatIndex: number,
  page: Pick<ChatTurnPage, "flatStartIndex" | "flatEndIndex"> | undefined
): number | null {
  if (!page) return globalFlatIndex;
  if (
    globalFlatIndex < page.flatStartIndex ||
    globalFlatIndex >= page.flatEndIndex
  ) {
    return null;
  }
  return globalFlatIndex - page.flatStartIndex;
}
