/**
 * AgentMessageEvent - Universal Component
 *
 * Renders AI agent message events across all contexts.
 *
 * Variants:
 * - chat: Uses AgentChatItemDefault (markdown rendering, expandable)
 * - simulator: Uses SimulatorMessages (full app with chat/think/todo tabs)
 *
 * Note: This was previously called AssistantEvent. The ui_canonical in Rust
 * is now `agent_message` to better reflect the actual purpose.
 */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { getEventIcon } from "@src/config/toolIcons";
import AgentChatItemDefault from "@src/engines/ChatPanel/ChatItems/AgentChatItemDefault";
import { AgentMessageBlock } from "@src/engines/ChatPanel/blocks";
import CanvasInlineCard from "@src/engines/ChatPanel/blocks/CanvasInlineCard";
import { useCanvasForTurn } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/useCanvasForTurn";
import MessageReferenceCards from "@src/engines/ChatPanel/blocks/MessageReferenceCards";
import LlmUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/LlmUsageBadge";
import {
  SessionLinkCard,
  type SessionLinkCardData,
} from "@src/engines/ChatPanel/blocks/ToolCallBlock/cards";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
  useEventBlockHeader,
} from "@src/engines/ChatPanel/blocks/primitives";
import { streamingDeltaContentAtom } from "@src/engines/SessionCore";
import { eventsAtom, sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type {
  EventVariant,
  UniversalEventProps,
} from "@src/engines/SessionCore/rendering/types/universalProps";
import {
  extractThinkContent,
  stripThinkTags,
} from "@src/engines/SessionCore/sync/adapters/shared/streamingParsers";
import { SimulatorMessages } from "@src/modules/WorkStation/Chat/Communication";
import { parseGitArtifactsFromText } from "@src/shared/git/sessionGitArtifacts";

// ============================================
// Types
// ============================================

export interface AgentMessageEventProps extends RawEventInput {
  variant?: EventVariant;
}

// ============================================
// Inline thinking block (for historical <think> tags)
// ============================================

const InlineThinkingBlock: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useTranslation("sessions");
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useEventBlockHeader({ defaultCollapsed: true, collapseAllValue: true });

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={getEventIcon("agent_message")}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent
        />
        <EventBlockHeaderTitle>{t("tools.thought")}</EventBlockHeaderTitle>
      </EventBlockHeader>

      {!isCollapsed && (
        <div className={getEventBlockContentClasses({ padding: "p-0" })}>
          <div className="activity-thinking activity-thinking--no-style allow-select">
            <div className="activity-thinking__content allow-select">
              <Markdown textContent={content} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================
// PR Session Link Cards (extracted from agent message text)
// ============================================

function extractPrCards(content: string): SessionLinkCardData[] {
  const artifacts = parseGitArtifactsFromText(content);
  return artifacts
    .filter(
      (a) => a.kind === "pullRequest" && a.url && a.repoFullName && a.prNumber
    )
    .map((a) => ({
      prUrl: a.url!,
      prStatus: "open" as const,
      repoFullName: a.repoFullName!,
      prNumber: a.prNumber!,
      prTitle: `PR #${a.prNumber}`,
    }));
}

const PrSessionLinkCards: React.FC<{
  content: string;
  isStreaming: boolean;
}> = React.memo(({ content, isStreaming }) => {
  const cards = useMemo(
    () => (isStreaming ? [] : extractPrCards(content)),
    [content, isStreaming]
  );
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => (
        <SessionLinkCard
          key={`${card.repoFullName}#${card.prNumber}`}
          card={card}
        />
      ))}
    </>
  );
});
PrSessionLinkCards.displayName = "PrSessionLinkCards";

// ============================================
// Chat Variant
// ============================================

interface ChatVariantProps {
  content?: string;
  thinkingContent?: string | null;
  itemIndex?: number;
  isStreaming?: boolean;
  sessionId?: string | null;
  canvasUrls?: ReadonlySet<string>;
  llmUsage?: UniversalEventProps["llmUsage"];
  /** Event id used by AgentMessageBlock's locate-in-simulator arrow. */
  eventId?: string;
  timestamp?: string;
}

const ChatVariant: React.FC<ChatVariantProps> = ({
  content,
  thinkingContent,
  itemIndex = 0,
  isStreaming = false,
  sessionId,
  canvasUrls,
  llmUsage,
  eventId,
  timestamp,
}) => {
  // Canvas preview from the global atom is only relevant for the live
  // streaming message. Historical (non-streaming) messages already have
  // their canvas rendered inline via CanvasInlineAdapter in the event list.
  // Reading the global atom unconditionally caused re-shows: any time a new
  // round started and openInSimulatorCanvas cleared cardDismissed, every
  // historical ChatVariant instance would briefly re-render the old canvas.
  const { snapshot: streamingCanvas } = useCanvasForTurn(
    isStreaming ? sessionId : null
  );
  const streamingCanvasPayload = streamingCanvas.payload;
  const canvasPayload = isStreaming ? streamingCanvasPayload : null;

  if (!content && !thinkingContent && !isStreaming && !canvasPayload)
    return null;

  // When the model wraps its entire reply in <think>...</think> with no
  // text outside, `content` is empty after stripping but `thinkingContent`
  // is populated. In that case we render only the inline thinking block
  // and skip the empty assistant bubble — otherwise the user sees a blank
  // chat row with no testid content.
  const hasVisibleContent = Boolean(content) || isStreaming;

  return (
    <>
      {thinkingContent && <InlineThinkingBlock content={thinkingContent} />}
      {hasVisibleContent && (
        <AgentMessageBlock
          eventId={eventId}
          isStreaming={isStreaming}
          itemIndex={itemIndex}
          messageContent={content}
          messageTimestamp={timestamp}
          rightContent={
            llmUsage ? <LlmUsageBadge usage={llmUsage} /> : undefined
          }
        >
          <AgentChatItemDefault
            itemIndex={itemIndex}
            expand={true}
            finish={!isStreaming}
            streamHtml={isStreaming}
            showCopyButton={false}
            appendedContent={
              <>
                <MessageReferenceCards
                  content={content || ""}
                  enabled={!isStreaming}
                  excludeUrls={canvasUrls}
                  sessionId={sessionId}
                />
                {!isStreaming && content && (
                  <PrSessionLinkCards
                    content={content}
                    isStreaming={isStreaming}
                  />
                )}
              </>
            }
          >
            {content || ""}
          </AgentChatItemDefault>
        </AgentMessageBlock>
      )}
      {canvasPayload && (
        <div className="px-2">
          <CanvasInlineCard
            mode={canvasPayload.mode}
            content={canvasPayload.content}
            url={canvasPayload.url}
            title={canvasPayload.title}
            isStreaming={canvasPayload.streaming ?? isStreaming}
            eventId={eventId}
          />
        </div>
      )}
    </>
  );
};

// ============================================
// Simulator Variant
// ============================================

interface SimulatorVariantProps {
  event: RawEventInput;
  mode?: "interactive" | "simulation";
}

const SimulatorVariant: React.FC<SimulatorVariantProps> = ({
  event,
  mode = "interactive",
}) => {
  // Extract the sessionId from the event so the notification bar in
  // SimulatorMessages uses the correct session rather than the global atom.
  const eventSessionId =
    (event as { event?: { sessionId?: string } })?.event?.sessionId ?? null;
  return (
    <SimulatorMessages
      currentEvent={event}
      mode={mode}
      sessionId={eventSessionId}
    />
  );
};

// ============================================
// Main Component
// ============================================

function extractText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
  }
  return undefined;
}

function hasUnloadedTurnPayload(value: RawEventInput | undefined): boolean {
  const rawResult = value?.event?.result ?? value?.result;
  if (!rawResult || typeof rawResult !== "object") return false;
  const result = rawResult as Record<string, unknown>;
  const unloadedTurn = result.unloadedTurn;
  if (!unloadedTurn || typeof unloadedTurn !== "object") return false;
  const turnId = (unloadedTurn as Record<string, unknown>).turnId;
  return typeof turnId === "string" && turnId.length > 0;
}

/**
 * Collects URLs used by canvas_inline events within the same agent turn as
 * the given agent_message event id. "Same turn" = all non-user events between
 * the preceding user event and the next user event.
 *
 * Used to suppress MessageReferenceCards from showing a URL card for a URL
 * that is already rendered by a CanvasInlineAdapter in the same turn.
 */
function useAdjacentCanvasUrls(
  eventId: string | undefined
): ReadonlySet<string> {
  const events = useAtomValue(eventsAtom);
  return useMemo(() => {
    if (!eventId) return new Set<string>();

    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) return new Set<string>();

    // Walk backward to the preceding user event boundary
    let start = 0;
    for (let i = idx - 1; i >= 0; i--) {
      if (events[i].source === "user") {
        start = i + 1;
        break;
      }
    }

    // Walk forward to the next user event boundary
    let end = events.length;
    for (let i = idx + 1; i < events.length; i++) {
      if (events[i].source === "user") {
        end = i;
        break;
      }
    }

    const urls = new Set<string>();
    for (let i = start; i < end; i++) {
      const evt = events[i];
      if (evt.uiCanonical === "canvas_inline") {
        const url = evt.args?.url;
        if (typeof url === "string" && url) {
          try {
            urls.add(new URL(url).toString());
          } catch {
            urls.add(url);
          }
        }
      }
    }
    return urls;
  }, [events, eventId]);
}

export const AgentMessageEvent: React.FC<AgentMessageEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "agent_message");
  const sessionId = useAtomValue(sessionIdAtom);
  const streamingMap = useAtomValue(streamingDeltaContentAtom);
  const liveDelta = sessionId ? (streamingMap.get(sessionId) ?? null) : null;
  const directStreamContent =
    liveDelta?.kind === "message" ? liveDelta.content : null;

  const isSyntheticLiveEvent =
    props.event?.args?.syntheticLive === true ||
    normalizedProps?.args?.syntheticLive === true;

  const rawContent = useMemo(() => {
    if (isSyntheticLiveEvent && props.isStreaming && directStreamContent) {
      return directStreamContent;
    }
    return (
      props.streamingContent ||
      extractText(normalizedProps?.result?.observation) ||
      extractText(normalizedProps?.result?.content) ||
      extractText(props.event?.result?.observation) ||
      extractText(props.event?.result?.content) ||
      extractText(props.event?.displayText) ||
      extractText(normalizedProps?.args?.task_description) ||
      undefined
    );
  }, [
    normalizedProps,
    props.streamingContent,
    props.event?.result?.observation,
    props.event?.result?.content,
    props.event?.displayText,
    props.isStreaming,
    directStreamContent,
    isSyntheticLiveEvent,
  ]);

  const content = rawContent ? stripThinkTags(rawContent) : undefined;
  const thinkingContent = useMemo(
    () => (rawContent ? extractThinkContent(rawContent) : null),
    [rawContent]
  );

  const canvasUrls = useAdjacentCanvasUrls(normalizedProps?.eventId);

  const variant = normalizedProps?.variant ?? props.variant;

  if (!normalizedProps && variant !== "chat") return null;

  if (variant === "chat") {
    if (hasUnloadedTurnPayload(props)) return null;

    return (
      <ChatVariant
        content={content}
        thinkingContent={thinkingContent}
        itemIndex={props.itemIndex}
        isStreaming={props.isStreaming}
        sessionId={sessionId}
        canvasUrls={canvasUrls}
        llmUsage={normalizedProps?.llmUsage}
        eventId={normalizedProps?.eventId}
        timestamp={normalizedProps?.timestamp ?? props.event?.createdAt}
      />
    );
  }

  return (
    <SimulatorVariant
      event={props}
      mode={(props.mode as "interactive" | "simulation") || "interactive"}
    />
  );
};

AgentMessageEvent.displayName = "AgentMessageEvent";

export default AgentMessageEvent;
