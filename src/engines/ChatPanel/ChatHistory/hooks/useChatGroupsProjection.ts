import {
  isAgentOrgGroupChatUserMessage,
  isAgentOrgInboxTranscriptEvent,
  isCoordinatorHumanUserEvent,
} from "../GroupChatView/groupChatPredicates";
import { isAgentErrorEvent } from "../chatItemPipeline/classifiers";
import { isAssistantMessageEvent } from "../chatItemPipeline/dedup";
import type { OptimizedChatItem } from "../chatItemPipeline/types";

export interface UnloadedTurnMeta {
  turnId: string;
  nextTurnId?: string | null;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
  bodyEventCount?: number;
  durationMs?: number;
}

export interface ChatGroupMeta {
  turnId: string | null;
  durationMs: number;
  itemCount: number;
  previewText: string;
  startMs: number | null;
  endMs: number | null;
  unloadedTurn: UnloadedTurnMeta | null;
}

export interface UseChatGroupsReturn {
  groupCounts: number[];
  groupHeaders: (OptimizedChatItem | null)[];
  groupMeta: ChatGroupMeta[];
  flatItems: OptimizedChatItem[];
  totalFlatItems: number;
  originalToFlatIndex: Map<number, number>;
  lastGroupFirstFlatIndex: number | null;
  lastAssistantFlatIndexPerItem: (number | null)[];
}

export type TurnGroupingPolicy =
  | { mode: "standard" }
  | { mode: "agent-org"; coordinatorSessionId: string };

export interface ChatGroupsProjectionOptions {
  collapseOverrides?: ReadonlyMap<string, boolean>;
  isAgentWorking?: boolean;
  collapseTailWhenIdle?: boolean;
  forceCollapseAllTurns?: boolean;
  disableTurnCollapse?: boolean;
  allTurnsCollapsed?: boolean;
  defaultTurnCollapsed?: boolean;
  turnGrouping?: TurnGroupingPolicy;
}

/** React-only compatibility options. Worker callers use ChatGroupsProjectionOptions. */
export interface UseChatGroupsOptions extends ChatGroupsProjectionOptions {
  isTurnHeaderItem?: (item: OptimizedChatItem) => boolean;
  isTurnBoundaryItem?: (item: OptimizedChatItem) => boolean;
}

interface ChatGroup {
  header: OptimizedChatItem | null;
  items: OptimizedChatItem[];
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function getUnloadedTurnMeta(
  item: OptimizedChatItem | undefined
): UnloadedTurnMeta | null {
  const shared = getObjectRecord(item?.event?.result?.unloadedTurn);
  if (!shared || typeof shared.turnId !== "string" || !shared.turnId) {
    return null;
  }

  return {
    turnId: shared.turnId,
    nextTurnId:
      typeof shared.nextTurnId === "string" ? shared.nextTurnId : null,
    startedAt:
      typeof shared.startedAt === "string" ? shared.startedAt : undefined,
    endedAt: typeof shared.endedAt === "string" ? shared.endedAt : undefined,
    eventCount:
      typeof shared.eventCount === "number" ? shared.eventCount : undefined,
    bodyEventCount:
      typeof shared.bodyEventCount === "number"
        ? shared.bodyEventCount
        : undefined,
    durationMs:
      typeof shared.durationMs === "number" ? shared.durationMs : undefined,
  };
}

function isUnloadedTurnItem(item: OptimizedChatItem | undefined): boolean {
  return getUnloadedTurnMeta(item) !== null;
}

function isTurnPreviewItem(item: OptimizedChatItem | undefined): boolean {
  return item?.event?.args?.turnPreviewOnly === true;
}

function isUserMessageItem(item: OptimizedChatItem | undefined): boolean {
  return item?.event?.source === "user" && Boolean(item.event.displayText);
}

function isAgentOrgGroupMessage(item: OptimizedChatItem): boolean {
  return Boolean(item.event && isAgentOrgGroupChatUserMessage(item.event));
}

function isAgentOrgInboxTranscriptItem(item: OptimizedChatItem): boolean {
  return Boolean(item.event && isAgentOrgInboxTranscriptEvent(item.event));
}

function isCoordinatorTurnHeader(
  item: OptimizedChatItem,
  coordinatorSessionId: string
): boolean {
  const event = item.event;
  return Boolean(
    event && isCoordinatorHumanUserEvent(event, coordinatorSessionId)
  );
}

function resolveTurnPredicates(options: UseChatGroupsOptions): {
  isHeader: (item: OptimizedChatItem) => boolean;
  isBoundary: (item: OptimizedChatItem) => boolean;
} {
  if (options.isTurnHeaderItem || options.isTurnBoundaryItem) {
    return {
      isHeader: options.isTurnHeaderItem ?? isUserMessageItem,
      isBoundary: options.isTurnBoundaryItem ?? (() => false),
    };
  }

  const grouping = options.turnGrouping ?? { mode: "standard" as const };
  if (grouping.mode === "agent-org") {
    return {
      isHeader: (item) =>
        isCoordinatorTurnHeader(item, grouping.coordinatorSessionId),
      isBoundary: isAgentOrgGroupMessage,
    };
  }

  return {
    isHeader: (item) =>
      isUserMessageItem(item) && !isAgentOrgInboxTranscriptItem(item),
    isBoundary: () => false,
  };
}

function isCompletedAssistantMessage(item: OptimizedChatItem): boolean {
  const event = item.event;
  return (
    !isUnloadedTurnItem(item) &&
    event?.displayStatus === "completed" &&
    isAssistantMessageEvent(event)
  );
}

function isCollapsePinnedItem(item: OptimizedChatItem): boolean {
  if (isUnloadedTurnItem(item) || !item.event) return false;
  return (
    isAgentErrorEvent(item.event) ||
    item.event.uiCanonical === "context_compacted"
  );
}

function parseEpochMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const TURN_COLLAPSE_ITEM_COUNT_THRESHOLD = 10;

export function isTurnCollapseEligible(
  meta: ChatGroupMeta | undefined,
  groupIndex: number,
  groupCount: number,
  options: {
    collapseTailWhenIdle?: boolean;
    forceCollapseAllTurns?: boolean;
  } = {}
): boolean {
  if (!meta || meta.turnId === null) return false;
  const bodyItemCount = meta.unloadedTurn?.bodyEventCount ?? meta.itemCount;
  if (bodyItemCount <= 1) return false;
  if (options.forceCollapseAllTurns === true) return true;
  if (groupIndex < groupCount - 1) return true;
  if (options.collapseTailWhenIdle !== true) return false;
  if (meta.unloadedTurn) return true;
  return meta.itemCount + 1 > TURN_COLLAPSE_ITEM_COUNT_THRESHOLD;
}

/** Pure grouping/collapse projection. It has no React, Jotai, or DOM dependency. */
export function projectChatGroups(
  optimizedChatHistory: OptimizedChatItem[],
  options: UseChatGroupsOptions = {}
): UseChatGroupsReturn {
  const {
    collapseOverrides,
    isAgentWorking = false,
    collapseTailWhenIdle = false,
    forceCollapseAllTurns = false,
    disableTurnCollapse = false,
    allTurnsCollapsed,
    defaultTurnCollapsed = true,
  } = options;
  const { isHeader, isBoundary } = resolveTurnPredicates(options);
  const groups: ChatGroup[] = [];
  let current: ChatGroup = { header: null, items: [] };

  for (const item of optimizedChatHistory) {
    if (isHeader(item) || isBoundary(item)) {
      if (current.header || current.items.length > 0) groups.push(current);
      current = { header: item, items: [] };
    } else {
      current.items.push(item);
    }
  }
  if (current.header || current.items.length > 0) groups.push(current);

  const groupHeaders = groups.map((group) => group.header);
  const groupMeta: ChatGroupMeta[] = groups.map((group) => {
    const headerEvent = group.header?.event;
    const turnId = headerEvent?.id ?? null;
    const startMs = parseEpochMs(headerEvent?.createdAt);
    let endMs: number | null = null;
    for (let i = group.items.length - 1; i >= 0; i--) {
      const itemMs = parseEpochMs(group.items[i].event?.createdAt);
      if (itemMs !== null) {
        endMs = itemMs;
        break;
      }
    }
    const unloadedTurnPlaceholder =
      group.items.map(getUnloadedTurnMeta).find((value) => value !== null) ??
      null;
    const hasLoadedBodyItem = group.items.some(
      (item) => !isUnloadedTurnItem(item) && !isTurnPreviewItem(item)
    );
    const unloadedTurn = hasLoadedBodyItem ? null : unloadedTurnPlaceholder;
    const unloadedStartMs = parseEpochMs(unloadedTurn?.startedAt);
    const unloadedEndMs = parseEpochMs(unloadedTurn?.endedAt);
    const durationMs =
      startMs !== null && endMs !== null && endMs > startMs
        ? endMs - startMs
        : 0;

    return {
      turnId,
      durationMs: unloadedTurn?.durationMs ?? durationMs,
      itemCount: group.items.length,
      previewText: headerEvent?.displayText ?? "",
      startMs: unloadedStartMs ?? startMs,
      endMs: unloadedEndMs ?? endMs,
      unloadedTurn,
    };
  });

  const groupCounts = new Array<number>(groups.length);
  const survivingPerGroup = new Array<OptimizedChatItem[]>(groups.length);
  const droppedItemTargetByGroup = new Array<(number | null)[]>(groups.length);
  let runningFlatIdx = 0;

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    const meta = groupMeta[groupIndex];
    const eligible =
      !disableTurnCollapse &&
      isTurnCollapseEligible(meta, groupIndex, groups.length, {
        collapseTailWhenIdle,
        forceCollapseAllTurns,
      });
    const override =
      meta.turnId && collapseOverrides
        ? collapseOverrides.get(meta.turnId)
        : undefined;
    const isCollapsed =
      eligible && (override ?? allTurnsCollapsed ?? defaultTurnCollapsed);

    if (!isCollapsed) {
      const keepStructuralPlaceholder = meta.unloadedTurn !== null;
      const surviving = keepStructuralPlaceholder
        ? group.items
        : group.items.filter((item) => !isUnloadedTurnItem(item));
      survivingPerGroup[groupIndex] = surviving;
      droppedItemTargetByGroup[groupIndex] = group.items.map((item) =>
        !keepStructuralPlaceholder && isUnloadedTurnItem(item)
          ? runningFlatIdx
          : null
      );
      groupCounts[groupIndex] = surviving.length;
      runningFlatIdx += surviving.length;
      continue;
    }

    if (meta.unloadedTurn) {
      const previewIndices = group.items
        .map((item, index) => (isTurnPreviewItem(item) ? index : -1))
        .filter((index) => index >= 0);
      if (previewIndices.length > 0) {
        const previewIndexSet = new Set(previewIndices);
        const previews = previewIndices.map((index) => group.items[index]);
        survivingPerGroup[groupIndex] = previews;
        droppedItemTargetByGroup[groupIndex] = group.items.map((_, index) =>
          previewIndexSet.has(index) ? null : runningFlatIdx
        );
        groupCounts[groupIndex] = previews.length;
        runningFlatIdx += previews.length;
      } else {
        survivingPerGroup[groupIndex] = group.items;
        droppedItemTargetByGroup[groupIndex] = group.items.map(() => null);
        groupCounts[groupIndex] = group.items.length;
        runningFlatIdx += group.items.length;
      }
      continue;
    }

    let keepIndex = -1;
    for (let i = group.items.length - 1; i >= 0; i--) {
      if (isCompletedAssistantMessage(group.items[i])) {
        keepIndex = i;
        break;
      }
    }
    const pinnedIndices: number[] = [];
    for (let i = Math.max(keepIndex + 1, 0); i < group.items.length; i++) {
      if (isCollapsePinnedItem(group.items[i])) pinnedIndices.push(i);
    }

    if (keepIndex === -1 && pinnedIndices.length > 0) {
      const keptIndexSet = new Set(pinnedIndices);
      const kept = pinnedIndices.map((index) => group.items[index]);
      survivingPerGroup[groupIndex] = kept;
      groupCounts[groupIndex] = kept.length;
      const firstKeptFlatIndex = runningFlatIdx;
      droppedItemTargetByGroup[groupIndex] = group.items.map((_, index) =>
        keptIndexSet.has(index) ? null : firstKeptFlatIndex
      );
      runningFlatIdx += kept.length;
      continue;
    }

    if (keepIndex === -1) {
      const structuralSourceIndex = group.items.findIndex(
        (item) => !isUnloadedTurnItem(item)
      );
      const structuralSource = group.items[structuralSourceIndex];
      if (!structuralSource) {
        survivingPerGroup[groupIndex] = [];
        droppedItemTargetByGroup[groupIndex] = group.items.map(
          () => runningFlatIdx
        );
        groupCounts[groupIndex] = 0;
        continue;
      }
      const keptFlatIndex = runningFlatIdx;
      survivingPerGroup[groupIndex] = [
        { ...structuralSource, structuralOnly: true },
      ];
      droppedItemTargetByGroup[groupIndex] = group.items.map((_, index) =>
        index === structuralSourceIndex ? null : keptFlatIndex
      );
      groupCounts[groupIndex] = 1;
      runningFlatIdx++;
      continue;
    }

    const keptIndices = [keepIndex, ...pinnedIndices];
    const keptIndexSet = new Set(keptIndices);
    const kept = keptIndices.map((index) => group.items[index]);
    survivingPerGroup[groupIndex] = kept;
    groupCounts[groupIndex] = kept.length;
    const keptFlatIndex = runningFlatIdx;
    droppedItemTargetByGroup[groupIndex] = group.items.map((_, index) =>
      keptIndexSet.has(index) ? null : keptFlatIndex
    );
    runningFlatIdx += kept.length;
  }

  const flatItems = survivingPerGroup.flat();
  const maxFlat = Math.max(0, flatItems.length - 1);
  const lastAssistantFlatIndexPerItem = new Array<number | null>(
    flatItems.length
  ).fill(null);
  let cursor = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const items = survivingPerGroup[groupIndex];
    let lastIndex: number | null = null;
    if (!(groupIndex === groups.length - 1 && isAgentWorking)) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (isCompletedAssistantMessage(items[i])) {
          lastIndex = cursor + i;
          break;
        }
      }
    }
    for (let i = 0; i < items.length; i++) {
      lastAssistantFlatIndexPerItem[cursor + i] = lastIndex;
    }
    cursor += items.length;
  }

  const originalToFlatIndex = new Map<number, number>();
  let originalIndex = 0;
  let flatIndexCursor = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    const surviving = survivingPerGroup[groupIndex];
    const droppedTargets = droppedItemTargetByGroup[groupIndex];
    if (group.header) {
      originalToFlatIndex.set(
        originalIndex,
        Math.min(flatIndexCursor, maxFlat)
      );
      originalIndex++;
    }
    let localKeptCursor = flatIndexCursor;
    for (let i = 0; i < group.items.length; i++) {
      const droppedTarget = droppedTargets[i];
      if (droppedTarget !== null) {
        originalToFlatIndex.set(originalIndex, droppedTarget);
      } else {
        originalToFlatIndex.set(originalIndex, localKeptCursor);
        localKeptCursor++;
      }
      originalIndex++;
    }
    flatIndexCursor += surviving.length;
  }

  const tailSurviving = survivingPerGroup[survivingPerGroup.length - 1];
  const lastGroupFirstFlatIndex =
    tailSurviving?.length > 0 ? flatItems.length - tailSurviving.length : null;

  return {
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    totalFlatItems: flatItems.length,
    originalToFlatIndex,
    lastGroupFirstFlatIndex,
    lastAssistantFlatIndexPerItem,
  };
}
