import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  getRegistryEventType,
  normalizeFunctionName,
} from "@src/lib/activityData/activityNormalizers";

import {
  getActionSummaryCategory,
  isBrowserEvent,
  isDeleteFileEvent,
  isEditFileEvent,
  isTerminalActivityEvent,
} from "./chatItemPipeline/classifiers";
import { isAssistantMessageEvent } from "./chatItemPipeline/dedup";
import {
  hasThinkingEventType,
  willEventRenderContent,
} from "./chatItemPipeline/filters";
import type { OptimizedChatItem } from "./chatItemPipeline/types";

const NON_BUNDLEABLE_EVENT_TYPES = new Set([
  "ask_question",
  "approval",
  "mode_switch",
]);

const BUNDLEABLE_GROUP_TYPES = new Set([
  "actionSummaryGroup",
  "activityStackGroup",
  "readFileGroup",
]);

export function isBundlableToolChatItem(item: OptimizedChatItem): boolean {
  if (item.structuralOnly || item.type === "turnToolBundle") {
    return false;
  }
  if (item.type === "threadSelector") {
    return false;
  }
  if (BUNDLEABLE_GROUP_TYPES.has(item.type)) {
    return true;
  }

  const event = item.event;
  if (!event || event.source === "user") {
    return false;
  }

  const eventType = getRegistryEventType(
    event as unknown as Record<string, unknown>
  );
  if (NON_BUNDLEABLE_EVENT_TYPES.has(eventType)) {
    return false;
  }

  if (isAssistantMessageEvent(event) && willEventRenderContent(event)) {
    return false;
  }

  return willEventRenderContent(event);
}

export function createTurnToolBundleId(items: OptimizedChatItem[]): string {
  return `turn-tool-bundle:${items.map((item) => item.chunk_id).join("|")}`;
}

export function countTurnToolBundleItems(items: OptimizedChatItem[]): number {
  return items.length;
}

export type TurnToolBundleTypeKey =
  | "thinking"
  | "explore"
  | "readFiles"
  | "terminal"
  | "edit"
  | "browser"
  | "readImage"
  | "other";

const TURN_TOOL_BUNDLE_TYPE_ORDER: TurnToolBundleTypeKey[] = [
  "thinking",
  "explore",
  "readFiles",
  "terminal",
  "edit",
  "browser",
  "readImage",
  "other",
];

function getUiCanonical(event: SessionEvent): string {
  return (
    event.uiCanonical ||
    normalizeFunctionName(event.functionName || event.actionType || "")
  );
}

function bumpTypeCount(
  counts: Map<TurnToolBundleTypeKey, number>,
  key: TurnToolBundleTypeKey,
  delta = 1
): void {
  counts.set(key, (counts.get(key) ?? 0) + delta);
}

function classifyActivityEvent(event: SessionEvent): TurnToolBundleTypeKey {
  if (hasThinkingEventType(event)) {
    return "thinking";
  }

  const canonical = getUiCanonical(event);
  if (canonical === "read_image") {
    return "readImage";
  }
  if (isEditFileEvent(event) || isDeleteFileEvent(event)) {
    return "edit";
  }
  if (isTerminalActivityEvent(event)) {
    return "terminal";
  }
  if (isBrowserEvent(event)) {
    return "browser";
  }
  if (getActionSummaryCategory(event)) {
    return "explore";
  }
  if (canonical === "read_file") {
    return "readFiles";
  }
  return "other";
}

function collectEventsFromItem(item: OptimizedChatItem): SessionEvent[] {
  if (item.type === "actionSummaryGroup") {
    return (
      item.actionSummaryEntries?.flatMap((entry) => entry.events) ??
      item.actionSummaryItems?.map((entry) => entry.event) ??
      []
    );
  }
  if (item.type === "readFileGroup") {
    return item.readFileEvents ?? [];
  }
  if (item.type === "activityStackGroup") {
    return item.activityStackGroup?.events ?? [];
  }
  return item.event ? [item.event] : [];
}

function classifyGroupedItem(item: OptimizedChatItem): TurnToolBundleTypeKey {
  if (item.type === "actionSummaryGroup") {
    return "explore";
  }
  if (item.type === "readFileGroup") {
    return "readFiles";
  }
  if (item.type === "activityStackGroup") {
    const category = item.activityStackGroup?.category;
    if (category === "terminal") return "terminal";
    if (category === "edit") return "edit";
    return "browser";
  }
  return item.event ? classifyActivityEvent(item.event) : "other";
}

export function collectTurnToolBundleTypeCounts(
  items: OptimizedChatItem[]
): Map<TurnToolBundleTypeKey, number> {
  const counts = new Map<TurnToolBundleTypeKey, number>();

  for (const item of items) {
    if (
      item.type === "actionSummaryGroup" ||
      item.type === "readFileGroup" ||
      item.type === "activityStackGroup"
    ) {
      const nestedEvents = collectEventsFromItem(item);
      if (nestedEvents.length > 0) {
        bumpTypeCount(counts, classifyGroupedItem(item), nestedEvents.length);
      } else {
        bumpTypeCount(counts, classifyGroupedItem(item));
      }
      continue;
    }

    if (item.event) {
      bumpTypeCount(counts, classifyActivityEvent(item.event));
    }
  }

  return counts;
}

export function buildTurnToolBundleTypeSummary(
  items: OptimizedChatItem[],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const counts = collectTurnToolBundleTypeCounts(items);
  const parts: string[] = [];

  for (const key of TURN_TOOL_BUNDLE_TYPE_ORDER) {
    const count = counts.get(key);
    if (!count) continue;
    const label = t(`chat.collapseToolBlocksTypes.${key}`);
    parts.push(
      count > 1
        ? t("chat.collapseToolBlocksTypeEntry", { label, count })
        : label
    );
  }

  return parts.join(t("chat.collapseToolBlocksTypeSeparator"));
}

export function findFirstBundledEventId(
  items: OptimizedChatItem[]
): string | undefined {
  for (const item of items) {
    if (item.event?.id) {
      return item.event.id;
    }
    const nestedEvents =
      item.readFileEvents ??
      item.actionSummaryItems?.map((entry) => entry.event) ??
      item.activityStackGroup?.events;
    const nestedId = nestedEvents?.find((event) => event.id)?.id;
    if (nestedId) {
      return nestedId;
    }
  }
  return undefined;
}

export function bundleGroupItems(
  items: OptimizedChatItem[]
): OptimizedChatItem[] {
  const bundled: OptimizedChatItem[] = [];
  let pending: OptimizedChatItem[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    bundled.push({
      chunk_id: createTurnToolBundleId(pending),
      type: "turnToolBundle",
      turnToolBundleItems: pending,
    });
    pending = [];
  };

  for (const item of items) {
    if (isBundlableToolChatItem(item)) {
      pending.push(item);
      continue;
    }
    flush();
    bundled.push(item);
  }

  flush();
  return bundled;
}

function isCompletedAssistantFlatItem(item: OptimizedChatItem): boolean {
  const event = item.event;
  return (
    !item.structuralOnly &&
    event?.displayStatus === "completed" &&
    event !== undefined &&
    isAssistantMessageEvent(event)
  );
}

function recomputeLastAssistantFlatIndexPerItem(
  flatItems: OptimizedChatItem[],
  groupCounts: number[],
  isAgentWorking: boolean
): (number | null)[] {
  const result = new Array<number | null>(flatItems.length).fill(null);
  let cursor = 0;

  for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex++) {
    const count = groupCounts[groupIndex];
    let lastIndex: number | null = null;
    const isTailGroup = groupIndex === groupCounts.length - 1;

    if (!(isTailGroup && isAgentWorking)) {
      for (let index = count - 1; index >= 0; index--) {
        if (isCompletedAssistantFlatItem(flatItems[cursor + index])) {
          lastIndex = cursor + index;
          break;
        }
      }
    }

    for (let index = 0; index < count; index++) {
      result[cursor + index] = lastIndex;
    }
    cursor += count;
  }

  return result;
}

export interface BundledFlatItemsResult {
  flatItems: OptimizedChatItem[];
  groupCounts: number[];
  lastAssistantFlatIndexPerItem: (number | null)[];
}

export function bundleFlatItemsByGroup(
  flatItems: OptimizedChatItem[],
  groupCounts: number[],
  options: { isAgentWorking?: boolean } = {}
): BundledFlatItemsResult {
  const nextFlatItems: OptimizedChatItem[] = [];
  const nextGroupCounts: number[] = [];
  let cursor = 0;

  for (const groupCount of groupCounts) {
    const groupSlice = flatItems.slice(cursor, cursor + groupCount);
    const bundledGroup = bundleGroupItems(groupSlice);
    nextGroupCounts.push(bundledGroup.length);
    nextFlatItems.push(...bundledGroup);
    cursor += groupCount;
  }

  return {
    flatItems: nextFlatItems,
    groupCounts: nextGroupCounts,
    lastAssistantFlatIndexPerItem: recomputeLastAssistantFlatIndexPerItem(
      nextFlatItems,
      nextGroupCounts,
      options.isAgentWorking ?? false
    ),
  };
}
