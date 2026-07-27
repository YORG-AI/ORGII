import { ChevronsUpDown } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView, AgentOrgTask } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import {
  derivePlanApprovalViewState,
  isPlanDisplayEvent,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import type { SessionReplayPlaceholderMode } from "@src/modules/WorkStation/shared";

import { isEmailBubbleEvent } from "./EmailMessageBubble";
import { EmptyState } from "./EmptyState";
import {
  BubbleWrapper,
  NewMessageDivider,
} from "./MessageViewer/MessageBubbleRenderer";
import {
  DEFAULT_INITIAL_RENDERED_MESSAGE_COUNT,
  LOAD_MORE_MESSAGE_COUNT,
  MESSAGE_INITIAL_RENDERED_MESSAGE_COUNT,
} from "./MessageViewer/constants";
import {
  getPlanDocStatusViewModel,
  getPlanDocViewModel,
  planSurfaceStatusLabel,
} from "./MessageViewer/planDocViewModel";
import { PlanDocPanel } from "./PlanDocPanel";
import { TodoKanban } from "./TodoKanban";
import type { MessageEntry, MessageViewMode } from "./types";

function minuteBucket(timestamp: string): number {
  return Math.floor(new Date(timestamp).getTime() / 60_000);
}

function isRegularMessageBubble(message: MessageEntry): boolean {
  return (
    message.sender === "agent" &&
    message.type === "chat" &&
    message.event.functionName !== "org_send_message" &&
    !isEmailBubbleEvent(message.event)
  );
}

function shouldGroupWithPreviousMessage(
  message: MessageEntry,
  previousMessage: MessageEntry | undefined
): boolean {
  if (!previousMessage) return false;
  if (
    !isRegularMessageBubble(message) ||
    !isRegularMessageBubble(previousMessage)
  ) {
    return false;
  }
  if (message.sender !== previousMessage.sender) return false;
  if (message.event.sessionId !== previousMessage.event.sessionId) return false;
  return (
    minuteBucket(message.timestamp) === minuteBucket(previousMessage.timestamp)
  );
}

export interface MessageViewerProps {
  /** Full bucket for the active tab; chat mode still renders it through the recent-message window below. */
  messages: MessageEntry[];
  /** Current view mode */
  viewMode: MessageViewMode;
  /** Callback when a message is clicked (to jump to that event) */
  onMessageClick?: (eventId: string) => void;
  /** Whether the viewer is mounted inside interactive chat or a replay recording. */
  sessionReplayMode?: SessionReplayPlaceholderMode;
  /**
   * Preview mode for the plan doc panel — controlled by the parent (tab bar).
   * Defined only when the active message is a plan doc.
   */
  planPreviewMode?: boolean;
  /**
   * When set, the plan doc panel renders an edit textarea instead of the viewer.
   * Controlled by the parent (tab bar Edit button).
   */
  planEditState?: {
    value: string;
    onChange: (value: string) => void;
  };
  /** Hide stale plan docs after Build / archive; the plan file may still exist on disk. */
  planDocPending?: boolean;
  activePlanMessage?: MessageEntry | null;
  selectedMessage?: MessageEntry | null;
  previewSelectedPlan?: boolean;
  /** Current replay event id; used to keep transcript views pinned to bottom. */
  currentEventId?: string | null;
  /**
   * Switch the Communication view mode. Used by the Agent Team task-list
   * card's navigate arrow to jump from the chat stream to the Todo Kanban
   * tab without forcing a manual tab click.
   */
  setViewMode?: (mode: MessageViewMode) => void;
  /**
   * Active org-run member roster — used by bubble wrappers to resolve a
   * subagent name (e.g. "Planner") from `event.sessionId`. Empty when the
   * outer session has no org run (or the runtime hasn't yet returned a
   * view); bubbles fall back to a generic "Agent" label in that case.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  /** Durable task snapshot for Agent Org sessions. Undefined for ordinary sessions. */
  agentOrgTasks?: ReadonlyArray<AgentOrgTask>;
}

export const MessageViewer: React.FC<MessageViewerProps> = ({
  messages,
  viewMode,
  onMessageClick,
  sessionReplayMode = "simulation",
  planPreviewMode,
  planEditState,
  planDocPending = false,
  activePlanMessage: controlledActivePlanMessage,
  selectedMessage,
  previewSelectedPlan = false,
  currentEventId,
  setViewMode,
  orgMembers,
  agentOrgTasks,
}) => {
  const handleNavigateToTodoList = useCallback(() => {
    setViewMode?.("todo");
  }, [setViewMode]);
  const { t } = useTranslation(["common", "sessions"]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreScrollAnchorRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const replayWindowKey = `${viewMode}:${currentEventId ?? ""}`;
  const initialRenderedMessageCount =
    viewMode === "chat" || viewMode === "todo"
      ? MESSAGE_INITIAL_RENDERED_MESSAGE_COUNT
      : DEFAULT_INITIAL_RENDERED_MESSAGE_COUNT;
  const [messageWindow, setMessageWindow] = useState({
    key: replayWindowKey,
    count: initialRenderedMessageCount,
  });
  const renderedMessageCount =
    messageWindow.key === replayWindowKey
      ? messageWindow.count
      : initialRenderedMessageCount;
  const lastMessageId = messages[messages.length - 1]?.eventId ?? null;
  const visibleMessages = useMemo(
    () => messages.slice(-renderedMessageCount),
    [messages, renderedMessageCount]
  );
  const hiddenMessageCount = Math.max(
    0,
    messages.length - visibleMessages.length
  );
  const canLoadMoreMessages = hiddenMessageCount > 0;
  const totalVisibleMessages = visibleMessages.length;
  const showNewMessageDivider = viewMode === "chat" && totalVisibleMessages > 0;
  const latestVisibleMessage = visibleMessages[visibleMessages.length - 1];
  const latestLiveDelta = useStreamingDeltaForSession(
    latestVisibleMessage?.event.args?.syntheticLive === true
      ? latestVisibleMessage.event.sessionId
      : null
  );
  const liveContentLength =
    latestLiveDelta?.kind === "message" ? latestLiveDelta.content.length : 0;

  const handleLoadMoreMessages = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    loadMoreScrollAnchorRef.current = scrollContainer
      ? {
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
        }
      : null;

    setMessageWindow((current) => ({
      key: replayWindowKey,
      count: Math.min(
        messages.length,
        (current.key === replayWindowKey
          ? current.count
          : initialRenderedMessageCount) + LOAD_MORE_MESSAGE_COUNT
      ),
    }));
  }, [initialRenderedMessageCount, messages.length, replayWindowKey]);

  useLayoutEffect(() => {
    const anchor = loadMoreScrollAnchorRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!anchor || !scrollContainer) return;

    loadMoreScrollAnchorRef.current = null;
    const heightDelta = scrollContainer.scrollHeight - anchor.scrollHeight;
    scrollContainer.scrollTop = anchor.scrollTop + heightDelta;
  }, [renderedMessageCount, visibleMessages.length]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const frameId = requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    return () => cancelAnimationFrame(frameId);
  }, [
    currentEventId,
    lastMessageId,
    liveContentLength,
    messages.length,
    viewMode,
  ]);

  const latestPlanMessage = useMemo(() => {
    if (viewMode !== "preview") return null;
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      if (isPlanDisplayEvent(messages[messageIndex].event)) {
        return messages[messageIndex];
      }
    }
    return null;
  }, [messages, viewMode]);

  const selectedPlanMessage =
    viewMode === "preview" && previewSelectedPlan && selectedMessage?.event
      ? isPlanDisplayEvent(selectedMessage.event)
        ? selectedMessage
        : null
      : null;
  const activePlanMessage =
    controlledActivePlanMessage ?? selectedPlanMessage ?? latestPlanMessage;
  const pendingPlan = usePendingPlanApproval(
    activePlanMessage?.event.sessionId
  );
  const canRenderDurableAgentOrgBoard =
    viewMode === "todo" && agentOrgTasks !== undefined;

  if (messages.length === 0 && !canRenderDurableAgentOrgBoard) {
    return (
      <div className="allow-select-deep flex h-full min-h-0 w-full flex-col">
        <EmptyState viewMode={viewMode} sessionReplayMode={sessionReplayMode} />
      </div>
    );
  }

  if (viewMode === "todo") {
    return (
      <div className="allow-select-deep flex h-full min-h-0 w-full flex-col overflow-hidden">
        <TodoKanban messages={messages} agentOrgTasks={agentOrgTasks} />
      </div>
    );
  }

  if (viewMode === "preview" && activePlanMessage) {
    const plan = getPlanDocViewModel(activePlanMessage.event, pendingPlan);
    const statusView = getPlanDocStatusViewModel(
      activePlanMessage.event,
      pendingPlan,
      t
    );
    const planViewState = derivePlanApprovalViewState({
      pendingPlan,
      chatEvents: messages.map((message) => message.event),
    });
    const previewSurfaceState = planViewState.getEventState(
      activePlanMessage.event,
      "preview"
    );
    const readyForReview =
      statusView.readyForReview && previewSurfaceState.ownsActions;
    const statusLabel = readyForReview
      ? statusView.label
      : planSurfaceStatusLabel(previewSurfaceState, t);
    return (
      <div
        data-testid="communication-plan-doc-surface"
        className="h-full min-h-0"
      >
        <PlanDocPanel
          content={plan.content}
          planRevisionId={plan.planRevisionId}
          statusLabel={statusLabel}
          readyForReview={readyForReview}
          planPath={plan.planPath}
          isPreviewMode={planPreviewMode ?? true}
          editState={planDocPending ? planEditState : undefined}
        />
      </div>
    );
  }

  return (
    <div
      className="allow-select-deep flex h-full w-full flex-col"
      data-testid="communication-message-viewer"
    >
      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide"
      >
        <div
          className={
            viewMode === "chat"
              ? "flex flex-col gap-2 pb-[120px] pt-3"
              : "flex flex-col gap-6 pb-[120px] pt-4"
          }
        >
          {canLoadMoreMessages && (
            <div className="flex w-full justify-center py-1.5">
              <Button
                htmlType="button"
                variant="tertiary"
                appearance="ghost"
                size="small"
                icon={<ChevronsUpDown size={14} />}
                data-testid="communication-load-more-messages"
                onClick={handleLoadMoreMessages}
              >
                {t("simulator.replay.messages.divider.loadEarlierMessages", {
                  ns: "sessions",
                  count: hiddenMessageCount,
                })}
              </Button>
            </div>
          )}
          {visibleMessages.map((message, index) => {
            const isLastVisibleMessage = index === totalVisibleMessages - 1;
            const previousMessage = visibleMessages[index - 1];
            const showChrome =
              isLastVisibleMessage ||
              !shouldGroupWithPreviousMessage(message, previousMessage);
            return (
              <React.Fragment key={message.eventId}>
                {showNewMessageDivider && isLastVisibleMessage && (
                  <NewMessageDivider
                    label={t("simulator.replay.messages.divider.newMessage", {
                      ns: "sessions",
                    })}
                  />
                )}
                <BubbleWrapper
                  message={message}
                  viewMode={viewMode}
                  index={index}
                  total={totalVisibleMessages}
                  onMessageClick={onMessageClick}
                  onNavigateToTodoList={
                    setViewMode ? handleNavigateToTodoList : undefined
                  }
                  showChrome={showChrome}
                  orgMembers={orgMembers}
                />
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};

MessageViewer.displayName = "MessageViewer";

export default MessageViewer;
