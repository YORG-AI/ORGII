import { MailOpen } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import {
  BlockOutput,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useBlockHeader } from "@src/engines/ChatPanel/blocks/useBlockLocate";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  AgentTurnContext,
  type AgentTurnContextValue,
} from "../AgentTurnContext";
import { useGroupChatContext } from "../GroupChatView/GroupChatContext";
import GroupChatMessageBubble from "../GroupChatView/GroupChatMessageBubble";
import {
  extractGroupMessageContent,
  isAgentOrgInboxTranscriptEvent,
  resolveGroupChatMessageBubble,
  resolveGroupChatToolUseSummary,
} from "../GroupChatView/groupChatUtils";
import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { NewEventDivider } from "../components/NewEventDivider";
import { CHAT_FOOTER_SPACER } from "../config/chatFooterSpacer";
import { getUnloadedTurnMeta } from "../hooks/useChatGroups";
import { ChatItemRenderer } from "./ChatItemRenderer";
import ChatItemWrap from "./ChatItemWrap";

const GROUP_CHAT_CONTINUATION_WINDOW_MS = 60_000;
const INBOX_TRANSCRIPT_ICON = (
  <MailOpen size={SESSION_UI_TOKENS.ICON.SIZE_SM} />
);

// ============================================
// Custom props equality for memo()
// ============================================

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
  return left.every((leftEvent, i) => sameEventSummary(leftEvent, right[i]));
}

function sameChatItem(
  left: OptimizedChatItem | undefined,
  right: OptimizedChatItem | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.chunk_id === right.chunk_id &&
    left.type === right.type &&
    left.structuralOnly === right.structuralOnly &&
    left.consolidatedParts === right.consolidatedParts &&
    left.repeatedErrorCount === right.repeatedErrorCount &&
    left.actionSummaryClosedByBoundary ===
      right.actionSummaryClosedByBoundary &&
    sameEventSummary(left.event, right.event) &&
    sameEventList(left.readFileEvents, right.readFileEvents) &&
    sameEventList(
      left.activityStackGroup?.events,
      right.activityStackGroup?.events
    ) &&
    sameEventList(
      left.actionSummaryItems?.map((item) => item.event),
      right.actionSummaryItems?.map((item) => item.event)
    )
  );
}

function areGroupItemRendererPropsEqual(
  previous: GroupItemRendererProps,
  next: GroupItemRendererProps
): boolean {
  return (
    previous.flatIndex === next.flatIndex &&
    previous.groupIndex === next.groupIndex &&
    sameChatItem(previous.chatItem, next.chatItem) &&
    // previousChatItem affects group-chat continuation window only (createdAt
    // comparison). Shallow-compare the event rather than the full item — the
    // continuation check only reads event.createdAt, source, and senderName.
    previous.previousChatItem?.event === next.previousChatItem?.event &&
    previous.lastAssistantFlatIndex === next.lastAssistantFlatIndex &&
    previous.isLastItemInGroup === next.isLastItemInGroup &&
    previous.isLastGroup === next.isLastGroup &&
    previous.isWpGeneWorking === next.isWpGeneWorking &&
    previous.isExploring === next.isExploring &&
    previous.codeBlockContainerWidth === next.codeBlockContainerWidth &&
    previous.onRegenerate === next.onRegenerate &&
    previous.onSubmit === next.onSubmit &&
    previous.onSkip === next.onSkip &&
    previous.onEditUserMessage === next.onEditUserMessage &&
    previous.newEventDividerLabel === next.newEventDividerLabel
  );
}

function isWithinGroupChatContinuationWindow(
  previousTimestamp: string,
  currentTimestamp: string
): boolean {
  const previousTime = Date.parse(previousTimestamp);
  const currentTime = Date.parse(currentTimestamp);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }
  const elapsedMs = currentTime - previousTime;
  return elapsedMs >= 0 && elapsedMs <= GROUP_CHAT_CONTINUATION_WINDOW_MS;
}

function getInboxTranscriptBody(event: SessionEvent): string {
  return extractGroupMessageContent(event).trim();
}

const InboxTranscriptCard: React.FC<{
  event: SessionEvent;
  title: string;
}> = ({ event, title }) => {
  const { t } = useTranslation("sessions");
  const body = getInboxTranscriptBody(event);
  const hasContent = body.length > 0;
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({ defaultCollapsed: true, eventId: event.id });

  return (
    <div className={`${getEventBlockContainerClasses(false)} animate-fade-in`}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={hasContent ? handleHeaderClick : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={INBOX_TRANSCRIPT_ICON}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          iconSize={SESSION_UI_TOKENS.ICON.SIZE_SM}
          hasContent={hasContent}
        />
        <EventBlockHeaderTitle>{title}</EventBlockHeaderTitle>
      </EventBlockHeader>

      {!isCollapsed && hasContent && (
        <div
          className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in`}
        >
          <div className="border-b border-border-1 px-3 py-1.5 text-[13px] leading-normal">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-text-3">
                {t("cards.agentMessage.meta.sender")}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-1">
                {t("cards.agentMessage.emailBubble.subagentMessages")}
              </span>
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-text-3">
                {t("cards.agentMessage.meta.recipient")}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-1">
                Coordinator
              </span>
            </div>
          </div>
          <BlockOutput
            output={body}
            withBorder={false}
            sessionId={event.sessionId}
            eventId={event.id}
          />
        </div>
      )}
    </div>
  );
};

export interface GroupItemRendererProps {
  flatIndex: number;
  groupIndex: number;
  /** The item at `flatIndex`. Passed directly to avoid the full array reference. */
  chatItem: OptimizedChatItem | undefined;
  /**
   * The nearest preceding non-structural, non-unloaded item before
   * `flatIndex`. Pre-resolved by the call site so this renderer does not
   * need to scan the full flat list on every render.
   */
  previousChatItem: OptimizedChatItem | undefined;
  /** Flat index of the last assistant item in this row's group, if any. */
  lastAssistantFlatIndex: number | null;
  /** Whether this row is the final body item in its group. */
  isLastItemInGroup: boolean;
  /** Whether this row belongs to the latest group. */
  isLastGroup: boolean;
  isWpGeneWorking: boolean;
  isExploring: boolean;
  codeBlockContainerWidth?: number;
  onRegenerate?: (groupIndex: number) => void;
  onSubmit: (eventId: string, answers: Record<string, string>) => void;
  onSkip: (eventId: string) => void;
  onEditUserMessage?: (
    item: OptimizedChatItem,
    newText: string,
    imageDataUrls?: string[]
  ) => Promise<void> | void;
  /**
   * When set, the renderer paints a `NewEventDivider` immediately
   * above each group's *last* item. Subagent panes use this so the
   * latest assistant event in every turn is visually called out —
   * matches the "---- New event ----" divider in
   * `Communication > messages`. `null` / undefined leaves the
   * divider off (default).
   */
  newEventDividerLabel?: string | null;
}

/**
 * Renders a single flat item within a chat-history group, wrapped in
 * an AgentTurnContext so descendants can surface turn-scoped actions
 * (e.g. Regenerate) without prop-drilling through the event registry.
 *
 * Note: the shared "Agent worked for …" collapse is applied
 * STRUCTURALLY in `useChatGroups` — collapsed body items are dropped
 * from `flatItems` and `groupCounts` before they ever reach this
 * renderer. Doing the hide here (via `return null`) leaves virtual item
 * size caches pointing at the pre-collapse heights, which
 * shows up as a tall blank tail beneath the surviving last reply.
 */
// memo: per-item renderer called 30-50x for each visible viewport.
// Parent (`ChatHistoryList`) is also memo'd and produces a stable
// `renderGroupItem` via `useCallback`, so we receive identical prop
// references across non-content re-renders.
export const GroupItemRenderer: React.FC<GroupItemRendererProps> = memo(
  ({
    flatIndex,
    groupIndex,
    chatItem,
    previousChatItem,
    lastAssistantFlatIndex,
    isLastItemInGroup,
    isLastGroup,
    isWpGeneWorking,
    isExploring,
    codeBlockContainerWidth,
    onRegenerate,
    onSubmit,
    onSkip,
    onEditUserMessage,
    newEventDividerLabel = null,
  }) => {
    const { t } = useTranslation("sessions");
    const groupChat = useGroupChatContext();
    const event = chatItem?.event;

    const simpleMessage = useMemo(() => {
      if (!groupChat?.enabled || !event) return null;
      return resolveGroupChatMessageBubble(
        event,
        groupChat.coordinatorSessionId,
        groupChat.orgMembers
      );
    }, [groupChat, event]);

    const previousSimpleMessage = useMemo(() => {
      if (!groupChat?.enabled || !previousChatItem) return null;
      const previousEvent = previousChatItem.event;
      if (!previousEvent) return null;
      const message = resolveGroupChatMessageBubble(
        previousEvent,
        groupChat.coordinatorSessionId,
        groupChat.orgMembers
      );
      if (!message) return null;
      return { event: previousEvent, message };
    }, [groupChat, previousChatItem]);

    const inboxTranscriptLabel = useMemo(() => {
      if (!event || simpleMessage) return null;
      if (!isAgentOrgInboxTranscriptEvent(event)) return null;
      return t("groupChat.inboxTranscript.readMessages", {
        defaultValue: "Coordinator read messages sent by other agents",
      });
    }, [event, simpleMessage, t]);

    const usesGroupChatMessageBubble = simpleMessage !== null;
    const showGroupBubbleSenderChrome =
      simpleMessage !== null &&
      (previousSimpleMessage?.message.senderName !== simpleMessage.senderName ||
        !event ||
        !isWithinGroupChatContinuationWindow(
          previousSimpleMessage.event.createdAt,
          event.createdAt
        ));
    const groupChatToolUseSummary = useMemo(() => {
      if (!groupChat?.enabled || !event || !simpleMessage) return null;
      return resolveGroupChatToolUseSummary(event);
    }, [event, groupChat?.enabled, simpleMessage]);

    const treatAsAgentActivity = Boolean(
      groupChat?.enabled &&
      event?.source === "user" &&
      event &&
      !groupChat.isCoordinatorTurnHeader(event)
    );

    // Trailing-item turn gap. Placing the 24px gap on the LAST item of
    // each non-final group keeps the next group's header free of top
    // padding — so pinned headers stay flush at the top of the viewport,
    // while the visual turn boundary scrolls away with the previous
    // group's body. Skipped on the final group (no following turn to
    // separate from).
    const turnGapStyle =
      isLastItemInGroup && !isLastGroup
        ? { paddingBottom: CHAT_FOOTER_SPACER.ROUND_GAP_PX }
        : undefined;

    // Memoize the context value so consumers of `AgentTurnContext`
    // (e.g. `RegenerateButton`, `AgentErrorChatItem`) don't re-render
    // every time the parent ticks. Identity changes only when its inputs
    // actually change.
    const turnContext = useMemo<AgentTurnContextValue>(
      () => ({
        lastAssistantFlatIndex,
        isLastGroup,
        isLastItemInGroup,
        onRegenerate: onRegenerate
          ? isWpGeneWorking
            ? () => Message.info("Workspace is working!")
            : () => onRegenerate(groupIndex)
          : undefined,
        groupSenderName:
          groupChat?.enabled && event && !usesGroupChatMessageBubble
            ? groupChat.resolveSenderName(event)
            : null,
      }),
      [
        lastAssistantFlatIndex,
        isLastGroup,
        isLastItemInGroup,
        isWpGeneWorking,
        onRegenerate,
        groupIndex,
        usesGroupChatMessageBubble,
        groupChat,
        event,
      ]
    );

    const isStructuralUnloadedTurnItem = getUnloadedTurnMeta(chatItem) !== null;
    const isStructuralOnlyItem = chatItem?.structuralOnly === true;
    const groupMessageWrapClass = showGroupBubbleSenderChrome
      ? "!pt-2 !pb-0"
      : "!pt-1 !pb-0";

    const renderedItem =
      chatItem && !isStructuralUnloadedTurnItem && !isStructuralOnlyItem ? (
        inboxTranscriptLabel && event ? (
          <ChatItemWrap variant="text" className="!py-1">
            <InboxTranscriptCard event={event} title={inboxTranscriptLabel} />
          </ChatItemWrap>
        ) : simpleMessage ? (
          <ChatItemWrap variant="text" className={groupMessageWrapClass}>
            <GroupChatMessageBubble
              senderName={simpleMessage.senderName}
              recipientName={simpleMessage.recipientName}
              bodyMarkdown={simpleMessage.bodyMarkdown}
              timestamp={event?.createdAt ?? ""}
              showSenderChrome={showGroupBubbleSenderChrome}
              toolUseSummary={groupChatToolUseSummary}
            />
          </ChatItemWrap>
        ) : (
          <ChatItemRenderer
            chatItem={chatItem}
            index={flatIndex}
            isWpGeneWorking={isWpGeneWorking}
            isExploring={isExploring}
            onSubmit={onSubmit}
            onSkip={onSkip}
            onEditUserMessage={onEditUserMessage}
            codeBlockContainerWidth={codeBlockContainerWidth}
            treatAsAgentActivity={treatAsAgentActivity}
          />
        )
      ) : null;

    // Wrap the rendered item in a guaranteed-non-zero-height container.
    // react-virtuoso measures each item's `offsetHeight`; a zero-height
    // child triggers a "Zero-sized element, this should not happen"
    // console error. The pipeline tries to pre-filter empty events
    // (`willEventRenderContent`) but some shapes still resolve to `null`
    // downstream — e.g. structural collapse rows, raw events with no
    // registered renderer, and unknown chat-item `type`s that fall through
    // to `renderDefault`. The 1px floor keeps Virtuoso's measurement loop
    // quiet without introducing visible whitespace.
    // Per-turn "new event" divider. Painted above the group's last item
    // so subagent panes can signpost the freshest activity inside each
    // round. Suppressed when the surviving last item is a structural
    // collapse stub (would be a divider above nothing meaningful) or
    // when the host doesn't supply a label.
    const showNewEventDivider =
      isLastItemInGroup &&
      typeof newEventDividerLabel === "string" &&
      newEventDividerLabel.length > 0 &&
      !isStructuralUnloadedTurnItem &&
      !isStructuralOnlyItem;

    return (
      <AgentTurnContext.Provider value={turnContext}>
        <div style={{ minHeight: 1, ...turnGapStyle }}>
          {showNewEventDivider && (
            <NewEventDivider label={newEventDividerLabel as string} />
          )}
          {renderedItem}
        </div>
      </AgentTurnContext.Provider>
    );
  },
  areGroupItemRendererPropsEqual
);

GroupItemRenderer.displayName = "GroupItemRenderer";
