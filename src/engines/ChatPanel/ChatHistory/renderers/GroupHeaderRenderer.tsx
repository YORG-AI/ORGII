import { useAtomValue } from "jotai";
import React, { memo, useCallback, useState } from "react";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { CHAT_ITEM_PADDING_X } from "@src/engines/ChatPanel/blocks/primitives/config";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import { loadSessionTurnBodyIntoStore } from "@src/engines/SessionCore/turns";

import UserChatItem from "../../ChatItems/UserChatItem";
import ChatPinnedBars from "../../InputArea/components/ChatPinnedBars";
import TurnCollapsePinBar from "../../InputArea/components/TurnCollapsePinBar";
import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { CHAT_FOOTER_SPACER } from "../config/chatFooterSpacer";
import {
  type ChatGroupMeta,
  isTurnCollapseEligible,
} from "../hooks/useChatGroups";

function sameHeader(
  left: OptimizedChatItem | null | undefined,
  right: OptimizedChatItem | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.chunk_id === right.chunk_id &&
    left.type === right.type &&
    left.event?.id === right.event?.id &&
    left.event?.displayText === right.event?.displayText &&
    left.event?.createdAt === right.event?.createdAt
  );
}

function sameMeta(
  left: ChatGroupMeta | undefined,
  right: ChatGroupMeta | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.turnId === right.turnId &&
    left.durationMs === right.durationMs &&
    left.itemCount === right.itemCount &&
    left.previewText === right.previewText &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.unloadedTurn?.turnId === right.unloadedTurn?.turnId
  );
}

function sameGroupHeaderProps(
  previous: GroupHeaderRendererProps,
  next: GroupHeaderRendererProps
): boolean {
  const previousHeader = previous.groupHeaders[previous.groupIndex];
  const nextHeader = next.groupHeaders[next.groupIndex];
  const previousMeta = previous.groupMeta[previous.groupIndex];
  const nextMeta = next.groupMeta[next.groupIndex];
  const previousHeaderKey =
    previousMeta?.turnId ??
    previousHeader?.event?.id ??
    previousHeader?.chunk_id;
  const nextHeaderKey =
    nextMeta?.turnId ?? nextHeader?.event?.id ?? nextHeader?.chunk_id;
  const previousSourceGroupIndex =
    previous.sourceGroupIndex ?? previous.groupIndex;
  const nextSourceGroupIndex = next.sourceGroupIndex ?? next.groupIndex;
  const previousSourceGroupCount =
    previous.sourceGroupCount ?? previous.groupCount;
  const nextSourceGroupCount = next.sourceGroupCount ?? next.groupCount;

  return (
    previous.groupIndex === next.groupIndex &&
    previousHeaderKey === nextHeaderKey &&
    previousSourceGroupIndex === nextSourceGroupIndex &&
    previousSourceGroupCount === nextSourceGroupCount &&
    previous.hasPinnedContent === next.hasPinnedContent &&
    previous.collapseLabelVariant === next.collapseLabelVariant &&
    previous.hideCollapseTimeRange === next.hideCollapseTimeRange &&
    previous.suppressRoundGap === next.suppressRoundGap &&
    previous.collapseTailWhenIdle === next.collapseTailWhenIdle &&
    previous.hideUserMessage === next.hideUserMessage &&
    previous.defaultTurnCollapsed === next.defaultTurnCollapsed &&
    previous.renderPart === next.renderPart &&
    previous.turnCollapseInteractionAtRef ===
      next.turnCollapseInteractionAtRef &&
    previous.onEditSubmit === next.onEditSubmit &&
    previous.onRestoreCheckpoint === next.onRestoreCheckpoint &&
    sameHeader(previousHeader, nextHeader) &&
    sameMeta(previousMeta, nextMeta)
  );
}

export type GroupHeaderRenderPart = "all" | "user" | "collapse";

export interface GroupHeaderRendererProps {
  groupIndex: number;
  sourceGroupIndex?: number;
  sourceGroupCount?: number;
  groupHeaders: (OptimizedChatItem | null)[];
  /** Per-group metadata aligned with `groupHeaders`. */
  groupMeta: ChatGroupMeta[];
  groupCount: number;
  /** Whether any pinned todo content exists for the current session. */
  hasPinnedContent: boolean;
  collapseLabelVariant?: "agent" | "agents";
  /** Hide the turn time range when another surface already shows it. */
  hideCollapseTimeRange?: boolean;
  /** Suppresses the inter-round top gap for headers rendered outside the list. */
  suppressRoundGap?: boolean;
  /** Allows the latest turn to show the collapse bar after the session idles. */
  collapseTailWhenIdle?: boolean;
  /**
   * Skip rendering the per-turn user-message card (`UserChatItem` + its
   * attached `ChatPinnedBars`). The `TurnCollapsePinBar` ("Agent worked
   * for X") still renders. Subagent cells use this so each turn's
   * Coordinator prompt is hidden by default, surfaced via a toggle in
   * the pagination row.
   */
  hideUserMessage?: boolean;
  /** Default collapse state for eligible turns when no explicit override exists. */
  defaultTurnCollapsed?: boolean;
  renderPart?: GroupHeaderRenderPart;
  turnCollapseInteractionAtRef: React.MutableRefObject<number>;
  onEditSubmit?: (
    header: OptimizedChatItem,
    newText: string,
    imageDataUrls?: string[]
  ) => Promise<void> | void;
  onRestoreCheckpoint?: (header: OptimizedChatItem) => Promise<void> | void;
}

/**
 * Renders the user-message group header row for ChatHistory.
 *
 * Wrapped in `memo` so it doesn't re-render every time the chat panel
 * tree re-mounts during scroll / event ticks. The header is one of N
 * sticky rows in the viewport, so even tiny wasted renders compound.
 */
export const GroupHeaderRenderer: React.FC<GroupHeaderRendererProps> = memo(
  ({
    groupIndex,
    sourceGroupIndex,
    sourceGroupCount,
    groupHeaders,
    groupMeta,
    groupCount,
    hasPinnedContent,
    collapseLabelVariant = "agent",
    hideCollapseTimeRange = false,
    suppressRoundGap = false,
    collapseTailWhenIdle = false,
    hideUserMessage = false,
    defaultTurnCollapsed = false,
    renderPart = "all",
    turnCollapseInteractionAtRef,
    onEditSubmit,
    onRestoreCheckpoint,
  }) => {
    const header = groupHeaders[groupIndex];
    const meta = groupMeta[groupIndex];
    const collapseGroupIndex = sourceGroupIndex ?? groupIndex;
    const collapseGroupCount = sourceGroupCount ?? groupCount;
    const sessionId = useAtomValue(sessionIdAtom);
    const [isEditing, setIsEditing] = useState(false);

    // Stabilize the per-message handlers so memoized children
    // (`UserChatItem`, `TurnCollapsePinBar`) can skip identical-prop
    // re-renders. The original inline closures were rebuilt on every
    // render, defeating `TurnCollapsePinBar`'s `memo` wrap downstream.
    //
    // Both handlers preserve the original `undefined` semantics — they
    // return `undefined` instead of being declared as `undefined` props,
    // which keeps the prop reference stable across renders. Downstream
    // call sites that gate on truthiness (`if (onExpand)`) still work
    // because the stable closures themselves are always defined; the
    // bodies short-circuit when the inputs are missing.
    const turnId = meta?.turnId ?? null;
    const unloadedTurnId = meta?.unloadedTurn?.turnId ?? null;
    const canExpandUnloadedTurn = Boolean(sessionId && unloadedTurnId);
    const handleExpandUnloadedTurn = useCallback(async () => {
      if (!sessionId || !unloadedTurnId) return;
      await loadSessionTurnBodyIntoStore({
        sessionId,
        turnId: unloadedTurnId,
      });
    }, [sessionId, unloadedTurnId]);
    const handleEdit = useCallback(
      (newText: string, imageDataUrls?: string[]) => {
        if (!onEditSubmit || !header) return;
        return onEditSubmit(header, newText, imageDataUrls);
      },
      [onEditSubmit, header]
    );
    const handleRestoreCheckpoint = useCallback(() => {
      if (!onRestoreCheckpoint || !header) return;
      return onRestoreCheckpoint(header);
    }, [onRestoreCheckpoint, header]);

    if (!header) return <div />;

    const isLastGroup = collapseGroupIndex === collapseGroupCount - 1;
    // Hide the attached pinned bar while the user is editing this message
    // so the editor doesn't carry an unrelated todo strip below it.
    const showPinnedBars = isLastGroup && hasPinnedContent && !isEditing;
    // Show the "Agent worked for …" pin bar on collapse-eligible turns.
    // The latest turn joins after the session has idled long enough.
    const showCollapseBar = isTurnCollapseEligible(
      meta,
      collapseGroupIndex,
      collapseGroupCount,
      {
        collapseTailWhenIdle,
      }
    );

    const showUserPart = renderPart !== "collapse" && !hideUserMessage;
    const showCollapsePart = renderPart !== "user" && showCollapseBar && turnId;
    if (!showUserPart && !showCollapsePart) return null;

    const headerPaddingBottomClass = showCollapsePart ? "" : "pb-2";
    const roundGap =
      renderPart !== "collapse" && groupIndex > 0 && !suppressRoundGap
        ? CHAT_FOOTER_SPACER.ROUND_GAP_PX
        : 0;

    return (
      <div
        className={`${CHAT_ITEM_PADDING_X} ${DETAIL_PANEL_TOKENS.contentWidth} bg-chat-pane ${headerPaddingBottomClass}`.trim()}
        style={roundGap > 0 ? { marginTop: roundGap } : undefined}
      >
        {showUserPart && (
          <div
            className={
              showPinnedBars
                ? "flex flex-col rounded-[12px] bg-chat-container"
                : "contents"
            }
          >
            <UserChatItem
              chatItem={header}
              onEditSubmit={onEditSubmit ? handleEdit : undefined}
              onRestoreCheckpoint={
                onRestoreCheckpoint ? handleRestoreCheckpoint : undefined
              }
              onEditingChange={
                isLastGroup && hasPinnedContent ? setIsEditing : undefined
              }
            />
            {showPinnedBars && <ChatPinnedBars />}
          </div>
        )}
        {showCollapsePart && (
          <TurnCollapsePinBar
            turnId={turnId}
            durationMs={meta?.durationMs ?? 0}
            startMs={meta?.startMs ?? null}
            endMs={meta?.endMs ?? null}
            showTimeRange={!hideCollapseTimeRange}
            labelVariant={collapseLabelVariant}
            defaultCollapsed={defaultTurnCollapsed}
            turnCollapseInteractionAtRef={turnCollapseInteractionAtRef}
            onExpand={
              canExpandUnloadedTurn ? handleExpandUnloadedTurn : undefined
            }
          />
        )}
      </div>
    );
  },
  sameGroupHeaderProps
);

GroupHeaderRenderer.displayName = "GroupHeaderRenderer";
