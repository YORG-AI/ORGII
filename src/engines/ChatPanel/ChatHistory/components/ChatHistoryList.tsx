/**
 * ChatHistoryList
 *
 * Pure list rendering: static path for small turns and TanStack Virtual
 * for longer grouped chat history. Extracted from `ChatHistory/index.tsx` to keep that file
 * under the 600-line limit.
 *
 * Receives all data and callbacks as props — no atom reads here.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import React, {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { PlanningFooter } from "@src/engines/ChatPanel/blocks/primitives";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { CHAT_FOOTER_SPACER } from "../config/chatFooterSpacer";
import { getUnloadedTurnMeta } from "../hooks/useChatGroups";
import { GroupItemRenderer } from "../renderers";
import type { GroupHeaderRenderPart } from "../renderers/GroupHeaderRenderer";

const STATIC_RENDER_ITEM_LIMIT = 24;
const AT_BOTTOM_EPSILON_PX = 4;

function isScrolledToPhysicalBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AT_BOTTOM_EPSILON_PX
  );
}

function sameNumberArray(
  left: readonly number[],
  right: readonly number[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameNullableNumberArray(
  left: readonly (number | null)[],
  right: readonly (number | null)[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

type EventSummary = NonNullable<OptimizedChatItem["event"]>;

const RESULT_RENDER_KEYS = [
  "type",
  "message",
  "content",
  "observation",
  "success",
  "failure",
  "error",
  "images",
  "call_id",
  "output",
  "stdout",
  "stderr",
  "interleaved_output",
  "interleavedOutput",
  "diff",
  "diffString",
  "segments",
  "filePaths",
  "linesAdded",
  "linesRemoved",
  "status",
] as const;

const ARG_RENDER_KEYS = [
  "command",
  "streamOutput",
  "streamContent",
  "title",
  "action",
  "content",
  "path",
  "file_path",
  "target_file",
  "patch_text",
  "old_str",
  "old_string",
  "old_content",
  "new_str",
  "new_string",
  "new_content",
  "subagentSessionId",
] as const;

function sameRecordKeys(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return keys.every((key) => left[key] === right[key]);
}

function sameEventSummary(
  left: EventSummary | undefined,
  right: EventSummary | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.actionType === right.actionType &&
    left.functionName === right.functionName &&
    left.uiCanonical === right.uiCanonical &&
    left.displayText === right.displayText &&
    left.displayStatus === right.displayStatus &&
    left.displayVariant === right.displayVariant &&
    left.activityStatus === right.activityStatus &&
    left.shellPid === right.shellPid &&
    left.shellProcessStatus === right.shellProcessStatus &&
    left.shellExitCode === right.shellExitCode &&
    left.shellLogPath === right.shellLogPath &&
    left.extracted === right.extracted &&
    left.payloadRefs === right.payloadRefs &&
    sameRecordKeys(left.result, right.result, RESULT_RENDER_KEYS) &&
    sameRecordKeys(left.args, right.args, ARG_RENDER_KEYS)
  );
}

function sameEventList(
  left: readonly EventSummary[] | undefined,
  right: readonly EventSummary[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((leftEvent, index) =>
    sameEventSummary(leftEvent, right[index])
  );
}

interface RowGroupMeta {
  lastAssistantFlatIndex: number | null;
  isLastItemInGroup: boolean;
  isLastGroup: boolean;
}

function buildRowGroupMeta(
  groupCounts: readonly number[],
  lastAssistantFlatIndexPerItem: readonly (number | null)[]
): RowGroupMeta[] {
  const result: RowGroupMeta[] = [];
  let flatIndex = 0;
  const lastGroupIndex = groupCounts.length - 1;
  for (let groupIndex = 0; groupIndex < groupCounts.length; groupIndex++) {
    const groupCount = groupCounts[groupIndex];
    const groupEndFlatIndex = flatIndex + groupCount - 1;
    const isLastGroup = groupIndex === lastGroupIndex;
    for (let itemOffset = 0; itemOffset < groupCount; itemOffset++) {
      result[flatIndex] = {
        lastAssistantFlatIndex:
          lastAssistantFlatIndexPerItem[flatIndex] ?? null,
        isLastItemInGroup: flatIndex === groupEndFlatIndex,
        isLastGroup,
      };
      flatIndex++;
    }
  }
  return result;
}

const EMPTY_ROW_GROUP_META: RowGroupMeta = {
  lastAssistantFlatIndex: null,
  isLastItemInGroup: false,
  isLastGroup: false,
};

function sameFlatItems(
  left: readonly OptimizedChatItem[],
  right: readonly OptimizedChatItem[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((leftItem, index) => {
    const rightItem = right[index];
    return (
      rightItem !== undefined &&
      leftItem.chunk_id === rightItem.chunk_id &&
      leftItem.type === rightItem.type &&
      leftItem.consolidatedParts === rightItem.consolidatedParts &&
      leftItem.repeatedErrorCount === rightItem.repeatedErrorCount &&
      leftItem.structuralOnly === rightItem.structuralOnly &&
      sameEventSummary(leftItem.event, rightItem.event) &&
      sameEventList(leftItem.readFileEvents, rightItem.readFileEvents) &&
      sameEventList(
        leftItem.activityStackGroup?.events,
        rightItem.activityStackGroup?.events
      ) &&
      sameEventList(
        leftItem.actionSummaryItems?.map((item) => item.event),
        rightItem.actionSummaryItems?.map((item) => item.event)
      )
    );
  });
}

function sameChatHistoryListProps(
  previous: ChatHistoryListProps,
  next: ChatHistoryListProps
): boolean {
  const sameFooterSpacer =
    Math.abs(previous.footerSpacerHeight - next.footerSpacerHeight) <
    CHAT_FOOTER_SPACER.UPDATE_THRESHOLD_PX;
  const checks: Array<[string, boolean]> = [
    ["flatItems", sameFlatItems(previous.flatItems, next.flatItems)],
    ["groupCounts", sameNumberArray(previous.groupCounts, next.groupCounts)],
    ["totalFlatItems", previous.totalFlatItems === next.totalFlatItems],
    [
      "lastAssistantFlatIndexPerItem",
      sameNullableNumberArray(
        previous.lastAssistantFlatIndexPerItem,
        next.lastAssistantFlatIndexPerItem
      ),
    ],
    [
      "codeBlockContainerWidth",
      previous.codeBlockContainerWidth === next.codeBlockContainerWidth,
    ],
    ["footerSpacerHeight", sameFooterSpacer],
    [
      "planningIndicatorCount",
      previous.planningIndicatorCount === next.planningIndicatorCount,
    ],
    [
      "planningShowSlowHint",
      previous.planningShowSlowHint === next.planningShowSlowHint,
    ],
    [
      "planningVariantIndex",
      previous.planningVariantIndex === next.planningVariantIndex,
    ],
    ["virtualListRef", previous.virtualListRef === next.virtualListRef],
    [
      "virtualListDataKey",
      previous.virtualListDataKey === next.virtualListDataKey,
    ],
    [
      "getIsWpGeneWorking",
      previous.getIsWpGeneWorking === next.getIsWpGeneWorking,
    ],
    ["getIsExploring", previous.getIsExploring === next.getIsExploring],
    [
      "renderGroupHeader",
      previous.renderGroupHeader === next.renderGroupHeader,
    ],
    [
      "onAtBottomStateChange",
      previous.onAtBottomStateChange === next.onAtBottomStateChange,
    ],
    ["onRangeChanged", previous.onRangeChanged === next.onRangeChanged],
    [
      "onActiveGroupIndexChange",
      previous.onActiveGroupIndexChange === next.onActiveGroupIndexChange,
    ],
    ["onEndReached", previous.onEndReached === next.onEndReached],
    ["onRegenerate", previous.onRegenerate === next.onRegenerate],
    ["onSubmit", previous.onSubmit === next.onSubmit],
    ["onSkip", previous.onSkip === next.onSkip],
    [
      "onEditUserMessage",
      previous.onEditUserMessage === next.onEditUserMessage,
    ],
    [
      "virtualScrollerRef",
      previous.virtualScrollerRef === next.virtualScrollerRef,
    ],
    [
      "staticScrollerRef",
      previous.staticScrollerRef === next.staticScrollerRef,
    ],
    [
      "newEventDividerLabel",
      previous.newEventDividerLabel === next.newEventDividerLabel,
    ],
  ];
  return checks.every(([, same]) => same);
}

export interface ChatHistoryListHandle {
  scrollToIndex: (options: {
    index: number;
    behavior?: ScrollBehavior;
    align?: "start" | "center" | "end" | "auto";
  }) => void;
}

interface ChatHistoryListProps {
  flatItems: OptimizedChatItem[];
  groupCounts: number[];
  totalFlatItems: number;
  lastAssistantFlatIndexPerItem: (number | null)[];
  codeBlockContainerWidth: number;
  footerSpacerHeight: number;
  planningIndicatorCount: number;
  planningShowSlowHint: boolean;
  planningVariantIndex: number;
  virtualListRef: React.RefObject<ChatHistoryListHandle | null>;
  virtualListDataKey: string;
  /**
   * Stable getter returning whether work-product generation is active.
   * Implemented as a function so Virtuoso item callbacks can read the
   * live value without the ref being read during React's render phase.
   */
  getIsWpGeneWorking: () => boolean;
  /**
   * Stable getter returning whether the agent is in "exploring" mode.
   * Same rationale as `getIsWpGeneWorking`.
   */
  getIsExploring: () => boolean;
  renderGroupHeader: (
    groupIndex: number,
    renderPart?: GroupHeaderRenderPart
  ) => React.ReactNode;
  onAtBottomStateChange: (atBottom: boolean) => void;
  onRangeChanged: (range: { startIndex: number; endIndex: number }) => void;
  onActiveGroupIndexChange?: (groupIndex: number, pinned: boolean) => void;
  onEndReached: () => void;
  onRegenerate?: (groupIndex: number) => void;
  onSubmit: (eventId: string, answers: Record<string, string>) => void;
  onSkip: (eventId: string) => void;
  onEditUserMessage?: (
    header: OptimizedChatItem,
    text: string,
    images?: string[]
  ) => void;
  virtualScrollerRef: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * Ref that receives the static-path scroll container (used only when
   * a page has no body items and Virtuoso is not mounted).
   * Allows useChatScrollPin to fall back to scrolling this element on
   * session switches instead of silently failing.
   */
  staticScrollerRef?: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * When set, `GroupItemRenderer` paints a `NewEventDivider` with this
   * label above each group's last item. Subagent panes opt in so the
   * freshest event in every turn is signposted. `null` / undefined
   * keeps the divider off (default for the main chat panel).
   */
  newEventDividerLabel?: string | null;
}

interface VirtualGroup {
  groupIndex: number;
  startFlatIndex: number;
  itemCount: number;
}

// memo: parent (`ChatHistory/index.tsx`) re-renders on every chat event
// (atom subscriptions, useDeferredValue ticks). All props are either
// primitives, useCallback-wrapped, refs, or arrays/objects produced by
// upstream useMemo (e.g. `useChatTurnPagination`), so default shallow
// compare is sufficient to skip the whole GroupedVirtuoso re-render
// during non-content updates.
const ChatHistoryList: React.FC<ChatHistoryListProps> = memo(
  ({
    flatItems,
    groupCounts,
    totalFlatItems,
    lastAssistantFlatIndexPerItem,
    codeBlockContainerWidth,
    footerSpacerHeight,
    planningIndicatorCount,
    planningShowSlowHint,
    planningVariantIndex,
    virtualListRef,
    virtualListDataKey,
    getIsWpGeneWorking,
    getIsExploring,
    renderGroupHeader: renderGroupHeaderProp,
    onAtBottomStateChange,
    onRangeChanged,
    onActiveGroupIndexChange,
    onEndReached,
    onRegenerate,
    onSubmit,
    onSkip,
    onEditUserMessage,
    virtualScrollerRef,
    staticScrollerRef,
    newEventDividerLabel = null,
  }) => {
    // Planning indicator state in refs so polling ticks don't invalidate
    // renderGroupItem's useCallback (Root Cause 2 fix).
    const planningIndicatorCountRef = useRef(planningIndicatorCount);
    planningIndicatorCountRef.current = planningIndicatorCount;
    const planningShowSlowHintRef = useRef(planningShowSlowHint);
    planningShowSlowHintRef.current = planningShowSlowHint;
    const planningVariantIndexRef = useRef(planningVariantIndex);
    planningVariantIndexRef.current = planningVariantIndex;

    // flatItems and previousChatItems in refs so renderGroupItem's useCallback
    // is not re-created on every token during streaming (Root Cause 1 fix).
    const flatItemsRef = useRef(flatItems);
    flatItemsRef.current = flatItems;
    const previousChatItemsRef = useRef<(OptimizedChatItem | undefined)[]>([]);

    // When the planning indicator is active, inject it as a virtual item
    // in the last group so it renders under the latest turn's header —
    // not as the global Virtuoso Footer which visually attaches to the
    // previous turn when the latest group has 0 body items.
    const hasPlanningItem =
      planningIndicatorCount > 0 && groupCounts.length > 0;
    const effectiveGroupCounts = useMemo(() => {
      if (!hasPlanningItem) return groupCounts;
      const adjusted = [...groupCounts];
      adjusted[adjusted.length - 1] += 1;
      return adjusted;
    }, [hasPlanningItem, groupCounts]);
    const effectiveTotalFlatItems = totalFlatItems + (hasPlanningItem ? 1 : 0);
    const virtualGroups = useMemo<VirtualGroup[]>(() => {
      let startFlatIndex = 0;
      return effectiveGroupCounts.map((itemCount, groupIndex) => {
        const group = { groupIndex, startFlatIndex, itemCount };
        startFlatIndex += itemCount;
        return group;
      });
    }, [effectiveGroupCounts]);
    const flatIndexToGroupIndex = useMemo(() => {
      const indexes: number[] = [];
      for (const group of virtualGroups) {
        for (let offset = 0; offset < group.itemCount; offset++) {
          indexes[group.startFlatIndex + offset] = group.groupIndex;
        }
      }
      return indexes;
    }, [virtualGroups]);
    // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
    const virtualizer = useVirtualizer({
      count: virtualGroups.length,
      getScrollElement: () => virtualScrollerRef.current,
      estimateSize: () => 360,
      overscan: 4,
      getItemKey: (index) => {
        const group = virtualGroups[index];
        if (!group) return `chat-group-${index}:0`;
        const itemKeys = flatItems
          .slice(group.startFlatIndex, group.startFlatIndex + group.itemCount)
          .map((item) => item.chunk_id)
          .join("|");
        return `${index}:${group.itemCount}:${itemKeys}`;
      },
    });
    const virtualItems = virtualizer.getVirtualItems();
    const rowResizeObserverRef = useRef<ResizeObserver | null>(null);
    const measuredRowHeightsRef = useRef(new WeakMap<Element, number>());
    const observedRowsRef = useRef(new Set<Element>());
    const measureVirtualRow = useCallback(
      (node: HTMLDivElement | null) => {
        if (!node) return;
        if (!rowResizeObserverRef.current) {
          rowResizeObserverRef.current = new ResizeObserver((entries) => {
            for (const entry of entries) {
              const target = entry.target;
              const nextHeight =
                entry.borderBoxSize[0]?.blockSize ??
                target.getBoundingClientRect().height;
              if (measuredRowHeightsRef.current.get(target) === nextHeight) {
                continue;
              }
              measuredRowHeightsRef.current.set(target, nextHeight);
              virtualizer.measureElement(target as HTMLElement);
            }
          });
        }
        virtualizer.measureElement(node);
        if (!observedRowsRef.current.has(node)) {
          observedRowsRef.current.add(node);
          rowResizeObserverRef.current.observe(node);
        }
      },
      [virtualizer]
    );

    useEffect(() => {
      const observedRows = observedRowsRef.current;
      return () => {
        rowResizeObserverRef.current?.disconnect();
        rowResizeObserverRef.current = null;
        observedRows.clear();
      };
    }, [virtualListDataKey]);

    useEffect(() => {
      if (virtualItems.length === 0) return;
      const firstGroup = virtualGroups[virtualItems[0].index];
      const lastGroup =
        virtualGroups[virtualItems[virtualItems.length - 1].index];
      if (!firstGroup || !lastGroup) return;
      onRangeChanged({
        startIndex: firstGroup.startFlatIndex,
        endIndex: Math.max(
          firstGroup.startFlatIndex,
          lastGroup.startFlatIndex + lastGroup.itemCount - 1
        ),
      });
    }, [onRangeChanged, virtualGroups, virtualItems]);

    useImperativeHandle(
      virtualListRef,
      () => ({
        scrollToIndex: ({ index, behavior = "auto", align = "center" }) => {
          const groupIndex = flatIndexToGroupIndex[index] ?? 0;
          virtualizer.scrollToIndex(groupIndex, { align, behavior });
        },
      }),
      [flatIndexToGroupIndex, virtualizer]
    );
    const rowGroupMeta = useMemo(
      () =>
        buildRowGroupMeta(effectiveGroupCounts, lastAssistantFlatIndexPerItem),
      [effectiveGroupCounts, lastAssistantFlatIndexPerItem]
    );
    const rowGroupMetaRef = useRef<RowGroupMeta[]>(rowGroupMeta);
    rowGroupMetaRef.current = rowGroupMeta;

    // For each flat index, the nearest preceding qualifying item — non-structural,
    // non-unloaded, with an event. Pre-computed once per flatItems change so
    // GroupItemRenderer doesn't run an O(N) backward scan on every render
    // (Root Cause 3 fix / Root Cause 1 fix combined).
    const previousChatItems = useMemo<(OptimizedChatItem | undefined)[]>(() => {
      const result: (OptimizedChatItem | undefined)[] = new Array(
        flatItems.length
      ).fill(undefined);
      let lastQualifying: OptimizedChatItem | undefined = undefined;
      for (let i = 0; i < flatItems.length; i++) {
        result[i] = lastQualifying;
        const item = flatItems[i];
        if (
          item &&
          !item.structuralOnly &&
          getUnloadedTurnMeta(item) === null &&
          item.event
        ) {
          lastQualifying = item;
        }
      }
      previousChatItemsRef.current = result;
      return result;
    }, [flatItems]);

    const useStaticRendering =
      effectiveTotalFlatItems <= STATIC_RENDER_ITEM_LIMIT;

    const staticGroups = useMemo(() => {
      if (!useStaticRendering) return [];
      return effectiveGroupCounts.map((groupItemCount, groupIndex) => {
        const groupStartFlatIndex = effectiveGroupCounts
          .slice(0, groupIndex)
          .reduce((sum, count) => sum + count, 0);
        const firstItem = flatItems[groupStartFlatIndex];
        const groupKey =
          firstItem?.event?.id ??
          firstItem?.chunk_id ??
          `static-group-${groupIndex}`;
        return {
          groupIndex,
          groupKey,
          itemIndexes: Array.from(
            { length: groupItemCount },
            (_, itemOffset) => groupStartFlatIndex + itemOffset
          ),
        };
      });
    }, [useStaticRendering, effectiveGroupCounts, flatItems]);

    const renderGroupItem = React.useCallback(
      (flatIndex: number, groupIndex: number) => {
        const currentFlatItems = flatItemsRef.current;
        if (flatIndex >= currentFlatItems.length) {
          return (
            <PlanningFooter
              key={`planning-footer-${flatIndex}`}
              count={planningIndicatorCountRef.current}
              showSlowHint={planningShowSlowHintRef.current}
              variantIndex={planningVariantIndexRef.current}
            />
          );
        }
        const rowMeta =
          rowGroupMetaRef.current[flatIndex] ?? EMPTY_ROW_GROUP_META;
        return (
          <GroupItemRenderer
            flatIndex={flatIndex}
            groupIndex={groupIndex}
            chatItem={currentFlatItems[flatIndex]}
            previousChatItem={previousChatItemsRef.current[flatIndex]}
            lastAssistantFlatIndex={rowMeta.lastAssistantFlatIndex}
            isLastItemInGroup={rowMeta.isLastItemInGroup}
            isLastGroup={rowMeta.isLastGroup}
            isWpGeneWorking={getIsWpGeneWorking()}
            isExploring={getIsExploring()}
            codeBlockContainerWidth={codeBlockContainerWidth}
            onRegenerate={onRegenerate}
            onSubmit={onSubmit}
            onSkip={onSkip}
            onEditUserMessage={onEditUserMessage}
            newEventDividerLabel={newEventDividerLabel}
          />
        );
      },
      [
        codeBlockContainerWidth,
        getIsWpGeneWorking,
        getIsExploring,
        onRegenerate,
        onSubmit,
        onSkip,
        onEditUserMessage,
        newEventDividerLabel,
      ]
    );

    const reportActiveGroupIndex = useCallback(
      (scrollRoot: HTMLDivElement) => {
        if (!onActiveGroupIndexChange) return;
        const rootTop = scrollRoot.getBoundingClientRect().top;
        let activeGroupIndex = 0;
        let activeTop = Number.NEGATIVE_INFINITY;
        for (const groupElement of scrollRoot.querySelectorAll<HTMLElement>(
          "[data-chat-group-index]"
        )) {
          const groupIndex = Number(groupElement.dataset.chatGroupIndex);
          if (!Number.isFinite(groupIndex)) continue;
          const top = groupElement.getBoundingClientRect().top - rootTop;
          if (top <= 0 && top >= activeTop) {
            activeTop = top;
            activeGroupIndex = groupIndex;
          }
        }
        onActiveGroupIndexChange(activeGroupIndex, activeTop < 0);
      },
      [onActiveGroupIndexChange]
    );

    if (useStaticRendering) {
      return (
        <div
          ref={staticScrollerRef}
          className="h-full overflow-y-auto overscroll-contain scrollbar-hide"
          onScroll={(event) => {
            const element = event.currentTarget;
            onAtBottomStateChange(isScrolledToPhysicalBottom(element));
            reportActiveGroupIndex(element);
          }}
        >
          <div
            className={`mx-auto min-h-full w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
          >
            {staticGroups.map(({ groupIndex, groupKey, itemIndexes }) => (
              <div
                key={groupKey}
                className="relative"
                data-chat-group-index={groupIndex}
              >
                <div className="relative z-[30]">
                  {renderGroupHeaderProp(groupIndex, "user")}
                </div>
                {renderGroupHeaderProp(groupIndex, "collapse")}
                {itemIndexes.map((itemFlatIndex) => {
                  if (itemFlatIndex >= flatItems.length) {
                    return (
                      <PlanningFooter
                        key={`planning-footer-${itemFlatIndex}`}
                        count={planningIndicatorCount}
                        showSlowHint={planningShowSlowHint}
                        variantIndex={planningVariantIndex}
                      />
                    );
                  }
                  const itemKey =
                    flatItems[itemFlatIndex]?.chunk_id ??
                    `static-chat-${itemFlatIndex}`;
                  const rowMeta =
                    rowGroupMeta[itemFlatIndex] ?? EMPTY_ROW_GROUP_META;
                  return (
                    <GroupItemRenderer
                      key={itemKey}
                      flatIndex={itemFlatIndex}
                      groupIndex={groupIndex}
                      chatItem={flatItems[itemFlatIndex]}
                      previousChatItem={previousChatItems[itemFlatIndex]}
                      lastAssistantFlatIndex={rowMeta.lastAssistantFlatIndex}
                      isLastItemInGroup={rowMeta.isLastItemInGroup}
                      isLastGroup={rowMeta.isLastGroup}
                      isWpGeneWorking={false}
                      isExploring={false}
                      codeBlockContainerWidth={codeBlockContainerWidth}
                      onRegenerate={onRegenerate}
                      onSubmit={onSubmit}
                      onSkip={onSkip}
                      onEditUserMessage={onEditUserMessage}
                      newEventDividerLabel={newEventDividerLabel}
                    />
                  );
                })}
              </div>
            ))}
            <div style={{ height: footerSpacerHeight }} />
          </div>
        </div>
      );
    }

    return (
      <div
        ref={(node) => {
          virtualScrollerRef.current = node;
        }}
        className="h-full w-full overflow-y-auto overscroll-contain scrollbar-hide"
        onScroll={(event) => {
          const element = event.currentTarget;
          const isAtBottom = isScrolledToPhysicalBottom(element);
          onAtBottomStateChange(isAtBottom);
          reportActiveGroupIndex(element);
          if (isAtBottom) onEndReached();
        }}
      >
        <div
          className={`relative mx-auto min-h-full w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
          style={{ height: virtualizer.getTotalSize() + footerSpacerHeight }}
        >
          {virtualItems.map((virtualItem) => {
            const group = virtualGroups[virtualItem.index];
            if (!group) return null;
            return (
              <div
                key={virtualItem.key}
                ref={measureVirtualRow}
                data-index={virtualItem.index}
                data-chat-group-index={group.groupIndex}
                className="absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <div className="relative z-[30]">
                  {renderGroupHeaderProp(group.groupIndex, "user")}
                </div>
                {renderGroupHeaderProp(group.groupIndex, "collapse")}
                {Array.from({ length: group.itemCount }, (_, itemOffset) => {
                  const flatIndex = group.startFlatIndex + itemOffset;
                  return (
                    <div
                      key={`virtual-item-${flatIndex}`}
                      data-item-index={flatIndex}
                    >
                      {renderGroupItem(flatIndex, group.groupIndex)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
  sameChatHistoryListProps
);

ChatHistoryList.displayName = "ChatHistoryList";

export default ChatHistoryList;
