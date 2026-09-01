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
import React, { Suspense, lazy, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { getEventIcon } from "@src/config/toolIcons";
import AgentChatItemDefault from "@src/engines/ChatPanel/ChatItems/AgentChatItemDefault";
import AgentMessageBlock from "@src/engines/ChatPanel/blocks/AgentMessageBlock";
import CanvasInlineCard from "@src/engines/ChatPanel/blocks/CanvasInlineCard";
import CanvasRevisionProgress from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress";
import { isCanvasRevisionPayload } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasRevision";
import { useCanvasForTurn } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/useCanvasForTurn";
import LlmUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/LlmUsageBadge";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
  useEventBlockHeader,
} from "@src/engines/ChatPanel/blocks/primitives";
import {
  useCanvasRevisionDraftForSession,
  useStreamingDeltaForSession,
} from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
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

// Lazy (same as user-message / thinking): SimulatorMessages is only used by
// the simulator variant, but a static import here made every chat message
// renderer pull the whole Communication app — SessionReplay CodePanel,
// CodeMirror, react-syntax-highlighter / Prism, file previewers.
const LazySimulatorMessages = lazy(
  () => import("@src/modules/WorkStation/Chat/Communication")
);

// ============================================
// Types
// ============================================

interface AgentMessageEventProps extends RawEventInput {
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
// Chat Variant
// ============================================

interface ChatVariantProps {
  content?: string;
  thinkingContent?: string | null;
  itemIndex?: number;
  isStreaming?: boolean;
  sessionId?: string | null;
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
  const revisionDraft = useCanvasRevisionDraftForSession(
    isStreaming ? sessionId : null
  );
  const showRevisionReceiving = revisionDraft?.phase === "receiving";

  if (!content && !thinkingContent && !isStreaming && !canvasPayload)
    return null;

  // When the model wraps its entire reply in <think>...</think> with no
  // text outside, `content` is empty after stripping but `thinkingContent`
  // is populated. In that case we render only the inline thinking block
  // and skip the empty assistant bubble — otherwise the user sees a blank
  // chat row with no testid content.
  const hasVisibleContent =
    Boolean(content) || (isStreaming && revisionDraft === null);

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
          >
            {content || ""}
          </AgentChatItemDefault>
        </AgentMessageBlock>
      )}
      {showRevisionReceiving && (
        <div className="px-2">
          <CanvasRevisionProgress draft={revisionDraft} />
        </div>
      )}
      {canvasPayload && !isCanvasRevisionPayload(canvasPayload) && (
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
    <Suspense fallback={null}>
      <LazySimulatorMessages
        currentEvent={event}
        mode={mode}
        sessionId={eventSessionId}
      />
    </Suspense>
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

export const AgentMessageEvent: React.FC<AgentMessageEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "agent_message");
  const sessionId = useAtomValue(sessionIdAtom);
  const liveDelta = useStreamingDeltaForSession(sessionId);
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

  const variant = normalizedProps?.variant ?? props.variant;
  const isTurnPreviewOnly =
    props.event?.args?.turnPreviewOnly === true ||
    normalizedProps?.args?.turnPreviewOnly === true;

  if (!normalizedProps && variant !== "chat") return null;

  if (variant === "chat") {
    if (hasUnloadedTurnPayload(props) && !isTurnPreviewOnly) return null;

    return (
      <ChatVariant
        content={content}
        thinkingContent={thinkingContent}
        itemIndex={props.itemIndex}
        isStreaming={props.isStreaming}
        sessionId={sessionId}
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
