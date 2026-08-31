/**
 * Chat Item Renderer
 *
 * Slim dispatcher that routes OptimizedChatItem to the appropriate
 * memoized renderer based on type. All rendering logic lives
 * in extracted modules:
 * - MemoizedItems: User, ThreadSelector
 * - ExtendedItemRenderers: Activity groups, stacks, fallback
 * - ChatItemWrap: Unified spacing wrapper
 *
 * Turn-scoped actions (Regenerate, etc.) are delivered to descendant
 * activity components via `AgentTurnContext.Provider`, which the caller
 * (ChatHistory) wraps around each item. See AgentTurnContext.tsx.
 */
import React, { memo } from "react";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import {
  renderActionSummaryGroup,
  renderActivity,
  renderActivityStackGroup,
  renderDefault,
  renderReadFileGroup,
  renderThreadSelector,
  renderTurnToolBundle,
} from "./ExtendedItemRenderers";
import { MemoizedUserChatItem } from "./MemoizedItems";

// ============================================
// Props Interface
// ============================================

export interface ChatItemRendererProps {
  chatItem: OptimizedChatItem;
  index: number;
  isWpGeneWorking: boolean;
  isExploring: boolean;
  onSubmit: (eventId: string, answers: Record<string, string>) => void;
  onSkip: (eventId: string) => void;
  onEditUserMessage?: (
    chatItem: OptimizedChatItem,
    newText: string,
    imageDataUrls?: string[]
  ) => void;
  codeBlockContainerWidth?: number;
  /** Render the item through activity components even if the source is `user`. */
  treatAsAgentActivity?: boolean;
}

// ============================================
// Main Renderer Component
// ============================================

export const ChatItemRenderer: React.FC<ChatItemRendererProps> = memo(
  ({
    chatItem,
    index,
    isWpGeneWorking: _isWpGeneWorking,
    isExploring: _isExploring,
    onSubmit: _onSubmit,
    onSkip: _onSkip,
    onEditUserMessage,
    codeBlockContainerWidth: _codeBlockContainerWidth,
    treatAsAgentActivity = false,
  }) => {
    const key = chatItem.chunk_id || `chat-${index}`;
    const event = chatItem.event;

    // User messages
    if (event?.source === "user" && !treatAsAgentActivity) {
      return (
        <MemoizedUserChatItem
          key={key}
          chatItem={chatItem}
          index={index}
          onEditUserMessage={onEditUserMessage}
        />
      );
    }

    // Switch on chat item type
    switch (chatItem.type) {
      case "activity":
        return renderActivity(chatItem, index, key);

      case "readFileGroup":
        return renderReadFileGroup(chatItem, key);

      case "actionSummaryGroup":
        return renderActionSummaryGroup(chatItem, key);

      case "activityStackGroup":
        return renderActivityStackGroup(chatItem, key);

      case "threadSelector":
        return renderThreadSelector(chatItem, key);

      case "turnToolBundle":
        return renderTurnToolBundle(
          chatItem,
          index,
          key,
          (child, childIndex) => (
            <ChatItemRenderer
              chatItem={child}
              index={childIndex}
              isWpGeneWorking={_isWpGeneWorking}
              isExploring={_isExploring}
              onSubmit={_onSubmit}
              onSkip={_onSkip}
              onEditUserMessage={onEditUserMessage}
              codeBlockContainerWidth={_codeBlockContainerWidth}
              treatAsAgentActivity={treatAsAgentActivity}
            />
          )
        );

      default:
        return renderDefault(chatItem, index, key);
    }
  }
);

ChatItemRenderer.displayName = "ChatItemRenderer";
