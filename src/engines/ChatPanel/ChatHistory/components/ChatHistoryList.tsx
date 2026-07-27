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

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { getUnloadedTurnMeta } from "../hooks/useChatGroups";
import { GroupItemRenderer } from "../renderers";
import { useChatHistoryListActiveGroupReporter } from "./ChatHistoryListActiveGroupReporter";
import { sameChatHistoryListProps } from "./ChatHistoryListEquality";
import {
  EMPTY_ROW_GROUP_META,
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
const PROGRAMMATIC_NAVIGATION_SIGNAL_MS = 500;

// memo: parent (`ChatHistory/index.tsx`) re-renders on every chat event
// (atom subscriptions, useDeferredValue ticks). All props are either
// primitives, useCallback-wrapped, refs, or arrays/objects produced by
// upstream useMemo (e.g. `useChatTurnPagination`), so default shallow
// compare is sufficient to skip the whole GroupedVirtuoso re-render
// during non-content updates.
const ChatHistoryList: React.FC<ChatHistoryListProps> = memo(
  ({
    flatItems,
    groupKeys,
    groupCounts,
    turnIds,
    totalFlatItems,
    lastAssistantFlatIndexPerItem,
    codeBlockContainerWidth,
    footerSpacerHeight,
    bottomInset,
    planningIndicatorCount,
    planningVariantIndex,
    planningFooterMode,
    virtualListRef,
    virtualListDataKey,
    getIsWpGeneWorking,
    getIsExploring,
    renderGroupHeader: renderGroupHeaderProp,
    onAtStartStateChange,
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
    const virtualGroupKeys = useMemo(
      () =>
        virtualGroups.map((group) => {
          const tailItem =
            flatItems[group.startFlatIndex + Math.max(0, group.itemCount - 1)];
          return (
            groupKeys[group.groupIndex] ??
            turnIds[group.groupIndex] ??
            tailItem?.event?.id ??
            tailItem?.chunk_id ??
            `chat-group-${group.groupIndex}`
          );
        }),
      [flatItems, groupKeys, turnIds, virtualGroups]
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
      // A prepend changes every numerical group index. Provider/user ids (or
      // the tail event for an anchorless partial turn) remain stable, allowing
      // TanStack Virtual to reuse measurements instead of remounting every
      // resident row after each bounded replay window.
      getItemKey: (index) => virtualGroupKeys[index] ?? `chat-group-${index}`,
    });
    const virtualItems = virtualizer.getVirtualItems();
    const rowResizeObserverRef = useRef<ResizeObserver | null>(null);
    const measuredRowHeightsRef = useRef(new WeakMap<Element, number>());
    const observedRowsRef = useRef(new Set<Element>());
    const programmaticNavigationAtRef = useRef(0);
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
          programmaticNavigationAtRef.current = performance.now();
          virtualizer.scrollToIndex(groupIndex, { align, behavior });
        },
        scrollToGroup: ({ groupIndex, behavior = "smooth", turnId = null }) => {
          const currentTurnIndex = turnId ? turnIds.indexOf(turnId) : -1;
          const resolvedGroupIndex =
            currentTurnIndex >= 0 ? currentTurnIndex : groupIndex;
          const boundedGroupIndex = Math.max(
            0,
            Math.min(resolvedGroupIndex, virtualGroups.length - 1)
          );
          programmaticNavigationAtRef.current = performance.now();
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
        turnIds,
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
      const seenGroupKeys = new Set<string>();
      let nextGroupStartFlatIndex = 0;
      return effectiveGroupCounts.map((groupItemCount, groupIndex) => {
        const groupStartFlatIndex = nextGroupStartFlatIndex;
        nextGroupStartFlatIndex += groupItemCount;
        // Only a group that owns at least one item may borrow its identity from
        // one. A zero-count group's start index points at the *next* group's
        // first item, so reading it unconditionally makes both groups emit the
        // same key ("Encountered two children with the same key"). Empty groups
        // are produced by useChatGroupsProjection when a collapsed turn has no
        // structural source.
        const firstItem =
          groupItemCount > 0 ? flatItems[groupStartFlatIndex] : undefined;
        let groupKey =
          firstItem?.event?.id ??
          firstItem?.chunk_id ??
          `static-group-${groupIndex}`;
        if (seenGroupKeys.has(groupKey)) {
          groupKey = `${groupKey}#${groupIndex}`;
        }
        seenGroupKeys.add(groupKey);
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

    const { scheduleReportActiveGroupIndex } =
      useChatHistoryListActiveGroupReporter({
        staticScrollerRef,
        virtualScrollerRef,
        useStaticRendering,
        virtualListDataKey,
        hideActiveGroupHeader,
        onActiveGroupIndexChange,
      });

    useEffect(() => {
      const frame = window.requestAnimationFrame(() => {
        const scrollRoot = useStaticRendering
          ? staticScrollerRef?.current
          : virtualScrollerRef.current;
        if (scrollRoot) {
          onAtStartStateChange(
            scrollRoot.scrollTop <= 32,
            scrollRoot.scrollHeight > scrollRoot.clientHeight + 1,
            "layout"
          );
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }, [
      onAtStartStateChange,
      staticScrollerRef,
      useStaticRendering,
      virtualListDataKey,
      virtualScrollerRef,
    ]);

    if (useStaticRendering) {
      return (
        <div
          ref={staticScrollerRef}
          data-testid="chat-history-scroll-root"
          className="h-full overflow-y-auto overscroll-contain pt-2 scrollbar-hide"
          onScroll={(event) => {
            const element = event.currentTarget;
            const startSignalSource =
              performance.now() - programmaticNavigationAtRef.current <
              PROGRAMMATIC_NAVIGATION_SIGNAL_MS
                ? "programmatic"
                : "scroll";
            onAtStartStateChange(
              element.scrollTop <= 32,
              element.scrollHeight > element.clientHeight + 1,
              startSignalSource
            );
            onAtBottomStateChange(
              isScrolledToContentBottom({
                element,
                footerSpacerHeight,
                bottomInset,
              })
            );
            scheduleReportActiveGroupIndex(element);
          }}
          onWheel={(event) => {
            const element = event.currentTarget;
            if (event.deltaY >= 0) {
              if (event.deltaY > 0) {
                onAtStartStateChange(
                  false,
                  element.scrollHeight > element.clientHeight + 1,
                  "wheel"
                );
              }
              return;
            }
            if (element.scrollTop > 32) return;
            // A wheel gesture at the physical top does not produce another
            // `scroll` event. Surface the user's continued scroll-back intent
            // so a request that overlapped the previous bounded page can queue
            // exactly one successor instead of stalling until a manual nudge.
            onAtStartStateChange(
              true,
              element.scrollHeight > element.clientHeight + 1,
              "wheel"
            );
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
                data-chat-group-key={groupKeys[groupIndex] ?? undefined}
                data-chat-turn-id={turnIds[groupIndex] ?? undefined}
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
        data-testid="chat-history-scroll-root"
        className="h-full w-full overflow-y-auto overscroll-contain pt-2 scrollbar-hide"
        onScroll={(event) => {
          const element = event.currentTarget;
          const startSignalSource =
            performance.now() - programmaticNavigationAtRef.current <
            PROGRAMMATIC_NAVIGATION_SIGNAL_MS
              ? "programmatic"
              : "scroll";
          onAtStartStateChange(
            element.scrollTop <= 32,
            element.scrollHeight > element.clientHeight + 1,
            startSignalSource
          );
          const isAtBottom = isScrolledToContentBottom({
            element,
            footerSpacerHeight,
            bottomInset,
          });
          onAtBottomStateChange(isAtBottom);
          scheduleReportActiveGroupIndex(element);
          if (isAtBottom) onEndReached();
        }}
        onWheel={(event) => {
          const element = event.currentTarget;
          if (event.deltaY >= 0) {
            if (event.deltaY > 0) {
              onAtStartStateChange(
                false,
                element.scrollHeight > element.clientHeight + 1,
                "wheel"
              );
            }
            return;
          }
          if (element.scrollTop > 32) return;
          onAtStartStateChange(
            true,
            element.scrollHeight > element.clientHeight + 1,
            "wheel"
          );
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
                data-chat-group-key={groupKeys[group.groupIndex] ?? undefined}
                data-chat-turn-id={turnIds[group.groupIndex] ?? undefined}
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
                {Array.from({ length: group.itemCount }, (_, itemOffset) => {
                  const flatIndex = group.startFlatIndex + itemOffset;
                  const item = flatItems[flatIndex];
                  return (
                    <div
                      key={`virtual-item-${flatIndex}`}
                      data-item-index={flatIndex}
                      data-chat-item-key={
                        item?.event?.id ?? item?.chunk_id ?? undefined
                      }
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
