import React, { memo, useCallback } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { buildSearchTargetRowProps } from "@src/engines/ChatPanel/ChatHistory/hooks/chatSearch";
import { isPlanDisplayEvent } from "@src/engines/SessionCore/derived/planDisplayEvents";

import {
  OrgSendMessageBubble,
  OrgTaskEventBubble,
  isOrgTaskEvent,
} from "../AgentEventBubbles";
import { ChatBubble, TodoBubble, UnloadedTurnBubble } from "../ChatBubble";
import { EmailMessageBubble, isEmailBubbleEvent } from "../EmailMessageBubble";
import { ThinkBubble } from "../ThinkBubble";
import type { MessageEntry, MessageViewMode } from "../types";
import {
  renderInteractionWidget,
  renderPlanDocCard,
} from "./InteractionRenderers";

export const NewMessageDivider: React.FC<{ label: string }> = memo(
  ({ label }) => (
    <div className="flex items-center gap-3 py-1 text-[11px] font-medium text-primary-6">
      <div className="h-px flex-1 bg-primary-6" />
      <span className="shrink-0">{label}</span>
      <div className="h-px flex-1 bg-primary-6" />
    </div>
  )
);
NewMessageDivider.displayName = "NewMessageDivider";

export const BubbleWrapper: React.FC<{
  message: MessageEntry;
  viewMode: MessageViewMode;
  index: number;
  total: number;
  onMessageClick?: (eventId: string) => void;
  /**
   * Called when an Agent Team task-list card's navigate arrow is clicked.
   * Wired by `MessageViewer` to switch the Communication tab to the Todo
   * Kanban view. No-op when the parent does not provide a handler.
   */
  onNavigateToTodoList?: () => void;
  showChrome?: boolean;
  /**
   * Active org-run member roster. Passed to `OrgTaskEventBubble` /
   * `OrgSendMessageBubble` so they can resolve a subagent display name
   * (e.g. "Planner") from `event.sessionId`.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  /** Active chat-search match event id (cross-pane sync). */
  activeSearchEventId?: string | null;
}> = memo(
  ({
    message,
    viewMode,
    index,
    total,
    onMessageClick,
    onNavigateToTodoList,
    showChrome = true,
    orgMembers,
    activeSearchEventId = null,
  }) => {
    const handleClick = useCallback(() => {
      onMessageClick?.(message.eventId);
    }, [message.eventId, onMessageClick]);

    const stableClick = onMessageClick ? handleClick : undefined;
    const isLatest = index === total - 1;
    const targetRowProps = buildSearchTargetRowProps(
      { messageId: message.eventId, eventId: message.event.id },
      activeSearchEventId
    );
    const wrapSearchTarget = (content: React.ReactNode) => (
      <div {...targetRowProps}>{content}</div>
    );

    let content: React.ReactNode = null;
    switch (viewMode) {
      case "think":
        content = (
          <ThinkBubble
            message={message}
            isLatest={isLatest}
            onClick={stableClick}
            orgMembers={orgMembers}
          />
        );
        break;
      case "interaction":
        content = (
          <>{renderInteractionWidget(message, onMessageClick, orgMembers)}</>
        );
        break;
      case "todo":
        if (isOrgTaskEvent(message.event)) {
          content = (
            <OrgTaskEventBubble
              message={message}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
        } else {
          content = (
            <TodoBubble
              message={message}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
        }
        break;
      case "chat":
        // Lazy-load placeholder for a turn whose body was windowed out of
        // the initial load (PR #561). `message.content` is the backend's
        // raw "turn is not loaded yet" observation text here — never
        // render it as if it were the agent's real reply. Renders a
        // compact loading row and kicks off the same
        // `loadSessionTurnBodyIntoStore` fetch the chat panel's collapse
        // bar uses; once the body lands, `derivedSnapshotAtom` recomputes
        // and this message re-derives without `unloadedTurn` set.
        if (message.unloadedTurn) {
          content = (
            <UnloadedTurnBubble
              message={message}
              unloadedTurn={message.unloadedTurn}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
          break;
        }
        if (message.type === "think") {
          content = (
            <ThinkBubble
              message={message}
              isLatest={isLatest}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
          break;
        }
        if (message.type === "todo") {
          if (isOrgTaskEvent(message.event)) {
            content = (
              <OrgTaskEventBubble
                message={message}
                onClick={stableClick}
                onNavigateToTodoList={onNavigateToTodoList}
                orgMembers={orgMembers}
              />
            );
          } else {
            content = <TodoBubble message={message} orgMembers={orgMembers} />;
          }
          break;
        }
        if (message.type === "interaction") {
          content = isPlanDisplayEvent(message.event) ? (
            renderPlanDocCard(message, orgMembers)
          ) : (
            <>{renderInteractionWidget(message, onMessageClick, orgMembers)}</>
          );
          break;
        }
        if (message.event.functionName === "org_send_message") {
          content = (
            <OrgSendMessageBubble
              message={message}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
          break;
        }
        if (isEmailBubbleEvent(message.event)) {
          content = (
            <EmailMessageBubble
              message={message}
              onClick={stableClick}
              orgMembers={orgMembers}
            />
          );
          break;
        }
        content = (
          <ChatBubble
            message={message}
            index={index}
            isLatest={isLatest}
            showChrome={showChrome}
            orgMembers={orgMembers}
          />
        );
        break;
      default:
        content = null;
    }

    return content ? wrapSearchTarget(content) : null;
  }
);
BubbleWrapper.displayName = "BubbleWrapper";
