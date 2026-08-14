/**
 * ChatHistoryListTypes
 *
 * Shared type/interface definitions for `ChatHistoryList` — the public
 * imperative handle, the internal props contract, and the small view-model
 * shapes used by the row-group and active-group-pin layout helpers.
 * Extracted from `ChatHistoryList.tsx` to keep that file under the
 * 600-line limit.
 */
import type React from "react";

import type { PlanningFooterMode } from "@src/engines/ChatPanel/blocks/primitives";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { GroupHeaderRenderPart } from "../renderers/GroupHeaderRenderer";

export type EventSummary = NonNullable<OptimizedChatItem["event"]>;

export interface ChatHistoryListHandle {
  scrollToIndex: (options: {
    index: number;
    behavior?: ScrollBehavior;
    align?: "start" | "center" | "end" | "auto";
  }) => void;
  scrollToGroup: (options: {
    groupIndex: number;
    behavior?: ScrollBehavior;
  }) => void;
}

export interface ChatHistoryListProps {
  flatItems: OptimizedChatItem[];
  groupCounts: number[];
  turnIds: (string | null)[];
  totalFlatItems: number;
  lastAssistantFlatIndexPerItem: (number | null)[];
  codeBlockContainerWidth: number;
  footerSpacerHeight: number;
  bottomInset: number;
  /** Top padding keeping content clear of the floating chrome; see chatPanelHeaderLayout. */
  topPaddingPx?: number;
  planningIndicatorCount: number;
  planningVariantIndex: number;
  planningFooterMode: PlanningFooterMode;
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
  onActiveGroupIndexChange?: (
    groupIndex: number,
    pinned: boolean,
    visibleGroupIndices: number[]
  ) => void;
  /** Hide the in-list copy of the active header when a separate pinned header is rendered. */
  hideActiveGroupHeader?: boolean;
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

export interface VirtualGroup {
  groupIndex: number;
  startFlatIndex: number;
  itemCount: number;
}

export interface GroupPinMetrics {
  groupIndex: number;
  top: number;
}

export interface GroupViewportMetrics extends GroupPinMetrics {
  bottom: number;
}

export interface RowGroupMeta {
  lastAssistantFlatIndex: number | null;
  isLastItemInGroup: boolean;
  isLastGroup: boolean;
}
