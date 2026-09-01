/**
 * ActivityRouter Component
 *
 * Routes a SessionEvent to the appropriate content component based on
 * actionType/functionName. Uses the unified event registry for
 * direct name → component resolution.
 */
import React, { Suspense, memo, useMemo } from "react";

import { MarkdownWorkspaceRootContext } from "@src/components/MarkDown/markdownWorkspaceRoot";
import AgentMessageBlock from "@src/engines/ChatPanel/blocks/AgentMessageBlock";
import LlmUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/LlmUsageBadge";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import {
  LLM_USAGE_ARGS_KEY,
  type LlmUsageMetadata,
  type SessionEvent,
  TOOL_USAGE_ARGS_KEY,
} from "@src/engines/SessionCore/core/types";
import {
  chatRequiresItemIndex,
  chatShowsStatusLine,
  getChatComponent,
} from "@src/engines/SessionCore/rendering/registry/events";
import { createLogger } from "@src/hooks/logger";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";
import {
  extractAssistantMessageContent,
  extractTextFromContent,
  isOrchestratorSystemPrompt,
} from "@src/lib/activityData/textExtractors";

import AgentChatItemDefault from "../ChatItems/AgentChatItemDefault";
import AgentErrorChatItem from "../ChatItems/AgentErrorChatItem";
import "./ActivityRouter.scss";
import { getAgentErrorMessage } from "./chatItemPipeline/classifiers";
import UserMessageContent from "./components/UserMessageContent";

const log = createLogger("ActivityRouter");

export type ActivityStatus = "processed" | "pending" | "agent";

export interface ActivityChatItemProps {
  event: SessionEvent;
  itemIndex?: number;
  status?: ActivityStatus;
  /** Pass true when the caller is in live-playback mode (e.g. subagent grid replay). */
  isStreaming?: boolean;
}

// ============================================
// Custom Comparison - Only re-render when data changes
// ============================================

const RESULT_COMPARE_KEYS = [
  "type",
  "message",
  "content",
  "observation",
  "success",
  "error",
  "error_message",
  "images",
  "call_id",
  "output",
  "diff",
  "diffString",
  "segments",
  "filePaths",
  "linesAdded",
  "linesRemoved",
] as const;

function isResultEqual(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  for (const key of RESULT_COMPARE_KEYS) {
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

function arePropsEqual(
  prevProps: ActivityChatItemProps,
  nextProps: ActivityChatItemProps
): boolean {
  if (prevProps.itemIndex !== nextProps.itemIndex) return false;
  if (prevProps.status !== nextProps.status) return false;
  if (prevProps.isStreaming !== nextProps.isStreaming) return false;

  const prevEvent = prevProps.event;
  const nextEvent = nextProps.event;

  if (prevEvent.id !== nextEvent.id) return false;
  if (prevEvent.actionType !== nextEvent.actionType) return false;
  if (prevEvent.functionName !== nextEvent.functionName) return false;
  if (prevEvent.uiCanonical !== nextEvent.uiCanonical) return false;
  if (prevEvent.activityStatus !== nextEvent.activityStatus) return false;
  if (prevEvent.displayStatus !== nextEvent.displayStatus) return false;
  if (prevEvent.displayText !== nextEvent.displayText) return false;
  if (prevEvent.displayVariant !== nextEvent.displayVariant) return false;
  if (prevEvent.shellPid !== nextEvent.shellPid) return false;
  if (prevEvent.shellProcessStatus !== nextEvent.shellProcessStatus) {
    return false;
  }
  if (prevEvent.shellExitCode !== nextEvent.shellExitCode) return false;
  if (prevEvent.shellLogPath !== nextEvent.shellLogPath) return false;
  if (prevEvent.extracted !== nextEvent.extracted) return false;
  if (prevEvent.payloadRefs !== nextEvent.payloadRefs) return false;

  if (!isResultEqual(prevEvent.result, nextEvent.result)) {
    return false;
  }

  const prevArgs = prevEvent.args;
  const nextArgs = nextEvent.args;
  if (prevArgs?.streamContent !== nextArgs?.streamContent) return false;
  if (prevArgs?.title !== nextArgs?.title) return false;
  if (prevArgs?.streamOutput !== nextArgs?.streamOutput) return false;
  if (prevArgs?.patch_text !== nextArgs?.patch_text) return false;
  if (prevArgs?.old_str !== nextArgs?.old_str) return false;
  if (prevArgs?.old_string !== nextArgs?.old_string) return false;
  if (prevArgs?.old_content !== nextArgs?.old_content) return false;
  if (prevArgs?.new_str !== nextArgs?.new_str) return false;
  if (prevArgs?.new_string !== nextArgs?.new_string) return false;
  if (prevArgs?.new_content !== nextArgs?.new_content) return false;
  if (prevArgs?.content !== nextArgs?.content) return false;
  if (prevArgs?.command !== nextArgs?.command) return false;
  if (prevArgs?.action !== nextArgs?.action) return false;
  if (prevArgs?.subagentSessionId !== nextArgs?.subagentSessionId) return false;
  if (prevArgs?.[TOOL_USAGE_ARGS_KEY] !== nextArgs?.[TOOL_USAGE_ARGS_KEY]) {
    return false;
  }
  if (prevArgs?.[LLM_USAGE_ARGS_KEY] !== nextArgs?.[LLM_USAGE_ARGS_KEY]) {
    return false;
  }

  return true;
}

// ============================================
// Loading Fallback
// ============================================

/**
 * uiCanonical values that carry their own dedicated chat renderer AND are
 * NOT assistant prose, even though the producing event is stamped
 * `source: "assistant"` / `displayVariant: "message"` for activity-status
 * purposes. Without this guard the broad heuristic below swallows them and
 * renders their raw `result.observation` (e.g. the literal string
 * `rate_limit_hint`) as an assistant message instead of routing to the
 * registered card component.
 */
const DEDICATED_NON_MESSAGE_CANONICALS = new Set([
  "rate_limit_hint",
  "context_compacted",
]);

function readLlmUsage(event: SessionEvent): LlmUsageMetadata | undefined {
  if (event.llmUsage) return event.llmUsage;
  const raw = event.args?.[LLM_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as LlmUsageMetadata;
}

function isSyntheticLiveAssistantEvent(event: SessionEvent): boolean {
  return event.args?.syntheticLive === true;
}

function isAssistantMessageLikeEvent(
  event: SessionEvent,
  eventType: string
): boolean {
  if (
    event.uiCanonical &&
    DEDICATED_NON_MESSAGE_CANONICALS.has(event.uiCanonical)
  ) {
    return false;
  }
  if (eventType === "agent_message") return true;
  if (event.uiCanonical === "assistant_message") return true;
  if (event.functionName === "assistant_message") return true;
  return event.source === "assistant" && event.displayVariant === "message";
}

// ============================================
// Error Boundary
// ============================================

interface ErrorBoundaryState {
  hasError: boolean;
}

class ActivityErrorBoundary extends React.Component<
  { children: React.ReactNode; eventType: string },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; eventType: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    log.error(
      `[ActivityRouter] Failed to render ${this.props.eventType}:`,
      error,
      errorInfo
    );
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="p-2 text-sm text-red-500">
          Failed to render activity
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================
// Main Component
// ============================================

const ActivityChatItem: React.FC<ActivityChatItemProps> = memo(
  ({ event, itemIndex = 0, status = "agent", isStreaming = false }) => {
    const userMessageText = useMemo((): string | null => {
      const actionType = event.actionType;
      if (actionType !== "raw" && actionType !== "raw_event") return null;
      if (!event.result?.type && !event.result?.message) return null;
      if (event.result?.type !== "user" && !event.result?.message) return null;

      const text =
        extractTextFromContent(event.result?.message) ||
        extractTextFromContent(event.result?.content) ||
        "";

      if (!text) return null;

      if (isOrchestratorSystemPrompt(text)) {
        return null;
      }

      return text;
    }, [event]);

    const userMessageImages = useMemo((): string[] | undefined => {
      if (!event.result?.images) return undefined;
      const images = event.result.images;
      if (Array.isArray(images) && images.length > 0) {
        return images as string[];
      }
      return undefined;
    }, [event.result]);

    const renderContent = () => {
      if (event.id === "loading") {
        return <ChatLoadingBlock />;
      }

      const actionType = event.actionType;
      const functionName = event.functionName;
      const eventType = getRegistryEventType(event);

      const agentErrorMessage = getAgentErrorMessage(event);
      if (agentErrorMessage) {
        return <AgentErrorChatItem errorMessage={agentErrorMessage} />;
      }

      if (
        isAssistantMessageLikeEvent(event, eventType) &&
        !isSyntheticLiveAssistantEvent(event)
      ) {
        const assistantContent = extractAssistantMessageContent(event);
        if (assistantContent) {
          const llmUsage = readLlmUsage(event);
          return (
            <AgentMessageBlock
              isStreaming={isStreaming}
              rightContent={
                llmUsage ? <LlmUsageBadge usage={llmUsage} /> : undefined
              }
            >
              <AgentChatItemDefault
                itemIndex={itemIndex}
                expand={true}
                finish={!isStreaming}
                streamHtml={isStreaming}
                messageTimestamp={event.createdAt}
              >
                {assistantContent}
              </AgentChatItemDefault>
            </AgentMessageBlock>
          );
        }
      }

      if (actionType === "raw" || actionType === "raw_event") {
        if (userMessageText || userMessageImages?.length) {
          return (
            <UserMessageContent
              text={userMessageText ?? ""}
              images={userMessageImages}
            />
          );
        }
        if (!functionName) {
          return null;
        }
      }

      const EventComponent = getChatComponent(eventType);

      if (EventComponent) {
        const extras: Record<string, unknown> = {};
        if (chatRequiresItemIndex(eventType)) {
          extras.itemIndex = itemIndex;
        }
        if (isStreaming) {
          extras.isStreaming = true;
        }
        return (
          <ActivityErrorBoundary eventType={eventType}>
            <Suspense fallback={<ChatLoadingBlock />}>
              <EventComponent event={event} variant="chat" {...extras} />
            </Suspense>
          </ActivityErrorBoundary>
        );
      }

      const observation = event.result?.observation;
      if (observation && typeof observation === "string") {
        return (
          <AgentChatItemDefault
            itemIndex={itemIndex}
            expand={true}
            finish={true}
            streamHtml={false}
          >
            {observation}
          </AgentChatItemDefault>
        );
      }

      return null;
    };

    const content = renderContent();
    if (!content) return null;

    const eventType = getRegistryEventType(event);
    const showStatusLine = chatShowsStatusLine(eventType);

    const statusLineClass = showStatusLine
      ? {
          processed: "activity-chat-item--status-processed",
          pending: "activity-chat-item--status-pending",
          agent: "activity-chat-item--status-agent",
        }[status] || "activity-chat-item--status-agent"
      : "";

    // Every file reference rendered below this event — markdown link, local
    // image, fenced-block open button — resolves against the repo that was
    // active when the event was written, not the folder the reader happens to
    // have focused while scrolling the transcript.
    return (
      <MarkdownWorkspaceRootContext.Provider value={event.repoPath}>
        <div className={`activity-chat-item ${statusLineClass}`.trim()}>
          {content}
        </div>
      </MarkdownWorkspaceRootContext.Provider>
    );
  },
  arePropsEqual
);

ActivityChatItem.displayName = "ActivityChatItem";

export default ActivityChatItem;
