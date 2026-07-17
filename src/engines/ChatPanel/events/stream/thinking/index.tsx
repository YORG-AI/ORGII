/**
 * ThinkingEvent - Universal Component
 *
 * Renders AI thinking/reasoning events across all contexts.
 *
 * Variants:
 * - chat: Uses ThinkingBlock with EventBlockHeader (collapsible, markdown)
 * - simulator: Uses SimulatorMessages app (via registry)
 *
 * @example
 * // From ChatPanel (SessionEvent)
 * <ThinkingEvent event={event} />
 *
 * // From Simulator (spread event format)
 * <ThinkingEvent {...event} mode="simulation" />
 *
 * // Explicit variant
 * <ThinkingEvent {...props} variant="chat" />
 */
import React, { Suspense, lazy, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { getEventIcon } from "@src/config/toolIcons";
import { hasThinkingEventType } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/filters";
import LlmUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/LlmUsageBadge";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
  useEventBlockHeader,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useChatEventReplay } from "@src/engines/ChatPanel/hooks/useChatEventReplay";
import {
  type RawEventInput,
  extractThinkingData,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type {
  EventVariant,
  UniversalEventProps,
} from "@src/engines/SessionCore/rendering/types/universalProps";
import { formatDuration } from "@src/util/time/formatDuration";

import { getThoughtPreview } from "./thoughtPreview";

const LazySimulatorMessages = lazy(
  () => import("@src/modules/WorkStation/Chat/Communication")
);

// ============================================
// Types
// ============================================

export interface ThinkingEventProps extends RawEventInput {
  /** Force a specific variant (auto-detected if not provided) */
  variant?: EventVariant;
}

// ============================================
// Chat Variant (uses ThinkingBlock styling)
// ============================================

interface ThoughtSubtitleProps {
  content?: string;
  duration?: number;
  isLoading: boolean;
}

const ThoughtSubtitle: React.FC<ThoughtSubtitleProps> = ({
  content,
  duration,
  isLoading,
}) => {
  const preview = getThoughtPreview(content);
  const durationLabel = duration ? formatDuration(duration) : null;

  if (!preview && !durationLabel) return null;

  return (
    <EventBlockHeaderSubtitle
      isLoading={isLoading}
      className="gap-1 text-text-1"
      title={[durationLabel, preview].filter(Boolean).join(" · ")}
    >
      {durationLabel && (
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {durationLabel}
        </span>
      )}
      {durationLabel && preview && (
        <span className="shrink-0 text-text-4">·</span>
      )}
      {preview && <span className="min-w-0 truncate">{preview}</span>}
    </EventBlockHeaderSubtitle>
  );
};

interface ChatVariantProps {
  content?: string;
  duration?: number;
  isLoading: boolean;
  isStreaming?: boolean;
  eventId?: string;
  llmUsage?: UniversalEventProps["llmUsage"];
}

const ChatVariant: React.FC<ChatVariantProps> = ({
  content,
  duration,
  isLoading,
  isStreaming = false,
  eventId,
  llmUsage,
}) => {
  const { t } = useTranslation("sessions");
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useEventBlockHeader({
    defaultCollapsed: true,
    collapseAllValue: true,
  });

  const { replayEventById } = useChatEventReplay();
  const handleLocate = useCallback(() => {
    if (eventId) {
      replayEventById(eventId);
    }
  }, [eventId, replayEventById]);

  const hasContent = Boolean(content);
  const title = t(isLoading ? "tools.thinkingRunning" : "tools.thinkingDone");

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={hasContent ? handleHeaderClick : undefined}
        onNavigate={eventId ? handleLocate : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={llmUsage ? <LlmUsageBadge usage={llmUsage} /> : undefined}
      >
        <EventBlockHeaderIcon
          icon={getEventIcon("thinking")}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent={hasContent}
          isLoading={isLoading}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title}
        </EventBlockHeaderTitle>
        <ThoughtSubtitle
          content={content}
          duration={duration}
          isLoading={isLoading}
        />
      </EventBlockHeader>

      {!isCollapsed && (
        <div className="ml-[14px] border-l border-border-1 py-0.5">
          <div
            className={`pl-3 ${getEventBlockContentClasses({ padding: "p-0" })}`}
          >
            <div className="activity-thinking activity-thinking--no-style allow-select">
              <div className="activity-thinking__content allow-select">
                {content ? (
                  <>
                    <Markdown textContent={content} />
                    {isStreaming && (
                      <span className="activity-thinking__cursor" />
                    )}
                  </>
                ) : (
                  <span className="text-text-3">
                    {t("tools.noThoughtPreview")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================
// Main Component
// ============================================

export const ThinkingEvent: React.FC<ThinkingEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "thinking");

  if (!normalizedProps) return null;

  const { content, duration } = extractThinkingData(normalizedProps);
  const displayContent = props.streamingContent || content;
  const hasContent = Boolean(displayContent?.trim());
  const isThinkingEvent = props.event
    ? hasThinkingEventType(props.event, normalizedProps.eventType)
    : false;
  const isLoading = normalizedProps.status === "running";

  if (normalizedProps.variant === "chat") {
    if (isThinkingEvent && !hasContent) return null;

    return (
      <ChatVariant
        content={displayContent}
        duration={duration}
        isLoading={isLoading}
        isStreaming={props.isStreaming}
        eventId={normalizedProps.eventId}
        llmUsage={normalizedProps.llmUsage}
      />
    );
  }

  return (
    <Suspense fallback={null}>
      <LazySimulatorMessages
        currentEvent={props}
        mode={(props.mode as "interactive" | "simulation") || "interactive"}
      />
    </Suspense>
  );
};

ThinkingEvent.displayName = "ThinkingEvent";

export default ThinkingEvent;
