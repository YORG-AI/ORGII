/**
 * ChatHistoryList
 *
 * Pure list rendering: static path for small turns and TanStack Virtual
 * for longer grouped chat history. Extracted from `ChatHistory/index.tsx` to keep that file
 * under the 600-line limit.
 *
 * Receives all data and callbacks as props — no atom reads here.
 *
 * Co-located sibling modules (split out to keep this file under the
 * 600-line limit; prefixed to stay collision-safe with concurrent refactors
 * elsewhere in this directory):
 * - `ChatHistoryListTypes.ts` — the public imperative handle, the props
 *   contract, and the small view-model interfaces used below.
 * - `ChatHistoryListEquality.ts` — the `React.memo` prop comparator.
 * - `ChatHistoryListLayout.ts` — scroll/row-group/active-pin pure helpers.
 * - `ChatHistoryListActiveGroupReporter.ts` — the scroll-driven active
 *   group index/pin reporter hook.
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
import { CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX } from "@src/engines/ChatPanel/header/chatPanelHeaderLayout";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { getUnloadedTurnMeta } from "../hooks/useChatGroups";
import { GroupItemRenderer } from "../renderers";
import { useChatHistoryListActiveGroupReporter } from "./ChatHistoryListActiveGroupReporter";
import { sameChatHistoryListProps } from "./ChatHistoryListEquality";
import {
  EMPTY_ROW_GROUP_META,
  buildChatGroupRenderKeys,
  buildRowGroupMeta,
  isScrolledToContentBottom,
  resolveActiveGroupPinState,
  resolveVisibleGroupIndices,
} from "./ChatHistoryListLayout";
import type {
  ChatHistoryListProps,
  RowGroupMeta,
  VirtualGroup,
} from "./ChatHistoryListTypes";

// Re-exported so existing importers (hooks, tests) that reach these via
// "./ChatHistoryList" keep working unchanged after the split above.
export type { ChatHistoryListHandle } from "./ChatHistoryListTypes";
export { resolveActiveGroupPinState, resolveVisibleGroupIndices };

const STATIC_RENDER_ITEM_LIMIT = 24;

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
    turnIds,
    assistantCopyEventIdsByGroup,
    resolveAssistantTurnCopyContent,
    totalFlatItems,
    lastAssistantFlatIndexPerItem,
    codeBlockContainerWidth,
    footerSpacerHeight,
    bottomInset,
    topPaddingPx = CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX,
    planningIndicatorCount,
    planningVariantIndex,
    planningFooterMode,
    virtualListRef,
    virtualListDataKey,
    getIsWpGeneWorking,
    getIsExploring,
    renderGroupHeader: renderGroupHeaderProp,
    onAtBottomStateChange,
    onRangeChanged,
    onActiveGroupIndexChange,
    hideActiveGroupHeader = false,
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
    const planningVariantIndexRef = useRef(planningVariantIndex);
    planningVariantIndexRef.current = planningVariantIndex;
    const planningFooterModeRef = useRef(planningFooterMode);
    planningFooterModeRef.current = planningFooterMode;

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
    const groupRenderKeys = useMemo(
      () => buildChatGroupRenderKeys(turnIds),
      [turnIds]
    );
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
      getItemKey: (index) =>
        groupRenderKeys[index] ?? `chat-group-index:${index}`,
    });
    const virtualItems = virtualizer.getVirtualItems();

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
        scrollToGroup: ({ groupIndex, behavior = "smooth" }) => {
          const boundedGroupIndex = Math.max(
            0,
            Math.min(groupIndex, virtualGroups.length - 1)
          );
          const staticScrollRoot = staticScrollerRef?.current;
          const staticGroup = staticScrollRoot?.querySelector<HTMLElement>(
            `[data-chat-group-index="${boundedGroupIndex}"]`
          );
          if (staticScrollRoot && staticGroup) {
            const rootRect = staticScrollRoot.getBoundingClientRect();
            const groupRect = staticGroup.getBoundingClientRect();
            staticScrollRoot.scrollTo({
              top: staticScrollRoot.scrollTop + groupRect.top - rootRect.top,
              behavior,
            });
            return;
          }
          virtualizer.scrollToIndex(boundedGroupIndex, {
            align: "start",
            behavior,
          });
        },
      }),
      [
        flatIndexToGroupIndex,
        staticScrollerRef,
        virtualGroups.length,
        virtualizer,
      ]
    );
    const rowGroupMeta = useMemo(
      () =>
        buildRowGroupMeta(effectiveGroupCounts, lastAssistantFlatIndexPerItem),
      [effectiveGroupCounts, lastAssistantFlatIndexPerItem]
    );
    const rowGroupMetaRef = useRef<RowGroupMeta[]>(rowGroupMeta);
    rowGroupMetaRef.current = rowGroupMeta;
    const turnIdsRef = useRef(turnIds);
    turnIdsRef.current = turnIds;
    const assistantCopyEventIdsByGroupRef = useRef(
      assistantCopyEventIdsByGroup
    );
    assistantCopyEventIdsByGroupRef.current = assistantCopyEventIdsByGroup;

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
      let nextGroupStartFlatIndex = 0;
      return effectiveGroupCounts.map((groupItemCount, groupIndex) => {
        const groupStartFlatIndex = nextGroupStartFlatIndex;
        nextGroupStartFlatIndex += groupItemCount;
        return {
          groupIndex,
          groupKey:
            groupRenderKeys[groupIndex] ?? `chat-group-index:${groupIndex}`,
          itemIndexes: Array.from(
            { length: groupItemCount },
            (_, itemOffset) => groupStartFlatIndex + itemOffset
          ),
        };
      });
    }, [useStaticRendering, effectiveGroupCounts, groupRenderKeys]);

    const renderGroupItem = React.useCallback(
      (flatIndex: number, groupIndex: number) => {
        const currentFlatItems = flatItemsRef.current;
        if (flatIndex >= currentFlatItems.length) {
          return (
            <PlanningFooter
              key={`planning-footer-${flatIndex}`}
              count={planningIndicatorCountRef.current}
              variantIndex={planningVariantIndexRef.current}
              mode={planningFooterModeRef.current}
            />
          );
        }
        const rowMeta =
          rowGroupMetaRef.current[flatIndex] ?? EMPTY_ROW_GROUP_META;
        return (
          <GroupItemRenderer
            flatIndex={flatIndex}
            groupIndex={groupIndex}
            turnId={turnIdsRef.current[groupIndex] ?? null}
            assistantCopyEventIds={
              assistantCopyEventIdsByGroupRef.current[groupIndex] ?? []
            }
            resolveAssistantTurnCopyContent={resolveAssistantTurnCopyContent}
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
        resolveAssistantTurnCopyContent,
      ]
    );

    const { scheduleReportActiveGroupIndex } =
      useChatHistoryListActiveGroupReporter({
        staticScrollerRef,
        virtualScrollerRef,
        useStaticRendering,
        virtualListDataKey,
        hideActiveGroupHeader,
        onActiveGroupIndexChange,
      });
    const setScrollContainerRef = useCallback(
      (node: HTMLDivElement | null) => {
        if (useStaticRendering) {
          if (staticScrollerRef) staticScrollerRef.current = node;
          virtualScrollerRef.current = null;
          return;
        }
        if (staticScrollerRef) staticScrollerRef.current = null;
        virtualScrollerRef.current = node;
      },
      [staticScrollerRef, useStaticRendering, virtualScrollerRef]
    );

    return (
      <div
        ref={setScrollContainerRef}
        data-testid="chat-history-scroll-container"
        className="allow-select-deep h-full w-full overflow-y-auto overscroll-contain scrollbar-hide"
        style={{ paddingTop: topPaddingPx }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const isAtBottom = isScrolledToContentBottom({
            element,
            footerSpacerHeight,
            bottomInset,
          });
          onAtBottomStateChange(isAtBottom);
          scheduleReportActiveGroupIndex(element);
          if (!useStaticRendering && isAtBottom) onEndReached();
        }}
      >
        <div
          className={`${useStaticRendering ? "mx-auto" : "relative mx-auto"} min-h-full w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
          style={
            useStaticRendering
              ? undefined
              : { height: virtualizer.getTotalSize() + footerSpacerHeight }
          }
        >
          {useStaticRendering
            ? staticGroups.map(({ groupIndex, groupKey, itemIndexes }) => (
                <div
                  key={groupKey}
                  className="relative"
                  data-chat-group-index={groupIndex}
                >
                  <div data-chat-group-header>
                    <div className="relative z-[30]">
                      {renderGroupHeaderProp(groupIndex, "user")}
                    </div>
                    {renderGroupHeaderProp(groupIndex, "collapse")}
                  </div>
                  {itemIndexes.map((itemFlatIndex) => {
                    if (itemFlatIndex >= flatItems.length) {
                      return (
                        <PlanningFooter
                          key={`planning-footer-${itemFlatIndex}`}
                          count={planningIndicatorCount}
                          variantIndex={planningVariantIndex}
                          mode={planningFooterMode}
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
                        turnId={turnIds[groupIndex] ?? null}
                        assistantCopyEventIds={
                          assistantCopyEventIdsByGroup[groupIndex] ?? []
                        }
                        resolveAssistantTurnCopyContent={
                          resolveAssistantTurnCopyContent
                        }
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
              ))
            : virtualItems.map((virtualItem) => {
                const group = virtualGroups[virtualItem.index];
                if (!group) return null;
                return (
                  <div
                    key={
                      groupRenderKeys[group.groupIndex] ??
                      `chat-group-index:${group.groupIndex}`
                    }
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    data-chat-group-index={group.groupIndex}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <div data-chat-group-header>
                      <div className="relative z-[30]">
                        {renderGroupHeaderProp(group.groupIndex, "user")}
                      </div>
                      {renderGroupHeaderProp(group.groupIndex, "collapse")}
                    </div>
                    {Array.from(
                      { length: group.itemCount },
                      (_, itemOffset) => {
                        const flatIndex = group.startFlatIndex + itemOffset;
                        return (
                          <div
                            key={`virtual-item-${flatIndex}`}
                            data-item-index={flatIndex}
                          >
                            {renderGroupItem(flatIndex, group.groupIndex)}
                          </div>
                        );
                      }
                    )}
                  </div>
                );
              })}
          {useStaticRendering ? (
            <div style={{ height: footerSpacerHeight }} />
          ) : null}
        </div>
      </div>
    );
  },
  sameChatHistoryListProps
);

ChatHistoryList.displayName = "ChatHistoryList";

export default ChatHistoryList;
