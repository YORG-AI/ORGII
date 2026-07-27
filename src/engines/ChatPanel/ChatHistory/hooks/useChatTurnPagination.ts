import { useMemo } from "react";

import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { ChatGroupMeta } from "./useChatGroups";

export interface ChatTurnPage {
  startGroupIndex: number;
  endGroupIndex: number;
  flatStartIndex: number;
  flatEndIndex: number;
  replayTurnSummary: ExternalReplayTurnSummary | null;
  replayBodyLoaded: boolean;
}

export interface ChatTurnPaginationOptions {
  enabled: boolean;
  activePageIndex: number;
  groupCounts: number[];
  groupHeaders: (OptimizedChatItem | null)[];
  groupMeta: ChatGroupMeta[];
  flatItems: OptimizedChatItem[];
  lastAssistantFlatIndexPerItem: (number | null)[];
  externalReplayTurnSummaries?: ExternalReplayTurnSummary[];
  /**
   * Treat groups that contain a user header but ZERO agent items as part
   * of an adjacent contentful page instead of giving them their own page.
   *
   * Surfaces that hide the per-turn user-message card (subagent grid
   * cells via `hideGroupUserMessage`) would otherwise render such pages
   * as structurally blank — e.g. a dead subagent whose tail is a batch
   * of queued user messages flushed after the session already failed
   * pinned "Latest Round" to an empty frame.
   */
  mergeUserOnlyPages?: boolean;
}

export interface UseChatTurnPaginationReturn {
  pageCount: number;
  currentPageIndex: number;
  pages: ChatTurnPage[];
  /** Resident source-group to logical page lookup; never scans virtual holes. */
  pageIndexByGroupIndex: ReadonlyMap<number, number>;
  displayGroupCounts: number[];
  displayGroupHeaders: (OptimizedChatItem | null)[];
  displayGroupMeta: ChatGroupMeta[];
  displayFlatItems: OptimizedChatItem[];
  displayTotalFlatItems: number;
  displayLastAssistantFlatIndexPerItem: (number | null)[];
  displaySourceGroupIndices: number[];
  displayLastGroupFirstFlatIndex: number | null;
}

export function projectChatTurnPagination({
  enabled,
  activePageIndex,
  groupCounts,
  groupHeaders,
  groupMeta,
  flatItems,
  lastAssistantFlatIndexPerItem,
  externalReplayTurnSummaries = [],
  mergeUserOnlyPages = false,
}: ChatTurnPaginationOptions): UseChatTurnPaginationReturn {
  const pages = buildTurnPages(
    groupCounts,
    groupHeaders,
    externalReplayTurnSummaries,
    mergeUserOnlyPages
  );
  const pageIndexByGroupIndex = buildPageIndexByGroupIndex(
    pages,
    externalReplayTurnSummaries
  );
  const pageCount = pages.length;
  const currentPageIndex = clampPageIndex(activePageIndex, pageCount);

  if (!enabled || pageCount === 0) {
    return {
      pageCount,
      currentPageIndex,
      pages,
      pageIndexByGroupIndex,
      displayGroupCounts: groupCounts,
      displayGroupHeaders: groupHeaders,
      displayGroupMeta: groupMeta,
      displayFlatItems: flatItems,
      displayTotalFlatItems: flatItems.length,
      displayLastAssistantFlatIndexPerItem: lastAssistantFlatIndexPerItem,
      displaySourceGroupIndices: groupCounts.map((_, groupIndex) => groupIndex),
      displayLastGroupFirstFlatIndex: computeLastGroupFirstFlatIndex(
        groupCounts,
        flatItems.length
      ),
    };
  }

  const page = pages[currentPageIndex];
  if (!page) {
    return {
      pageCount,
      currentPageIndex,
      pages,
      pageIndexByGroupIndex,
      displayGroupCounts: [],
      displayGroupHeaders: [],
      displayGroupMeta: [],
      displayFlatItems: [],
      displayTotalFlatItems: 0,
      displayLastAssistantFlatIndexPerItem: [],
      displaySourceGroupIndices: [],
      displayLastGroupFirstFlatIndex: null,
    };
  }

  const displayGroupCounts = groupCounts.slice(
    page.startGroupIndex,
    page.endGroupIndex + 1
  );
  const displayFlatItems = flatItems.slice(
    page.flatStartIndex,
    page.flatEndIndex
  );
  const displayLastAssistantFlatIndexPerItem = lastAssistantFlatIndexPerItem
    .slice(page.flatStartIndex, page.flatEndIndex)
    .map((flatIndex) => {
      if (flatIndex === null) return null;
      if (flatIndex < page.flatStartIndex || flatIndex >= page.flatEndIndex) {
        return null;
      }
      return flatIndex - page.flatStartIndex;
    });

  return {
    pageCount,
    currentPageIndex,
    pages,
    pageIndexByGroupIndex,
    displayGroupCounts,
    displayGroupHeaders: groupHeaders.slice(
      page.startGroupIndex,
      page.endGroupIndex + 1
    ),
    displayGroupMeta: groupMeta.slice(
      page.startGroupIndex,
      page.endGroupIndex + 1
    ),
    displayFlatItems,
    displayTotalFlatItems: displayFlatItems.length,
    displayLastAssistantFlatIndexPerItem,
    displaySourceGroupIndices: displayGroupCounts.map(
      (_, offset) => page.startGroupIndex + offset
    ),
    displayLastGroupFirstFlatIndex: computeLastGroupFirstFlatIndex(
      displayGroupCounts,
      displayFlatItems.length
    ),
  };
}

export function useChatTurnPagination({
  enabled,
  activePageIndex,
  groupCounts,
  groupHeaders,
  groupMeta,
  flatItems,
  lastAssistantFlatIndexPerItem,
  externalReplayTurnSummaries,
  mergeUserOnlyPages,
}: ChatTurnPaginationOptions): UseChatTurnPaginationReturn {
  return useMemo(
    () =>
      projectChatTurnPagination({
        enabled,
        activePageIndex,
        groupCounts,
        groupHeaders,
        groupMeta,
        flatItems,
        lastAssistantFlatIndexPerItem,
        externalReplayTurnSummaries,
        mergeUserOnlyPages,
      }),
    [
      enabled,
      activePageIndex,
      groupCounts,
      groupHeaders,
      groupMeta,
      flatItems,
      lastAssistantFlatIndexPerItem,
      externalReplayTurnSummaries,
      mergeUserOnlyPages,
    ]
  );
}

function buildPageIndexByGroupIndex(
  pages: ChatTurnPage[],
  externalReplayTurnSummaries: ExternalReplayTurnSummary[]
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  const addPage = (page: ChatTurnPage | undefined, pageIndex: number) => {
    if (!page || page.endGroupIndex < page.startGroupIndex) return;
    for (
      let groupIndex = page.startGroupIndex;
      groupIndex <= page.endGroupIndex;
      groupIndex += 1
    ) {
      result.set(groupIndex, pageIndex);
    }
  };

  if (externalReplayTurnSummaries.length > 0) {
    // The summary array is deliberately sparse. forEach visits only the
    // at-most-12 resident headers instead of totalTurnCount virtual holes.
    externalReplayTurnSummaries.forEach((_summary, pageIndex) => {
      addPage(pages[pageIndex], pageIndex);
    });
  } else {
    pages.forEach(addPage);
  }
  return result;
}

function buildTurnPages(
  groupCounts: number[],
  groupHeaders: (OptimizedChatItem | null)[],
  externalReplayTurnSummaries: ExternalReplayTurnSummary[],
  mergeUserOnlyPages = false
): ChatTurnPage[] {
  if (externalReplayTurnSummaries.length > 0) {
    return buildExternalReplayTurnPages(
      groupCounts,
      groupHeaders,
      externalReplayTurnSummaries
    );
  }

  const rawPages: ChatTurnPage[] = [];
  let startGroupIndex = 0;
  let flatCursor = 0;
  let pageFlatStartIndex = 0;

  for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex++) {
    const count = groupCounts[groupIndex] ?? 0;
    const nextFlatCursor = flatCursor + count;
    const hasAgentItems = count > 0;
    const hasUserHeader = groupHeaders[groupIndex] !== null;
    const isLastGroup = groupIndex === groupCounts.length - 1;

    // With `mergeUserOnlyPages`, a user header alone does not close a
    // page — the group is folded into the next contentful page so that
    // surfaces hiding user-message cards never produce a blank page.
    // Trailing user-only groups are folded backwards after the loop.
    const closesPage = mergeUserOnlyPages
      ? hasAgentItems
      : hasUserHeader || hasAgentItems || isLastGroup;

    if (closesPage) {
      rawPages.push({
        startGroupIndex,
        endGroupIndex: groupIndex,
        flatStartIndex: pageFlatStartIndex,
        flatEndIndex: nextFlatCursor,
        replayTurnSummary: null,
        replayBodyLoaded: false,
      });
      startGroupIndex = groupIndex + 1;
      pageFlatStartIndex = nextFlatCursor;
    }

    flatCursor = nextFlatCursor;
  }

  if (mergeUserOnlyPages) {
    // Fold any trailing user-only groups into the final contentful page
    // (or into a single page when no contentful page exists at all) so
    // the tail of the timeline is never a structurally blank page.
    if (startGroupIndex <= groupCounts.length - 1) {
      const lastPage = rawPages[rawPages.length - 1];
      if (lastPage) {
        lastPage.endGroupIndex = groupCounts.length - 1;
        lastPage.flatEndIndex = flatCursor;
      } else if (groupCounts.length > 0) {
        rawPages.push({
          startGroupIndex: 0,
          endGroupIndex: groupCounts.length - 1,
          flatStartIndex: 0,
          flatEndIndex: flatCursor,
          replayTurnSummary: null,
          replayBodyLoaded: false,
        });
      }
    }
  }

  return rawPages;
}

function buildExternalReplayTurnPages(
  groupCounts: number[],
  groupHeaders: (OptimizedChatItem | null)[],
  externalReplayTurnSummaries: ExternalReplayTurnSummary[]
): ChatTurnPage[] {
  const groupByTurnId = new Map<string, number>();
  for (let groupIndex = 0; groupIndex < groupHeaders.length; groupIndex++) {
    const eventId = groupHeaders[groupIndex]?.event?.id;
    if (!eventId) continue;
    // New bounded replay headers use the complete provider-stable event id.
    // Keep the stripped legacy Cursor bubble id during migration so cached
    // summaries from an older build still map to the same group.
    groupByTurnId.set(eventId, groupIndex);
    if (eventId.startsWith("cursoride-user-")) {
      groupByTurnId.set(eventId.slice("cursoride-user-".length), groupIndex);
    }
  }

  const groupFlatStartIndices = computeGroupFlatStartIndices(groupCounts);
  const target: ChatTurnPage[] = [];
  target.length = externalReplayTurnSummaries.length;

  // Keep page count exact without allocating one page object per turn. The
  // list is virtualized and navigation reads only current/neighbor indices.
  return new Proxy(target, {
    get(pages, property, receiver) {
      if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
        return Reflect.get(pages, property, receiver);
      }
      const pageIndex = Number(property);
      if (
        !Number.isSafeInteger(pageIndex) ||
        pageIndex < 0 ||
        pageIndex >= externalReplayTurnSummaries.length
      ) {
        return undefined;
      }
      const summary = externalReplayTurnSummaries[pageIndex];
      if (!summary) return undefined;
      const renderedUserEventId = summary.renderedUserEventId ?? summary.turnId;
      const loadedGroupIndex = groupByTurnId.get(renderedUserEventId);
      if (loadedGroupIndex === undefined) {
        return {
          startGroupIndex: 0,
          endGroupIndex: -1,
          flatStartIndex: 0,
          flatEndIndex: 0,
          replayTurnSummary: summary,
          replayBodyLoaded: false,
        } satisfies ChatTurnPage;
      }
      const groupIndex = loadedGroupIndex;
      const flatStartIndex = groupFlatStartIndices[groupIndex] ?? 0;
      const flatEndIndex = flatStartIndex + (groupCounts[groupIndex] ?? 0);
      return {
        startGroupIndex: groupIndex,
        endGroupIndex: groupIndex,
        flatStartIndex,
        flatEndIndex,
        replayTurnSummary: summary,
        replayBodyLoaded: true,
      } satisfies ChatTurnPage;
    },
  });
}

function computeGroupFlatStartIndices(groupCounts: number[]): number[] {
  const indices: number[] = [];
  let flatStartIndex = 0;
  for (const count of groupCounts) {
    indices.push(flatStartIndex);
    flatStartIndex += count;
  }
  return indices;
}

function clampPageIndex(pageIndex: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(pageIndex, 0), pageCount - 1);
}

function computeLastGroupFirstFlatIndex(
  groupCounts: number[],
  flatItemCount: number
): number | null {
  if (groupCounts.length === 0) return null;
  const tailCount = groupCounts[groupCounts.length - 1] ?? 0;
  if (tailCount <= 0) return null;
  return flatItemCount - tailCount;
}
